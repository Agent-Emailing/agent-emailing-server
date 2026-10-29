#!/usr/bin/env node
// Cross-provider interop: a quote requested in four emails, on every lane
// between AgentMail, Primitive and Resend.
//
//   AGENTMAIL_API_KEY=... PRIMITIVE_API_KEY=... RESEND_API_KEY=... MAILBOX_SA_JSON='{...}' \
//   npm run interop -- --primitive-domain <sub>.primitive.email \
//     --mailbox mailbox@example.org --mailbox-base mailbox [--lanes agentmail-primitive,...] [--out docs]
//
// The use case. A buyer's purchasing agent (example.org) asks a supplier's
// sales agent (example.com) for a quote:
//   1. request: a parts list as CSV, a limit of up to 500.00 USD
//   2. respond, needs your input: two items have a 3-week lead time; is a split delivery fine?
//   3. request, the answer: yes
//   4. respond, done: the quote as a PDF, the price and the delivery dates
//
// A lane "X → Y" puts the buyer on carrier X and the supplier on carrier Y.
// Each lane runs:
//   (a) the four emails, each checked: delivered and how long it took, the
//       signature, the sender's name card, the text and subject digests, the
//       file digests, the thread, and the task's state; with the custom
//       headers that survived and the DKIM and DMARC results the receiving
//       provider reports;
//   (b) the carrier test of Agent Emailing §12.3, from X to Y;
//   (c) a forged quote: email 4 with its price raised after signing, sent from
//       Y to X. The buyer's server must refuse it, and the person view must fail.
//
// The parties:
//   AgentMail  one test inbox, made at the start and deleted at the end
//   Primitive  a new address per lane on the account's managed domain
//   Resend     sends through Resend; receives at <mailbox-base>+<label>@<domain>,
//              a mailbox read through the Gmail API, because the Resend key
//              cannot receive. Lanes into Resend are therefore not run.
// Primitive may only answer addresses that wrote to it first. When the
// Primitive buyer's first request is refused for that reason, the supplier
// knocks first and the request is sent again.
//
// Each agent has a new key and a name card signed by a test registrar made for
// the run. Results are written to <out>/interop-<date>.md and .json, the date
// in Mountain time. Keys come from the environment and are never printed.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentEmailServer, StaticCardResolver, createAgentKey, createRegistrarKey, signCard, carrierTest, fixtureAsOutbound,
  composeAgentEmail, renderHuman, personView, verifyEnvelope, sha256hex, parseMail, leaves, header, parseMessageIds,
  decodeWords, textOf, filenameOf, contentId, parseAuthResults, firstAddress, uuid7, traceFor, ENVELOPE_MEDIA_TYPE,
} from "../dist/index.js";
import { AgentMailCarrier } from "../dist/providers/agentmail.js";
import { PrimitiveCarrier } from "../dist/providers/primitive.js";
import { ResendCarrier } from "../dist/providers/resend.js";
import { googleAccessToken } from "../dist/providers/google-auth.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PRIM_DOMAIN = arg("primitive-domain");
const MAILBOX = arg("mailbox");
const MAILBOX_BASE = arg("mailbox-base");
const OUT = arg("out", "docs");
const STATE = arg("state", ".state/interop");
const ONLY = arg("lanes")?.split(",");
for (const v of ["AGENTMAIL_API_KEY", "PRIMITIVE_API_KEY", "RESEND_API_KEY", "MAILBOX_SA_JSON"]) if (!process.env[v]) { console.error(`${v} is not set`); process.exit(2); }
if (!PRIM_DOMAIN || !MAILBOX || !MAILBOX_BASE) { console.error("needs --primitive-domain, --mailbox and --mailbox-base"); process.exit(2); }
const MAILBOX_DOMAIN = MAILBOX.split("@")[1];

