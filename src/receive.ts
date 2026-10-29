// Receiving an email (Agent Emailing §7.2), in the spec's order of checks:
//
//   1. the carrier's webhook signature (the adapter's job, before this runs)
//   2. parse; a delivery status notification goes to §8; automatic mail to §7.3
//   3. find the envelope parts: none goes to §4.2 or §4.3, more than one is refused
//   4. parse the envelope and verify its signature
//   5. duplicates, then freshness, then addressing and size
//   6. the sender's standing and admission
//   7. resolve the cid: references
//   8. hand the envelope to the agent, its payload text fenced
//
// The result carries two verdicts: one for the agent (deliver, hold or
// refuse, with the reason) and, on request, one for software that shows the
// email to a person (matches, warn or fail, with each check).
import type { Envelope, FileRef } from "./envelope/envelope.js";
import { sha256hex, verifyEnvelope } from "./envelope/envelope.js";
import { isAgentId } from "./envelope/keys.js";
import { admit, emailEndpoint, type CardResolver, type NameCard, type Roster, type Standing } from "./cards.js";
import { parseDsn, isAutoSubmitted, type DeliveryReport } from "./dsn.js";
import { checkHuman, ENVELOPE_MEDIA_TYPE, EMAILING_VERSION, isSealed, returnedFiles, stateOf, type PersonView } from "./human.js";
import { IdentityBridge, type IdentityBridgeMarker } from "./identity-bridge.js";
import { hasAlignedDmarcPass, parseAuthResults, type AuthResults } from "./mailauth.js";
import {
  contentId, decodeWords, filenameOf, firstAddress, header, leaves, parseMail, parseMessageIds, textOf, type MimePart,
} from "./mime/mime.js";
import {
  DEFAULT_MAX_INBOUND_CHARS, fencePayload, isAddressedTo, isFresh, isOversize, MAILBOX_MAX_AGE_MS, MAX_CLOCK_SKEW_AHEAD_MS,
} from "./protections.js";
import type { InboundMail } from "./providers/types.js";
import type { DuplicateMemory } from "./store.js";

export interface ReceiverOptions {
  /** This agent's ID. */
  self: string;
  /** The (from, id) memory. It must persist (§7.1). */
  memory: DuplicateMemory;
  roster?: Roster;
  /** Reverse resolution of sender keys to verified name cards (§6.2). */
  cards?: CardResolver;
  /** Whether the registry says a node vouches for this key (§6.2 item 1).
   *  There is no registry over email; a deployment may plug one in. */
  vouched?: (agentId: string) => Promise<boolean>;
  /** Revoked and stopped keys, refused as Agent Messaging §5.3 step 2 says. */
  revoked?: (agentId: string) => Promise<boolean>;
  /** A respond we asked for: admitted without a roster entry. */
  expectedReply?: (env: Envelope) => boolean;
  /** Bridged mode (§4.2). Without it, plain email is never bridged. */
  bridge?: IdentityBridge;
  /** What happens to plain email from a sender no bridge hosts (§4.3):
   *  a content-free held attempt for the owner ("knock", the default), or nothing ("drop"). */
  strangers?: "knock" | "drop";
  /** Authentication-Results authserv-ids to trust, for carriers that give no
   *  results through their API. */
  trustedAuthservIds?: string[];
  maxAgeMs?: number;
  skewAheadMs?: number;
  maxInboundChars?: number;
  /** Also run the check of §3.3 for software that shows the email to a person. */
  personView?: boolean;
}

export type FileStatus = "verified" | "digest_mismatch" | "unresolvable";

export interface ReceivedFile {
  entry: FileRef;
  status: FileStatus;
  /** The decoded bytes, only when verified. */
  bytes?: Buffer;
}

export type Refusal =
  | "more than one envelope part" | "INVALID_ENVELOPE" | "IDENTITY_MISMATCH" | "not carried by email"
  | "duplicate" | "stale" | "misaddressed" | "CONTEXT_TOO_LARGE" | "UNAUTHORIZED" | "blocked"
  | "automatic reply" | "no envelope and no admitted bridged sender" | "no aligned DMARC pass, so no bridged identity"
  | "KNOCK_CARRIES_NO_MESSAGE";

