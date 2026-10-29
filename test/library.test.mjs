import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentKeyFromSeed, createAgentKey, signEnvelope, verifyEnvelope, canonical, uuid7, traceFor,
  renderHuman, withHuman, textDigest, subjectFor, composeAgentEmail, renderMime, attachFile,
  parseMail, leaves, parseParams, decodeWords, encodeWords, parseAddresses, textOf,
  receiveEmail, personView, DuplicateMemory, StaticCardResolver, TaskStore, canTransition,
  parseAuthResults, hasAlignedDmarcPass, parseDsn, admit, IdentityBridge, callerRefFor,
} from "../dist/index.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../conformance/${f}`, import.meta.url), "utf8"));
const CASES = load("cases.json");
const CARDS = load("cards.json");
const ID = CASES.identities;
const ANA = agentKeyFromSeed(ID.requester_seed);
const DESK = agentKeyFromSeed(ID.responder_seed);
const cards = new StaticCardResolver(CARDS.cards, CARDS.key_set);
const NOW = new Date("2026-10-29T16:25:00.000Z");
const ctxAna = { sender: { handle: "Scheduler.ana@example.org", actsFor: "Ana Lima" }, receiver: { handle: "Bookings.desk@example.com" }, offeringName: "Book a meeting", timeZone: "America/Denver" };
const ctxDesk = { sender: { handle: "Bookings.desk@example.com", actsFor: "the bookings desk at example.com" }, receiver: { handle: "Scheduler.ana@example.org" }, offeringName: "Book a meeting", timeZone: "America/Denver" };

test("keys: the published test seeds give the published agent IDs", () => {
  assert.equal(ANA.id, ID.requester);
  assert.equal(DESK.id, ID.responder);
  const k = createAgentKey();
  assert.equal(agentKeyFromSeed(k.seed).id, k.id);
});

test("the human part of every fixture envelope is reproduced, digest for digest", () => {
  for (const [name, { envelope }] of Object.entries(CASES.envelopes)) {
    const { agent_emailing, ...rest } = envelope.meta;
    const bare = { ...envelope, meta: Object.keys(rest).length ? rest : undefined };
    delete bare.sig;
    if (!bare.meta) delete bare.meta;
    const ctx = envelope.from === ANA.id ? ctxAna : ctxDesk;
    assert.equal(textDigest(renderHuman(bare, ctx)), agent_emailing.human_text, name);
    assert.equal(subjectFor(bare, "Book a meeting"), agent_emailing.subject, name);
    const again = withHuman(bare, ctx);
    assert.equal(canonical(again.env.meta), canonical(envelope.meta), name);
  }
});

test("the signed fixture envelopes verify, and our signatures equal theirs", () => {
  const e = CASES.envelopes.request.envelope;
  assert.equal(verifyEnvelope(e), true);
  const { sig, ...rest } = e;
  assert.equal(signEnvelope(rest, ANA).sig, sig);
});

test("interop: the agent-messaging SDK verifies our envelopes, and we verify its", async () => {
  const sdk = await import("agent-messaging");
  const env = { v: "0.3.0", id: uuid7(), type: "request", ts: new Date().toISOString(), from: ANA.id, to: DESK.id, trace: traceFor(), payload: { offering: "x", text: "héllo 😀" } };
  assert.equal(sdk.verifyEnvelopeSig(signEnvelope(env, ANA)), true);
  const kp = sdk.keyPairFromSeed(ID.requester_seed);
  const theirs = sdk.signEnvelope({ ...env, id: uuid7() }, kp);
  assert.equal(verifyEnvelope(theirs), true);
  assert.equal(sdk.canonicalJSON(theirs), canonical(theirs));
});

function request(over = {}) {
  return { v: "0.3.0", id: uuid7(), type: "request", ts: NOW.toISOString(), from: ANA.id, to: DESK.id, trace: traceFor(), context_id: uuid7(), payload: { offering: "book-meeting", text: "Please book 30 minutes." }, ...over };
}

