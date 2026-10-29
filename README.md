# Agent Emailing Server

The Agent Emailing Server lets an AI agent send and receive signed requests
and answers through ordinary email. It is the reference implementation of
[Agent Emailing](https://agentemailing.ai), an open standard for carrying a
signed [Agent Messaging](https://agentmessaging.ai) envelope inside an email.

An agent with a key and a mailbox can ask another agent for something, and
get a signed answer back, through any email provider. The envelope travels as
an attachment. The receiving agent checks its signature exactly as it would on
a message broker. The email provider is only the pipe.

The server is free and open source under the Apache License 2.0. Its
development is sponsored by [AgentMesh](https://agentmesh.ai).

## What it does

- **Builds agent email** from a signed envelope, as §3 of the standard says:
  the readable text first, then the envelope part, then each attached file,
  which the envelope names by `cid:` with its size and SHA-256. The text and
  the subject are generated from the envelope, never written by hand, and
  their digest is signed in the envelope.
- **Checks incoming email** in the standard's order (§7.2), and gives two
  verdicts. For the agent: deliver, hold or refuse, with the reason. For
  software that shows the email to a person: the text matches, differs, or
  cannot be trusted, with each check.
- **Runs as one agent's email runtime.** It watches the agent's mailbox, hands
  each verified envelope to the agent, and sends the agent's answers in the
  same thread, signed, with the task's state in the subject.
- **Protects the agent.** Duplicates are refused for the whole 7-day mailbox
  window, across restarts. Stale, forwarded and tampered email is refused
  silently. Senders the agent does not know are held for the owner. Plain mail
  from strangers becomes a held attempt that records who wrote, never what
  they wrote. Sender text is framed before a model sees it.
- **Never answers what it must not.** No answer to automatic mail, bounces, or
  plain mail. No answer to an address it has not verified. A cap on email to
  any one address, and never to itself.
- **Turns bounces into delivery failures** the agent is told about.
- **Bridged mode.** With an aligned DMARC pass, a person who writes plain email
  gets a lasting identity that the server signs for, marked as bridged.
- **Works with any mailbox** through its own IMAP and SMTP clients, and with
  Resend, AgentMail, Cloudflare Email and Primitive through small adapters.

It does not claim to implement Agent Messaging: email is not a broker, and the
standard says why (§2.3).

## Quick start

You need Node.js 22 or later, a mailbox for the agent, and its IMAP and SMTP
settings.

```sh
git clone https://github.com/Agent-Emailing/agent-emailing-server.git
cd agent-emailing-server
npm install
npm run build

# The agent's key. Keep the seed file secret.
mkdir -p state
node dist/server/cli.js keygen --out state/agent.seed

# A small agent that answers every request with what it was asked.
AGENT_TOKEN=change-me node examples/echo-agent.mjs &

# The server. Copy the example config and fill in your mailbox.
cp examples/config.imap-smtp.json config.json
MAILBOX_PASSWORD=... AGENT_TOKEN=change-me SERVER_TOKEN=change-me-too \
  node dist/server/cli.js serve --config config.json
```

To check one email the way a mail program would:

```sh
node dist/server/cli.js check message.eml --cards cards.json [--as <agent id>]
```

To run the server inside your own program instead:

```js
import { AgentEmailServer, agentKeyFromSeed } from "agent-emailing-server";
import { ImapSmtpCarrier } from "agent-emailing-server/providers/imap-smtp";

const server = new AgentEmailServer({
  agent: { key: agentKeyFromSeed(process.env.AGENT_SEED), address: "agent@example.org", handle: "Assistant.ana@example.org" },
  carrier: new ImapSmtpCarrier({ imap: { /* ... */ }, smtp: { /* ... */ } }),
  stateDir: "state",
  deliver: async (d) => {
    if (d.kind === "request") return { status: "completed", text: "Done." };
  },
});
await server.start();
```

## Configuration

The config file is JSON. Secrets are never in it: each is named by the
environment variable that holds it (a field ending in `Env`), or by a file
(a field ending in `File`).

| Field | What it is |
|---|---|
| `agent.seedFile` or `agent.seedEnv` | The agent's seed. |
| `agent.address` | The agent's mailbox. Publish it as the `email` endpoint on its name card (§5.1). |
| `agent.handle`, `agent.actsFor`, `agent.name` | What the human part says about the agent. |
| `agent.offerings` | Offering names by id, for the human part and the subject. |
| `agent.timeZone` | The time zone the human part uses for times. |
| `carrier` | The carrier and its settings: `imap-smtp`, `resend`, `agentmail`, `cloudflare` or `primitive`. See the examples. |
| `agentInterface.url`, `.tokenEnv` | HTTP mode: where deliveries are POSTed, and the bearer token sent with them. |
| `http.host`, `.port`, `.tokenEnv` | The server's own HTTP API and webhook listener. |
| `stateDir` | Where the server keeps its duplicate memory, tasks, held mail and records. |
| `roster` | EXT-6 admission: `contacts`, explicit `entries`, and `defaults` by tier. |
| `registrar.url`, `.keySet` | A Personal Agent Naming registrar, to find senders' name cards. Pin its key set. |
| `cardsFile` | Signed name cards held locally. |
| `peers` | Agents whose addresses the operator has verified, for agents with no name card. |
| `bridge.enabled`, `.offering` | Bridged mode, and the offering plain email is asked on. |
| `strangers` | `knock` (the default) records plain mail from strangers as held attempts; `drop` discards it. |
| `trustedAuthservIds` | Whose `Authentication-Results` headers to believe (for Gmail, `mx.google.com`). |
| `limits` | `perAddressPerHour` (default 120), `updatesPerTask` (50), `maxInboundBytes` (25 MB). |

## The agent interface

The agent gets a callback, or an HTTP POST, for each admitted email: the
verified envelope, a copy of its payload with the sender's text framed, the
verified files, who sent it and how much standing it has, and where its task
stands. The agent answers with a status and a result; the server builds,
signs, threads and sends the respond. The server's HTTP API also lets the
agent send requests, and lets the owner allow or block held senders.

[docs/agent-interface.md](docs/agent-interface.md) has the details.

## The provider interface

Each carrier sits behind a small adapter with the four operations of §11.4:
`capabilities`, `send`, `receive` and `status`. This implementation adds three
optional members the spec's interface lacks: a webhook entry point, pushed
status events, and the text of an email whose carrier gives no raw message.

[docs/provider-interface.md](docs/provider-interface.md) has the contract,
notes on each carrier, and how to write and test a new adapter.

## Providers

| Provider | Built | Tested against | Proven live |
|---|---|---|---|
| IMAP and SMTP (built in) | yes | fake IMAP and SMTP servers on localhost, with the conformance fixtures | TLS, STARTTLS, greeting, capabilities and sign-in refusals against Gmail. A signed-in IMAP round trip was not run: the test mailbox's credentials do not allow IMAP. |
| Resend | yes | mocked API in its documented shapes | Sending: the carrier test of §12.3 and a fresh signed request, through Resend to a real mailbox, both passing; and the signed respond of the AgentMail run. Inbound and status were not run live: the key used can only send. |
| AgentMail | yes | mocked API in its documented shapes | A signed request with a file, sent from a test AgentMail inbox through the adapter, and the signed respond with a file received back into it: raw message fetched, both files verified against their signed digests. The carrier test of §12.3 inside AgentMail, from the inbox to itself, passing. Inbound was read by polling; webhooks were not run live. |
| Cloudflare Email | yes, with an example Worker | mocked Worker, using the Worker's own signing code | no |
| Primitive | yes | mocked API in its documented shapes, refusing every header but its three | A signed request with a file, from the test-rig mailbox through Resend to a Primitive address, and the signed respond with a file sent back through the adapter: raw message fetched, both files verified against their signed digests, and only `Auto-Submitted` sent to Primitive. The carrier test of §12.3 between two Primitive addresses, passing. Inbound was read by polling; webhooks were not run live. |

Across providers, `npm run interop` (tools/interop.mjs) runs a quote request
as four emails in one thread on every lane between AgentMail, Primitive and
Resend, with the carrier test and a forged quote on each. The results of the
last run are in [docs/interop-2026-10-29.md](docs/interop-2026-10-29.md): every
lane that could run passed every check; the two lanes into Resend could not run,
because the Resend key can only send.

Primitive accepts only three custom headers on outbound mail:
`Auto-Submitted`, `X-Auto-Response-Suppress` and `Precedence`. Its test sends a
full agent email with the hint headers dropped, and the receiving side still
delivers it whole, with its file verified and its text matching. The live run
showed the same on real mail. Everything an agent acts on is in the envelope.

## Conformance

The standard's conformance folder has 19 cases over 17 email fixtures, every
envelope really signed with published test keys. `conformance/run.mjs` runs
every case twice: once against the library's receiver, and once against a
running server on a loopback carrier, where "reply" means the server really
sent an answer, and every answer it sends must itself verify, name the request
it answers, and pass the person-view check.

```sh
npm run conformance
```

| Case | Fixture | What it checks | Library | Server |
|---|---|---|---|---|
| e01 | 01-request.eml | A request with a file: delivered, file verified, answered, text matches | pass | pass |
| e02 | 02-respond-input.eml | A respond that needs input, correlated to its request | pass | pass |
| e03 | 03-request-answer.eml | The answer, continuing the task | pass | pass |
| e04 | 04-respond-done.eml | The respond that finishes the task, with a returned file | pass | pass |
| e05 | 05-forwarded.eml | A forwarded email, refused as misaddressed | pass | pass |
| e06 | 06-stale.eml | An envelope older than the 7-day mailbox window | pass | pass |
| e07 | 07-tampered.eml | A changed envelope, refused with IDENTITY_MISMATCH | pass | pass |
| e08 | 08-hint-mismatch.eml | Hint headers that disagree with the envelope | pass | pass |
| e09 | 09-file-digest.eml | A file whose digest does not match | pass | pass |
| e10 | 10-two-envelopes.eml | Two envelope parts, refused | pass | pass |
| e11 | 11-auto-reply.eml | An automatic reply, never answered | pass | pass |
| e12 | 12-stranger.eml | Plain mail from a stranger, never reaching the agent | pass | pass |
| e13 | 13-reencoded.eml | An envelope re-encoded by a carrier, still valid | pass | pass |
| e14 | 01-request.eml | The same email twice, refused as a duplicate | pass | pass |
| e15 | 14-bounce.eml | A bounce, matched to its request as undeliverable | pass | pass |
| e16 | 15-bridged-plain.eml | A bridged sender with an aligned DMARC pass | pass | pass |
| e17 | 15-bridged-plain.eml | The same sender without one | pass | pass |
| e18 | 16-text-mismatch.eml | A text that disagrees with its envelope: the agent acts, a person is warned | pass | pass |
| e19 | 17-forged.eml | A forgery: signature, sender and text all fail | pass | pass |

The unit tests also check the shared parts against Agent Messaging's own
fixtures: canonical JSON, and every vector of the receiver protections
(freshness to the millisecond, addressing, the size cap in UTF-16 code units,
and the frame around sender text, byte for byte). They check that this
implementation's envelopes and those of the `agent-messaging` SDK verify each
other, and that every fixture's text is reproduced digest for digest.

```sh
npm test
```

## Choices the standard leaves open

Where the standard does not decide, this implementation chooses, and says so:

- **The duplicate memory** must persist for the 7-day window and must also be
  bounded. It keeps up to 200,000 pairs, drops entries the freshness window
  already refuses, and raises a local signal if a flood ever forces it to
  forget an entry inside the window.
- **Bridged mode** asks a plain email on the offering named in
  `bridge.offering` (default `message`), with the body as `text` and the
  subject as `subject`. The envelope id is derived from the email's
  `Message-ID`, so a redelivered email is caught as a duplicate.
- **Task updates.** Over email a performer often sends no `working` update. A
  move that Agent Messaging §7.3 allows by way of `working`, such as
  `input_required` to `completed`, is accepted as that two-step move. The
  first update a party sees opens its record.
- **Knocks** are recorded and never answered by email, so every outcome looks
  the same to the sender.
- **An attached email** (`message/rfc822`) is another email. The server does
  not look for an envelope inside it.

## Dependencies

None at run time. The library, the server, the MIME reader and writer, the
IMAP and SMTP clients and the vendor adapters use only Node.js itself. The
development dependencies are TypeScript, Node's type definitions, and the
`agent-messaging` SDK, which the tests use to show that both implementations
sign and verify the same envelopes.

## Security

Report a security problem privately: see [SECURITY.md](SECURITY.md).

The server holds the agent's signing key. Keep the seed file readable only by
the server, and the state directory too: it holds bridged identities' keys.
The HTTP API binds to 127.0.0.1 by default and needs a bearer token.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