export interface Verdict {
  /** What kind of email it was. */
  kind: "agent email" | "delivery report" | "automatic" | "plain";
  /** What happens for the agent. "knock" records a content-free held attempt;
   *  "report" is a delivery report for the sender's own records. */
  action: "deliver" | "hold" | "refuse" | "knock" | "drop" | "report";
  refusal?: Refusal;
  /** Local signals raised (Agent Messaging §22.7). Never sent to the sender. */
  signals: string[];
  /** Whether a respond may be sent at all: only to a request, and only to a
   *  verified address (§5.3). Refusals at steps 3 to 5 are silent. */
  respondTo?: { address: string; basis: "name card" | "dmarc"; maxMessageBytes?: number };
  /** For CONTEXT_TOO_LARGE, the one refusal that is answered. */
  answer?: "CONTEXT_TOO_LARGE";
  mode?: "native" | "bridged";
  envelope?: Envelope;
  /** A copy of the payload with the sender text framed (§22.6). */
  fencedPayload?: unknown;
  files?: ReceivedFile[];
  standing?: Standing;
  card?: NameCard;
  state?: string;
  task?: string;
  correlatesTo?: string;
  /** Hint headers that disagreed with the envelope (§3.5). */
  hintMismatch?: string[];
  bridged?: { marker: IdentityBridgeMarker; address: string };
  report?: DeliveryReport;
  /** A plain email's sender, for a knock: who, never what they said. */
  knock?: { address?: string; dmarcPass: boolean };
  person?: PersonView;
  /** The parsed email, for the server's threading. */
  messageId?: string;
  references?: string[];
  fromAddress?: string;
  auth?: AuthResults;
}

/** Turn a carrier's inbound mail into a MIME tree. With the raw message it is
 *  parsed; without it, the tree is rebuilt from the headers, text and
 *  attachments the carrier gave. */
export function toMime(input: InboundMail | Uint8Array | string): MimePart {
  if (typeof input === "string" || input instanceof Uint8Array) return parseMail(input);
  if (input.raw) return parseMail(input.raw);
  const leaf = (type: string, bytes: Uint8Array, extra: [string, string][] = [], params: Record<string, string> = {}): MimePart =>
    ({ headers: [["content-type", type], ...extra], type, params, parts: [], bytes: Buffer.from(bytes), encoding: "binary" });
  const parts: MimePart[] = [];
  if (input.text !== undefined) parts.push(leaf("text/plain", Buffer.from(input.text, "utf8"), [], { charset: "utf-8" }));
  if (input.html !== undefined) parts.push(leaf("text/html", Buffer.from(input.html, "utf8"), [], { charset: "utf-8" }));
  for (const a of input.attachments) {
    const extra: [string, string][] = [["content-disposition", `attachment${a.filename ? `; filename="${a.filename}"` : ""}`]];
    if (a.contentId) extra.push(["content-id", `<${a.contentId.replace(/^<|>$/g, "")}>`]);
    parts.push(leaf(a.contentType.split(";")[0]!.trim().toLowerCase(), a.bytes, extra, a.filename ? { name: a.filename } : {}));
  }
  const headers = input.headers.map(([k, v]) => [k.toLowerCase(), v] as [string, string]).filter(([k]) => k !== "content-type");
  return { headers, type: "multipart/mixed", params: {}, parts, bytes: Buffer.alloc(0), encoding: "7bit" };
}

const isEnvelopePart = (p: MimePart) => p.type === ENVELOPE_MEDIA_TYPE;

/** The body text of a plain email, for a bridged request. */
function plainText(mail: MimePart): string {
  const t = leaves(mail).find((p) => p.type === "text/plain" && !/attachment/i.test(header(p, "content-disposition") ?? ""));
  if (t) return textOf(t).replace(/\r\n?/g, "\n").trim();
  const h = leaves(mail).find((p) => p.type === "text/html");
  return h ? textOf(h).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim() : "";
}

