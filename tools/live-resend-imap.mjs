#!/usr/bin/env node
// A live run: Resend carries agent email to a real mailbox, and the mailbox is
// read back.
//
//   RESEND_API_KEY=...  MAILBOX_SA_JSON='{...}'  node tools/live-resend-imap.mjs \
//     --from agent-emailing-test@example.org --to mailbox+label@example.org --mailbox mailbox@example.org \
//     [--reader imap|gmail-api] [--read-only --since <time>]
//
// It sends two emails through Resend:
//   1. 01-request.eml rebuilt through Resend's API: the carrier test of
//      Agent Emailing §12.3;
//   2. a fresh request signed now with a new key, so freshness, the mailbox's
//      own DKIM and DMARC results (§5.3, §6.4) and the person-view check run
//      on real mail.
// Then it reads both back and runs the carrier test and the receiver on what
// arrived. It reads the mailbox one of two ways, with a Google service account
// that may act as the mailbox:
//   --reader imap       the built-in IMAP client, XOAUTH2 (needs the
//                       https://mail.google.com/ scope)
//   --reader gmail-api  the Gmail API's raw format (gmail.readonly is enough)
// Either way it never marks anything read. With --read-only it sends nothing
// and checks what an earlier run sent. Secrets come from the environment and
// are never printed.
import { readFileSync } from "node:fs";
import {
  carrierTest, fixtureAsOutbound, composeAgentEmail, createAgentKey, agentKeyFromSeed, uuid7, traceFor,
  receiveEmail, personView, DuplicateMemory, parseMail, leaves,
} from "../dist/index.js";
import { ResendCarrier } from "../dist/providers/resend.js";
import { ImapClient } from "../dist/providers/imap.js";
import { googleAccessToken } from "../dist/providers/google-auth.js";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const FROM = arg("from"), TO = arg("to"), MAILBOX = arg("mailbox");
if (!FROM || !TO || !MAILBOX) { console.error("needs --from, --to and --mailbox"); process.exit(2); }
const READ_ONLY = process.argv.includes("--read-only");
for (const v of READ_ONLY ? ["MAILBOX_SA_JSON"] : ["RESEND_API_KEY", "MAILBOX_SA_JSON"]) if (!process.env[v]) { console.error(`${v} is not set`); process.exit(2); }

const CASES = JSON.parse(readFileSync(new URL("../conformance/cases.json", import.meta.url), "utf8"));
const FIXTURE = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
const log = (s) => console.log(`${new Date().toISOString()}  ${s}`);
const results = {};
const responder = agentKeyFromSeed(CASES.identities.responder_seed);
const SINCE = new Date(arg("since") ?? Date.now() - 60_000);
let freshId;

if (!READ_ONLY) {
  const resend = new ResendCarrier({ apiKey: process.env.RESEND_API_KEY });
  // 1. The carrier test.
  const sent1 = await resend.send(fixtureAsOutbound(FIXTURE, `Agent Emailing carrier test <${FROM}>`, TO));
  log(`sent 01-request.eml through Resend: id ${sent1.carrierId}`);
  // 2. A fresh request, signed now.
  const requester = createAgentKey();
  const env = {
    v: "0.3.0", id: uuid7(), type: "request", ts: new Date().toISOString(), from: requester.id, to: responder.id, trace: traceFor(), context_id: uuid7(),
    payload: { offering: "echo", text: "A live test of Agent Emailing through Resend and IMAP." },
  };
  const { mail } = composeAgentEmail({
    envelope: env, key: requester,
    human: { sender: { handle: requester.id }, receiver: { handle: responder.id }, offeringName: "Echo" },
    from: { name: "Agent Emailing live test", address: FROM }, to: [{ address: TO }],
  });
  const sent2 = await resend.send(mail);
  freshId = env.id;
  log(`sent a fresh signed request through Resend: id ${sent2.carrierId}, envelope ${env.id}`);
  for (const s of [sent1, sent2]) {
    try { log(`Resend status of ${s.carrierId}: ${JSON.stringify(await resend.status(s.carrierId))}`); }
    catch (e) { log(`Resend status of ${s.carrierId}: this key may not read it (HTTP ${e.status})`); }
  }
}

