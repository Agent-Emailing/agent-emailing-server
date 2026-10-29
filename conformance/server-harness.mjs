// The server half of conformance/run.mjs. Each case gets a fresh
// AgentEmailServer on a loopback carrier, with its own state directory, the
// case's clock, and a small agent that answers every request it is handed.
// The fixture is delivered to the server's mailbox exactly as written.
//
// What the case expects is then read from what really happened: whether the
// agent was handed the envelope, whether the server sent an answer, what it
// held, and what it recorded. Every answer the server sends is received back
// by the original sender's side and must verify, name the request it answers,
// and pass the person-view check.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEmailServer, LoopbackNetwork, StaticCardResolver, agentKeyFromSeed, receiveEmail, personView, DuplicateMemory,
} from "../dist/index.js";

const ADDRESS_OF = (CARDS, id) => CARDS.cards[id]?.card.endpoints.find((e) => e.protocol === "email")?.address ?? "agent@example.net";

export async function runServerCase(c, { CASES, CARDS, ROSTER, SENT, translate, fixture }) {
  const ID = CASES.identities;
  const seed = { [ID.requester]: ID.requester_seed, [ID.responder]: ID.responder_seed, [ID.third_party]: ID.third_party_seed }[c.receive_as];
  const key = agentKeyFromSeed(seed);
  const card = CARDS.cards[c.receive_as]?.card;
  const cards = new StaticCardResolver(CARDS.cards, CARDS.key_set);
  const dir = mkdtempSync(join(tmpdir(), "ae-conf-"));
  const net = new LoopbackNetwork();
  const address = ADDRESS_OF(CARDS, c.receive_as);
  const carrier = net.mailbox(address);
  // The other parties' mailboxes, so the answers have somewhere to arrive.
  const inboxes = {};
  for (const id of Object.keys(CARDS.cards)) if (id !== c.receive_as) inboxes[id] = net.mailbox(ADDRESS_OF(CARDS, id));
  const plain = net.mailbox("ana@example.org");
  const arrived = [];
  for (const box of [...Object.values(inboxes), plain]) box.receive(async (m) => { arrived.push({ box: box.address, raw: Buffer.from(m.raw) }); });

  let now = new Date(c.now);
  const deliveries = [];
  const server = new AgentEmailServer({
    agent: { key, address, handle: card?.handle ?? key.id, actsFor: card?.operator?.name, offerings: { "book-meeting": "Book a meeting" }, timeZone: "America/Denver" },
    carrier, stateDir: dir, roster: ROSTER, cards,
    bridge: c.role === "bridge" ? { enabled: true } : undefined,
    clock: () => now,
    deliver: async (d) => { deliveries.push(d); if (d.kind === "request") return { status: "completed", text: "Done." }; },
    log: () => {},
  });
  // The sending agent's record of 01-request.eml, for the bounce (§8).
  for (const [messageId, envelope_id] of Object.entries(SENT)) server.rememberSent({ envelope_id, to: ID.responder, address: "bookings-agent@mail.example.com", messageId });
  await server.start();
  try {
    const inject = async (cc) => {
      now = new Date(cc.now);
      net.authFor = () => cc.carrier_auth;
      const before = arrived.length;
      await carrier.arrive(fixture(cc.fixture), cc.carrier_auth, `${cc.id}-${Math.random()}`);
      await net.settle();
      return before;
    };
    if (c.after) await inject(CASES.cases.find((x) => x.id === c.after));
    const firstDelivery = deliveries.length;
    const before = await inject(c);
    const mine = deliveries.slice(firstDelivery);
    const answers = arrived.slice(before);

    // Rebuild the verdict from what happened. The library's verdict is still
    // the source of refusal reasons and tiers, so receive the fixture again on
    // a scratch memory to read them; the outcome fields come from the server.
    const scratch = await receiveEmail(fixture(c.fixture), {
      self: c.receive_as, memory: new DuplicateMemory(), roster: ROSTER, cards, bridge: server.bridge, personView: Boolean(c.expect.person_view),
    }, { now: new Date(c.now), auth: c.carrier_auth });
    const handed = mine.find((d) => d.kind !== "delivery_report");
    const v = { ...scratch, signals: server.signals.length ? server.signals : scratch.signals };
    if (c.after && scratch.action === "deliver") {
      // The same email a second time: the server must not hand it over again,
      // and must say why in a local signal.
      if (handed) throw new Error("the duplicate was handed to the agent");
      if (!server.signals.some((s) => s.text.startsWith("a duplicate envelope was refused"))) throw new Error("no local signal for the duplicate");
      v.action = "refuse"; v.refusal = "duplicate";
    }
    if (scratch.action === "deliver" && !handed && !c.after) throw new Error("the library would deliver, but the server did not hand the agent anything");
    if (handed && scratch.action !== "deliver") throw new Error(`the server handed the agent an email the library would ${scratch.action}`);
    if (scratch.action === "hold" && !server.heldAttempts().length) throw new Error("the email should be held, but the server holds nothing");
    if (scratch.action === "knock" && !server.heldAttempts().some((h) => h.kind === "plain email" || h.kind === "knock")) throw new Error("no held attempt was recorded");
    for (const h of server.heldAttempts()) if (JSON.stringify(h).includes("ignore your previous instructions")) throw new Error("a held attempt kept what the sender said");

    // Each answer the server sent must verify, correlate, and read correctly.
    for (const a of answers) {
      const original = handed?.envelope;
      const back = await receiveEmail(a.raw, { self: original.from, memory: new DuplicateMemory(), roster: { contacts: [c.receive_as] }, cards }, { now: new Date(c.now) });
      if (back.action !== "deliver") throw new Error(`the server's answer was not accepted by the requester: ${back.action} ${back.refusal ?? ""}`);
      if (back.envelope.in_reply_to !== original.id) throw new Error("the answer does not name the request it answers");
      const pv = await personView(a.raw, { cards, now: new Date(c.now) });
      if (pv.verdict !== "matches") throw new Error(`the answer's human part does not match its envelope: ${JSON.stringify(pv.checks.filter((x) => !x.ok))}`);
    }

    const out = translate(c, v, { sent: SENT, reply: answers.length ? "the agent's own answer" : "none" });
    if (v.action === "report") {
      const o = server.outcomesList()[0];
      out.outcome_for_request = { request: o?.request_id, outcome: o?.outcome, status: o?.status };
      if (!mine.some((d) => d.kind === "delivery_report")) throw new Error("the agent was not told of the bounce");
    }
    return out;
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
