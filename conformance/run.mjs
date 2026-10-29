// Runs the nineteen Agent Emailing 0.2.0 conformance cases (SPEC.md §12)
// against this implementation, twice:
//
//   library  each fixture through receiveEmail(), the library's receiver
//   server   each fixture delivered by a loopback carrier to a running
//            AgentEmailServer, with a small agent behind it that answers every
//            request it is handed, so "reply" is what the server really sent
//
//   node conformance/run.mjs [library|server] [--json]
//
// The cases' outcomes are written in the cases' own words ("the agent's own
// answer", "as a bridged request"). translate() below is the whole mapping
// from this implementation's verdict to those words.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  receiveEmail, DuplicateMemory, StaticCardResolver, IdentityBridge, agentKeyFromSeed,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(resolve(HERE, "cases.json"), "utf8"));
const CARDS = JSON.parse(readFileSync(resolve(HERE, "cards.json"), "utf8"));
const fixture = (name) => readFileSync(resolve(HERE, "fixtures", name));
const ID = CASES.identities;
// The two agents of the example thread know each other: each is the other's contact.
const ROSTER = { contacts: [ID.requester, ID.responder] };
const cards = new StaticCardResolver(CARDS.cards, CARDS.key_set);
// The sending agent's record of what it sent (§8): the Message-ID of 01-request.eml.
const SENT = { "<a7f3c9e1.20261029161403@agents.example.org>": CASES.envelopes.request.envelope.id };

const PERSON = { matches: "matches", warn: "warn: the text does not match the signed message", fail: "fail: do not trust this email" };

/** This implementation's verdict, in the words of cases.json. */
export function translate(c, v, extra = {}) {
  const out = { reply: "none" };
  if (v.action === "report") {
    out.deliver = false;
    out.outcome_for_request = { request: extra.sent?.[v.report.originalMessageId], outcome: v.report.outcome, status: v.report.status };
    return out;
  }
  if (v.mode === "bridged" && (v.action === "deliver" || v.action === "hold")) {
    out.deliver = "as a bridged request";
    out.mode = "bridged";
    out.identity_bridge = v.bridged.marker;
  } else {
    out.deliver = v.action === "deliver";
    if (v.mode && out.deliver) out.mode = v.mode;
  }
  if (v.refusal) out.refusal = v.refusal;
  if (v.signals.length) out.local_signal = true;
  if (v.standing) { out.admission_tier = v.standing.tier; out.default_stance = v.standing.defaultStance; }
  if (v.action !== "deliver") out.reaches_model = false;
  if (v.action === "knock") out.held_attempt_report = "allowed";
  if (out.deliver === true) {
    out.acted_on = v.hintMismatch?.includes("agent-messaging-type") ? `the envelope, as type ${v.envelope.type}` : "the envelope";
    out.state = v.state;
    if (v.task) out.task = v.task;
    if (v.correlatesTo) out.correlates_to = v.correlatesTo;
    if (v.files?.length) out.files = Object.fromEntries(v.files.map((f) => [f.entry.name, f.status]));
  }
  out.reply = extra.reply ?? (out.deliver === true && v.envelope?.type === "request" && v.respondTo ? "the agent's own answer" : "none");
  if (v.person) out.person_view = PERSON[v.person.verdict];
  return out;
}

const sub = (want, got) => Object.entries(want).every(([k, val]) =>
  val && typeof val === "object" ? got?.[k] && sub(val, got[k]) : got?.[k] === val);

async function libraryCase(c) {
  const memory = new DuplicateMemory();
  const bridge = c.role === "bridge" ? new IdentityBridge({}) : undefined;
  const opts = { self: c.receive_as, memory, roster: ROSTER, cards, bridge, personView: Boolean(c.expect.person_view) };
  const now = new Date(c.now);
  if (c.after) {
    const prev = CASES.cases.find((x) => x.id === c.after);
    await receiveEmail(fixture(prev.fixture), { ...opts, self: prev.receive_as }, { now: new Date(prev.now), auth: prev.carrier_auth });
  }
  const v = await receiveEmail(fixture(c.fixture), opts, { now, auth: c.carrier_auth });
  return translate(c, v, { sent: SENT });
}

async function serverCases() {
  const { runServerCase } = await import("./server-harness.mjs");
  return async (c) => runServerCase(c, { CASES, CARDS, ROSTER, SENT, translate, fixture });
}

const mode = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "both";
const json = process.argv.includes("--json");
const results = {};
let failed = 0;
for (const m of mode === "both" ? ["library", "server"] : [mode]) {
  const run = m === "library" ? libraryCase : await serverCases();
  results[m] = [];
  if (!json) console.log(`\n${m}`);
  for (const c of CASES.cases) {
    let got, error;
    try { got = await run(c); } catch (e) { error = e; }
    const ok = !error && sub(c.expect, got);
    if (!ok) failed++;
    results[m].push({ id: c.id, fixture: c.fixture, ok });
    if (!json) console.log(`  ${ok ? "pass" : "FAIL"}  ${c.id}  ${c.fixture}${ok ? "" : `\n        expected ${JSON.stringify(c.expect)}\n        got      ${error ? error.stack : JSON.stringify(got)}`}`);
  }
}
if (json) console.log(JSON.stringify(results, null, 2));
else console.log(failed ? `\n${failed} case(s) failed` : `\nall ${CASES.cases.length} cases pass${mode === "both" ? " in both modes" : ""}`);
process.exit(failed ? 1 : 0);
