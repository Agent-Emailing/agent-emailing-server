#!/usr/bin/env node
// A live run through Primitive: a signed request and respond, each with a
// file, between an agent on a Primitive address and an agent on another
// carrier, with Primitive allowing only its three custom headers.
//
//   PRIMITIVE_API_KEY=... RESEND_API_KEY=... MAILBOX_SA_JSON='{...}' node tools/live-primitive.mjs \
//     --domain <sub>.primitive.email --peer-address mailbox+label@example.org --peer-from-mailbox mailbox@example.org
//
// New Primitive accounts may only answer addresses that wrote to them first,
// so the other side asks first:
// - The requester's server is reached at --peer-address. It reads that mailbox
//   through the Gmail API's raw format and sends through Resend.
// - The performer's server runs on a new address on the Primitive domain,
//   through the Primitive adapter: it polls GET /v1/emails, fetches each raw
//   message, and answers with POST /v1/send-mail (never the reply endpoint,
//   which writes its own subject, and the subject is signed).
// - Each agent has a new key and a name card signed by a test registrar made
//   for this run (§5.1, §5.3).
// - Then the carrier test of §12.3 inside Primitive: 01-request.eml between
//   two addresses on the domain.
// Every send-mail request is recorded, to show which headers went to Primitive.
// Keys come from the environment and are never printed.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AgentEmailServer, StaticCardResolver, createAgentKey, createRegistrarKey, signCard, carrierTest, fixtureAsOutbound, sha256hex, parseMail,
} from "../dist/index.js";
import { PrimitiveCarrier } from "../dist/providers/primitive.js";
import { ResendCarrier } from "../dist/providers/resend.js";
import { googleAccessToken } from "../dist/providers/google-auth.js";

for (const v of ["PRIMITIVE_API_KEY", "RESEND_API_KEY", "MAILBOX_SA_JSON"]) if (!process.env[v]) { console.error(`${v} is not set`); process.exit(2); }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DOMAIN = arg("domain"), PEER = arg("peer-address"), PEER_MAILBOX = arg("peer-from-mailbox");
if (!DOMAIN || !PEER || !PEER_MAILBOX) { console.error("needs --domain, --peer-address and --peer-from-mailbox"); process.exit(2); }
const STATE = arg("state") ?? "state-live-primitive";
const KEY = process.env.PRIMITIVE_API_KEY;
const log = (s) => console.log(`${new Date().toISOString()}  ${s}`);
const CASES = JSON.parse(readFileSync(new URL("../conformance/cases.json", import.meta.url), "utf8"));
const FIXTURE = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 3000)); } return false; };

// Record what goes to Primitive's send-mail, and what comes back.
const sends = [];
const recordingFetch = async (url, init = {}) => {
  const r = await fetch(url, init);
  if (String(url).endsWith("/send-mail")) {
    const body = JSON.parse(init.body);
    const text = await r.clone().text();
    sends.push({ status: r.status, headers: Object.keys(body.headers ?? {}), in_reply_to: body.in_reply_to, attachments: body.attachments.map((a) => `${a.filename} (${a.content_type}${a.content_id ? ", cid" : ""})`), answer: text.slice(0, 300) });
  }
  return r;
};

/** The requester's carrier for this run: Gmail API reads, Resend sends. */
class GmailReadResendSend extends ResendCarrier {
  constructor(address, mailbox) { super({ apiKey: process.env.RESEND_API_KEY }); this.address = address; this.mailbox = mailbox; this.inbound = []; this.seen = new Set(); this.since = Date.now() - 60_000; }
  receive(h) { this.inbound.push(h); }
  async start() {
    const tick = async () => {
      try {
        const token = await googleAccessToken(process.env.MAILBOX_SA_JSON, this.mailbox, "https://www.googleapis.com/auth/gmail.readonly");
        const A = { authorization: `Bearer ${token}` };
        const q = encodeURIComponent(`to:${this.address} after:${Math.floor(this.since / 1000)}`);
        const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?includeSpamTrash=true&maxResults=20&q=${q}`, { headers: A }).then((r) => r.json());
        for (const { id } of list.messages ?? []) {
          if (this.seen.has(id)) continue;
          const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`, { headers: A }).then((r) => r.json());
          const raw = Buffer.from(m.raw, "base64url");
          this.seen.add(id);
          for (const h of this.inbound) await h({ carrierEventId: `gmail:${id}`, raw, headers: parseMail(raw).headers, attachments: [], receivedAt: new Date().toISOString() });
        }
      } catch (e) { log(`requester mailbox: ${e.message}`); }
    };
    this.timer = setInterval(() => void tick(), 5000);
  }
  async close() { clearInterval(this.timer); }
}