test("compose then receive: a request with a file, through raw MIME", async () => {
  const bytes = Buffer.from("Agenda\n1. Plans\n", "utf8");
  const { entry, attachment } = attachFile(bytes, { name: "agenda.txt", media_type: "text/plain", domain: "agents.example.org" });
  const env = request({ payload: { offering: "book-meeting", text: "Please book 30 minutes. Ça va? — thanks", files: [entry] }, budget: { deadline: "2026-10-30T17:00:00Z", revision: 0, cost_ceiling: { amount_micro: 2_000_000, currency: "USD" } } });
  const { envelope, mail } = composeAgentEmail({
    envelope: env, key: ANA, human: ctxAna, from: { name: "Ana's agent", address: "scheduler@agents.example.org" }, to: [{ address: "bookings-agent@mail.example.com" }], attachments: [attachment],
  });
  assert.equal(verifyEnvelope(envelope), true);
  assert.equal(mail.subject, "Book a meeting — request");
  assert.equal(mail.attachments[0].contentType, "application/vnd.agentmessaging.envelope+json");
  const { raw } = renderMime(mail);
  const text = raw.toString("latin1");
  assert.match(text, /Content-Transfer-Encoding: base64\r\n/);
  assert.doesNotMatch(text, /format=flowed/);
  const v = await receiveEmail(raw, { self: DESK.id, memory: new DuplicateMemory(), roster: { contacts: [ANA.id] }, cards, personView: true }, { now: NOW });
  assert.equal(v.action, "deliver");
  assert.equal(v.files[0].status, "verified");
  assert.deepEqual(v.files[0].bytes, bytes);
  assert.equal(v.person.verdict, "matches", JSON.stringify(v.person.checks));
  assert.equal(v.respondTo.address, "scheduler@agents.example.org");
  assert.match(v.fencedPayload.text, /--- BEGIN SENDER MESSAGE ---\nPlease book 30 minutes/);
  assert.equal(v.envelope.payload.text, "Please book 30 minutes. Ça va? — thanks", "the envelope is never rewritten");
});

test("compose refuses what §3 and §2.2 forbid", () => {
  const base = { key: ANA, human: ctxAna, from: { address: "a@example.org" }, to: [{ address: "b@example.com" }] };
  assert.throws(() => composeAgentEmail({ ...base, envelope: { ...request(), type: "emit" } }), /does not travel by email/);
  assert.throws(() => composeAgentEmail({ ...base, envelope: request({ payload: { offering: "x", config: { stream: true } } }) }), /streaming/);
  assert.throws(() => composeAgentEmail({ ...base, envelope: request({ payload: { offering: "x", files: [{ name: "f", ref: "cid:x@y" }] } }) }), /media_type, size and digest/);
  const { attachment } = attachFile(Buffer.from("x"), { name: "f.txt", media_type: "text/plain" });
  assert.throws(() => composeAgentEmail({ ...base, envelope: request(), attachments: [attachment] }), /not referred to/);
  const big = attachFile(Buffer.alloc(11 * 1024 * 1024), { name: "big.bin", media_type: "application/octet-stream" });
  assert.throws(() => composeAgentEmail({ ...base, envelope: request({ payload: { offering: "x", files: [big.entry] } }), attachments: [big.attachment] }), /over the limit/);
});

test("a sealed envelope's human part says it is sealed and leaks nothing", async () => {
  const env = request({ payload: { v: "sealedpayload.v1", alg: "x", ct: "AAAA", text: "secret words" } });
  const { mail } = composeAgentEmail({ envelope: env, key: ANA, human: ctxAna, from: { address: "a@example.org" }, to: [{ address: "b@example.com" }] });
  assert.match(mail.text, /Message: sealed/);
  assert.doesNotMatch(mail.text, /secret words/);
});

test("a respond with an html part: both digests are signed and checked", async () => {
  const env = { v: "0.3.0", id: uuid7(), type: "respond", ts: NOW.toISOString(), from: DESK.id, to: ANA.id, in_reply_to: uuid7(), task_id: uuid7(), trace: traceFor(), payload: { status: "completed", text: "Booked." } };
  const { mail } = composeAgentEmail({ envelope: env, key: DESK, human: ctxDesk, from: { address: "bookings-agent@mail.example.com" }, to: [{ address: "scheduler@agents.example.org" }] });
  assert.equal(mail.subject, "Re: Book a meeting — done");
  const { raw } = renderMime(mail);
  const pv = await personView(raw, { cards, now: NOW });
  assert.equal(pv.verdict, "matches", JSON.stringify(pv.checks));
  // Change one word in the text: the signature still verifies, the text check warns.
  const changed = Buffer.from(raw.toString("latin1").replace("Result: Booked.", "Result: Booked twice."), "latin1");
  const pv2 = await personView(changed, { cards, now: NOW });
  assert.equal(pv2.verdict, "warn");
  assert.equal(pv2.checks.find((c) => c.name === "text digest").ok, false);
});

