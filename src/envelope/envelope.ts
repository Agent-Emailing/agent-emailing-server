// The Agent Messaging envelope (Agent Messaging §5): its shape, canonical JSON
// (RFC 8785, §5.3) and the tagged Ed25519 signature over it.
import { sign, verify, createHash, randomBytes } from "node:crypto";
import { publicKeyFromId, type AgentKey } from "./keys.js";

/** One file entry: a request's `payload.files` item or a respond artifact's
 *  `ref` part (Agent Messaging §7.5). */
export interface FileRef {
  name?: string;
  media_type?: string;
  ref?: string;
  uri?: string;
  size?: number;
  digest?: string;
  [k: string]: unknown;
}

export interface Artifact {
  id?: string;
  name?: string;
  media_type?: string;
  parts?: FileRef[];
  created_at?: string;
  [k: string]: unknown;
}

export interface Envelope {
  v: string;
  id: string;
  type: "request" | "respond" | "register" | "discover" | "emit" | "subscribe" | string;
  ts: string;
  from: string;
  to?: string;
  trace: { trace_id: string; span_id: string; parent_span_id?: string | null; tracestate?: string };
  task_id?: string | null;
  in_reply_to?: string | null;
  context_id?: string | null;
  budget?: { deadline?: string; revision?: number; cost_ceiling?: { amount_micro: number; currency: string }; [k: string]: unknown };
  error?: { code?: string; message?: string; retryable?: boolean; details?: unknown; [k: string]: unknown } | null;
  payload?: any;
  artifacts?: Artifact[];
  meta?: Record<string, any>;
  sig?: string;
}

/** The wire version this implementation sends (Agent Messaging §5.2). */
export const WIRE_VERSION = "0.3.0";

/** The domain tag inside the envelope's signed bytes (Agent Messaging §5.3). */
export const ENVELOPE_TAG = "agentmesh-envelope-v1\n";

/** Canonical JSON (RFC 8785) under Agent Messaging's two rules: absent members
 *  are omitted, and a present null is a value. JavaScript's own number and
 *  string serialization is the one RFC 8785 specifies, and its default sort is
 *  the UTF-16 code unit order RFC 8785 requires. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("NaN and Infinity are not JSON values");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`not a JSON value: ${typeof v}`);
}

/** The bytes `sig` covers: the tag, then the canonical envelope without `sig`. */
export function signedBytes(env: Envelope): Buffer {
  const { sig: _sig, ...rest } = env;
  return Buffer.from(ENVELOPE_TAG + canonical(rest), "utf8");
}

/** Sign an envelope with the agent's key. Returns a new object; `from` must be
 *  the key's agent ID. */
export function signEnvelope(env: Envelope, key: AgentKey): Envelope {
  if (env.from !== key.id) throw new Error("the envelope's from is not this key");
  const { sig: _sig, ...rest } = env;
  return { ...rest, sig: sign(null, signedBytes(rest as Envelope), key.privateKey).toString("base64url") };
}

/** Verify `sig` against `from` (Agent Messaging §5.3, step 1). */
export function verifyEnvelope(env: unknown): boolean {
  const e = env as Envelope;
  if (!e || typeof e !== "object" || typeof e.sig !== "string" || typeof e.from !== "string") return false;
  try {
    return verify(null, signedBytes(e), publicKeyFromId(e.from), Buffer.from(e.sig, "base64url"));
  } catch {
    return false;
  }
}

export const sha256hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** A UUIDv7 (time-ordered), as Agent Messaging §5.2 recommends for `id`. */
export function uuid7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A fresh W3C trace context, or a child of `parent`. */
export function traceFor(parent?: { trace_id: string; span_id: string }): Envelope["trace"] {
  const span_id = randomBytes(8).toString("hex");
  return parent
    ? { trace_id: parent.trace_id, span_id, parent_span_id: parent.span_id }
    : { trace_id: randomBytes(16).toString("hex"), span_id, parent_span_id: null };
}
