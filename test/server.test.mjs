import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEmailServer, LoopbackNetwork, StaticCardResolver, agentKeyFromSeed, createAgentKey, parseMail, header, decodeWords,
} from "../dist/index.js";
import { startHttp } from "../dist/server/http.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../conformance/${f}`, import.meta.url), "utf8"));
const CASES = load("cases.json");
const CARDS = load("cards.json");
const ID = CASES.identities;
const cards = new StaticCardResolver(CARDS.cards, CARDS.key_set);
const T0 = Date.parse("2026-10-29T16:10:00.000Z");

function pair({ anaDeliver, deskDeliver, deskRoster = { contacts: [ID.requester] }, clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ae-srv-"));
  const net = new LoopbackNetwork();
  const now = clock ?? (() => new Date(T0));
  const ana = new AgentEmailServer({
    agent: { key: agentKeyFromSeed(ID.requester_seed), address: "scheduler@agents.example.org", handle: "Scheduler.ana@example.org", actsFor: "Ana Lima", timeZone: "America/Denver" },
    carrier: net.mailbox("scheduler@agents.example.org"), stateDir: join(dir, "ana"), cards, roster: { contacts: [ID.responder] },
    deliver: anaDeliver, clock: now, log: () => {},
  });
  const desk = new AgentEmailServer({
    agent: { key: agentKeyFromSeed(ID.responder_seed), address: "bookings-agent@mail.example.com", handle: "Bookings.desk@example.com", actsFor: "the bookings desk at example.com", offerings: { "book-meeting": "Book a meeting" }, timeZone: "America/Denver" },
    carrier: net.mailbox("bookings-agent@mail.example.com"), stateDir: join(dir, "desk"), cards, roster: deskRoster,
    deliver: deskDeliver, clock: now, log: () => {},
  });
  return { dir, net, ana, desk, cleanup: async () => { await ana.close(); await desk.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a four-email thread between two servers: request, needs input, answer, done with a file", async () => {
  const seenByAna = [], seenByDesk = [];
  const invite = Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  const p = pair({
    anaDeliver: async (d) => { seenByAna.push(d); },
    deskDeliver: async (d) => {
      seenByDesk.push(d);
      if (!d.envelope.task_id) return { status: "input_required", text: "Tuesday 10:00 or Thursday 13:30?", problems: [{ input: "slot", problem: "missing", description: "Choose one of the two times." }] };
      return { status: "completed", text: "Booked: Tuesday 10:00.", files: [{ name: "invite.ics", media_type: "text/calendar", bytes: invite }] };
    },
  });
  try {
    await p.ana.start(); await p.desk.start();
    const sent = await p.ana.request({ to: ID.responder, offering: "book-meeting", offering_name: "Book a meeting", text: "Please book 30 minutes with Ana Lima next week." });
    await p.net.settle();
    assert.equal(seenByDesk.length, 1);
    assert.equal(seenByDesk[0].sender.handle, "Scheduler.ana@example.org");
    assert.match(seenByDesk[0].payload.text, /BEGIN SENDER MESSAGE/);
    assert.equal(seenByAna.length, 1);
    const taskId = seenByAna[0].envelope.task_id;
    assert.equal(seenByAna[0].envelope.in_reply_to, sent.envelope.id);
    assert.equal(seenByAna[0].task.state, "input_required");
    assert.equal(p.ana.tasks.get(taskId).state, "input_required");

    await p.ana.request({ to: ID.responder, offering: "book-meeting", text: "Tuesday at 10:00, please.", task_id: taskId, input: { slot: "2026-11-03T17:00:00Z" } });
    await p.net.settle();
    assert.equal(seenByDesk.length, 2);
    assert.equal(seenByDesk[1].task.state, "working");
    assert.equal(seenByAna.length, 2);
    assert.equal(seenByAna[1].task.state, "completed");
    assert.equal(seenByAna[1].files[0].status, "verified");
    assert.deepEqual(Buffer.from(seenByAna[1].files[0].content_base64, "base64"), invite);
    assert.equal(p.desk.tasks.get(taskId).state, "completed");

    // Threading and subjects, as a person's mail program sees them.
    const log = p.net.log.map((e) => parseMail(e.raw));
    assert.deepEqual(log.map((m) => decodeWords(header(m, "subject"))), [
      "Book a meeting — request", "Re: Book a meeting — needs your input", "Re: Book a meeting — answer", "Re: Book a meeting — done",
    ]);
    const ids = p.net.log.map((e) => e.messageId);
    assert.equal(header(log[1], "in-reply-to"), ids[0]);
    assert.equal(header(log[2], "in-reply-to"), ids[1]);
    assert.equal(header(log[3], "references"), `${ids[0]} ${ids[1]} ${ids[2]}`);
  } finally { await p.cleanup(); }
});

test("an unknown sender's request is held, told to the owner without its content, and released on allow", async () => {
  const seen = [];
  const p = pair({ deskRoster: {}, deskDeliver: async (d) => { seen.push(d); return { status: "completed", text: "ok" }; } });
  try {
    await p.ana.start(); await p.desk.start();
    await p.ana.request({ to: ID.responder, offering: "book-meeting", text: "secret plans", files: [{ name: "plan.txt", media_type: "text/plain", bytes: Buffer.from("the plan") }] });
    await p.net.settle();
    assert.equal(seen.length, 0);
    const kept = [...p.desk["heldMail"].values()][0];
    assert.equal(kept.verdict.files, undefined, "a held message's files are not opened before it is admitted (§3.4)");
    const held = p.desk.heldAttempts();
    assert.equal(held.length, 1);
    assert.equal(held[0].sender, ID.requester);
    assert.equal(held[0].tier, "registered");
    assert.equal(held[0].handle, "Scheduler.ana@example.org");
    assert.doesNotMatch(JSON.stringify(held), /secret plans/);
    const r = await p.desk.decide(ID.requester, "allow");
    await p.net.settle();
    assert.equal(r.released, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].files[0].status, "verified");
    assert.equal(Buffer.from(seen[0].files[0].content_base64, "base64").toString(), "the plan");
    assert.match(seen[0].payload.text, /BEGIN SENDER MESSAGE/);
    assert.equal(p.desk.heldAttempts().length, 0);
    assert.equal(p.net.log.length, 2, "the answer went out after release");
  } finally { await p.cleanup(); }
});

test("a bounce reported by the carrier reaches the agent as an undeliverable request", async () => {
  const seen = [];
  const p = pair({ anaDeliver: async (d) => { seen.push(d); } });
  try {
    await p.ana.start();
    const out = await p.ana.request({ to: ID.responder, offering: "book-meeting", text: "x" });
    const carrierId = p.net.log[0].carrierId;
    await p.ana.handleStatus({ carrierId, state: "bounced", dsnStatus: "5.1.1" });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].report, { request_id: out.envelope.id, outcome: "undeliverable", status: "5.1.1" });
    assert.equal(p.ana.outcomesList()[0].outcome, "undeliverable");
  } finally { await p.cleanup(); }
});

