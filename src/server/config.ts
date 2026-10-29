// The server's configuration file. Secrets never sit in the file: each one is
// named by the environment variable that holds it (a "...Env" field) or by a
// file that holds it (a "...File" field), and read by that exact name.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { agentKeyFromSeed } from "../envelope/keys.js";
import { ChainResolver, HttpCardResolver, StaticCardResolver, type CardResolver, type RegistrarKey, type Roster } from "../cards.js";
import type { CarrierAdapter } from "../providers/types.js";
import type { ServerOptions } from "./server.js";

export interface SecretRef { env?: string; file?: string; value?: never }

export interface Config {
  agent: {
    /** The agent's seed: from an environment variable or a file (mode 0600). */
    seedEnv?: string;
    seedFile?: string;
    address: string;
    name?: string;
    handle?: string;
    actsFor?: string;
    offerings?: Record<string, string>;
    timeZone?: string;
  };
  carrier: CarrierConfig;
  /** HTTP mode: where deliveries are POSTed, and the bearer token sent with them. */
  agentInterface?: { url: string; tokenEnv?: string };
  http?: { host?: string; port: number; tokenEnv?: string };
  stateDir?: string;
  roster?: Roster;
  /** Name cards: a registrar to resolve against, and/or a local file of signed cards. */
  registrar?: { url: string; keySet?: RegistrarKey[] };
  cardsFile?: string;
  peers?: { agent_id: string; address: string; handle?: string; acts_for?: string }[];
  bridge?: { enabled: boolean; offering?: string };
  strangers?: "knock" | "drop";
  trustedAuthservIds?: string[];
  limits?: { perAddressPerHour?: number; updatesPerTask?: number; maxInboundBytes?: number };
}

export type CarrierConfig =
  | { type: "imap-smtp"; imap: { host: string; port?: number; security?: "tls" | "starttls" | "none"; user: string; passEnv?: string; mailbox?: string; oauth?: GoogleOAuthConfig }; smtp: { host: string; port?: number; security?: "tls" | "starttls" | "none"; user?: string; passEnv?: string; oauth?: GoogleOAuthConfig }; pollMs?: number }
  | { type: "resend"; apiKeyEnv: string; webhookSecretEnv?: string; pollMs?: number }
  | { type: "agentmail"; apiKeyEnv: string; inboxId: string; webhookSecretEnv?: string; baseUrl?: string; pollMs?: number }
  | { type: "cloudflare"; workerUrl?: string; workerSecretEnv: string; accountId?: string; apiTokenEnv?: string }
  | { type: "primitive"; apiKeyEnv: string; webhookSecretEnv?: string; endpointId?: string };

/** A Google service account with domain-wide delegation, acting as the mailbox (XOAUTH2). */
export interface GoogleOAuthConfig { serviceAccountEnv?: string; serviceAccountFile?: string; subject: string }

export function secret(name: string | undefined, what: string): string {
  if (!name) throw new Error(`${what}: no environment variable named`);
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${what}: the environment variable ${name} is not set`);
  return v;
}
const optionalSecret = (name: string | undefined) => (name ? process.env[name] : undefined);

export function loadConfig(path: string): Config & { baseDir: string } {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Config;
  return { ...cfg, baseDir: dirname(resolve(path)) };
}

export async function buildCarrier(c: CarrierConfig, baseDir: string, log?: (l: string) => void): Promise<CarrierAdapter> {
  switch (c.type) {
    case "imap-smtp": {
      const { ImapSmtpCarrier } = await import("../providers/imap-smtp.js");
      const { googleAccessToken } = await import("../providers/google-auth.js");
      const tokenFor = (o?: GoogleOAuthConfig) => {
        if (!o) return undefined;
        const sa = o.serviceAccountFile ? readFileSync(resolve(baseDir, o.serviceAccountFile), "utf8") : secret(o.serviceAccountEnv, "the service account");
        return () => googleAccessToken(sa, o.subject, "https://mail.google.com/");
      };
      return new ImapSmtpCarrier({
        imap: { host: c.imap.host, port: c.imap.port ?? 993, security: c.imap.security ?? "tls", user: c.imap.user, pass: optionalSecret(c.imap.passEnv), accessToken: tokenFor(c.imap.oauth), mailbox: c.imap.mailbox },
        smtp: { host: c.smtp.host, port: c.smtp.port ?? 465, security: c.smtp.security ?? "tls", user: c.smtp.user ?? c.imap.user, pass: optionalSecret(c.smtp.passEnv), accessToken: tokenFor(c.smtp.oauth) },
        pollMs: c.pollMs, log,
      });
    }
    case "resend": {
      const { ResendCarrier } = await import("../providers/resend.js");
      return new ResendCarrier({ apiKey: secret(c.apiKeyEnv, "the Resend API key"), webhookSecret: optionalSecret(c.webhookSecretEnv), pollMs: c.pollMs, log });
    }
    case "agentmail": {
      const { AgentMailCarrier } = await import("../providers/agentmail.js");
      return new AgentMailCarrier({ apiKey: secret(c.apiKeyEnv, "the AgentMail API key"), inboxId: c.inboxId, webhookSecret: optionalSecret(c.webhookSecretEnv), baseUrl: c.baseUrl, pollMs: c.pollMs, log });
    }
    case "cloudflare": {
      const { CloudflareCarrier } = await import("../providers/cloudflare.js");
      return new CloudflareCarrier({ workerUrl: c.workerUrl, accountId: c.accountId, apiToken: optionalSecret(c.apiTokenEnv), workerSecret: secret(c.workerSecretEnv, "the Worker's shared secret"), log });
    }
    case "primitive": {
      const { PrimitiveCarrier } = await import("../providers/primitive.js");
      return new PrimitiveCarrier({ apiKey: secret(c.apiKeyEnv, "the Primitive API key"), webhookSecret: optionalSecret(c.webhookSecretEnv), endpointId: c.endpointId, log });
    }
  }
}

export async function serverOptions(cfg: Config & { baseDir: string }, log: (l: string) => void): Promise<ServerOptions> {
  const seed = cfg.agent.seedFile ? readFileSync(resolve(cfg.baseDir, cfg.agent.seedFile), "utf8").trim() : secret(cfg.agent.seedEnv, "the agent's seed");
  const resolvers: CardResolver[] = [];
  if (cfg.cardsFile) {
    const f = JSON.parse(readFileSync(resolve(cfg.baseDir, cfg.cardsFile), "utf8"));
    resolvers.push(new StaticCardResolver(f.cards, f.key_set));
  }
  if (cfg.registrar) resolvers.push(new HttpCardResolver(cfg.registrar.url, { keySet: cfg.registrar.keySet }));
  return {
    agent: { ...cfg.agent, key: agentKeyFromSeed(seed) },
    carrier: await buildCarrier(cfg.carrier, cfg.baseDir, log),
    stateDir: resolve(cfg.baseDir, cfg.stateDir ?? "state"),
    roster: cfg.roster,
    cards: resolvers.length ? new ChainResolver(resolvers) : undefined,
    peers: cfg.peers,
    bridge: cfg.bridge,
    strangers: cfg.strangers,
    trustedAuthservIds: cfg.trustedAuthservIds,
    agentUrl: cfg.agentInterface?.url,
    agentToken: optionalSecret(cfg.agentInterface?.tokenEnv),
    limits: cfg.limits,
    log,
  };
}
