// The four vendor adapters against mocked APIs. Each mock answers with the
// shapes the vendor documents (request fields, response fields, webhook
// payloads and signatures), and plays the carrier: what one side sends
// through the API, it builds into an email the way the vendor would, with
// only the headers the vendor keeps, and delivers to the other side through
// a signed webhook. Each test ends with the carrier test of Agent Emailing
// §12.3 on what arrived. None of this proves a vendor live; the live runs are
// in tools/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  renderMime, fixtureAsOutbound, carrierTest, receiveEmail, DuplicateMemory, StaticCardResolver, parseMail, header,
} from "../dist/index.js";
import { ResendCarrier } from "../dist/providers/resend.js";
import { AgentMailCarrier } from "../dist/providers/agentmail.js";
import { PrimitiveCarrier, PRIMITIVE_HEADERS } from "../dist/providers/primitive.js";
import { CloudflareCarrier } from "../dist/providers/cloudflare.js";
import { signSvix, signTimestamped, verifyTimestamped } from "../dist/providers/http-util.js";
import * as workerSig from "../examples/cloudflare-worker/sig.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../conformance/${f}`, import.meta.url), "utf8"));
const CASES = load("cases.json");
const CARDS = load("cards.json");
const FIXTURE = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
const cards = new StaticCardResolver(CARDS.cards, CARDS.key_set);
const NOW = new Date("2026-10-29T16:25:00.000Z");
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const WHSEC = "whsec_" + Buffer.from("a test webhook secret, 32 bytes!").toString("base64");

/** The OutboundMail a vendor's JSON describes, keeping only `keep` headers. */
const asMail = (from, to, subject, text, headers, attachments, keep = () => true) => ({
  from, to, subject, text, attachments,
  headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => keep(k) && !/^(in-reply-to|references)$/i.test(k))),
  inReplyTo: headers?.["In-Reply-To"], references: headers?.["References"]?.split(" "),
});

async function deliveredVerdict(raw) {
  return receiveEmail(raw, { self: CASES.identities.responder, memory: new DuplicateMemory(), roster: { contacts: [CASES.identities.requester] }, cards, personView: true }, { now: NOW });
}

