// Name cards (Personal Agent Naming §5.1, §5.3) and how a receiver uses them:
// a native sender's standing (Agent Emailing §6.2), the handle the human part
// and the frame name, and the email endpoint a respond may go to (§5.3).
import { createPublicKey, verify } from "node:crypto";
import { canonical, sha256hex } from "./envelope/envelope.js";

export interface NameCard {
  handle: string;
  operator?: { name?: string };
  binding?: string;
  endpoints?: { protocol: string; agent_id?: string; address?: string; max_message_bytes?: number }[];
  registrar?: string;
  issued_at: string;
  expires_at: string;
  [k: string]: unknown;
}

export interface SignedCard {
  card: NameCard;
  registrar_key: string;
  registrar_kid: string;
  registrar_sig: string;
}

export interface RegistrarKey { kid: string; key: string; status?: string }

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const GRACE_MS = 60_000;

export const kidOf = (key: string): string => sha256hex(Buffer.from(key, "utf8")).slice(0, 12);

/** Verify a signed card for an agent key: the registrar's signature under a
 *  key of its published set, the validity window (with a minute's grace), a
 *  key binding, and an agentmesh endpoint naming `agentId`. Returns the card
 *  or undefined. */
export function verifyCard(resp: SignedCard | undefined, keySet: RegistrarKey[], agentId: string, at: Date): NameCard | undefined {
  if (!resp?.card) return undefined;
  if (!keySet.some((k) => k.key === resp.registrar_key && k.kid === resp.registrar_kid && k.status !== "revoked")) return undefined;
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(resp.registrar_key, "base64url")]), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(canonical(resp.card), "utf8"), pub, Buffer.from(resp.registrar_sig, "base64"))) return undefined;
  } catch {
    return undefined;
  }
  const c = resp.card;
  const t = at.getTime();
  if (!(Date.parse(c.issued_at) <= t + GRACE_MS && t <= Date.parse(c.expires_at) + GRACE_MS)) return undefined;
  if (!String(c.binding ?? "").startsWith("agent-key")) return undefined;
  if (!(c.endpoints ?? []).some((e) => e.protocol === "agentmesh" && e.agent_id === agentId)) return undefined;
  return c;
}

/** The card's email endpoint (Agent Emailing §5.1). */
export const emailEndpoint = (card: NameCard | undefined): { address: string; max_message_bytes?: number } | undefined => {
  const e = card?.endpoints?.find((x) => x.protocol === "email" && typeof x.address === "string");
  return e ? { address: e.address!, max_message_bytes: e.max_message_bytes } : undefined;
};

/** Finds the verified card bound to an agent key (reverse resolution,
 *  Personal Agent Naming §5.4). */
export interface CardResolver {
  byAgentId(agentId: string, at: Date): Promise<NameCard | undefined>;
}

/** Cards held locally, for tests, for a fixed set of peers, or as a cache. */
export class StaticCardResolver implements CardResolver {
  constructor(private cards: Record<string, SignedCard>, private keySet: RegistrarKey[]) {}
  async byAgentId(agentId: string, at: Date): Promise<NameCard | undefined> {
    return verifyCard(this.cards[agentId], this.keySet, agentId, at);
  }
}

/** Reverse resolution against a registrar over HTTPS:
 *  GET <registrar>/api/resolve?agent_id=<key>. The registrar's key set is
 *  pinned from configuration, or fetched once from /api/registrar-key and then
 *  kept (Personal Agent Naming §5.3: a pinned key that changes is refused). */