const log = (s) => console.log(`${new Date().toISOString()}  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(2000); } return false; };
const CASES = JSON.parse(readFileSync(new URL("../conformance/cases.json", import.meta.url), "utf8"));
const FIXTURE = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
const NAMES = { agentmail: "AgentMail", primitive: "Primitive", resend: "Resend" };
const HINTS = ["Auto-Submitted", "Agent-Emailing-Version", "Agent-Messaging-Type", "Agent-Messaging-Task", "Agent-Messaging-Context"];

// ── the files ───────────────────────────────────────────────────────────────
const CSV = Buffer.from([
  "part_number,description,quantity",
  "BR-6204,Ball bearing 6204,40",
  "SH-1220,Steel shaft 12 x 200 mm,20",
  "GB-0410,Gearbox 4:1,4",
  "CP-0032,Coupling 32 mm,8",
  "",
].join("\n"), "utf8");

/** A one-page PDF of plain text lines, written by hand (PDF 1.4, Helvetica). */
function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 11 Tf 72 740 Td 15 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const QUOTE_TEXT = "Quote Q-2026-1029: 412.50 USD for all four items. Items BR-6204 and SH-1220 ship on 2026-11-06; GB-0410 and CP-0032 ship on 2026-11-20.";
const PDF = pdf([
  "Quote Q-2026-1029", "From: the sales desk at example.com", "To: the purchasing desk at example.org", "",
  "BR-6204  Ball bearing 6204        40   3.10   124.00",
  "SH-1220  Steel shaft 12 x 200 mm  20   4.25    85.00",
  "GB-0410  Gearbox 4:1               4  42.50   170.00",
  "CP-0032  Coupling 32 mm            8   4.1875  33.50", "",
  "Total: 412.50 USD", "Delivery: BR-6204 and SH-1220 on 2026-11-06; GB-0410 and CP-0032 on 2026-11-20 (split delivery).",
]);

// ── the parties ─────────────────────────────────────────────────────────────

/** The Resend party: sends through Resend, reads its mailbox through the Gmail API. */
class ResendWithMailbox extends ResendCarrier {
  constructor(address) { super({ apiKey: process.env.RESEND_API_KEY }); this.address = address; this.inbound = []; this.seen = new Set(); this.since = Date.now() - 60_000; }
  receive(h) { this.inbound.push(h); }
  async start() {
    const tick = async () => {
      try {
        const token = await googleAccessToken(process.env.MAILBOX_SA_JSON, MAILBOX, "https://www.googleapis.com/auth/gmail.readonly");
        const A = { authorization: `Bearer ${token}` };
        const q = encodeURIComponent(`to:${this.address} after:${Math.floor(this.since / 1000)}`);
        const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?includeSpamTrash=true&maxResults=30&q=${q}`, { headers: A }).then((r) => r.json());
        for (const { id } of [...(list.messages ?? [])].reverse()) {
          if (this.seen.has(id)) continue;
          const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`, { headers: A }).then((r) => r.json());
          const raw = Buffer.from(m.raw, "base64url");
          this.seen.add(id);
          const headers = parseMail(raw).headers;
          const auth = parseAuthResults(headers, ["mx.google.com"], firstAddress(header(headers, "from")));
          for (const h of this.inbound) await h({ carrierEventId: `gmail:${id}`, raw, headers, attachments: [], auth, receivedAt: new Date().toISOString() });
        }
      } catch (e) { log(`resend party mailbox: ${e.message}`); }
    };
    this.timer = setInterval(() => void tick(), 4000);
  }
  async close() { clearInterval(this.timer); }
}

let agentmailInbox;
const created = { agentmail_inboxes: [], primitive_addresses: [], resend_party_addresses: [] };

async function makeAgentMailInbox() {
  const username = `ae-interop-${randomBytes(4).toString("hex")}`;
  const r = await fetch("https://api.agentmail.to/v0/inboxes", { method: "POST", headers: { authorization: `Bearer ${process.env.AGENTMAIL_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ username, display_name: "Agent Emailing interop test", client_id: username }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`creating an AgentMail inbox: HTTP ${r.status} ${j.message ?? ""}`);
  created.agentmail_inboxes.push(j.inbox_id);
  log(`created AgentMail inbox ${j.inbox_id}`);
  return j.inbox_id;
}