test("Resend: send, the signed email.received webhook, the raw download, and bounces", async () => {
  const calls = [];
  const store = new Map();
  const fetchMock = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, headers: init.headers, body: init.body });
    if (u.pathname === "/emails" && init.method === "POST") {
      const b = JSON.parse(init.body);
      const id = randomUUID();
      const atts = b.attachments.map((a) => ({ filename: a.filename, contentType: a.content_type, contentId: a.content_id, bytes: Buffer.from(a.content, "base64") }));
      const { raw, messageId } = renderMime(asMail(b.from, b.to, b.subject, b.text, b.headers, atts));
      store.set(id, { raw, messageId, last_event: "delivered" });
      return json({ id });
    }
    const m = u.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
    if (m) return json({ object: "email", id: m[1], from: "scheduler@agents.example.org", to: ["bookings-agent@mail.example.com"], authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, raw: { download_url: `https://cdn.example.net/raw/${m[1]}`, expires_at: "2026-10-30T00:00:00Z" }, created_at: NOW.toISOString() });
    if (u.hostname === "cdn.example.net") return new Response(store.get(u.pathname.split("/").pop()).raw);
    const e = u.pathname.match(/^\/emails\/([^/]+)$/);
    if (e) return json({ object: "email", id: e[1], last_event: store.get(e[1])?.last_event ?? "queued", message_id: store.get(e[1])?.messageId?.slice(1, -1) });
    return json({ message: "not found" }, 404);
  };
  const sender = new ResendCarrier({ apiKey: "re_test", fetch: fetchMock });
  const receiver = new ResendCarrier({ apiKey: "re_test", webhookSecret: WHSEC, fetch: fetchMock });
  const got = [], statuses = [];
  receiver.receive(async (m) => { got.push(m); });
  receiver.onStatus(async (s) => { statuses.push(s); });

  const sent = await sender.send(fixtureAsOutbound(FIXTURE, "scheduler@agents.example.org", "bookings-agent@mail.example.com"));
  const post = JSON.parse(calls[0].body);
  assert.equal(calls[0].headers.authorization, "Bearer re_test");
  assert.match(calls[0].headers["idempotency-key"], /^ae-[0-9a-f]{48}$/);
  assert.equal(post.headers["Auto-Submitted"], "auto-generated");
  assert.ok(post.attachments.some((a) => a.content_type === "application/vnd.agentmessaging.envelope+json" && a.filename === "envelope.json"));
  assert.ok(post.attachments.some((a) => a.content_id === CASES.files["agenda.txt"].content_id));
  assert.equal(sent.messageId, store.get(sent.carrierId).messageId, "the Message-ID Resend set, read back");

  const body = Buffer.from(JSON.stringify({ type: "email.received", created_at: NOW.toISOString(), data: { email_id: sent.carrierId, from: "scheduler@agents.example.org", to: ["bookings-agent@mail.example.com"], message_id: sent.messageId, subject: "x", attachments: [] } }));
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await receiver.webhook({ headers: { "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": "v1,AAAA" }, body, path: "/webhooks/resend" })).status, 401);
  const ok = await receiver.webhook({ headers: { "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": signSvix("msg_1", ts, body, WHSEC) }, body, path: "/webhooks/resend" });
  assert.equal(ok.status, 200);
  assert.equal(got[0].carrierEventId, "resend:msg_1");
  assert.equal(got[0].auth.dmarc, "pass");
  const ct = carrierTest(got[0], CASES);
  assert.equal(ct.pass, true, ct.details.join("; "));
  const v = await deliveredVerdict(got[0].raw);
  assert.equal(v.action, "deliver");
  assert.equal(v.person.verdict, "matches");

  const bounce = Buffer.from(JSON.stringify({ type: "email.bounced", created_at: NOW.toISOString(), data: { email_id: sent.carrierId, bounce: { type: "Permanent", subType: "General", message: "x", diagnosticCode: ["smtp; 550 5.1.1 user unknown"] } } }));
  await receiver.webhook({ headers: { "svix-id": "msg_2", "svix-timestamp": String(ts), "svix-signature": signSvix("msg_2", ts, bounce, WHSEC) }, body: bounce, path: "/webhooks/resend" });
  assert.deepEqual(statuses[0], { carrierId: sent.carrierId, state: "bounced", dsnStatus: "5.1.1", at: NOW.toISOString() });
  assert.deepEqual(await sender.status(sent.carrierId), { state: "delivered" });
});

test("AgentMail: send from the inbox, threading in headers, the message.received webhook and the raw download", async () => {
  const calls = [];
  const store = new Map();
  const fetchMock = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: decodeURIComponent(u.pathname), headers: init.headers, body: init.body });
    let m;
    if ((m = decodeURIComponent(u.pathname).match(/^\/v0\/inboxes\/([^/]+)\/messages\/send$/))) {
      const b = JSON.parse(init.body);
      const atts = b.attachments.map((a) => ({ filename: a.filename, contentType: a.content_type, contentId: a.content_id, bytes: Buffer.from(a.content, "base64") }));
      const { raw, messageId } = renderMime(asMail(m[1], b.to, b.subject, b.text, b.headers, atts));
      store.set(messageId, raw);
      return json({ message_id: messageId, thread_id: "thd_1" });
    }
    if ((m = decodeURIComponent(u.pathname).match(/^\/v0\/inboxes\/[^/]+\/messages\/(<[^>]+>)\/raw$/))) return json({ message_id: m[1], size: store.get(m[1]).length, download_url: `https://cdn.example.net/eml?id=${encodeURIComponent(m[1])}`, expires_at: "2026-10-30T00:00:00Z" });
    if ((m = decodeURIComponent(u.pathname).match(/^\/v0\/inboxes\/[^/]+\/messages\/(<[^>]+>)$/))) return json({ inbox_id: "bookings-agent@mail.example.com", message_id: m[1], from: "Ana's agent <scheduler@agents.example.org>", authentication_results: { spf: "pass", dkim: "pass", dmarc: "pass", dkim_domain: "agents.example.org" }, created_at: NOW.toISOString() });
    if (u.hostname === "cdn.example.net") return new Response(store.get(u.searchParams.get("id")));
    return json({ name: "NotFoundError" }, 404);
  };
  const sender = new AgentMailCarrier({ apiKey: "am_test", inboxId: "scheduler@agents.example.org", fetch: fetchMock });
  const receiver = new AgentMailCarrier({ apiKey: "am_test", inboxId: "bookings-agent@mail.example.com", webhookSecret: WHSEC, fetch: fetchMock });
  const got = [];
  receiver.receive(async (m) => { got.push(m); });
  const mail = { ...fixtureAsOutbound(FIXTURE, "scheduler@agents.example.org", "bookings-agent@mail.example.com"), inReplyTo: "<earlier@agents.example.org>", references: ["<earlier@agents.example.org>"] };
  const sent = await sender.send(mail);
  assert.equal(calls[0].path, "/v0/inboxes/scheduler@agents.example.org/messages/send");
  const post = JSON.parse(calls[0].body);
  assert.equal(post.from, undefined, "the sender is the inbox");
  assert.equal(post.headers["In-Reply-To"], "<earlier@agents.example.org>");
  assert.equal(post.subject, "Book a meeting — request", "the signed subject, never one a reply endpoint writes");
  const body = Buffer.from(JSON.stringify({ type: "event", event_type: "message.received", event_id: "evt_abc", message: { inbox_id: "bookings-agent@mail.example.com", message_id: sent.messageId } }));
  const ts = Math.floor(Date.now() / 1000);
  assert.equal((await receiver.webhook({ headers: { "svix-id": "msg_9", "svix-timestamp": String(ts), "svix-signature": signSvix("msg_9", ts, body, WHSEC) }, body, path: "/webhooks/agentmail" })).status, 200);
  assert.equal(got[0].carrierEventId, "agentmail:evt_abc", "event_id, not svix-id, is the id to deduplicate on");
  assert.deepEqual(got[0].auth.dkim, [{ domain: "agents.example.org", result: "pass", aligned: true }]);
  const ct = carrierTest(got[0], CASES);
  assert.equal(ct.pass, true, ct.details.join("; "));
  assert.equal(header(parseMail(got[0].raw), "in-reply-to"), "<earlier@agents.example.org>");
});