const results = {};
let servers = [];
const tag = randomBytes(4).toString("hex");
const ADDRESS = `ae-test-${tag}@${DOMAIN}`;
try {
  const reqKey = createAgentKey(), perfKey = createAgentKey();
  const reg = createRegistrarKey();
  const now = Date.now();
  const card = (key, handle, address) => signCard({
    handle, binding: "agent-key", endpoints: [{ protocol: "agentmesh", agent_id: key.id }, { protocol: "email", address }],
    registrar: "https://registrar.example.net", issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3600_000).toISOString(),
  }, reg);
  const cards = new StaticCardResolver({
    [reqKey.id]: card(reqKey, "Requester.live-test@example.org", PEER),
    [perfKey.id]: card(perfKey, "Performer.live-test@example.org", ADDRESS),
  }, [{ kid: reg.kid, key: reg.key, status: "current" }]);

  const invite = Buffer.from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//example.org//live test//EN\r\nEND:VCALENDAR\r\n");
  const agenda = Buffer.from("Agenda for the live test\n1. Check that this file arrives unchanged.\n");
  const seen = { performer: [], requester: [] };
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const rawSeen = [];
  const primCarrier = new PrimitiveCarrier({ apiKey: KEY, pollMs: 4000, address: ADDRESS, fetch: recordingFetch, log: (l) => log(`performer: ${l}`) });
  primCarrier.receive(async (m) => { rawSeen.push({ id: m.carrierEventId, raw: Boolean(m.raw), bytes: m.raw?.length, auth: m.auth }); });
  const performer = new AgentEmailServer({
    agent: { key: perfKey, address: ADDRESS, handle: "Performer.live-test@example.org", name: "Agent Emailing test performer", offerings: { "book-meeting": "Book a meeting" } },
    carrier: primCarrier, stateDir: join(STATE, "performer"), cards, roster: { contacts: [reqKey.id] },
    deliver: async (d) => {
      seen.performer.push(d);
      if (d.kind === "request") return { status: "completed", text: "Booked. The invitation is attached.", files: [{ name: "invite.ics", media_type: "text/calendar", bytes: invite }] };
    },
    log: (l) => log(`performer: ${l}`),
  });
  const requester = new AgentEmailServer({
    agent: { key: reqKey, address: PEER, handle: "Requester.live-test@example.org", name: "Agent Emailing test requester" },
    carrier: new GmailReadResendSend(PEER, PEER_MAILBOX), stateDir: join(STATE, "requester"), cards, roster: { contacts: [perfKey.id] },
    trustedAuthservIds: ["mx.google.com"],
    deliver: async (d) => { seen.requester.push(d); }, log: (l) => log(`requester: ${l}`),
  });
  servers = [performer, requester];
  await performer.start();
  await requester.start();

  const sent = await requester.request({
    to: perfKey.id, offering: "book-meeting", offering_name: "Book a meeting", text: "Please book 30 minutes next week. The agenda is attached.",
    files: [{ name: "agenda.txt", media_type: "text/plain", bytes: agenda }],
  });
  log(`requester sent request ${sent.envelope.id} through Resend to ${ADDRESS}`);

  const gotRequest = await until(() => seen.performer.some((d) => d.kind === "request"), 240_000);
  const req = seen.performer.find((d) => d.kind === "request");
  results.request = gotRequest ? {
    verified_sender: req.sender.handle, tier: req.sender.tier, can_respond: req.can_respond,
    file: req.files[0]?.status, file_digest_ok: Boolean(req.files[0]?.content_base64) && sha256hex(Buffer.from(req.files[0].content_base64, "base64")) === sha256hex(agenda),
    raw_fetched: rawSeen.some((x) => x.raw), primitive_auth: rawSeen[0]?.auth,
  } : undefined;
  log(`performer: ${gotRequest ? `request delivered through Primitive: ${JSON.stringify(results.request)}` : "the request did not arrive"}`);

  const gotRespond = await until(() => seen.requester.some((d) => d.kind === "respond"), 240_000);
  const resp = seen.requester.find((d) => d.kind === "respond");
  results.respond = gotRespond ? {
    correlates: resp.envelope.in_reply_to === sent.envelope.id, task_state: resp.task?.state, verified_sender: resp.sender.handle,
    file: resp.files[0]?.status, file_digest_ok: Boolean(resp.files[0]?.content_base64) && sha256hex(Buffer.from(resp.files[0].content_base64, "base64")) === sha256hex(invite),
  } : undefined;
  log(`requester: ${gotRespond ? `respond delivered from Primitive: ${JSON.stringify(results.respond)}` : "the respond did not arrive"}`);
  log(`what went to Primitive's send-mail: ${JSON.stringify(sends)}`);
  log(`signals: performer ${JSON.stringify(performer.signals.map((s) => s.text))}; requester ${JSON.stringify(requester.signals.map((s) => s.text))}`);
  for (const s of servers) await s.close();
  servers = [];

  // The carrier test inside Primitive: between two addresses on the domain.
  const other = `ae-test-${tag}-ct@${DOMAIN}`;
  const pc = new PrimitiveCarrier({ apiKey: KEY, fetch: recordingFetch });
  await pc.send(fixtureAsOutbound(FIXTURE, ADDRESS, other));
  log(`sent 01-request.eml from ${ADDRESS} to ${other}; send-mail answered ${sends[sends.length - 1]?.status}`);
  let arrived;
  const reader = new PrimitiveCarrier({ apiKey: KEY, pollMs: 4000, address: other, fetch: recordingFetch });
  reader.receive(async (m) => { const t = carrierTest(m, CASES); if (t.envelope || t.file) arrived ??= { raw: Boolean(m.raw), bytes: m.raw?.length, ...t }; });
  await reader.start();
  await until(() => Boolean(arrived), 180_000);
  await reader.close();
  results.carrier_test = arrived ?? "did not arrive";
  log(`carrier test (§12.3) inside Primitive: ${arrived ? `${arrived.pass ? "PASS" : "FAIL"}; raw ${arrived.raw} (${arrived.bytes} bytes); envelope ${arrived.envelope}, agenda.txt ${arrived.file}, text digest ${arrived.text}${arrived.details.length ? `; ${arrived.details.join("; ")}` : ""}` : "did not arrive"}`);
} catch (e) {
  log(`error: ${e.message}`);
  log(`what went to Primitive's send-mail: ${JSON.stringify(sends)}`);
  results.error = e.message;
} finally {
  for (const s of servers) await s.close().catch(() => {});
}
const headersOk = sends.length > 0 && sends.every((s) => s.headers.every((h) => ["auto-submitted", "x-auto-response-suppress", "precedence"].includes(h.toLowerCase())));
const ok = results.request?.file === "verified" && results.request?.file_digest_ok && results.request?.raw_fetched && results.respond?.correlates && results.respond?.file === "verified" && results.respond?.file_digest_ok && headersOk;
log(ok ? `ROUND TRIP PASSED, only allowed headers sent${results.carrier_test?.pass ? "; CARRIER TEST PASSED" : "; carrier test not passed"}` : "LIVE RUN FAILED");
process.exit(ok ? 0 : 1);