function partyFor(kind, role, tag) {
  if (kind === "agentmail") return { kind, address: agentmailInbox, carrier: new AgentMailCarrier({ apiKey: process.env.AGENTMAIL_API_KEY, inboxId: agentmailInbox, pollMs: 3000 }) };
  if (kind === "primitive") {
    const address = `ae-interop-${role}-${tag}@${PRIM_DOMAIN}`;
    created.primitive_addresses.push(address);
    return { kind, address, carrier: new PrimitiveCarrier({ apiKey: process.env.PRIMITIVE_API_KEY, pollMs: 3000, address }) };
  }
  const address = `${MAILBOX_BASE}+ae-interop-${role}-${tag}@${MAILBOX_DOMAIN}`;
  created.resend_party_addresses.push(address);
  return { kind, address, carrier: new ResendWithMailbox(address) };
}

const envOfRaw = (raw) => {
  const p = leaves(parseMail(raw)).find((x) => x.type === ENVELOPE_MEDIA_TYPE);
  try { return p ? JSON.parse(p.bytes.toString("utf8")) : undefined; } catch { return undefined; }
};

/** Record every send and every arrival on a carrier, before the server sees it. */
function instrument(carrier) {
  const rec = { sent: [], received: [] };
  const send = carrier.send.bind(carrier);
  carrier.send = async (mail) => {
    const envPart = mail.attachments.find((a) => a.contentType === ENVELOPE_MEDIA_TYPE);
    const id = envPart ? JSON.parse(Buffer.from(envPart.bytes).toString("utf8")).id : undefined;
    const t = Date.now();
    const r = await send(mail);
    rec.sent.push({ id, t, headers: Object.keys(mail.headers ?? {}), ...r });
    return r;
  };
  const events = new Set();
  carrier.receive(async (m) => {
    // A poller may see the same event twice; record it once.
    if (events.has(m.carrierEventId)) return;
    events.add(m.carrierEventId);
    rec.received.push({ id: envOfRaw(m.raw)?.id, t: Date.now(), raw: Buffer.from(m.raw), auth: m.auth });
  });
  return rec;
}

// ── one lane ────────────────────────────────────────────────────────────────