test("Primitive: three custom headers are enough", async () => {
  const calls = [];
  const store = new Map();
  const fetchMock = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, headers: init.headers, body: init.body });
    if (u.pathname === "/v1/send-mail") {
      const b = JSON.parse(init.body);
      for (const k of Object.keys(b.headers ?? {})) if (!PRIMITIVE_HEADERS.includes(k.toLowerCase())) return json({ success: false, error: { code: "validation_error", message: `header ${k} is not allowed` } }, 400);
      const atts = b.attachments.map((a) => ({ filename: a.filename, contentType: a.content_type, contentId: a.content_id, bytes: Buffer.from(a.content_base64, "base64") }));
      const { raw, messageId } = renderMime({ from: b.from, to: b.to, subject: b.subject, text: b.body_text, headers: b.headers, attachments: atts, inReplyTo: b.in_reply_to, references: b.references });
      const id = randomUUID();
      store.set(id, { raw, messageId });
      return json({ success: true, data: { id, status: "queued", accepted: b.to, rejected: [] } });
    }
    let m;
    if ((m = u.pathname.match(/^\/v1\/sent-emails\/([^/]+)$/))) return json({ success: true, data: { id: m[1], status: "delivered", message_id: store.get(m[1])?.messageId } });
    if ((m = u.pathname.match(/^\/v1\/emails\/([^/]+)\/raw$/))) {
      assert.equal(init.headers.authorization, "Bearer prim_test");
      return new Response(store.get(m[1]).raw, { headers: { "content-type": "message/rfc822" } });
    }
    return json({ success: false, error: { code: "not_found" } }, 404);
  };
  const sender = new PrimitiveCarrier({ apiKey: "prim_test", fetch: fetchMock });
  const receiver = new PrimitiveCarrier({ apiKey: "prim_test", webhookSecret: "prim-secret", endpointId: "ep_1", fetch: fetchMock });
  const got = [];
  receiver.receive(async (m) => { got.push(m); });

  // A full agent email, with every hint header the server adds.
  const mail = fixtureAsOutbound(FIXTURE, "scheduler@agents.example.org", "bookings-agent@mail.example.com");
  mail.headers = { "Auto-Submitted": "auto-generated", "Agent-Emailing-Version": "0.2.0", "Agent-Messaging-Type": "request", "Agent-Messaging-Context": CASES.envelopes.request.envelope.context_id };
  mail.inReplyTo = "<a@agents.example.org>";
  mail.references = ["<a@agents.example.org>"];
  const sent = await sender.send(mail);
  const post = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(post.headers), ["Auto-Submitted"]);
  assert.deepEqual(sender.lastDropped, ["Agent-Emailing-Version", "Agent-Messaging-Type", "Agent-Messaging-Context"]);
  assert.equal(post.in_reply_to, "<a@agents.example.org>");
  assert.equal(sent.messageId, store.get(sent.carrierId).messageId);

  // Delivered by webhook: once with the raw message inline, once by download.
  for (const inline of [true, false]) {
    const raw = store.get(sent.carrierId).raw;
    const body = Buffer.from(JSON.stringify({
      id: `evt_${inline}`, event: "email.received", version: "2025-12-14", delivery: { endpoint_id: "ep_1", attempt: 1 },
      email: {
        id: sent.carrierId, received_at: NOW.toISOString(),
        content: { raw: inline ? { included: true, encoding: "base64", data: raw.toString("base64") } : { included: false } },
        auth: { spf: "pass", dmarc: "pass", dkimSignatures: [{ domain: "agents.example.org", result: "pass", aligned: true }] },
      },
    }));
    assert.equal((await receiver.webhook({ headers: { "primitive-signature": signTimestamped(body, "wrong") }, body, path: "/webhooks/primitive" })).status, 401);
    assert.equal((await receiver.webhook({ headers: { "primitive-signature": signTimestamped(body, "prim-secret") }, body, path: "/webhooks/primitive" })).status, 200);
  }
  assert.equal(got.length, 2);
  for (const g of got) {
    const ct = carrierTest(g, CASES);
    assert.equal(ct.pass, true, ct.details.join("; "));
    const v = await deliveredVerdict(g.raw);
    assert.equal(v.action, "deliver", "everything the agent needs is in the envelope");
    assert.equal(v.hintMismatch, undefined);
    assert.deepEqual(v.signals, [], "no hint headers, so nothing to disagree");
    assert.equal(v.person.verdict, "matches");
    assert.equal(v.files[0].status, "verified");
  }
});