// Read the mailbox. Emails are told apart by their envelopes, never by
// Message-ID (Agent Emailing §3.6).
const READER = arg("reader") ?? "imap";
let imap;
if (READER === "imap") {
  const token = () => googleAccessToken(process.env.MAILBOX_SA_JSON, MAILBOX, "https://mail.google.com/");
  imap = new ImapClient({ host: "imap.gmail.com", port: 993, security: "tls", user: MAILBOX, accessToken: token });
  await imap.connect();
  log(`IMAP: signed in to ${MAILBOX} with XOAUTH2`);
}

async function listImap() {
  const out = [];
  const day = SINCE.toUTCString().slice(5, 16).replace(/ /g, "-");
  for (const box of ["INBOX", "[Gmail]/Spam"]) {
    await imap.select(box);
    for (const uid of await imap.uidSearch(`SINCE ${day} TO "${TO}"`)) out.push({ box, raw: await imap.uidFetchRaw(uid) });
  }
  return out;
}

async function listGmailApi() {
  const token = await googleAccessToken(process.env.MAILBOX_SA_JSON, MAILBOX, "https://www.googleapis.com/auth/gmail.readonly");
  const H = { authorization: `Bearer ${token}` };
  const q = encodeURIComponent(`to:${TO} after:${Math.floor(SINCE.getTime() / 1000) - 60}`);
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?includeSpamTrash=true&maxResults=50&q=${q}`, { headers: H }).then((r) => r.json());
  const out = [];
  for (const { id } of list.messages ?? []) {
    const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`, { headers: H }).then((r) => r.json());
    if (Number(m.internalDate) < SINCE.getTime() - 60_000) continue;
    const labels = m.labelIds ?? [];
    out.push({ box: labels.includes("SPAM") ? "Spam" : labels.includes("INBOX") ? "INBOX" : labels.join(","), raw: Buffer.from(m.raw, "base64url") });
  }
  return out;
}

function envelopeOf(raw) {
  const part = leaves(parseMail(raw)).find((p) => p.type === "application/vnd.agentmessaging.envelope+json");
  try { return part ? JSON.parse(part.bytes.toString("utf8")) : undefined; } catch { return undefined; }
}

let carrierMail, freshMail;
const deadline = Date.now() + 240_000;
while (Date.now() < deadline && !(carrierMail && freshMail)) {
  for (const m of READER === "imap" ? await listImap() : await listGmailApi()) {
    const e = envelopeOf(m.raw);
    if (!e) continue;
    if (e.id === CASES.envelopes.request.envelope.id) carrierMail ??= m;
    else if (e.payload?.offering === "echo" && (!freshId || e.id === freshId)) freshMail ??= m;
  }
  if (!(carrierMail && freshMail)) await new Promise((r) => setTimeout(r, 10_000));
}
await imap?.logout();

if (carrierMail) {
  log(`the carrier test email arrived in ${carrierMail.box}, ${carrierMail.raw.length} bytes, read without marking it seen`);
  const ct = carrierTest(carrierMail.raw, CASES);
  results.carrier_test = ct;
  log(`carrier test (§12.3): ${ct.pass ? "PASS" : "FAIL"}; envelope ${ct.envelope}, agenda.txt ${ct.file}, text digest ${ct.text}${ct.details.length ? `; ${ct.details.join("; ")}` : ""}`);
} else log("the carrier test email did not arrive");

if (freshMail) {
  log(`the fresh request arrived in ${freshMail.box}, ${freshMail.raw.length} bytes`);
  const e = envelopeOf(freshMail.raw);
  // Judge freshness at the time it arrived, so a later --read-only run gives the same answer.
  const v = await receiveEmail(freshMail.raw, { self: responder.id, memory: new DuplicateMemory(), roster: { contacts: [e.from] }, trustedAuthservIds: ["mx.google.com"] }, { now: new Date(Math.min(Date.now(), Date.parse(e.ts) + 60_000)) });
  const pv = await personView(freshMail.raw);
  results.fresh = { action: v.action, refusal: v.refusal, respondTo: v.respondTo, auth: v.auth, person: pv.verdict, signals: v.signals };
  log(`receiver: ${v.action}${v.refusal ? ` (${v.refusal})` : ""}; the mailbox's own results ${JSON.stringify(v.auth)}; respond address ${v.respondTo ? `${v.respondTo.address}, by ${v.respondTo.basis}` : "none"}; person view ${pv.verdict}`);
} else log("the fresh request did not arrive");

const ok = results.carrier_test?.pass && results.fresh?.action === "deliver" && results.fresh?.person === "matches";
log(ok ? "LIVE RUN PASSED" : "LIVE RUN FAILED");
process.exit(ok ? 0 : 1);
