// The Agent Emailing Server: one agent's email runtime. It watches the agent's
// mailbox through a carrier adapter, checks every email in the order of
// Agent Emailing §7.2, hands verified envelopes to the agent, and sends the
// agent's answers in the same thread.
//
// The agent is reached through a small interface (docs/agent-interface.md):
// a callback when the server runs in the agent's own process, or an HTTP POST
// to the agent's URL. The agent answers in the reply to that call, or later
// through the server's own HTTP API.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, FileRef } from "../envelope/envelope.js";
import { traceFor, uuid7, WIRE_VERSION } from "../envelope/envelope.js";
import type { AgentKey } from "../envelope/keys.js";
import { attachFile, composeAgentEmail } from "../compose.js";
import { emailEndpoint, type CardResolver, type Roster, type Stance } from "../cards.js";
import { IdentityBridge } from "../identity-bridge.js";
import { finishDelivery, receiveEmail, type ReceivedFile, type Verdict } from "../receive.js";
import { DuplicateMemory, Collection } from "../store.js";
import { TaskStore, TERMINAL } from "../tasks.js";
import type { Attachment } from "../mime/mime.js";
import type { CarrierAdapter, InboundMail, StatusEvent } from "../providers/types.js";

// ── what the agent sees and says ────────────────────────────────────────────

/** What the server hands the agent for each admitted email. */
export interface Delivery {
  kind: "request" | "respond" | "delivery_report";
  /** The verified envelope, verbatim. */
  envelope?: Envelope;
  /** A copy of the payload with the sender's text framed (Agent Messaging §22.6).
   *  Give this, never the raw payload text, to a model. */
  payload?: unknown;
  files?: { name?: string; media_type?: string; size?: number; digest?: string; status: ReceivedFile["status"]; content_base64?: string }[];
  sender?: {
    agent_id: string; mode: "native" | "bridged"; tier: string; handle?: string; operator?: string;
    /** For a bridged sender, the address it wrote from (verified by DMARC). */
    address?: string;
  };
  /** For a request: whether an answer can be sent (a verified address exists, §5.3). */
  can_respond?: boolean;
  task?: { task_id: string; state?: string; applied?: boolean; why?: string };
  /** For a delivery report: the request it is about. */
  report?: { request_id?: string; outcome: string; status?: string };
  received_at: string;
}

/** What the agent answers with. The server builds and signs the respond envelope. */
export interface AgentAnswer {
  status: "submitted" | "working" | "input_required" | "auth_required" | "completed" | "failed" | "canceled" | "rejected" | "exhausted";
  text?: string;
  output?: unknown;
  /** For input_required: what is needed (Agent Messaging §6.5). */
  problems?: { input?: string; problem?: string; description: string; expected?: string }[];
  files?: { name: string; media_type: string; content_base64?: string; bytes?: Uint8Array }[];
  error?: { code: string; message: string; retryable?: boolean };
  price?: { amount_micro: number; currency: string };
}

/** A new request the agent sends. `to` is an agent ID; the address comes from
 *  its verified name card or the operator's peer list, never from a handle. */
export interface OutboundRequest {
  to: string;
  offering: string;
  offering_name?: string;
  text?: string;
  input?: unknown;
  files?: { name: string; media_type: string; content_base64?: string; bytes?: Uint8Array }[];
  budget?: Envelope["budget"];
  /** Continue a task: answer an input_required, or cancel with offering "task.cancel". */
  task_id?: string;
  context_id?: string;
  timeout_ms?: number;
}

export interface Signal { at: string; text: string; carrierEventId?: string }