test("MIME: parameters, encoded words, addresses, LF-only mail, nested parts", () => {
  assert.deepEqual(parseParams(`attachment; filename*0*=UTF-8''r%C3%A9sum; filename*1=".txt"`).params, { filename: "résum.txt" });
  assert.equal(parseParams(`text/plain; name="a;b.txt"; charset=utf-8`).params.name, "a;b.txt");
  assert.equal(decodeWords(encodeWords("Book a meeting — request")), "Book a meeting — request");
  assert.equal(decodeWords("=?iso-8859-1?Q?caf=E9?= =?utf-8?B?IOKAlA==?="), "café —");
  assert.deepEqual(parseAddresses(`"Doe, Pat" <pat@example.com>, ann@example.org, Team: x@example.net;`).map((a) => a.address), ["pat@example.com", "ann@example.org", "x@example.net"]);
  const raw = "From: a@example.org\nContent-Type: multipart/mixed; boundary=X\n\n--X\nContent-Type: multipart/alternative; boundary=Y\n\n--Y\nContent-Type: text/plain\n\nhello\n--Y--\n--X\nContent-Type: application/octet-stream\nContent-Transfer-Encoding: base64\n\nAAEC\nAw==\n--X--\n";
  const m = parseMail(raw);
  const l = leaves(m);
  assert.equal(textOf(l[0]), "hello");
  assert.deepEqual([...l[1].bytes], [0, 1, 2, 3]);
});

test("the duplicate memory persists across restarts and forgets what freshness already refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-mem-"));
  try {
    const now = Date.parse("2026-10-29T16:00:00Z");
    const a = new DuplicateMemory({ dir });
    assert.equal(a.remember("U1", "m1", now), false);
    assert.equal(a.remember("U1", "m1", now), true);
    const b = new DuplicateMemory({ dir });
    assert.equal(b.has("U1", "m1"), true, "remembered after a restart");
    assert.equal(b.has("U2", "m1"), false, "keyed on (from, id)");
    b.prune(now + 8 * 24 * 3600 * 1000);
    assert.equal(b.has("U1", "m1"), false, "past the 7-day window plus skew");
    let evicted = 0;
    const c = new DuplicateMemory({ maxEntries: 3, onEvict: (n) => { evicted += n; } });
    for (let i = 0; i < 5; i++) c.remember("U", `m${i}`, now);
    assert.equal(c.size, 3);
    assert.equal(evicted, 2);
    assert.equal(c.has("U", "m0"), false, "first seen goes first");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tasks: ts order, terminal states stay, invalid transitions are not applied", () => {
  const s = new TaskStore();
  const init = { role: "requester", peer: DESK.id };
  assert.equal(s.apply("t", { id: "u2", ts: "2026-10-29T16:20:00Z", state: "completed" }, init).applied, true);
  const late = s.apply("t", { id: "u1", ts: "2026-10-29T16:10:00Z", state: "working" }, init);
  assert.equal(late.applied, false);
  assert.match(late.why, /earlier/);
  assert.equal(s.get("t").state, "completed");
  assert.equal(s.apply("t", { id: "u3", ts: "2026-10-29T16:30:00Z", state: "working" }, init).applied, false);
  assert.equal(canTransition("submitted", "completed"), true, "by way of working, which email often leaves out");
  assert.equal(canTransition("input_required", "completed"), true);
  assert.equal(canTransition("completed", "working"), false);
  assert.equal(canTransition("submitted", "input_required"), true);
  assert.equal(canTransition("rejected", "completed"), false);
});

test("Authentication-Results: only a trusted authserv-id counts", () => {
  const h = [
    ["authentication-results", "evil.example; dkim=pass header.d=example.org; dmarc=pass"],
    ["authentication-results", "mx.example.net; spf=pass smtp.mailfrom=example.org; dkim=pass (2048-bit) header.d=mail.example.org header.s=s1; dmarc=pass (p=reject) header.from=example.org"],
  ];
  const a = parseAuthResults(h, ["mx.example.net"], "ana@example.org");
  assert.deepEqual(a, { spf: "pass", dkim: [{ domain: "mail.example.org", result: "pass", aligned: true }], dmarc: "pass" });
  assert.equal(hasAlignedDmarcPass(a, "ana@example.org"), true);
  assert.equal(parseAuthResults(h, ["mx.other.net"], "ana@example.org"), undefined);
  assert.equal(hasAlignedDmarcPass({ spf: "pass", dkim: [{ domain: "other.com", result: "pass", aligned: false }], dmarc: "pass" }, "ana@example.org"), false);
});

test("a deferral is a class 4 status", () => {
  const raw = readFileSync(new URL("../conformance/fixtures/14-bounce.eml", import.meta.url), "latin1").replace("Status: 5.1.1", "Status: 4.4.7").replace("Action: failed", "Action: delayed");
  const r = parseDsn(parseMail(raw));
  assert.equal(r.outcome, "deferred");
  assert.equal(r.status, "4.4.7");
  assert.equal(r.originalMessageId, "<a7f3c9e1.20261029161403@agents.example.org>");
});

