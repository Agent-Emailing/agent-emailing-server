// The human part and the subject (Agent Emailing §3.3): generated from the
// envelope and from what the verified name cards state, summarized in the
// envelope's signed meta.agent_emailing, and checked the way software that
// shows the text to a person checks it.
//
// renderHuman produces the same text as the reference generator of the
// conformance fixtures, so a test can rebuild every fixture's human part and
// get the digest its envelope signs.
import type { Envelope, FileRef } from "./envelope/envelope.js";
import { sha256hex, verifyEnvelope } from "./envelope/envelope.js";
import { decodeWords, header, leaves, textOf, type MimePart } from "./mime/mime.js";

export const EMAILING_VERSION = "0.2.0";
export const ENVELOPE_MEDIA_TYPE = "application/vnd.agentmessaging.envelope+json";

const OUTCOME: Record<string, string> = {
  completed: "done", input_required: "needs your input", auth_required: "needs your input",
  rejected: "declined", failed: "failed", canceled: "canceled", exhausted: "stopped at its limit",
  submitted: "in progress", working: "in progress",
};

/** The state word of the subject table in §3.3. */
export function stateOf(env: Envelope): string {
  if (env.type === "request") {
    if (env.payload?.offering === "task.cancel") return "cancel";
    return env.task_id ? "answer" : "request";
  }
  return OUTCOME[env.payload?.status] ?? (env.error ? "failed" : "update");
}

export const isSealed = (env: Envelope): boolean => env.payload?.v === "sealedpayload.v1";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The subject: the offering in words, a dash, and the state. Every email in a
 *  thread except the first begins with "Re: ". */
export function subjectFor(env: Envelope, offeringName: string): string {
  const base = `${offeringName} — ${stateOf(env)}`;
  return env.type === "respond" || env.task_id ? `Re: ${base}` : base;
}