export interface ServerOptions {
  agent: {
    key: AgentKey;
    address: string;
    name?: string;
    handle?: string;
    actsFor?: string;
    /** Offering names from the agent's manifest, by id (Agent Messaging §8.1). */
    offerings?: Record<string, string>;
    timeZone?: string;
  };
  carrier: CarrierAdapter;
  stateDir?: string;
  roster?: Roster;
  cards?: CardResolver;
  /** Peers whose addresses the operator has verified, for outbound requests
   *  to agents with no name card. */
  peers?: { agent_id: string; address: string; handle?: string; acts_for?: string }[];
  bridge?: { enabled: boolean; offering?: string; nodeSeed?: string };
  strangers?: "knock" | "drop";
  trustedAuthservIds?: string[];
  /** Callback mode: the server calls this for every delivery. */
  deliver?: (d: Delivery) => Promise<AgentAnswer | void | undefined>;
  /** HTTP mode: the server POSTs every delivery here. */
  agentUrl?: string;
  agentToken?: string;
  /** Outbound limits, the server's loop protection. */
  limits?: { perAddressPerHour?: number; updatesPerTask?: number; maxInboundBytes?: number };
  clock?: () => Date;
  onSignal?: (s: Signal) => void;
  log?: (line: string) => void;
}

interface RequestRecord {
  id: string;
  from: string;
  offering?: string;
  offeringName?: string;
  task_id?: string;
  context_id?: string;
  trace?: Envelope["trace"];
  respondTo?: { address: string; maxMessageBytes?: number };
  receiverHandle: string;
  messageId?: string;
  references: string[];
  bridgedAddress?: string;
  received_at: string;
  answered?: number;
}

interface SentRecord {
  envelope_id: string;
  type: string;
  to: string;
  address: string;
  carrierId: string;
  messageId?: string;
  offering?: string;
  offeringName?: string;
  sent_at: string;
  outcome?: { state: string; status?: string; at: string };
}

interface HeldRecord {
  key: string;
  sender: string;
  tier: string;
  handle?: string;
  address?: string;
  first_at: string;
  last_at: string;
  count: number;
  kind: "held message" | "knock" | "plain email";
}

export class AgentEmailServer {
  readonly o: ServerOptions;
  private memory: DuplicateMemory;
  private requests: Collection<RequestRecord>;
  private sent: Collection<SentRecord>;
  private events: Collection<number>;
  private held: Collection<HeldRecord>;
  private heldMail: Collection<{
    sender: string; verdict: Verdict; parts: { contentId: string; b64: string }[];
    bridgedFiles: { entry: FileRef; status: ReceivedFile["status"]; b64?: string }[]; at: string;
  }>;
  private pending: Collection<{ delivery: Delivery; request?: RequestRecord; tries: number; next: number }>;
  private outcomes: Collection<{ request_id?: string; message_id?: string; outcome: string; status?: string; at: string }>;
  readonly tasks: TaskStore;
  readonly bridge?: IdentityBridge;
  private rosterFile?: string;
  roster: Roster;
  readonly signals: Signal[] = [];
  private sendTimes = new Map<string, number[]>();
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();

  constructor(o: ServerOptions) {
    this.o = o;
    const dir = o.stateDir;
    if (dir) mkdirSync(dir, { recursive: true });
    this.memory = new DuplicateMemory({ dir, onEvict: (n) => this.signal(`the duplicate memory was full and forgot ${n} entries inside the mailbox window`) });
    this.requests = new Collection(dir, "requests");
    this.sent = new Collection(dir, "sent");
    this.events = new Collection(dir, "carrier-events", 100_000);
    this.held = new Collection(dir, "held-attempts");
    this.heldMail = new Collection(dir, "held-mail");
    this.pending = new Collection(dir, "pending-deliveries");
    this.outcomes = new Collection(dir, "outcomes");
    this.tasks = new TaskStore(dir);
    if (o.bridge?.enabled) this.bridge = new IdentityBridge({ dir: dir ? join(dir, "bridge") : undefined, offering: o.bridge.offering, nodeSeed: o.bridge.nodeSeed });
    this.rosterFile = dir ? join(dir, "roster.json") : undefined;
    this.roster = this.rosterFile && existsSync(this.rosterFile) ? JSON.parse(readFileSync(this.rosterFile, "utf8")) : structuredClone(o.roster ?? {});
  }