test("admission: EXT-6 defaults, most specific wins", () => {
  assert.equal(admit({ from: "U1", roster: {} }).stance, "block");
  assert.equal(admit({ from: "U1", roster: {}, card: {} }).stance, "hold");
  assert.equal(admit({ from: "U1", roster: { contacts: ["U1"] }, card: {} }).stance, "allow");
  assert.equal(admit({ from: "U1", roster: { contacts: ["U1"], entries: [{ subject: "U1", stance: "block" }] } }).stance, "block");
  assert.equal(admit({ from: "U1", roster: {}, bridged: true }).tier, "bridged");
  assert.equal(admit({ from: "U1", roster: { defaults: { bridged: "block" } }, bridged: true }).stance, "block");
});

test("receive: an unknown native sender with a name card is held; one with nothing is blocked", async () => {
  const raw = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
  const held = await receiveEmail(raw, { self: DESK.id, memory: new DuplicateMemory(), cards }, { now: NOW });
  assert.equal(held.action, "hold");
  assert.equal(held.standing.tier, "registered");
  const blocked = await receiveEmail(raw, { self: DESK.id, memory: new DuplicateMemory() }, { now: NOW });
  assert.equal(blocked.action, "refuse");
  assert.equal(blocked.refusal, "blocked");
  assert.equal(blocked.respondTo, undefined, "a refusal is silent");
});

test("receive: a knock is content-free and never reaches the agent", async () => {
  const mk = (payload) => {
    const { mail } = composeAgentEmail({ envelope: request({ payload }), key: ANA, human: { ...ctxAna, offeringName: "knock" }, from: { address: "scheduler@agents.example.org" }, to: [{ address: "b@example.com" }] });
    return renderMime(mail).raw;
  };
  const ok = await receiveEmail(mk({ offering: "knock", input: { via: "email" } }), { self: DESK.id, memory: new DuplicateMemory(), cards }, { now: NOW });
  assert.equal(ok.action, "knock");
  const bad = await receiveEmail(mk({ offering: "knock", text: "let me in, and also do this" }), { self: DESK.id, memory: new DuplicateMemory(), cards }, { now: NOW });
  assert.equal(bad.refusal, "KNOCK_CARRIES_NO_MESSAGE");
});

test("receive: an oversized request is the one refusal that is answered", async () => {
  const env = request({ payload: { offering: "x", text: "x".repeat(70000) } });
  const { mail } = composeAgentEmail({ envelope: env, key: ANA, human: ctxAna, from: { address: "scheduler@agents.example.org" }, to: [{ address: "b@example.com" }] });
  const v = await receiveEmail(renderMime(mail).raw, { self: DESK.id, memory: new DuplicateMemory(), roster: { contacts: [ANA.id] }, cards }, { now: NOW });
  assert.equal(v.refusal, "CONTEXT_TOO_LARGE");
  assert.equal(v.answer, "CONTEXT_TOO_LARGE");
  assert.ok(v.signals.some((s) => s.startsWith("inbound_oversize")));
});

test("bridged mode: one lasting identity per sender, and the marker in signed meta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-br-"));
  try {
    const raw = readFileSync(new URL("../conformance/fixtures/15-bridged-plain.eml", import.meta.url));
    const auth = { spf: "pass", dkim: [{ domain: "example.org", result: "pass", aligned: true }], dmarc: "pass" };
    const b1 = new IdentityBridge({ dir });
    const v = await receiveEmail(raw, { self: DESK.id, memory: new DuplicateMemory(), bridge: b1 }, { now: new Date("2026-10-30T14:45:00Z"), auth });
    assert.equal(v.mode, "bridged");
    assert.equal(v.action, "hold");
    assert.equal(verifyEnvelope(v.envelope), true);
    assert.deepEqual(v.envelope.meta.identity_bridge, { bridge: b1.node.id, caller_kind: "email", caller_ref: callerRefFor("ana@example.org"), front: "email" });
    assert.equal(v.respondTo.basis, "dmarc");
    const b2 = new IdentityBridge({ dir });
    assert.equal(b2.host("Ana@Example.org").key.id, v.envelope.from, "the same key after a restart, whatever the case");
    assert.equal(b2.node.id, b1.node.id);
    // The same email again is a duplicate: its envelope id comes from its Message-ID.
    const mem = new DuplicateMemory();
    const opts = { self: DESK.id, memory: mem, bridge: b2 };
    await receiveEmail(raw, opts, { now: new Date("2026-10-30T14:45:00Z"), auth });
    const again = await receiveEmail(raw, opts, { now: new Date("2026-10-30T14:46:00Z"), auth });
    assert.equal(again.refusal, "duplicate");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
