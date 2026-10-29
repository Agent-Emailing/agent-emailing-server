# Changes and releases

This repository is the home of the Agent Emailing Server: the library, the
server, the carrier adapters, and their tests.

A few files are copies of material published with the specifications:
`conformance/cases.json`, `conformance/cards.json` and `conformance/fixtures/`
(Agent Emailing), and `conformance/inbound-protections.json` and
`conformance/canonical-json.json` (Agent Messaging). They change where the
specifications are written, and arrive here as a pull request that updates
them. When they change, the implementation follows them: the fixtures are the
authority.

## A change

1. Open a pull request. CI (`.github/workflows/ci.yml`) runs the secret check,
   the typecheck and build, the unit tests, and the 19 conformance cases
   against the library and against the server.
2. Merge it when CI is green.

## A release

1. Raise `version` in `package.json` in a pull request, and say what the
   release holds.
2. When it is merged and CI is green, tag that commit `v<version>` and push
   the tag.

## Live checks

The tests never reach a real provider. Two scripts in `tools/` do, and are run
by hand with the credentials in the environment:

- `tools/live-resend-imap.mjs` sends through Resend and reads the mailbox back,
  then runs the carrier test of §12.3 and the receiver on what arrived.
- `tools/live-agentmail.mjs` makes a test AgentMail inbox, runs a signed request
  and respond with files between it and an agent on another carrier, runs the
  carrier test inside AgentMail, and deletes the inbox.
- `tools/live-primitive.mjs` does the same through a Primitive address, with
  the other side asking first, and records which headers went to Primitive.
- `tools/interop.mjs` (`npm run interop`) runs the quote exchange, the carrier
  test and a forged quote on every lane between AgentMail, Primitive and Resend,
  and writes `docs/interop-<date>.md` and `.json`. Run it on demand.
- `tools/live-handshake.mjs` checks the IMAP and SMTP clients' TLS, STARTTLS
  and sign-in handling against a real mail service, without sending mail.

Send only from addresses you own, and only to mailboxes you own.