async function runLane(X, Y) {
  const tag = randomBytes(3).toString("hex");
  const lane = { lane: `${NAMES[X]} → ${NAMES[Y]}`, buyer_carrier: NAMES[X], supplier_carrier: NAMES[Y], emails: [], notes: [] };
  const buyer = partyFor(X, "buyer", tag), supplier = partyFor(Y, "supplier", tag);
  lane.buyer_address = buyer.address; lane.supplier_address = supplier.address;
  const bKey = createAgentKey(), sKey = createAgentKey();
  const reg = createRegistrarKey();
  const now = Date.now();
  const HANDLES = { buyer: "Purchasing.buyer@example.org", supplier: "Sales.supplier@example.com" };
  const mkCard = (key, handle, operator, address) => signCard({
    handle, operator: { name: operator }, binding: "agent-key", endpoints: [{ protocol: "agentmesh", agent_id: key.id }, { protocol: "email", address }],
    registrar: "https://registrar.example.net", issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3 * 3600_000).toISOString(),
  }, reg);
  const cards = new StaticCardResolver({
    [bKey.id]: mkCard(bKey, HANDLES.buyer, "the purchasing desk at example.org", buyer.address),
    [sKey.id]: mkCard(sKey, HANDLES.supplier, "the sales desk at example.com", supplier.address),
  }, [{ kid: reg.kid, key: reg.key, status: "current" }]);

  const bRec = instrument(buyer.carrier), sRec = instrument(supplier.carrier);
  const got = { buyer: [], supplier: [] };
  const dir = join(STATE, `${X}-${Y}-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const supplierServer = new AgentEmailServer({
    agent: { key: sKey, address: supplier.address, handle: HANDLES.supplier, actsFor: "the sales desk at example.com", name: "Sales agent", offerings: { "request-quote": "Request a quote" }, timeZone: "America/Denver" },
    carrier: supplier.carrier, stateDir: join(dir, "supplier"), cards, roster: { contacts: [bKey.id] }, trustedAuthservIds: ["mx.google.com"], log: () => {},
    deliver: async (d) => {
      got.supplier.push({ d, t: Date.now() });
      if (d.kind !== "request" || d.envelope.payload?.offering === "knock") return;
      if (!d.envelope.task_id) return {
        status: "input_required", text: "Two items, GB-0410 and CP-0032, have a 3-week lead time. Is a split delivery fine?",
        problems: [{ input: "split_delivery", problem: "missing", description: "Is a split delivery fine?", expected: "true or false" }],
      };
      return {
        status: "completed", text: QUOTE_TEXT, price: { amount_micro: 412_500_000, currency: "USD" },
        output: { quote_id: "Q-2026-1029", total: "412.50 USD", deliveries: [{ items: ["BR-6204", "SH-1220"], date: "2026-11-06" }, { items: ["GB-0410", "CP-0032"], date: "2026-11-20" }] },
        files: [{ name: "quote-Q-2026-1029.pdf", media_type: "application/pdf", bytes: PDF }],
      };
    },
  });
  const buyerServer = new AgentEmailServer({
    agent: { key: bKey, address: buyer.address, handle: HANDLES.buyer, actsFor: "the purchasing desk at example.org", name: "Purchasing agent", timeZone: "America/Denver" },
    carrier: buyer.carrier, stateDir: join(dir, "buyer"), cards, roster: { contacts: [sKey.id] }, trustedAuthservIds: ["mx.google.com"], log: () => {},
    deliver: async (d) => { got.buyer.push({ d, t: Date.now() }); },
  });
  await supplierServer.start();
  await buyerServer.start();
  const stop = async () => { await buyerServer.close().catch(() => {}); await supplierServer.close().catch(() => {}); };

  try {
    // Email 1. The Primitive buyer may need the supplier to write first.
    const ask = () => buyerServer.request({
      to: sKey.id, offering: "request-quote", offering_name: "Request a quote",
      text: "Please quote the parts in the attached list, delivered to our plant in Denver.",
      input: { parts_list: "parts-list.csv", deliver_to: "Denver, CO" }, files: [{ name: "parts-list.csv", media_type: "text/csv", bytes: CSV }],
      budget: { deadline: new Date(Date.now() + 3 * 24 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z"), revision: 0, cost_ceiling: { amount_micro: 500_000_000, currency: "USD" } },
    });
    let first, knockId;
    try { first = await ask(); }
    catch (e) {
      if (!/recipient_not_allowed/.test(e.message)) throw e;
      lane.notes.push(`Primitive refused the buyer's first email (recipient_not_allowed), so the supplier knocked first.`);
      knockId = uuid7();
      const { mail } = composeAgentEmail({
        envelope: { v: "0.3.0", id: knockId, type: "request", ts: new Date().toISOString(), from: sKey.id, to: bKey.id, trace: traceFor(), payload: { offering: "knock", input: { via: "email" } } },
        key: sKey, human: { sender: { handle: HANDLES.supplier }, receiver: { handle: HANDLES.buyer }, offeringName: "knock" },
        from: { address: supplier.address }, to: [{ address: buyer.address }],
      });
      await supplier.carrier.send(mail);
      await until(() => bRec.received.length > 0, 180_000);
      first = await ask();
    }
    const ids = [first.envelope.id];
    const answers = () => sRec.sent.filter((s) => s.id && s.id !== knockId && !ids.includes(s.id));
    await until(() => answers().length > 0, 240_000);
    const e2 = answers()[0];
    if (e2) ids.push(e2.id);
    await until(() => got.buyer.some((g) => g.d.envelope?.id === ids[1]), 240_000);
    const taskId = got.buyer.find((g) => g.d.envelope?.id === ids[1])?.d.envelope.task_id;
    if (taskId) {
      const third = await buyerServer.request({ to: sKey.id, offering: "request-quote", task_id: taskId, text: "Yes, a split delivery is fine.", input: { split_delivery: true } });
      ids.push(third.envelope.id);
      await until(() => answers().length > 0, 240_000);
      const e4 = answers()[0];
      if (e4) ids.push(e4.id);
      await until(() => got.buyer.some((g) => g.d.envelope?.id === ids[3]), 240_000);
    }

    // Check each email.
    const plan = [
      { n: 1, kind: "request", from: "buyer", to: "supplier", files: { "parts-list.csv": CSV }, task: null },
      { n: 2, kind: "needs your input", from: "supplier", to: "buyer", files: {}, task: "input_required" },
      { n: 3, kind: "answer", from: "buyer", to: "supplier", files: {}, task: "working" },
      { n: 4, kind: "done", from: "supplier", to: "buyer", files: { "quote-Q-2026-1029.pdf": PDF }, task: "completed" },
    ];
    const recs = { buyer: bRec, supplier: sRec };
    const receivedRaw = [];
    for (const p of plan) {
      const id = ids[p.n - 1];
      const sent = recs[p.from].sent.find((s) => s.id === id);
      const arr = id && recs[p.to].received.find((r) => r.id === id);
      const del = id && got[p.to].find((g) => g.d.envelope?.id === id);
      const e = { email: p.n, kind: p.kind, direction: `${p.from} → ${p.to}`, delivered: Boolean(del) };
      receivedRaw.push(arr?.raw);
      if (arr) {
        const m = parseMail(arr.raw);
        e.seconds = sent ? Math.round((arr.t - sent.t) / 100) / 10 : undefined;
        const env = envOfRaw(arr.raw);
        e.signature = verifyEnvelope(env) ? "pass" : "FAIL";
        e.name_card = del?.d.sender?.handle === HANDLES[p.from] ? "pass" : "FAIL";
        const pv = await personView(arr.raw, { cards, now: new Date() });
        e.text_and_subject = pv.verdict === "matches" ? "pass" : `FAIL (${pv.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")})`;
        e.subject = decodeWords(header(m, "subject"));
        const want = Object.entries(p.files);
        e.files = want.length ? (want.every(([name, bytes]) => {
          const f = del?.d.files?.find((x) => x.name === name);
          return f?.status === "verified" && sha256hex(Buffer.from(f.content_base64, "base64")) === sha256hex(bytes);
        }) ? "pass" : "FAIL") : "none attached";
        e.task_state = p.task ? (del?.d.task?.state === p.task ? `pass (${p.task})` : `FAIL (${del?.d.task?.state})`) : "opens the task";
        e.headers_survived = HINTS.filter((h) => header(m, h.toLowerCase()) !== undefined);
        e.auth = arr.auth ? { spf: arr.auth.spf, dmarc: arr.auth.dmarc, dkim: arr.auth.dkim.map((d) => `${d.domain}:${d.result}${d.aligned ? " (aligned)" : ""}`) } : "not reported";
        e.message_id = parseMessageIds(header(m, "message-id"))[0];
        e.in_reply_to = parseMessageIds(header(m, "in-reply-to"))[0];
        e.references = parseMessageIds(header(m, "references"));
      }
      lane.emails.push(e);
    }
    // Threading: each email answers the one before it as its receiver saw it.
    lane.threading = lane.emails.slice(1).every((e, i) => {
      const prev = lane.emails[i];
      return prev.message_id && e.in_reply_to === prev.message_id && e.references?.includes(prev.message_id);
    }) ? "kept" : "broken";
    if (lane.threading === "broken") lane.notes.push(`Threading: ${lane.emails.map((e) => `email ${e.email} Message-ID ${e.message_id ?? "-"}, In-Reply-To ${e.in_reply_to ?? "-"}`).join("; ")}.`);
    lane.supplier_task_final = taskId ? supplierServer.tasks.get(taskId)?.state : undefined;
    lane.buyer_task_final = taskId ? buyerServer.tasks.get(taskId)?.state : undefined;

    // (c) The forged quote: email 4, its price raised after signing, from the supplier's carrier.
    const doneRaw = receivedRaw[3];
    if (doneRaw) {
      const env = envOfRaw(doneRaw);
      const forged = JSON.parse(JSON.stringify(env));
      forged.payload.price.amount_micro = 4_125_000_000;
      forged.payload.text = forged.payload.text.replace("412.50 USD", "4125.00 USD");
      const m = parseMail(doneRaw);
      const atts = leaves(m).filter((x) => filenameOf(x)).map((x) => ({ filename: filenameOf(x), contentType: x.type, contentId: contentId(x), bytes: x.type === ENVELOPE_MEDIA_TYPE ? Buffer.from(JSON.stringify(forged)) : x.bytes }));
      const text = renderHuman(forged, { sender: { handle: HANDLES.supplier, actsFor: "the sales desk at example.com" }, receiver: { handle: HANDLES.buyer }, offeringName: "Request a quote", timeZone: "America/Denver" });
      const before = { deliveries: got.buyer.length, received: bRec.received.length };
      await supplier.carrier.send({
        from: supplier.address, to: [buyer.address], subject: decodeWords(header(m, "subject")), text, attachments: atts,
        headers: { "Auto-Submitted": "auto-generated" }, inReplyTo: parseMessageIds(header(m, "in-reply-to"))[0], references: parseMessageIds(header(m, "references")),
      });
      const arrived = await until(() => bRec.received.length > before.received && bRec.received.slice(before.received).some((r) => r.id === env.id), 240_000);
      await sleep(3000);
      const forgedRaw = bRec.received.slice(before.received).find((r) => r.id === env.id)?.raw;
      const pv = forgedRaw ? await personView(forgedRaw, { cards, now: new Date() }) : undefined;
      lane.forgery = {
        arrived,
        refused_by_server: arrived && got.buyer.length === before.deliveries && buyerServer.signals.some((s) => /signature does not verify/.test(s.text)) ? "pass (IDENTITY_MISMATCH, silent)" : "FAIL",
        person_view: pv ? (pv.verdict === "fail" ? "pass (FAIL shown)" : `FAIL (${pv.verdict})`) : "not arrived",
      };
    } else lane.forgery = { arrived: false, refused_by_server: "not run: email 4 did not arrive", person_view: "not run" };
  } catch (e) {
    lane.error = e.message;
    log(`${lane.lane}: ${e.message}`);
  } finally { await stop(); }

  // (b) The carrier test, from X to Y, on fresh carrier instances.
  try {
    const ctTo = Y === "agentmail" ? agentmailInbox : Y === "primitive" ? `ae-interop-ct-${tag}@${PRIM_DOMAIN}` : `${MAILBOX_BASE}+ae-interop-ct-${tag}@${MAILBOX_DOMAIN}`;
    if (Y === "primitive") created.primitive_addresses.push(ctTo);
    const reader = Y === "agentmail" ? new AgentMailCarrier({ apiKey: process.env.AGENTMAIL_API_KEY, inboxId: agentmailInbox, pollMs: 3000 })
      : Y === "primitive" ? new PrimitiveCarrier({ apiKey: process.env.PRIMITIVE_API_KEY, pollMs: 3000, address: ctTo }) : new ResendWithMailbox(ctTo);
    let result;
    reader.receive(async (m) => { const t = carrierTest(m, CASES); if (t.envelope || t.file) result ??= t; });
    await reader.start();
    const sender = partyFor(X, "ct-sender", tag).carrier;
    const fromAddr = X === "agentmail" ? agentmailInbox : X === "primitive" ? `ae-interop-buyer-${tag}@${PRIM_DOMAIN}` : `${MAILBOX_BASE}+ae-interop-buyer-${tag}@${MAILBOX_DOMAIN}`;
    await sender.send(fixtureAsOutbound(FIXTURE, fromAddr, ctTo));
    await until(() => Boolean(result), 240_000);
    await reader.close();
    lane.carrier_test = result ? (result.pass ? "pass" : `FAIL (${result.details.join("; ")})`) : "FAIL (did not arrive)";
  } catch (e) { lane.carrier_test = `FAIL (${e.message})`; }
  return lane;
}

