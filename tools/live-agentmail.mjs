#!/usr/bin/env node
// A live run through AgentMail: a signed request and respond, each with a
// file, between an agent on an AgentMail inbox and an agent on another carrier.
//
//   AGENTMAIL_API_KEY=... RESEND_API_KEY=... MAILBOX_SA_JSON='{...}' node tools/live-agentmail.mjs \
//     --peer-address mailbox+label@example.org --peer-from-mailbox mailbox@example.org [--state <dir>]
//
// - The requester's server runs on one new AgentMail inbox, through the
//   AgentMail adapter: it sends the request, polls the inbox, fetches each raw
//   message, and checks the respond's file against its signed digest.
// - The performer's server is reached at --peer-address. It reads that mailbox
//   through the Gmail API's raw format (a service account that may act as
//   --peer-from-mailbox) and answers through Resend, from the same address.
// - Each agent has a new key and a name card signed by a test registrar made
//   for this run, listing its address as the email endpoint (§5.1), so each
//   side has a verified address to answer (§5.3).
// - Then the carrier test of §12.3 is tried inside AgentMail: 01-request.eml
//   from the inbox to itself.
// - The inbox is deleted at the end, whatever happened.
// Keys come from the environment and are never printed.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AgentEmailServer, StaticCardResolver, createAgentKey, createRegistrarKey, signCard, carrierTest, fixtureAsOutbound, sha256hex, parseMail,
} from "../dist/index.js";
import { AgentMailCarrier } from "../dist/providers/agentmail.js";
import { ResendCarrier } from "../dist/providers/resend.js";
import { googleAccessToken } from "../dist/providers/google-auth.js";

for (const v of ["AGENTMAIL_API_KEY", "RESEND_API_KEY", "MAILBOX_SA_JSON"]) if (!process.env[v]) { console.error(`${v} is not set`); process.exit(2); }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PEER = arg("peer-address"), PEER_MAILBOX = arg("peer-from-mailbox");
if (!PEER || !PEER_MAILBOX) { console.error("needs --peer-address and --peer-from-mailbox"); process.exit(2); }
const STATE = arg("state") ?? "state-live-agentmail";
const KEY = process.env.AGENTMAIL_API_KEY;
const BASE = "https://api.agentmail.to/v0";
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const log = (s) => console.log(`${new Date().toISOString()}  ${s}`);
const CASES = JSON.parse(readFileSync(new URL("../conformance/cases.json", import.meta.url), "utf8"));
const FIXTURE = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 3000)); } return false; };

/** The performer's carrier for this run: Gmail API reads, Resend sends. */
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
      } catch (e) { log(`performer mailbox: ${e.message}`); }
    };
    this.timer = setInterval(() => void tick(), 5000);
  }
  async close() { clearInterval(this.timer); }
}

