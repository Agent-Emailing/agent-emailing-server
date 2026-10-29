# The agent interface

The server is one agent's email runtime. It holds the agent's key, reads the
agent's mailbox, and checks every email. The agent itself is code you write.
It meets the server in one of two ways:

- **Callback.** Your code runs the server in its own process and passes
  `deliver`, a function the server calls for every admitted email.
- **HTTP.** The server runs on its own and POSTs every admitted email to a URL
  you give (`agentInterface.url`). Your agent calls the server's own HTTP API
  to answer later, to send requests, and to decide on held senders.

Either way, the agent sees only verified envelopes. It never sees the email's
text, its subject, or mail that failed a check.

## What the server hands the agent

One JSON object per email, called a delivery:

```json
{
  "kind": "request",
  "envelope": { "v": "0.3.0", "id": "019a...", "type": "request", "from": "UBMB...", "payload": { "offering": "book-meeting", "text": "Please book 30 minutes..." }, "sig": "..." },
  "payload": { "offering": "book-meeting", "text": "=== agentmesh message ===...\n--- BEGIN SENDER MESSAGE ---\nPlease book 30 minutes...\n--- END SENDER MESSAGE ---" },
  "files": [{ "name": "agenda.txt", "media_type": "text/plain", "size": 284, "digest": "sha256:c411...", "status": "verified", "content_base64": "QWdlbmRh..." }],
  "sender": { "agent_id": "UBMB...", "mode": "native", "tier": "contact", "handle": "Scheduler.ana@example.org", "operator": "Ana Lima" },
  "can_respond": true,
  "task": { "task_id": "019a...", "state": "working", "applied": true },
  "received_at": "2026-10-29T16:25:00.000Z"
}
```

- `kind` is `request`, `respond`, or `delivery_report` (a bounce or a deferral
  of an email the agent sent).
- `envelope` is the signed envelope, exactly as it arrived. Its signature has
  been checked, and so have its age, its addressee, its size and its sender's
  standing.
- `payload` is a copy of the envelope's payload with the sender's text framed,
  as Agent Messaging §22.6 says. **Give this to a model, never the raw
  `envelope.payload.text`.** The frame tells the model which words a stranger
  wrote.
- `files` lists every file the envelope refers to. `status` is `verified` (its
  size and SHA-256 match the signed entry, and `content_base64` holds it),
  `digest_mismatch`, or `unresolvable`. A file that does not match is never
  given to the agent. Files are not safe because their digests match: do not
  run them.
- `sender.tier` is the sender's EXT-6 tier: `rostered`, `contact`,
  `registered`, `bridged` or `anonymous`. `sender.mode` is `bridged` when the
  sender wrote plain email and the server's bridge signed for it; then
  `sender.address` is the address it wrote from.
- `can_respond` is false when there is no verified address to answer
  (Agent Emailing §5.3). An answer to such a request is refused.
- `task` says where the task stands, for a request that continues one and for
  every respond.

A `delivery_report` looks like this:

```json
{ "kind": "delivery_report", "report": { "request_id": "019a...", "outcome": "undeliverable", "status": "5.1.1" }, "received_at": "..." }
```

## Answering

Answer in the reply to the delivery, or later. An answer is the respond's
content; the server builds the envelope, signs it, writes the human part and
the subject, threads it, and sends it to the verified address.

```json
{
  "status": "completed",
  "text": "Booked: Tuesday 3 November, 10:00 to 10:30 Mountain time.",
  "output": { "confirmation": "BK-4471" },
  "files": [{ "name": "invite.ics", "media_type": "text/calendar", "content_base64": "QkVHSU46VkNBTEVOREFS..." }]
}
```

- `status` is a task state: `submitted`, `working`, `input_required`,
  `auth_required`, `completed`, `failed`, `canceled`, `rejected` or
  `exhausted`. Over email every answer is in task mode: the first one opens a
  task, and later ones update it. A finished task is never reopened.
- `problems` says what is needed when the status is `input_required`:
  `[{ "input": "slot", "problem": "missing", "description": "Choose one of the two times." }]`.
- `error` (`{ "code", "message" }`) goes with `failed`.

**In callback mode**, return the answer from `deliver`, or return nothing and
call `server.respond(requestId, answer)` later.

**In HTTP mode**, reply `200` with `{"respond": {...}}` to answer at once, or
`202` or `204` to answer later with `POST /v1/respond`. Any other status, or no
reply within 30 seconds, means the agent did not take the delivery. The server
keeps it and tries again every 30 seconds for up to 7 days, because the
envelope is already in its duplicate memory and a carrier's own redelivery
would be refused.

## The server's HTTP API

Every `/v1` route needs `Authorization: Bearer <token>`, the token named by
`http.tokenEnv`. The listener binds to 127.0.0.1 unless `http.host` says
otherwise.

| Route | What it does |
|---|---|
| `GET /healthz` | Says the server is up. No token. |
| `POST /webhooks/<carrier>` | Where a carrier's webhooks arrive. No token: the adapter checks the carrier's own signature. |
| `POST /v1/respond` | Answer a request: the answer above, plus `in_reply_to`, the request's envelope id. |
| `POST /v1/request` | Send a request (below). |
| `GET /v1/held` | Who is waiting: held senders, knocks and plain email from strangers. It says who, how often and when, never what they said. |
| `POST /v1/held/<sender>` | `{"stance":"allow"}` or `{"stance":"block"}`. Allowing a sender releases its held mail to the agent. |
| `GET /v1/tasks`, `GET /v1/tasks/<id>` | The agent's task records, with each update and whether it was applied. |
| `GET /v1/outcomes` | Bounces and deferrals of email the agent sent. |
| `GET /v1/signals` | Recent local signals: refusals and anything else an operator should see. |

### Sending a request

```json
{
  "to": "UAIUKGBIXQ3USXOYJQIFRNAPXT7SJSFODBHGBALIR4KDVVSVCLOY7LQF",
  "offering": "book-meeting",
  "offering_name": "Book a meeting",
  "text": "Please book 30 minutes with Ana Lima next week.",
  "input": { "duration_minutes": 30 },
  "files": [{ "name": "agenda.txt", "media_type": "text/plain", "content_base64": "..." }],
  "budget": { "deadline": "2026-10-30T17:00:00Z", "revision": 0, "cost_ceiling": { "amount_micro": 2000000, "currency": "USD" } }
}
```

`to` is an agent ID. The server finds the address on the agent's verified name
card, or in the operator's `peers` list. It never builds an address from a
handle (Agent Emailing §5.2), and it refuses a request with no verified
address.

To answer an agent that asked for more input, send a request with the same
`task_id`. To cancel, send `"offering": "task.cancel"` with the `task_id`.

## Held senders

A sender the agent does not know is not delivered. By EXT-6's defaults, a
contact is allowed, a sender with a verified identity but unknown is held, a
bridged sender is held, and a sender with no verified identity is refused.
Held mail waits, unread and with its files unopened, until the owner allows or
blocks the sender. A knock and a plain email from a stranger are recorded as
held attempts with no content at all.
