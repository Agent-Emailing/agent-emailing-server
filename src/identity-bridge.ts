// Bridged mode (Agent Emailing §4.2, Agent Messaging §4.15): a person or an
// agent sends plain email to an address this server serves. With an aligned
// DMARC pass as the credential, the bridge hosts one lasting mesh identity
// per sender address, keyed by caller_ref, and signs an envelope for it that
// says, in its signed meta, that it is bridged.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Envelope } from "./envelope/envelope.js";
import { sha256hex, signEnvelope, traceFor, WIRE_VERSION } from "./envelope/envelope.js";
import { agentKeyFromSeed, createAgentKey, type AgentKey } from "./envelope/keys.js";
import { Collection } from "./store.js";

export interface IdentityBridgeMarker {
  bridge: string;
  caller_kind: "email";
  caller_ref: string;
  front: "email";
}

/** caller_ref: the lowercase hex SHA-256 of the sender's addr-spec, lowercased (§4.2). */
export const callerRefFor = (address: string): string => sha256hex(Buffer.from(address.trim().toLowerCase(), "utf8"));

/** A UUID derived from a seed string, so that a redelivered email yields the
 *  same envelope id and the duplicate memory catches it. */
function derivedUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x80; // version 8: custom
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export class IdentityBridge {
  private identities: Collection<{ seed: string; created_at: string }>;
  readonly node: AgentKey;
  constructor(opts: { dir?: string; nodeSeed?: string; offering?: string }) {
    if (opts.dir) mkdirSync(opts.dir, { recursive: true });
    this.identities = new Collection(opts.dir, "bridged-identities");
    const stored = this.identities.get("__node__");
    this.node = opts.nodeSeed ? agentKeyFromSeed(opts.nodeSeed) : stored ? agentKeyFromSeed(stored.seed) : createAgentKey();
    if (!opts.nodeSeed && !stored) this.identities.set("__node__", { seed: this.node.seed, created_at: new Date().toISOString() });
    this.offering = opts.offering ?? "message";
  }
  /** The offering a bridged plain email is asked on. Agent Emailing does not
   *  name one, so it is configuration. */
  readonly offering: string;

  /** The hosted identity for a sender address: the same key every time. */
  host(address: string): { key: AgentKey; callerRef: string } {
    const callerRef = callerRefFor(address);
    let rec = this.identities.get(callerRef);
    if (!rec) {
      rec = { seed: createAgentKey().seed, created_at: new Date().toISOString() };
      this.identities.set(callerRef, rec);
    }
    return { key: agentKeyFromSeed(rec.seed), callerRef };
  }

  /** Is this agent ID one the bridge hosts? Returns its caller_ref. */
  hosts(agentId: string): string | undefined {
    for (const [ref, rec] of this.identities.entries()) {
      if (ref !== "__node__" && agentKeyFromSeed(rec.seed).id === agentId) return ref;
    }
    return undefined;
  }

  marker(callerRef: string): IdentityBridgeMarker {
    return { bridge: this.node.id, caller_kind: "email", caller_ref: callerRef, front: "email" };
  }

  /** Sign a request for a plain email's sender. The text and subject become
   *  the payload; files are listed by digest and their bytes travel beside the
   *  envelope (§3.4: a bridge delivers the bytes with the envelope). */
  envelopeFor(opts: {
    address: string; to: string; messageId?: string; text: string; subject?: string;
    files?: { name?: string; media_type: string; size: number; digest: string }[]; now: Date;
  }): { envelope: Envelope; marker: IdentityBridgeMarker } {
    const { key, callerRef } = this.host(opts.address);
    const marker = this.marker(callerRef);
    const id = derivedUuid(`agent-emailing bridged\n${callerRef}\n${opts.messageId ?? `${opts.subject}\n${opts.text}`}`);
    const env: Envelope = {
      v: WIRE_VERSION, id, type: "request", ts: opts.now.toISOString(), from: key.id, to: opts.to, trace: traceFor(),
      payload: {
        offering: this.offering,
        text: opts.text,
        ...(opts.subject ? { subject: opts.subject } : {}),
        ...(opts.files?.length ? { files: opts.files } : {}),
      },
      meta: { identity_bridge: marker },
    };
    return { envelope: signEnvelope(env, key), marker };
  }

  /** The key to sign with when answering as a hosted identity is never needed:
   *  answers go from the receiving agent. This returns the hosted key only for
   *  tests and tools. */
  keyFor(address: string): AgentKey { return this.host(address).key; }
}