// ── the run ─────────────────────────────────────────────────────────────────
const KINDS = ["agentmail", "primitive", "resend"];
const lanes = [];
for (const X of KINDS) for (const Y of KINDS) if (X !== Y) lanes.push([X, Y]);
const results = { date: "", started_at: new Date().toISOString(), use_case: "Requesting a quote, as four emails in one thread", lanes: [], not_run: [], created, deleted: [] };
const mountainDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
results.date = mountainDate;
rmSync(STATE, { recursive: true, force: true });

try {
  agentmailInbox = await makeAgentMailInbox();
  for (const [X, Y] of lanes) {
    const name = `${NAMES[X]} → ${NAMES[Y]}`;
    if (ONLY && !ONLY.includes(`${X}-${Y}`)) continue;
    if (Y === "resend") {
      results.not_run.push({ lane: name, reason: "Resend's key can only send, so a supplier on Resend cannot receive the request. Not run." });
      log(`${name}: not run (Resend cannot receive with this key)`);
      continue;
    }
    log(`${name}: running`);
    const r = await runLane(X, Y);
    results.lanes.push(r);
    log(`${name}: ${JSON.stringify({ delivered: r.emails.map((e) => e.delivered), threading: r.threading, carrier_test: r.carrier_test, forgery: r.forgery, error: r.error })}`);
  }
} finally {
  // Delete what the run made.
  for (const id of created.agentmail_inboxes) {
    const r = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${process.env.AGENTMAIL_API_KEY}` } });
    results.deleted.push(`AgentMail inbox ${id}: HTTP ${r.status}`);
  }
  const H = { authorization: `Bearer ${process.env.PRIMITIVE_API_KEY}` };
  const list = await fetch("https://api.primitive.dev/v1/emails?limit=100", { headers: H }).then((r) => r.json()).catch(() => ({ data: [] }));
  for (const e of list.data ?? []) {
    if (!created.primitive_addresses.some((a) => JSON.stringify(e).toLowerCase().includes(a.toLowerCase()))) continue;
    const r = await fetch(`https://api.primitive.dev/v1/emails/${e.id}`, { method: "DELETE", headers: H });
    results.deleted.push(`Primitive stored email ${e.id}: HTTP ${r.status}`);
  }
  results.left_behind = [
    "Mail received by the Resend party's mailbox stays there: the service account may only read it.",
    "The providers' records of sent mail (Resend, AgentMail, Primitive) stay with the providers.",
  ];
  results.finished_at = new Date().toISOString();
  for (const d of results.deleted) log(`deleted ${d}`);
  rmSync(STATE, { recursive: true, force: true });
}