let inbox;
const results = {};
let servers = [];
try {
  const username = `ae-test-${randomBytes(4).toString("hex")}`;
  const r = await fetch(`${BASE}/inboxes`, { method: "POST", headers: H, body: JSON.stringify({ username, display_name: "Agent Emailing test requester", client_id: username }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`creating an inbox: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  inbox = j.inbox_id;
  log(`created inbox ${inbox}`);

  const reqKey = createAgentKey(), perfKey = createAgentKey();
  const reg = createRegistrarKey();
  const now = Date.now();
  const card = (key, handle, address) => signCard({
    handle, binding: "agent-key", endpoints: [{ protocol: "agentmesh", agent_id: key.id }, { protocol: "email", address }],
    registrar: "https://registrar.example.net", issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3600_000).toISOString(),
  }, reg);
  const cards = new StaticCardResolver({
    [reqKey.id]: card(reqKey, "Requester.live-test@example.org", inbox),
    [perfKey.id]: card(perfKey, "Performer.live-test@example.org", PEER),
  }, [{ kid: reg.kid, key: reg.key, status: "current" }]);

  const invite = Buffer.from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//example.org//live test//EN\r\nEND:VCALENDAR\r\n");
  const agenda = Buffer.from("Agenda for the live test\n1. Check that this file arrives unchanged.\n");
  const seen = { performer: [], requester: [] };
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const rawSeen = [];
  const reqCarrier = new AgentMailCarrier({ apiKey: KEY, inboxId: inbox, pollMs: 4000, log: (l) => log(`requester: ${l}`) });
  reqCarrier.receive(async (m) => { rawSeen.push({ id: m.carrierEventId, raw: Boolean(m.raw), bytes: m.raw?.length }); });
  const requester = new AgentEmailServer({
    agent: { key: reqKey, address: inbox, handle: "Requester.live-test@example.org", name: "Agent Emailing test requester" },
    carrier: reqCarrier, stateDir: join(STATE, "requester"), cards, roster: { contacts: [perfKey.id] },
    deliver: async (d) => { seen.requester.push(d); }, log: (l) => log(`requester: ${l}`),
  });
  const performer = new AgentEmailServer({
    agent: { key: perfKey, address: PEER, handle: "Performer.live-test@example.org", name: "Agent Emailing test performer", offerings: { "book-meeting": "Book a meeting" } },
    carrier: new GmailReadResendSend(PEER, PEER_MAILBOX), stateDir: join(STATE, "performer"), cards, roster: { contacts: [reqKey.id] },
    trustedAuthservIds: ["mx.google.com"],
    deliver: async (d) => {
      seen.performer.push(d);
      if (d.kind === "request") return { status: "completed", text: "Booked. The invitation is attached.", files: [{ name: "invite.ics", media_type: "text/calendar", bytes: invite }] };
    },
    log: (l) => log(`performer: ${l}`),
  });
  servers = [requester, performer];
  await performer.start();
  await requester.start();

  const sent = await requester.request({
    to: perfKey.id, offering: "book-meeting", offering_name: "Book a meeting", text: "Please book 30 minutes next week. The agenda is attached.",
    files: [{ name: "agenda.txt", media_type: "text/plain", bytes: agenda }],
  });
  log(`requester sent request ${sent.envelope.id} through AgentMail (${sent.messageId})`);

  const gotRequest = await until(() => seen.performer.some((d) => d.kind === "request"), 240_000);
  const req = seen.performer.find((d) => d.kind === "request");
  results.request = gotRequest ? {
    verified_sender: req.sender.handle, tier: req.sender.tier, can_respond: req.can_respond,
    file: req.files[0]?.status, file_digest_ok: Boolean(req.files[0]?.content_base64) && sha256hex(Buffer.from(req.files[0].content_base64, "base64")) === sha256hex(agenda),
    fenced: /BEGIN SENDER MESSAGE/.test(req.payload.text),
  } : undefined;
  log(`performer: ${gotRequest ? `request delivered: ${JSON.stringify(results.request)}` : "the request did not arrive"}`);

  const gotRespond = await until(() => seen.requester.some((d) => d.kind === "respond"), 240_000);
  const resp = seen.requester.find((d) => d.kind === "respond");
  results.respond = gotRespond ? {
    correlates: resp.envelope.in_reply_to === sent.envelope.id, task_state: resp.task?.state, verified_sender: resp.sender.handle,
    file: resp.files[0]?.status, file_digest_ok: Boolean(resp.files[0]?.content_base64) && sha256hex(Buffer.from(resp.files[0].content_base64, "base64")) === sha256hex(invite),
    raw_fetched: rawSeen.filter((x) => x.raw).length > 0,
  } : undefined;
  log(`requester: ${gotRespond ? `respond delivered through AgentMail: ${JSON.stringify(results.respond)}` : "the respond did not arrive"}`);
  log(`requester: raw messages fetched from AgentMail: ${JSON.stringify(rawSeen)}`);
  for (const s of servers) await s.close();
  servers = [];

  // The carrier test inside AgentMail: from the inbox to itself.
  const am = new AgentMailCarrier({ apiKey: KEY, inboxId: inbox });
  const ctSent = await am.send(fixtureAsOutbound(FIXTURE, inbox, inbox));
  log(`sent 01-request.eml from ${inbox} to itself (${ctSent.messageId})`);
  let arrived;
  await until(async () => {
    const list = await fetch(`${BASE}/inboxes/${encodeURIComponent(inbox)}/messages?limit=30`, { headers: H }).then((x) => x.json());
    for (const m of list.messages ?? []) {
      if (!(m.labels ?? []).includes("received")) continue;
      const mail = await am.fetchInbound(m.message_id, "carrier-test");
      const t = carrierTest(mail, CASES);
      if (t.envelope || t.file) { arrived = { raw: Boolean(mail.raw), bytes: mail.raw?.length, ...t }; return true; }
    }
    return false;
  }, 120_000);
  results.carrier_test = arrived ?? "did not arrive as received mail";
  log(`carrier test (§12.3) inside AgentMail: ${arrived ? `${arrived.pass ? "PASS" : "FAIL"}; raw ${arrived.raw} (${arrived.bytes} bytes); envelope ${arrived.envelope}, agenda.txt ${arrived.file}, text digest ${arrived.text}${arrived.details.length ? `; ${arrived.details.join("; ")}` : ""}` : "a message sent to the same inbox did not arrive as received mail"}`);
} catch (e) {
  log(`error: ${e.message}`);
  results.error = e.message;
} finally {
  for (const s of servers) await s.close().catch(() => {});
  if (inbox) {
    const r = await fetch(`${BASE}/inboxes/${encodeURIComponent(inbox)}`, { method: "DELETE", headers: H });
    log(`deleted inbox ${inbox}: HTTP ${r.status}`);
  }
}
const ok = results.request?.file === "verified" && results.request?.file_digest_ok && results.respond?.correlates && results.respond?.file === "verified" && results.respond?.file_digest_ok && results.respond?.raw_fetched;
log(ok ? `ROUND TRIP PASSED${results.carrier_test?.pass ? "; CARRIER TEST PASSED" : "; carrier test inside AgentMail not passed"}` : "LIVE RUN FAILED");
process.exit(ok ? 0 : 1);