/** The person view on its own: what a mail program concludes (§3.3). */
export async function personView(input: InboundMail | Uint8Array | string, opts: { cards?: CardResolver; now?: Date } = {}): Promise<PersonView> {
  const mail = toMime(input);
  const parts = leaves(mail).filter(isEnvelopePart);
  let env: Envelope | undefined;
  if (parts.length === 1) { try { env = JSON.parse(parts[0]!.bytes.toString("utf8")); } catch { env = undefined; } }
  let handle: string | undefined;
  if (env && verifyEnvelope(env) && opts.cards) handle = (await opts.cards.byAgentId(env.from, opts.now ?? new Date()))?.handle;
  return checkHuman(mail, env, handle);
}

/** Receive one email. */
export async function receiveEmail(input: InboundMail | Uint8Array | string, o: ReceiverOptions, ctx: { now?: Date; auth?: AuthResults } = {}): Promise<Verdict> {
  const now = ctx.now ?? new Date();
  const mail = toMime(input);
  const signals: string[] = [];
  const fromAddress = firstAddress(header(mail, "from"))?.toLowerCase();
  const auth = ctx.auth ?? (typeof input === "object" && !(input instanceof Uint8Array) ? input.auth : undefined)
    ?? (o.trustedAuthservIds?.length ? parseAuthResults(mail.headers, o.trustedAuthservIds, fromAddress) : undefined);
  const base = {
    signals, fromAddress, auth,
    messageId: parseMessageIds(header(mail, "message-id"))[0],
    references: [...parseMessageIds(header(mail, "references"))],
  };

  // Step 2: a delivery status notification answers a message we sent (§8).
  const dsn = parseDsn(mail);
  if (dsn) return { ...base, kind: "delivery report", action: "report", report: dsn };
  if (mail.type === "multipart/report") {
    // Other reports (disposition notifications, feedback) are never answered (§7.3).
    return { ...base, kind: "automatic", action: "drop", refusal: "automatic reply" };
  }
  const automatic = isAutoSubmitted(mail);

  // Step 3: the envelope parts, wherever they sit in the tree.
  const envParts = leaves(mail).filter(isEnvelopePart);
  if (envParts.length > 1) {
    signals.push("an email with more than one envelope part was refused");
    return { ...base, kind: "agent email", action: "refuse", refusal: "more than one envelope part" };
  }
  if (envParts.length === 0) {
    if (automatic) return { ...base, kind: "automatic", action: "drop", refusal: "automatic reply" };
    return receivePlain(mail, o, now, base);
  }

  // Step 4: parse and verify. Values, never bytes (§3.2).
  let env: Envelope;
  try {
    env = JSON.parse(envParts[0]!.bytes.toString("utf8"));
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("not an object");
  } catch {
    signals.push("an envelope part that is not JSON was refused");
    return { ...base, kind: "agent email", action: "refuse", refusal: "INVALID_ENVELOPE", ...(o.personView ? { person: checkHuman(mail, undefined) } : {}) };
  }
  if (!verifyEnvelope(env)) {
    signals.push(`an envelope whose signature does not verify was refused (claimed from ${String(env.from).slice(0, 12)}…)`);
    return { ...base, kind: "agent email", action: "refuse", refusal: "IDENTITY_MISMATCH", ...(o.personView ? { person: checkHuman(mail, env) } : {}) };
  }
  const verdict = await afterVerify(env, mail, o, now, { ...base, kind: "agent email", mode: "native" });
  if (o.personView) verdict.person = checkHuman(mail, env, verdict.card?.handle ?? (o.cards ? (await o.cards.byAgentId(env.from, now))?.handle : undefined));
  return verdict;
}

type Base = Pick<Verdict, "signals" | "fromAddress" | "auth" | "messageId" | "references"> & Partial<Verdict>;