  private now(): Date { return this.o.clock ? this.o.clock() : new Date(); }
  private log(line: string): void { (this.o.log ?? ((l) => console.log(l)))(line); }
  private signal(text: string, carrierEventId?: string): void {
    const s = { at: this.now().toISOString(), text, carrierEventId };
    this.signals.push(s);
    if (this.signals.length > 500) this.signals.shift();
    this.o.onSignal?.(s);
    this.log(`signal: ${text}`);
  }
  get self(): string { return this.o.agent.key.id; }

  async start(): Promise<void> {
    this.o.carrier.receive(async (mail) => { await this.enqueue(mail); });
    this.o.carrier.onStatus?.((ev) => this.handleStatus(ev));
    await this.o.carrier.start?.();
    this.timer = setInterval(() => void this.retryPending(), 30_000);
    this.timer.unref();
    this.log(`agent ${this.self} on ${this.o.carrier.name} as ${this.o.agent.address}`);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue;
    await this.o.carrier.close?.();
  }

  /** Inbound mail is handled one email at a time, in arrival order. */
  enqueue(mail: InboundMail): Promise<Verdict | undefined> {
    const run = this.queue.then(() => this.handleInbound(mail));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  async handleInbound(mail: InboundMail): Promise<Verdict | undefined> {
    const now = this.now();
    if (mail.carrierEventId && this.events.has(mail.carrierEventId)) return undefined; // a carrier's retry
    if (mail.raw && mail.raw.length > (this.o.limits?.maxInboundBytes ?? 25 * 1024 * 1024)) {
      this.signal(`an email of ${mail.raw.length} bytes was over the inbound limit and was not read`, mail.carrierEventId);
      if (mail.carrierEventId) this.events.set(mail.carrierEventId, now.getTime());
      return undefined;
    }
    const v = await receiveEmail(mail, {
      self: this.self, memory: this.memory, roster: this.roster, cards: this.o.cards, bridge: this.bridge,
      strangers: this.o.strangers, trustedAuthservIds: this.o.trustedAuthservIds,
      expectedReply: (env) => {
        const sent = env.in_reply_to ? this.findSentByEnvelope(env.in_reply_to) : undefined;
        return Boolean(sent && sent.to === env.from);
      },
    }, { now });
    for (const s of v.signals) this.signal(s, mail.carrierEventId);
    if (mail.carrierEventId) this.events.set(mail.carrierEventId, now.getTime());
    this.log(`inbound ${mail.carrierEventId}: ${v.kind}, ${v.action}${v.refusal ? ` (${v.refusal})` : ""}`);

    switch (v.action) {
      case "report": await this.handleReport(v); break;
      case "knock": this.recordAttempt(v, v.envelope ? "knock" : "plain email"); break;
      case "hold": {
        this.recordAttempt(v, "held message");
        // Kept as received; it is read and checked only when the owner allows it.
        const { heldParts, ...kept } = v;
        const parts = (heldParts ?? []).map((p) => ({ contentId: p.contentId, b64: Buffer.from(p.bytes).toString("base64") }));
        const bridgedFiles = v.mode === "bridged" ? (v.files ?? []).map((f) => ({ entry: f.entry, status: f.status, b64: f.bytes?.toString("base64") })) : [];
        this.heldMail.set(`${v.envelope!.from}\n${v.envelope!.id}`, { sender: v.envelope!.from, verdict: { ...kept, files: undefined }, parts, bridgedFiles, at: now.toISOString() });
        break;
      }
      case "deliver": {
        const { delivery, request } = this.buildDelivery(v);
        await this.dispatch(delivery, request);
        break;
      }
      case "refuse":
        if (v.answer === "CONTEXT_TOO_LARGE" && v.envelope && v.respondTo) {
          const request = this.recordRequest(v);
          await this.respondTo(request, { status: "failed", error: { code: "CONTEXT_TOO_LARGE", message: "The message is over this agent's inbound size cap.", retryable: false } }, true);
        }
        break;
      default: break;
    }
    return v;
  }

  private recordRequest(v: Verdict): RequestRecord {
    const env = v.envelope!;
    const card = v.card;
    const rec: RequestRecord = {
      id: env.id, from: env.from, offering: env.payload?.offering, offeringName: env.meta?.agent_emailing?.offering_name,
      task_id: env.task_id ?? undefined, context_id: env.context_id ?? undefined, trace: env.trace,
      respondTo: v.respondTo ? { address: v.respondTo.address, maxMessageBytes: v.respondTo.maxMessageBytes } : undefined,
      receiverHandle: card?.handle ?? v.bridged?.address ?? env.from,
      messageId: v.messageId, references: v.references ?? [], bridgedAddress: v.bridged?.address,
      received_at: this.now().toISOString(),
    };
    this.requests.set(env.id, rec);
    return rec;
  }

  private buildDelivery(v: Verdict): { delivery: Delivery; request?: RequestRecord } {
    const env = v.envelope!;
    const delivery: Delivery = {
      kind: env.type === "request" ? "request" : "respond",
      envelope: env,
      payload: v.fencedPayload,
      files: (v.files ?? []).map((f) => ({
        name: f.entry.name, media_type: f.entry.media_type, size: f.entry.size, digest: f.entry.digest, status: f.status,
        ...(f.bytes ? { content_base64: f.bytes.toString("base64") } : {}),
      })),
      sender: {
        agent_id: env.from, mode: v.mode ?? "native", tier: v.standing?.tier ?? "anonymous",
        handle: v.card?.handle, operator: v.card?.operator?.name, address: v.bridged?.address,
      },
      received_at: this.now().toISOString(),
    };
    let request: RequestRecord | undefined;
    if (env.type === "request") {
      request = this.recordRequest(v);
      delivery.can_respond = Boolean(request.respondTo);
      if (env.task_id) {
        const t = this.tasks.get(env.task_id);
        if (t && t.role === "performer" && t.peer === env.from) {
          if (env.payload?.offering !== "task.cancel" && (t.state === "input_required" || t.state === "auth_required")) {
            const r = this.tasks.apply(env.task_id, { id: env.id, ts: env.ts, state: "working" }, t);
            delivery.task = { task_id: env.task_id, state: r.record.state, applied: r.applied, why: r.why };
          } else delivery.task = { task_id: env.task_id, state: t.state };
          if (v.messageId) { t.messageIds.push(v.messageId); this.tasks.put(t); }
        } else {
          delivery.task = { task_id: env.task_id, state: undefined, applied: false, why: "no task by this id with this sender" };
        }
      }
    } else if (env.task_id) {
      const status = String(env.payload?.status ?? (env.error ? "failed" : "working"));
      const sent = env.in_reply_to ? this.findSentByEnvelope(env.in_reply_to) : undefined;
      const r = this.tasks.apply(env.task_id, { id: env.id, ts: env.ts, state: status }, {
        role: "requester", peer: env.from, peerAddress: sent?.address, context_id: env.context_id ?? undefined, request_id: env.in_reply_to ?? undefined,
        offering: sent?.offering, offeringName: sent?.offeringName, messageIds: sent?.messageId ? [sent.messageId] : [],
      });
      if (v.messageId && !r.record.messageIds.includes(v.messageId)) { r.record.messageIds.push(v.messageId); this.tasks.put(r.record); }
      delivery.task = { task_id: env.task_id, state: r.record.state, applied: r.applied, why: r.why };
      if (!r.applied) this.signal(`a task update was recorded but not applied: ${r.why}`);
    }
    return { delivery, request };
  }

  /** Hand a delivery to the agent. A failed hand-over is kept and retried:
   *  the duplicate memory already holds the envelope, so the carrier's own
   *  redelivery would be refused. */
  private async dispatch(delivery: Delivery, request?: RequestRecord): Promise<void> {
    let answer: AgentAnswer | void | undefined;
    try {
      answer = await this.callAgent(delivery);
    } catch (e) {
      const key = delivery.envelope ? `${delivery.envelope.from}\n${delivery.envelope.id}` : `report-${uuid7()}`;
      const prev = this.pending.get(key);
      this.pending.set(key, { delivery, request, tries: (prev?.tries ?? 0) + 1, next: Date.now() + 30_000 });
      this.signal(`the agent did not take a delivery, kept for retry: ${(e as Error).message}`);
      return;
    }
    if (answer && request) await this.respondTo(request, answer);
  }

  private async callAgent(d: Delivery): Promise<AgentAnswer | void | undefined> {
    if (this.o.deliver) return this.o.deliver(d);
    if (!this.o.agentUrl) throw new Error("no agent is connected (set deliver or agentUrl)");
    const r = await fetch(this.o.agentUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.o.agentToken ? { authorization: `Bearer ${this.o.agentToken}` } : {}) },
      body: JSON.stringify(d),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`the agent answered HTTP ${r.status}`);
    const text = await r.text();
    if (!text.trim()) return undefined;
    const j = JSON.parse(text) as { respond?: AgentAnswer };
    return j.respond;
  }

  private async retryPending(): Promise<void> {
    const now = Date.now();
    for (const [key, p] of this.pending.entries()) {
      if (p.next > now) continue;
      if (p.tries > 2000 || now - Date.parse(p.delivery.received_at) > 7 * 24 * 3600 * 1000) {
        this.pending.delete(key);
        this.signal(`a delivery the agent never took was dropped after ${p.tries} tries`);
        continue;
      }
      this.pending.delete(key);
      await this.dispatch(p.delivery, p.request);
    }
  }

  private recordAttempt(v: Verdict, kind: HeldRecord["kind"]): void {
    const now = this.now().toISOString();
    const sender = v.envelope?.from ?? `email:${v.knock?.address ?? "unknown"}`;
    const key = v.mode === "bridged" ? `bridged:${v.bridged?.address}` : sender;
    const prev = this.held.get(key);
    // Who knocked, never what they said (EXT-6 §9.1).
    this.held.set(key, {
      key, sender, tier: v.standing?.tier ?? (v.envelope ? "anonymous" : "plain email"), handle: v.card?.handle,
      address: v.bridged?.address ?? (v.envelope ? undefined : v.knock?.address), first_at: prev?.first_at ?? now, last_at: now,
      count: (prev?.count ?? 0) + 1, kind: prev?.kind === "held message" ? "held message" : kind,
    });
    // Waiting entries expire after 30 days without a repeat attempt.
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const h of this.held.values()) if (Date.parse(h.last_at) < cutoff) this.held.delete(h.key);
  }

  // ── the owner's decisions ─────────────────────────────────────────────────

  heldAttempts(): HeldRecord[] { return this.held.values(); }

  /** Allow or block a sender (an agent ID). Allowing releases its held mail to the agent. */
  async decide(sender: string, stance: Stance): Promise<{ released: number }> {
    const entries = (this.roster.entries ?? []).filter((e) => e.subject !== sender);
    entries.push({ subject: sender, stance });
    this.roster = { ...this.roster, entries };
    if (this.rosterFile) writeFileSync(this.rosterFile, JSON.stringify(this.roster, null, 2));
    for (const h of this.held.values()) if (h.sender === sender) this.held.delete(h.key);
    let released = 0;
    for (const [key, m] of this.heldMail.entries()) {
      if (m.sender !== sender) continue;
      this.heldMail.delete(key);
      if (stance !== "allow") continue;
      released++;
      const v: Verdict = { ...m.verdict, action: "deliver" };
      if (v.mode === "bridged") v.files = m.bridgedFiles.map((f) => ({ entry: f.entry, status: f.status, bytes: f.b64 ? Buffer.from(f.b64, "base64") : undefined }));
      finishDelivery(v, m.parts.map((p) => ({ contentId: p.contentId, bytes: Buffer.from(p.b64, "base64") })), this.now());
      const { delivery, request } = this.buildDelivery(v);
      await this.dispatch(delivery, request);
    }
    return { released };
  }

  // ── delivery reports (§8) ─────────────────────────────────────────────────

  private findSentByEnvelope(id: string): SentRecord | undefined {
    return this.sent.values().find((s) => s.envelope_id === id);
  }

  private async handleReport(v: Verdict): Promise<void> {
    const r = v.report!;
    const sent = r.originalMessageId ? this.sent.values().find((s) => s.messageId === r.originalMessageId) : undefined;
    await this.recordOutcome(sent, { outcome: r.outcome, status: r.status, messageId: r.originalMessageId });
  }

  async handleStatus(ev: StatusEvent): Promise<void> {
    const sent = this.sent.get(ev.carrierId) ?? (ev.messageId ? this.sent.values().find((s) => s.messageId === ev.messageId) : undefined);
    const outcome = ev.state === "bounced" ? "undeliverable" : ev.state === "deferred" ? "deferred" : ev.state;
    await this.recordOutcome(sent, { outcome, status: ev.dsnStatus, messageId: ev.messageId });
  }

  private async recordOutcome(sent: SentRecord | undefined, o: { outcome: string; status?: string; messageId?: string }): Promise<void> {
    const at = this.now().toISOString();
    if (sent) { sent.outcome = { state: o.outcome, status: o.status, at }; this.sent.set(sent.carrierId, sent); }
    const rec = { request_id: sent?.envelope_id, message_id: o.messageId ?? sent?.messageId, outcome: o.outcome, status: o.status, at };
    this.outcomes.set(`${rec.message_id ?? uuid7()}\n${o.outcome}`, rec);
    if (o.outcome === "delivered") return;
    if (!sent) { this.signal(`a delivery report for an email this agent has no record of (${o.messageId ?? "no Message-ID"})`); return; }
    await this.dispatch({ kind: "delivery_report", report: { request_id: sent.envelope_id, outcome: o.outcome, status: o.status }, received_at: at });
  }

  outcomesList() { return this.outcomes.values(); }

  /** Import a record of an email this agent sent before, so a later delivery
   *  report can be matched to it (§8). For migrations and tests. */
  rememberSent(rec: { envelope_id: string; type?: string; to: string; address: string; carrierId?: string; messageId?: string }): void {
    const carrierId = rec.carrierId ?? `imported-${rec.envelope_id}`;
    this.sent.set(carrierId, { type: "request", ...rec, carrierId, sent_at: this.now().toISOString() });
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  private offeringName(id: string | undefined, fallback?: string): string {
    return (id && this.o.agent.offerings?.[id]) ?? fallback ?? id ?? "a request";
  }

  /** Loop protection: a cap on emails to one address per hour, and never to ourselves. */
  private checkRate(address: string): void {
    const a = address.toLowerCase();
    if (a === this.o.agent.address.toLowerCase()) throw new Error("refusing to send email to this agent's own address");
    const limit = this.o.limits?.perAddressPerHour ?? 120;
    const now = Date.now();
    const list = (this.sendTimes.get(a) ?? []).filter((t) => now - t < 3600_000);
    if (list.length >= limit) throw new Error(`refusing to send: ${limit} emails to ${a} in the last hour`);
    list.push(now);
    this.sendTimes.set(a, list);
  }

  private filesToAttachments(files: AgentAnswer["files"]): { entries: FileRef[]; attachments: Attachment[] } {
    const entries: FileRef[] = [], attachments: Attachment[] = [];
    const domain = this.o.agent.address.split("@")[1];
    for (const f of files ?? []) {
      const bytes = f.bytes ?? Buffer.from(f.content_base64 ?? "", "base64");
      const a = attachFile(bytes, { name: f.name, media_type: f.media_type, domain });
      entries.push(a.entry); attachments.push(a.attachment);
    }
    return { entries, attachments };
  }

  /** Answer a request the agent was handed. */
  async respond(requestId: string, answer: AgentAnswer): Promise<{ envelope: Envelope; messageId?: string }> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`no request ${requestId} is known`);
    return this.respondTo(request, answer);
  }

  private async respondTo(request: RequestRecord, answer: AgentAnswer, isRefusal = false): Promise<{ envelope: Envelope; messageId?: string }> {
    if (!request.respondTo) throw new Error("there is no verified address to answer (Agent Emailing §5.3)");
    const now = this.now();
    let taskId = request.task_id;
    if (!taskId) {
      // Over email every answer is in task mode (§8): the first one opens the task.
      const existing = this.tasks.all().find((t) => t.role === "performer" && t.request_id === request.id);
      taskId = existing?.task_id ?? uuid7();
      request.task_id = taskId;
      this.requests.set(request.id, request);
    }
    const task = this.tasks.get(taskId);
    const maxUpdates = this.o.limits?.updatesPerTask ?? 50;
    if (task && task.history.length >= maxUpdates) throw new Error(`refusing to send: task ${taskId} already has ${maxUpdates} updates`);
    if (task?.state && TERMINAL.has(task.state)) throw new Error(`task ${taskId} is already ${task.state}`);
    const { entries, attachments } = this.filesToAttachments(answer.files);
    const env: Envelope = {
      v: WIRE_VERSION, id: uuid7(), type: "respond", ts: now.toISOString(), from: this.self, to: request.from,
      trace: traceFor(request.trace), task_id: taskId, in_reply_to: request.id, ...(request.context_id ? { context_id: request.context_id } : {}),
      payload: {
        status: answer.status,
        ...(answer.text !== undefined ? { text: answer.text } : {}),
        ...(answer.output !== undefined ? { output: answer.output } : {}),
        ...(answer.problems ? { problems: answer.problems } : {}),
        ...(answer.price ? { price: answer.price } : {}),
      },
      ...(answer.error ? { error: answer.error } : {}),
      ...(entries.length ? { artifacts: [{ id: uuid7(), name: entries.length === 1 ? entries[0]!.name : "Files", parts: entries, created_at: now.toISOString() }] } : {}),
    };
    const applied = this.tasks.apply(taskId, { id: env.id, ts: env.ts, state: answer.status }, {
      role: "performer", peer: request.from, peerAddress: request.respondTo.address, context_id: request.context_id,
      offering: request.offering, offeringName: request.offeringName, request_id: request.id,
    });
    if (!applied.applied && !isRefusal) throw new Error(`the answer was not sent: ${applied.why}`);
    const threadIds = [...new Set([...request.references, ...(request.messageId ? [request.messageId] : [])])];
    const out = await this.sendEnvelope(env, {
      address: request.respondTo.address, receiverHandle: request.receiverHandle,
      offeringName: this.offeringName(request.offering, request.offeringName), attachments,
      inReplyTo: request.messageId, references: threadIds, maxMessageBytes: request.respondTo.maxMessageBytes,
    });
    if (out.messageId) { applied.record.messageIds.push(out.messageId); this.tasks.put(applied.record); }
    request.answered = (request.answered ?? 0) + 1;
    this.requests.set(request.id, request);
    return out;
  }

  /** Send a new request, or continue or cancel a task. */
  async request(r: OutboundRequest): Promise<{ envelope: Envelope; messageId?: string }> {
    const now = this.now();
    const card = this.o.cards ? await this.o.cards.byAgentId(r.to, now) : undefined;
    const peer = this.o.peers?.find((p) => p.agent_id === r.to);
    const ep = emailEndpoint(card) ?? (peer ? { address: peer.address, max_message_bytes: undefined } : undefined);
    if (!ep) throw new Error(`no verified email address for ${r.to}: it needs a name card with an email endpoint, or an entry in peers (Agent Emailing §5)`);
    const task = r.task_id ? this.tasks.get(r.task_id) : undefined;
    if (r.task_id && (!task || task.role !== "requester" || task.peer !== r.to)) throw new Error(`no task ${r.task_id} with ${r.to}`);
    const { entries, attachments } = this.filesToAttachments(r.files);
    const env: Envelope = {
      v: WIRE_VERSION, id: uuid7(), type: "request", ts: now.toISOString(), from: this.self, to: r.to, trace: traceFor(),
      ...(r.task_id ? { task_id: r.task_id } : {}),
      context_id: r.context_id ?? task?.context_id ?? uuid7(),
      ...(r.budget ? { budget: r.budget } : {}),
      payload: {
        offering: r.offering,
        ...(r.text !== undefined ? { text: r.text } : {}),
        ...(r.input !== undefined ? { input: r.input } : {}),
        ...(entries.length ? { files: entries } : {}),
        // Email can take hours or days; a short timeout means nothing here (§8).
        config: { timeout_ms: r.timeout_ms ?? 3 * 24 * 3600 * 1000 },
      },
    };
    if (task && r.offering !== "task.cancel" && (task.state === "input_required" || task.state === "auth_required")) {
      this.tasks.apply(task.task_id, { id: env.id, ts: env.ts, state: "working" }, task);
    }
    const threadIds = task?.messageIds ?? [];
    const out = await this.sendEnvelope(env, {
      address: ep.address, receiverHandle: card?.handle ?? peer?.handle ?? r.to,
      offeringName: r.offering_name ?? task?.offeringName ?? r.offering, attachments,
      inReplyTo: threadIds[threadIds.length - 1], references: threadIds, maxMessageBytes: ep.max_message_bytes,
    });
    if (task && out.messageId) { task.messageIds.push(out.messageId); this.tasks.put(task); }
    return out;
  }

  private async sendEnvelope(env: Envelope, t: {
    address: string; receiverHandle: string; offeringName: string; attachments: Attachment[];
    inReplyTo?: string; references?: string[]; maxMessageBytes?: number;
  }): Promise<{ envelope: Envelope; messageId?: string }> {
    this.checkRate(t.address);
    const a = this.o.agent;
    const { envelope, mail } = composeAgentEmail({
      envelope: env, key: a.key,
      human: { sender: { handle: a.handle ?? a.key.id, actsFor: a.actsFor }, receiver: { handle: t.receiverHandle }, offeringName: t.offeringName, timeZone: a.timeZone },
      from: { name: a.name, address: a.address }, to: [{ address: t.address }], attachments: t.attachments,
      inReplyTo: t.inReplyTo, references: t.references?.length ? t.references : undefined,
      maxMessageBytes: Math.min(t.maxMessageBytes ?? Infinity, this.o.carrier.capabilities().maxOutboundBytes || Infinity),
    });
    const res = await this.o.carrier.send(mail);
    this.sent.set(res.carrierId, {
      envelope_id: envelope.id, type: envelope.type, to: envelope.to!, address: t.address, carrierId: res.carrierId,
      messageId: res.messageId, offering: envelope.payload?.offering, offeringName: t.offeringName, sent_at: this.now().toISOString(),
    });
    this.log(`sent ${envelope.type} ${envelope.id} to ${t.address} (${res.messageId ?? res.carrierId})`);
    return { envelope, messageId: res.messageId };
  }

  /** The delivery outcome of a sent email, asking the carrier (§8). */
  async status(carrierId: string) { return this.o.carrier.status(carrierId); }
}