/** §3.3: decoded to Unicode, line endings made LF, spaces and tabs at the end
 *  of each line removed, empty lines at the end removed. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
}
export const textDigest = (text: string): string => `sha256:${sha256hex(Buffer.from(normalizeText(text), "utf8"))}`;
export const htmlDigest = (bytes: Uint8Array): string => `sha256:${sha256hex(bytes)}`;

export const money = (c: { amount_micro: number; currency: string }): string => `${(c.amount_micro / 1e6).toFixed(2)} ${c.currency}`;

const ZONE_NAMES: Record<string, string> = {
  "America/Denver": "Mountain time", "America/Phoenix": "Mountain time", "America/New_York": "Eastern time",
  "America/Chicago": "Central time", "America/Los_Angeles": "Pacific time", UTC: "UTC", "Etc/UTC": "UTC",
};

/** A time in words, in the reader's time zone (UTC when it is not known). */
export function when(iso: string, tz = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${ZONE_NAMES[tz] ?? tz}`;
}

const fileLine = (f: FileRef) => `${f.name ?? "a file"} (${f.media_type}, ${f.size} bytes)`;
export const returnedFiles = (env: Envelope): FileRef[] => (env.artifacts ?? []).flatMap((a) => (a.parts ?? []).filter((x) => x.ref));

const NEXT: Record<string, string> = {
  "needs your input": "Reply with what is asked for. The work waits for your answer.",
  declined: "Nothing will be done. You may ask another agent.",
  failed: "The work stopped. You may try again later.",
  canceled: "The work was stopped. Nothing more will happen.",
  "stopped at its limit": "The work reached its agreed limit. Files made so far are attached.",
  "in progress": "The work continues. Updates will arrive in this thread.",
};

/** What the human part is generated from, besides the envelope. Every value
 *  comes from a verified name card or the receiving agent's manifest. */
export interface HumanContext {
  /** The sender's handle from its verified card, or its agent ID when it has none. */
  sender: { handle: string; actsFor?: string };
  receiver: { handle: string };
  /** The offering's name in the receiving agent's manifest, or its id. */
  offeringName: string;
  /** The reader's time zone, where the sender knows it. */
  timeZone?: string;
}

/** The human part's text (§3.3). */
export function renderHuman(env: Envelope, ctx: HumanContext): string {
  const p = env.payload ?? {};
  const sealed = isSealed(env);
  const forWhom = ctx.sender.actsFor ? `, acting for ${ctx.sender.actsFor},` : "";
  const state = stateOf(env);
  const tz = ctx.timeZone ?? "UTC";
  const L: string[] = [];
  if (env.type === "request") {
    const kind = ({ request: "Request", answer: "Answer to a question", cancel: "Cancellation" } as Record<string, string>)[state];
    L.push(`${kind} from ${ctx.sender.handle}${forWhom} to ${ctx.receiver.handle}.`, "");
    L.push(`Asked for: ${ctx.offeringName}`);
    if (sealed) L.push("Message: sealed. Only the receiving agent can read it.");
    else if (typeof p.text === "string") L.push(`Message: ${p.text}`);
    const files: FileRef[] = sealed ? [] : p.files ?? [];
    L.push(`Handed over: ${files.length ? files.map(fileLine).join("; ") : sealed ? "anything attached is sealed" : "nothing"}`);
    if (env.budget?.cost_ceiling) L.push(`Price: up to ${money(env.budget.cost_ceiling)}`);
    if (env.budget?.deadline) L.push(`Answer needed by: ${when(env.budget.deadline, tz)}`);
    L.push(`What happens next: ${state === "answer"
      ? `${ctx.receiver.handle} continues the work with this answer. Its reply will arrive in this thread.`
      : state === "cancel" ? `${ctx.receiver.handle} stops the work and confirms in this thread.`
      : `${ctx.receiver.handle} will do the work or ask for what it needs. Its answer will arrive in this thread.`}`);
  } else {
    L.push(`Answer from ${ctx.sender.handle}${forWhom} to ${ctx.receiver.handle}, about ${ctx.offeringName}.`, "");
    L.push(`Outcome: ${cap(state)}`);
    if (sealed) L.push("Result: sealed. Only the receiving agent can read it.");
    else if (typeof p.text === "string") L.push(`Result: ${p.text}`);
    else if (env.error?.message) L.push(`Result: ${env.error.message}`);
    if (!sealed && Array.isArray(p.problems) && p.problems.length) L.push(`Needed from you: ${p.problems.map((x: { description?: string }) => x.description).join(" ")}`);
    const files = sealed ? [] : returnedFiles(env);
    L.push(`Files returned: ${files.length ? files.map(fileLine).join("; ") : "none"}`);
    if (p.price) L.push(`Price: ${money(p.price)}`);
    L.push(`What happens next: ${state === "done"
      ? files.length ? "Nothing more is needed. Open the attached files to use the result." : "Nothing more is needed."
      : NEXT[state] ?? "Updates will arrive in this thread."}`);
  }
  L.push("", "--",
    "Generated from the signed Agent Emailing envelope (envelope.json).",
    "Agents act only on the envelope. Software that checks Agent Emailing",
    "confirms that this text matches it.");
  return L.join("\n");
}

/** Add the signed summary of §3.3 to an unsigned envelope. The text is made
 *  first, from the envelope without the summary; then the summary is added;
 *  then the caller signs. */
export function withHuman(env: Envelope, ctx: HumanContext): { env: Envelope; text: string; subject: string } {
  const { agent_emailing: _old, ...otherMeta } = env.meta ?? {};
  const bare: Envelope = { ...env, meta: Object.keys(otherMeta).length ? otherMeta : undefined };
  if (!bare.meta) delete bare.meta;
  const text = renderHuman(bare, ctx);
  const subject = subjectFor(bare, ctx.offeringName);
  const meta = { ...otherMeta, agent_emailing: { v: EMAILING_VERSION, offering_name: ctx.offeringName, subject, human_text: textDigest(text) } };
  return { env: { ...bare, meta }, text, subject };
}

// ── the check software runs before it shows the text to a person ────────────

export interface PersonCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PersonView {
  /** "matches": every check passed. "warn": the signature verifies but the
   *  text or subject differs from what was signed. "fail": the signature does
   *  not verify, so nothing in the email can be trusted. */
  verdict: "matches" | "warn" | "fail";
  checks: PersonCheck[];
  /** What the signed envelope says, to show in place of the text on a warning. */
  signed?: { sender: string; offering: string; state: string; text?: string; files: string[]; price?: string };
  text: string;
  subject: string;
}

/** The check of §3.3 for software that shows the human part to a person.
 *  `senderHandle` is the handle from the sender's verified name card; when the
 *  sender has none, the text must name its agent ID instead. */
export function checkHuman(mail: MimePart, env: Envelope | undefined, senderHandle?: string): PersonView {
  const textPart = leaves(mail).find((p) => p.type === "text/plain" && !/attachment/i.test(header(p, "content-disposition") ?? ""));
  const htmlPart = leaves(mail).find((p) => p.type === "text/html" && !/attachment/i.test(header(p, "content-disposition") ?? ""));
  const text = textPart ? textOf(textPart) : "";
  const subject = decodeWords(header(mail.headers, "subject"));
  const checks: PersonCheck[] = [];
  const sigOk = Boolean(env) && verifyEnvelope(env);
  checks.push({ name: "signature", ok: sigOk, detail: sigOk ? "the envelope's signature verifies" : env ? "the envelope's signature does not verify" : "there is no envelope" });
  if (!env || !sigOk) return { verdict: "fail", checks, text, subject };

  const ae = env.meta?.agent_emailing ?? {};
  const norm = normalizeText(text);
  const p = env.payload ?? {};
  const sealed = isSealed(env);
  checks.push({ name: "text digest", ok: Boolean(textPart) && ae.human_text === textDigest(text), detail: textPart ? undefined : "there is no text part" });
  if (htmlPart || ae.human_html) checks.push({ name: "html digest", ok: Boolean(htmlPart) && ae.human_html === htmlDigest(htmlPart!.bytes) });
  checks.push({ name: "subject", ok: Boolean(ae.subject) && ae.subject === subject });
  const states = (v: string | undefined | null, name: string) => {
    if (v === undefined || v === null || v === "") return;
    checks.push({ name, ok: norm.includes(v) });
  };
  states(senderHandle ?? env.from, "states the sender");
  states(ae.offering_name ?? "", "states what was asked");
  if (!ae.offering_name) checks.push({ name: "states what was asked", ok: false, detail: "the envelope has no offering_name" });
  const files: string[] = [];
  if (!sealed) {
    if (typeof p.text === "string") states(p.text, "states the message word for word");
    for (const f of [...(p.files ?? []), ...returnedFiles(env)] as FileRef[]) if (f.name) { files.push(f.name); states(f.name, `names the file ${f.name}`); }
  }
  if (env.type === "respond") states(`Outcome: ${cap(stateOf(env))}`, "states the outcome");
  let price: string | undefined;
  if (env.budget?.cost_ceiling) { price = money(env.budget.cost_ceiling); states(price, "states the price"); }
  if (!sealed && p.price) { price = money(p.price); states(price, "states the price"); }
  const ok = checks.every((c) => c.ok);
  return {
    verdict: ok ? "matches" : "warn",
    checks,
    signed: { sender: senderHandle ?? env.from, offering: ae.offering_name ?? p.offering ?? "", state: stateOf(env), text: sealed ? undefined : p.text, files, price },
    text,
    subject,
  };
}