/** Steps 5 to 8, for a verified envelope (native, or signed by our bridge). */
async function afterVerify(env: Envelope, mail: MimePart, o: ReceiverOptions, now: Date, base: Base & { kind: Verdict["kind"]; mode: "native" | "bridged" }): Promise<Verdict> {
  const signals = base.signals;
  const v: Verdict = { ...base, action: "refuse", envelope: env } as Verdict;
  if (env.type !== "request" && env.type !== "respond") {
    signals.push(`a ${env.type} envelope was refused: it does not travel by email (§2.2)`);
    return { ...v, refusal: "not carried by email" };
  }
  // Step 5: remember first, then judge (Agent Messaging §22.2).
  if (typeof env.id !== "string" || !env.id || o.memory.remember(env.from, env.id, now.getTime())) {
    signals.push(`a duplicate envelope was refused (${env.id})`);
    return { ...v, refusal: "duplicate" };
  }
  if (!isFresh(env.ts, now, o.maxAgeMs ?? MAILBOX_MAX_AGE_MS, o.skewAheadMs ?? MAX_CLOCK_SKEW_AHEAD_MS)) {
    signals.push(`a stale envelope was refused (ts ${env.ts})`);
    return { ...v, refusal: "stale" };
  }
  if (!isAddressedTo(env, o.self)) {
    signals.push(`an envelope addressed to another agent was refused (to ${String(env.to).slice(0, 12)}…)`);
    return { ...v, refusal: "misaddressed" };
  }
  if (o.revoked && (await o.revoked(env.from))) {
    signals.push(`an envelope from a revoked or stopped key was refused`);
    return { ...v, refusal: "UNAUTHORIZED" };
  }

  // Hint headers never change what is done (§3.5).
  const hints: [string, unknown][] = [
    ["agent-messaging-type", env.type], ["agent-messaging-task", env.task_id ?? undefined],
    ["agent-messaging-context", env.context_id ?? undefined], ["agent-emailing-version", env.meta?.agent_emailing?.v ?? EMAILING_VERSION],
  ];
  const mismatch = hints.filter(([h, val]) => { const got = header(mail, h); return got !== undefined && got.trim() !== String(val ?? ""); }).map(([h]) => h);
  if (mismatch.length) { v.hintMismatch = mismatch; signals.push(`hint headers disagree with the envelope: ${mismatch.join(", ")}`); }

  v.state = stateOf(env);
  if (env.task_id) v.task = env.task_id;
  if (env.type === "respond" && env.in_reply_to) v.correlatesTo = env.in_reply_to;

  // Step 6: standing and admission.
  const card = base.mode === "native" && o.cards ? await o.cards.byAgentId(env.from, now) : undefined;
  if (card) v.card = card;
  const vouched = base.mode === "native" && o.vouched ? await o.vouched(env.from) : false;
  const standing = admit({ from: env.from, roster: o.roster ?? {}, card, vouched, bridged: base.mode === "bridged" });
  if (env.type === "respond" && o.expectedReply?.(env) && standing.stance !== "block") standing.stance = "allow";
  v.standing = standing;

  // Where a respond may go (§5.3): the card's email endpoint, or the From
  // address of an email with an aligned DMARC pass. Never Reply-To.
  const ep = emailEndpoint(card);
  if (ep) v.respondTo = { address: ep.address, basis: "name card", maxMessageBytes: ep.max_message_bytes };
  else if (base.fromAddress && hasAlignedDmarcPass(base.auth, base.fromAddress)) v.respondTo = { address: base.fromAddress, basis: "dmarc" };

  // The size cap is the one refusal that is answered (Agent Messaging §22.7).
  if (isOversize(env.payload, o.maxInboundChars ?? DEFAULT_MAX_INBOUND_CHARS)) {
    signals.push("inbound_oversize: an envelope over the inbound size cap was refused");
    return { ...v, refusal: "CONTEXT_TOO_LARGE", answer: env.type === "request" && v.respondTo ? "CONTEXT_TOO_LARGE" : undefined };
  }

  // A knock is content-free and never reaches the agent (EXT-6 §9.3).
  if (env.type === "request" && env.payload?.offering === "knock") {
    const input = env.payload?.input ?? {};
    const allowed = ["grants", "via", "ask"];
    if (typeof input !== "object" || Object.keys(input).some((k) => !allowed.includes(k)) || env.payload?.text !== undefined || (env.payload?.files ?? []).length) {
      return { ...v, refusal: "KNOCK_CARRIES_NO_MESSAGE", respondTo: undefined };
    }
    return { ...v, action: "knock", respondTo: undefined };
  }

  if (standing.stance === "block") {
    signals.push(`a ${standing.tier} sender was blocked`);
    return { ...v, refusal: "blocked", respondTo: undefined };
  }

  // Step 7: cid: references, resolved only inside this email (§3.4).
  v.files = resolveFiles(env, mail);
  // Step 8: a copy of the payload with the sender text fenced (§22.6).
  v.fencedPayload = fencePayload(env.payload, {
    from: env.from, received_at: now.toISOString(), trace: env.trace,
    handle: card?.handle, operator: card?.operator?.name, audience: env.meta?.audience === "person" ? "person" : undefined,
  }).payload;
  if (env.type === "respond") v.respondTo = undefined; // a respond is never answered by email
  return { ...v, action: standing.stance === "hold" ? "hold" : "deliver" };
}