// ── write the results ───────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const jsonPath = join(OUT, `interop-${mountainDate}.json`);
writeFileSync(jsonPath, JSON.stringify(results, null, 2) + "\n");
const cell = (s) => String(s ?? "-").replace(/\|/g, "/");
const all = (r, k) => r.emails.every((e) => !e[k] || String(e[k]).startsWith("pass") || e[k] === "none attached" || e[k] === "opens the task") ? "pass" : "FAIL";
const md = [
  `# Agent Emailing interop, ${mountainDate}`,
  "",
  `The use case: a buyer's purchasing agent (example.org) asks a supplier's sales agent (example.com) for a quote, in four emails in one thread: the request with a parts list (CSV) and a limit of 500.00 USD; "needs your input" about a split delivery; the answer; and "done" with the quote (PDF), the price and the delivery dates.`,
  "",
  "A lane \"X → Y\" puts the buyer on carrier X and the supplier on carrier Y, so emails 1 and 3 travel from X to Y and emails 2 and 4 from Y to X. Each lane also runs the carrier test of §12.3 from X to Y, and sends a forged quote (email 4 with its price raised after signing) from Y to X.",
  "",
  "The Resend party sends through Resend and receives in a Google Workspace mailbox read through the Gmail API, because the Resend key can only send. So in the Resend → X lanes, emails 2 and 4 arrive in that mailbox, not at Resend.",
  "",
  `Run with \`npm run interop\` (tools/interop.mjs), from ${results.started_at} to ${results.finished_at}.`,
  "",
  "## Lanes",
  "",
  "| Lane | Delivered | Seconds per email | Threading | Signature | Name card | Text and subject | Files | Task state | Carrier test | Forged quote refused | Forged quote, person view |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...results.lanes.map((r) => `| ${r.lane} | ${r.emails.filter((e) => e.delivered).length} of 4 | ${r.emails.map((e) => e.seconds ?? "-").join(", ")} | ${r.threading} | ${all(r, "signature")} | ${all(r, "name_card")} | ${all(r, "text_and_subject")} | ${all(r, "files")} | ${all(r, "task_state")} | ${cell(r.carrier_test)} | ${cell(r.forgery?.refused_by_server)} | ${cell(r.forgery?.person_view)} |`),
  ...results.not_run.map((n) => `| ${n.lane} | not run | | | | | | | | | | |`),
  "",
  "## What the carriers kept and reported",
  "",
  "| Lane | Email | Custom headers that arrived | SPF, DKIM, DMARC as the receiving side reports them |",
  "|---|---|---|---|",
  ...results.lanes.flatMap((r) => r.emails.map((e) => `| ${r.lane} | ${e.email}, ${e.kind} (${e.direction}) | ${e.headers_survived ? e.headers_survived.join(", ") || "none" : "-"} | ${typeof e.auth === "object" ? `spf ${e.auth.spf}; dkim ${e.auth.dkim.join(", ") || "none"}; dmarc ${e.auth.dmarc}` : cell(e.auth)} |`)),
  "",
  "## What could not run",
  "",
  ...results.not_run.map((n) => `- **${n.lane}**: ${n.reason}`),
  ...results.lanes.filter((r) => r.error || r.notes.length).map((r) => `- **${r.lane}**: ${[r.error, ...r.notes].filter(Boolean).join(" ")}`),
  "",
  "## What the run created and deleted",
  "",
  `- AgentMail inboxes created: ${created.agentmail_inboxes.join(", ") || "none"}.`,
  `- Primitive addresses used (on the account's managed domain, nothing to create): ${created.primitive_addresses.join(", ") || "none"}.`,
  `- Resend party addresses (subaddresses of the test mailbox): ${created.resend_party_addresses.join(", ") || "none"}.`,
  ...results.deleted.map((d) => `- Deleted: ${d}.`),
  ...results.left_behind.map((d) => `- Left: ${d}`),
  "",
  `The full results, per email and per check, are in [interop-${mountainDate}.json](interop-${mountainDate}.json).`,
  "",
].join("\n");
writeFileSync(join(OUT, `interop-${mountainDate}.md`), md);
log(`wrote ${join(OUT, `interop-${mountainDate}.md`)} and ${jsonPath}`);
const failed = results.lanes.some((r) => r.error || r.emails.some((e) => !e.delivered) || r.threading !== "kept" || !String(r.carrier_test).startsWith("pass") || !String(r.forgery?.refused_by_server).startsWith("pass") || !String(r.forgery?.person_view).startsWith("pass"));
log(failed ? "INTEROP: some checks failed" : "INTEROP: every lane that could run passed");
process.exit(failed ? 1 : 0);