test("Cloudflare: the Worker relay, signed both ways with the Worker's own code, and REST refusing what it cannot carry", async () => {
  const secret = "a shared secret between server and Worker";
  const outbox = [];
  const workerFetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.pathname, "/send");
    // The Worker's own verification code (examples/cloudflare-worker/sig.js).
    assert.equal(await workerSig.verify(init.headers["x-agent-emailing-signature"], new TextEncoder().encode(init.body), secret), true);
    const { from, to, raw } = JSON.parse(init.body);
    outbox.push({ from, to, raw: Buffer.from(raw, "base64") });
    return json({ messageId: "<cf-1@agents.example.org>" });
  };
  const carrier = new CloudflareCarrier({ workerUrl: "https://agent-emailing-carrier.example.workers.dev", workerSecret: secret, fetch: workerFetch });
  const sent = await carrier.send(fixtureAsOutbound(FIXTURE, "scheduler@agents.example.org", "bookings-agent@mail.example.com"));
  assert.equal(sent.messageId, "<cf-1@agents.example.org>");
  assert.equal(carrierTest(outbox[0].raw, CASES).pass, true);

  // Inbound: the Worker signs the raw message; the server's adapter checks it.
  const got = [];
  carrier.receive(async (m) => { got.push(m); });
  const raw = outbox[0].raw;
  const sig = await workerSig.sign(new Uint8Array(raw), secret);
  assert.equal(verifyTimestamped(sig, raw, secret), true, "the two implementations agree");
  assert.equal((await carrier.webhook({ headers: { "x-agent-emailing-signature": sig, "x-event-id": await workerSig.sha256hex(new Uint8Array(raw)) }, body: raw, path: "/webhooks/cloudflare" })).status, 200);
  assert.equal((await carrier.webhook({ headers: { "x-agent-emailing-signature": sig.replace(/v1=./, "v1=0") }, body: raw, path: "/webhooks/cloudflare" })).status, 401);
  assert.equal(carrierTest(got[0], CASES).pass, true);

  const rest = new CloudflareCarrier({ workerSecret: secret, accountId: "acc", apiToken: "tok", fetch: async () => json({ success: true, result: { message_id: "<m@x>", delivered: ["b@example.com"] } }) });
  await assert.rejects(rest.send(fixtureAsOutbound(FIXTURE, "a@example.org", "b@example.com")), /Content-ID/);
});