/** Resolve every cid: entry against this email's parts, checking size and digest. */
export function resolveFiles(env: Envelope, mail: MimePart): ReceivedFile[] {
  if (isSealed(env)) return [];
  const entries = [...((env.payload?.files ?? []) as FileRef[]), ...returnedFiles(env)].filter((f) => typeof f?.ref === "string" && f.ref.startsWith("cid:"));
  const all = leaves(mail);
  return entries.map((entry) => {
    const cid = entry.ref!.slice(4);
    const part = all.find((p) => contentId(p) === cid);
    if (!part) return { entry, status: "unresolvable" as const };
    const ok = part.bytes.length === entry.size && `sha256:${sha256hex(part.bytes)}` === entry.digest;
    return ok ? { entry, status: "verified" as const, bytes: part.bytes } : { entry, status: "digest_mismatch" as const };
  });
}

/** An email with no envelope part (§4.2, §4.3). */
async function receivePlain(mail: MimePart, o: ReceiverOptions, now: Date, base: Base): Promise<Verdict> {
  const dmarcPass = hasAlignedDmarcPass(base.auth, base.fromAddress);
  if (o.bridge && dmarcPass && base.fromAddress) {
    const files = leaves(mail).filter((p) => /attachment/i.test(header(p, "content-disposition") ?? "") || (p.type !== "text/plain" && p.type !== "text/html"));
    const fileBytes = files.map((p) => ({ entry: { name: filenameOf(p), media_type: p.type, size: p.bytes.length, digest: `sha256:${sha256hex(p.bytes)}` } as FileRef, bytes: p.bytes }));
    const { envelope, marker } = o.bridge.envelopeFor({
      address: base.fromAddress, to: o.self, messageId: base.messageId, text: plainText(mail),
      subject: decodeWords(header(mail, "subject")) || undefined, files: fileBytes.map((f) => f.entry as { name?: string; media_type: string; size: number; digest: string }), now,
    });
    const v = await afterVerify(envelope, mail, o, now, { ...base, kind: "plain", mode: "bridged" });
    v.bridged = { marker, address: base.fromAddress };
    // The bridge delivers the file bytes with the envelope (§3.4).
    if (v.action === "deliver" || v.action === "hold") v.files = fileBytes.map((f) => ({ entry: f.entry, status: "verified" as const, bytes: f.bytes }));
    return v;
  }
  const refusal: Refusal = o.bridge ? "no aligned DMARC pass, so no bridged identity" : "no envelope and no admitted bridged sender";
  if ((o.strangers ?? "knock") === "drop") return { ...base, kind: "plain", action: "drop", refusal };
  return { ...base, kind: "plain", action: "knock", refusal, knock: { address: base.fromAddress, dmarcPass } };
}

/** True when a string is a well-formed agent ID. Re-exported for callers. */
export { isAgentId };