test("a delivery the agent does not take is kept and retried, not lost to the duplicate memory", async () => {
  let fail = true;
  const seen = [];
  const p = pair({ deskDeliver: async (d) => { if (fail) throw new Error("agent down"); seen.push(d); } });
  try {
    await p.ana.start(); await p.desk.start();
    await p.ana.request({ to: ID.responder, offering: "book-meeting", text: "x" });
    await p.net.settle();
    assert.equal(seen.length, 0);
    assert.ok(p.desk.signals.some((s) => /kept for retry/.test(s.text)));
    fail = false;
    // Make the retry due now, and run it.
    const pending = p.desk["pending"];
    for (const [k, v] of pending.entries()) pending.set(k, { ...v, next: 0 });
    await p.desk["retryPending"]();
    assert.equal(seen.length, 1);
  } finally { await p.cleanup(); }
});

test("loop protection: a cap per address, and never to its own address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-loop-"));
  const net = new LoopbackNetwork();
  const k = createAgentKey();
  const s = new AgentEmailServer({
    agent: { key: k, address: "me@example.org" }, carrier: net.mailbox("me@example.org"), stateDir: dir, log: () => {},
    peers: [{ agent_id: ID.responder, address: "peer@example.com" }, { agent_id: ID.third_party, address: "me@example.org" }], limits: { perAddressPerHour: 2 },
  });
  try {
    await s.request({ to: ID.responder, offering: "x", text: "1" });
    await s.request({ to: ID.responder, offering: "x", text: "2" });
    await assert.rejects(s.request({ to: ID.responder, offering: "x", text: "3" }), /2 emails/);
    await assert.rejects(s.request({ to: ID.third_party, offering: "x" }), /own address/);
    await assert.rejects(s.request({ to: createAgentKey().id, offering: "x" }), /no verified email address/);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("automatic mail and plain mail from strangers are never answered", async () => {
  const p = pair({ deskDeliver: async () => ({ status: "completed", text: "should never be sent" }) });
  try {
    await p.desk.start();
    const box = p.net.boxes.get("bookings-agent@mail.example.com");
    await box.arrive(readFileSync(new URL("../conformance/fixtures/11-auto-reply.eml", import.meta.url)));
    await box.arrive(readFileSync(new URL("../conformance/fixtures/12-stranger.eml", import.meta.url)), { spf: "none", dkim: [], dmarc: "none" });
    await box.arrive(readFileSync(new URL("../conformance/fixtures/14-bounce.eml", import.meta.url)));
    await p.net.settle();
    assert.equal(p.net.log.length, 0);
    const knock = p.desk.heldAttempts().find((h) => h.kind === "plain email");
    assert.equal(knock.address, "offers@example.net");
    assert.doesNotMatch(JSON.stringify(knock), /ignore your/i);
  } finally { await p.cleanup(); }
});

test("bridged mode: a person's plain email is answered in plain words, to the verified address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-brs-"));
  const net = new LoopbackNetwork();
  const seen = [];
  const desk = new AgentEmailServer({
    agent: { key: agentKeyFromSeed(ID.responder_seed), address: "bookings-agent@mail.example.com", handle: "Bookings.desk@example.com" },
    carrier: net.mailbox("bookings-agent@mail.example.com"), stateDir: dir, bridge: { enabled: true, offering: "message" },
    roster: { defaults: { bridged: "allow" } }, clock: () => new Date("2026-10-30T14:45:00Z"), log: () => {},
    deliver: async (d) => { seen.push(d); return { status: "completed", text: "Thursday at 14:00 works. It is moved." }; },
  });
  const ana = net.mailbox("ana@example.org");
  const got = [];
  ana.receive(async (m) => { got.push(m); });
  try {
    await desk.start();
    await net.boxes.get("bookings-agent@mail.example.com").arrive(readFileSync(new URL("../conformance/fixtures/15-bridged-plain.eml", import.meta.url)), { spf: "pass", dkim: [{ domain: "example.org", result: "pass", aligned: true }], dmarc: "pass" });
    await net.settle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sender.mode, "bridged");
    assert.equal(seen[0].sender.address, "ana@example.org");
    assert.equal(got.length, 1);
    const m = parseMail(got[0].raw);
    assert.equal(header(m, "in-reply-to"), "<CAF9.ana.2026@example.org>");
    assert.match(got[0].raw.toString(), /Thursday at 14:00 works/);
  } finally { await desk.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the HTTP API: a bearer token, the agent answering later, and the owner's decisions", async () => {
  const p = pair({ deskRoster: {}, deskDeliver: async () => undefined });
  const http = await startHttp(p.desk, { port: 0, token: "test-token" });
  const base = `http://127.0.0.1:${http.address().port}`;
  const call = (path, body, token = "test-token") => fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    await p.ana.start(); await p.desk.start();
    const req = await p.ana.request({ to: ID.responder, offering: "book-meeting", text: "x" });
    await p.net.settle();
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await call("/v1/held", undefined, "wrong")).status, 401);
    const held = await call("/v1/held");
    assert.equal(held.json.held[0].sender, ID.requester);
    assert.equal((await call(`/v1/held/${ID.requester}`, { stance: "allow" })).json.released, 1);
    const ans = await call("/v1/respond", { in_reply_to: req.envelope.id, status: "completed", text: "Done later." });
    assert.equal(ans.status, 200, JSON.stringify(ans.json));
    await p.net.settle();
    const tasks = await call("/v1/tasks");
    assert.equal(tasks.json.tasks[0].state, "completed");
    assert.equal((await call(`/v1/tasks/${ans.json.task_id}`)).json.state, "completed");
    assert.equal((await call("/v1/respond", { in_reply_to: req.envelope.id, status: "working" })).status, 400, "a finished task is not reopened");
  } finally { http.close(); await p.cleanup(); }
});