export class HttpCardResolver implements CardResolver {
  private pinned?: RegistrarKey[];
  private cache = new Map<string, { card?: NameCard; at: number }>();
  constructor(private registrar: string, opts: { keySet?: RegistrarKey[]; cacheMs?: number; fetch?: typeof fetch } = {}) {
    this.pinned = opts.keySet;
    this.cacheMs = opts.cacheMs ?? 5 * 60_000;
    this.fetcher = opts.fetch ?? fetch;
  }
  private cacheMs: number;
  private fetcher: typeof fetch;
  private async keys(): Promise<RegistrarKey[]> {
    if (this.pinned) return this.pinned;
    const r = await this.fetcher(new URL("/api/registrar-key", this.registrar));
    if (!r.ok) throw new Error(`registrar key set: HTTP ${r.status}`);
    const j = (await r.json()) as { key_set?: RegistrarKey[] };
    this.pinned = (j.key_set ?? []).filter((k) => k.kid === kidOf(k.key));
    return this.pinned;
  }
  async byAgentId(agentId: string, at: Date): Promise<NameCard | undefined> {
    const hit = this.cache.get(agentId);
    if (hit && Date.now() - hit.at < this.cacheMs && (!hit.card || Date.parse(hit.card.expires_at) > at.getTime())) return hit.card;
    let card: NameCard | undefined;
    try {
      const u = new URL("/api/resolve", this.registrar);
      u.searchParams.set("agent_id", agentId);
      const r = await this.fetcher(u, { headers: { accept: "application/json" } });
      if (r.ok) {
        const signed = (await r.json()) as SignedCard;
        card = verifyCard(signed, await this.keys(), agentId, at);
        if (card && card.registrar && new URL(card.registrar).origin !== new URL(this.registrar).origin) card = undefined;
      }
    } catch {
      card = undefined;
    }
    this.cache.set(agentId, { card, at: Date.now() });
    return card;
  }
}

/** Several resolvers, asked in order. */
export class ChainResolver implements CardResolver {
  constructor(private list: CardResolver[]) {}
  async byAgentId(agentId: string, at: Date): Promise<NameCard | undefined> {
    for (const r of this.list) { const c = await r.byAgentId(agentId, at); if (c) return c; }
    return undefined;
  }
}

// ── admission (EXT-6) ───────────────────────────────────────────────────────

export type Tier = "rostered" | "contact" | "registered" | "bridged" | "anonymous";
export type Stance = "allow" | "hold" | "block";

export interface Roster {
  /** Explicit entries by agent key (EXT-6 §3). */
  entries?: { subject: string; stance: Stance }[];
  /** Accepted contacts: agent keys this agent knows (EXT-6 §2). */
  contacts?: string[];
  /** Stances by tier. The defaults are EXT-6 §10's: contact allows,
   *  registered and bridged hold, anonymous blocks. */
  defaults?: Partial<Record<Tier, Stance>>;
}

export const DEFAULT_STANCES: Record<Tier, Stance> = { rostered: "allow", contact: "allow", registered: "hold", bridged: "hold", anonymous: "block" };

export interface Standing {
  tier: Tier;
  stance: Stance;
  /** The tier's default stance, before any explicit entry. */
  defaultStance: Stance;
  card?: NameCard;
  /** How the sender's identity was established (Agent Emailing §6.2). */
  basis: "roster" | "contact" | "name card" | "node vouch" | "bridge" | "none";
}

/** Sort a sender into a tier and find its stance. Most specific wins: an
 *  explicit entry, then the contact list, then the tier's default. */
export function admit(opts: { from: string; roster: Roster; card?: NameCard; vouched?: boolean; bridged?: boolean }): Standing {
  const defaults = { ...DEFAULT_STANCES, ...(opts.roster.defaults ?? {}) };
  const entry = opts.roster.entries?.find((e) => e.subject === opts.from);
  let tier: Tier;
  let basis: Standing["basis"];
  if (entry) { tier = "rostered"; basis = "roster"; }
  else if (opts.roster.contacts?.includes(opts.from)) { tier = "contact"; basis = "contact"; }
  else if (opts.bridged) { tier = "bridged"; basis = "bridge"; }
  else if (opts.vouched) { tier = "registered"; basis = "node vouch"; }
  else if (opts.card) { tier = "registered"; basis = "name card"; }
  else { tier = "anonymous"; basis = "none"; }
  const defaultStance = defaults[tier];
  return { tier, stance: entry ? entry.stance : defaultStance, defaultStance, card: opts.card, basis };
}
