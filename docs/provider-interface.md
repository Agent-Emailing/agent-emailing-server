# The provider interface

A carrier is the email provider, or mail system, that sends and receives an
agent's email. The server talks to every carrier through a small adapter. The
adapter contract is the one Agent Emailing §11.4 gives, in
`src/providers/types.ts`.

## The four operations

```ts
interface CarrierAdapter {
  readonly name: string;
  capabilities(): CarrierCapabilities;
  send(mail: OutboundMail): Promise<{ carrierId: string; messageId?: string }>;
  receive(handler: (mail: InboundMail) => Promise<void>): void;
  status(carrierId: string): Promise<{ state: "delivered" | "deferred" | "bounced" | "unknown"; dsnStatus?: string }>;

  // Additions (below).
  webhook?(req: { headers: Record<string, string>; body: Buffer; path: string }): Promise<{ status: number; body?: string }>;
  onStatus?(handler: (ev: StatusEvent) => Promise<void>): void;
  start?(): Promise<void>;
  close?(): Promise<void>;
}
```

- **`capabilities()`** says what the carrier supports, from §11.2 and §11.3:
  whether it gives the raw message, whether attachments can be downloaded, how
  inbound mail is pushed, whether it reports SPF, DKIM and DMARC, whether it
  threads, which custom headers it accepts, and its largest outbound email.
  The server keeps every email under `maxOutboundBytes`.
- **`send(mail)`** sends one email. `mail` has `from`, `to`, `subject`, `text`,
  optional `html`, `inReplyTo` and `references`, `headers`, and
  `attachments`. An attachment is `{ filename, contentType, contentId?, bytes }`.
  The first attachment is always the envelope part
  (`application/vnd.agentmessaging.envelope+json`, `envelope.json`). File parts
  carry the `contentId` their `cid:` reference names. A carrier that takes raw
  MIME gets it from `renderMime(mail)`; a carrier with a JSON API maps the
  fields. The adapter drops headers its carrier refuses, and returns the
  carrier's id for the email and its `Message-ID` when the carrier says it.
- **`receive(handler)`** registers the function the adapter calls for each
  inbound email, pushed or polled. `InboundMail` is
  `{ carrierEventId, raw?, headers, attachments, text?, html?, auth?, receivedAt }`.
  `carrierEventId` must stay the same when the carrier retries. `raw` is the
  RFC 5322 message when the carrier gives it, which is best. `auth` is the
  carrier's own SPF, DKIM and DMARC results. The handler resolves when the
  server has taken the email; until then the adapter must not acknowledge it
  to the carrier.
- **`status(carrierId)`** asks for a sent email's delivery outcome.

An adapter must not change the bytes of the envelope part or of any file part,
and must pass through every attachment with the envelope's media type.

## The additions

The spec's interface has no place for three things a real server needs, so
this implementation adds them as optional members:

- **`webhook(req)`.** Carriers with webhooks call one HTTP endpoint. The
  server's listener routes `POST /webhooks/<name>` to the adapter, with the
  raw body. The adapter checks the carrier's own signature first (§7.2 step 1)
  and answers `401` when it fails.
- **`onStatus(handler)`.** Carriers report bounces and deferrals by webhook,
  not only by returning a delivery status notification to the mailbox. This is
  the push form of `status()`.
- **`text` and `html` on `InboundMail`.** A carrier that gives no raw message
  must still give the human part. Without it, neither the person-view check of
  §3.3 nor the third check of the carrier test can run.

## The adapters

| Adapter | Inbound | Outbound | Status | Raw message | Auth results |
|---|---|---|---|---|---|
| `imap-smtp` (built in) | IMAP IDLE, or polling | SMTP submission | delivery status notifications in the mailbox | yes | from `Authentication-Results`, trusted by authserv-id |
| `resend` | `email.received` webhook, or polling | `POST /emails` | `GET /emails/{id}`, webhooks | `raw.download_url` | yes (one DKIM result, no domain) |
| `agentmail` | `message.received` webhook, or polling | `POST /v0/inboxes/{inbox}/messages/send` | webhooks | `GET .../raw` | yes, with the DKIM domain |
| `cloudflare` | the Worker's `email()` handler posts the raw message | the Worker's `send_email` binding, with raw MIME; or the REST API without file parts | the send result | yes | not given to Workers |
| `primitive` | `email.received` webhook, or polling `GET /v1/emails` | `POST /v1/send-mail` | `GET /v1/sent-emails/{id}`, webhooks | inline, or `GET /v1/emails/{id}/raw` | yes, each DKIM signature with its alignment |
| `loopback` | in process | in process | in process | yes | set by the test |

Notes on particular carriers:

- **IMAP.** Mail is fetched with `BODY.PEEK[]`, so fetching does not mark it
  read. It is marked `\Seen` only after the server has taken it, so mail the
  server could not take is fetched again. The adapter signs in with a password
  (`AUTHENTICATE PLAIN` or `LOGIN`) or an OAuth token (`XOAUTH2`); for a Google
  Workspace mailbox, a service account with domain-wide delegation and the
  `https://mail.google.com/` scope can act as the mailbox.
- **SMTP.** Implicit TLS on 465 or STARTTLS on 587, with `AUTH PLAIN`, `LOGIN`
  or `XOAUTH2`. SMTP says nothing after the hand-over, so `status()` answers
  `unknown`; bounces come back to the mailbox and the server reads them.
- **Authentication results over IMAP** come from the `Authentication-Results`
  header the receiving server adds. Anyone can write that header into the mail
  they send, so only headers whose authserv-id is in `trustedAuthservIds` count
  (for Gmail, `mx.google.com`).
- **Resend.** A send-only API key can send, but cannot read an email's status
  or `Message-ID` back. Threading then rests on what the receiver records, and
  bounces arrive by webhook, matched by Resend's own email id. Resend reports
  one DKIM result without its domain; the adapter counts a DKIM pass with a
  DMARC pass as aligned.
- **AgentMail.** The sender is the inbox. The adapter threads with
  `In-Reply-To` and `References` in the headers map and never uses the reply
  endpoint, because that endpoint writes its own subject and the subject is
  signed (§3.3). AgentMail's documentation does not say whether `/send`
  honours those headers. A whole request is limited to 6 MB.
- **Cloudflare.** The example Worker in `examples/cloudflare-worker/` carries
  both directions, signed with a secret it shares with the server. Raw MIME
  keeps every `Content-ID`, which `cid:` file parts need. Cloudflare's REST API
  documents no `Content-ID` for attachments, so in REST mode an email with
  file parts is refused rather than sent broken.
- **Primitive.** Only `Auto-Submitted`, `X-Auto-Response-Suppress` and
  `Precedence` may be set. The adapter drops the hint headers of §3.5 and uses
  Primitive's own `in_reply_to` and `references` fields. Everything the agent
  acts on is in the envelope, so nothing is lost. A new Primitive account may
  only answer addresses that wrote to it first, so in a first exchange the
  other side asks first. The adapter answers with `POST /v1/send-mail`, never
  the reply endpoint, which writes its own subject.

## Writing an adapter

1. Implement the four operations, and `webhook` if the carrier pushes by
   webhook. Check the carrier's signature before anything else.
2. Give the raw message when the carrier can. Otherwise rebuild what you can:
   the headers, `text`, `html`, and every attachment's bytes, content type,
   file name and `Content-ID`.
3. Use the carrier's stable event id as `carrierEventId`.
4. Test it with `carrierTest()` (Agent Emailing §12.3): send
   `fixtureAsOutbound(01-request.eml)` through the adapter, receive it, and
   check that the envelope, `agenda.txt` and the text part arrive unchanged.
   `test/providers.test.mjs` shows the pattern with mocked APIs.
