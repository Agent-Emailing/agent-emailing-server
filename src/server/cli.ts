#!/usr/bin/env node
// agent-emailing-server: run the server, make a key, or check an email.
//
//   agent-emailing-server serve --config config.json
//   agent-emailing-server keygen --out state/agent.seed
//   agent-emailing-server check message.eml [--as <agent id>] [--cards cards.json] [--now <time>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createAgentKey } from "../envelope/keys.js";
import { StaticCardResolver } from "../cards.js";
import { DuplicateMemory } from "../store.js";
import { personView, receiveEmail } from "../receive.js";
import { AgentEmailServer } from "./server.js";
import { loadConfig, secret, serverOptions } from "./config.js";
import { startHttp } from "./http.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function serve() {
  const path = flag("config") ?? "config.json";
  const cfg = loadConfig(path);
  const server = new AgentEmailServer(await serverOptions(cfg, log));
  await server.start();
  if (cfg.http) {
    const token = cfg.http.tokenEnv ? secret(cfg.http.tokenEnv, "the HTTP API token") : undefined;
    if (!token) log("the HTTP API has no token, so only /healthz and /webhooks answer");
    await startHttp(server, { host: cfg.http.host, port: cfg.http.port, token });
    log(`listening on ${cfg.http.host ?? "127.0.0.1"}:${cfg.http.port}`);
  }
  const stop = async () => { log("stopping"); await server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function keygen() {
  const out = flag("out");
  const k = createAgentKey();
  if (out) {
    if (existsSync(out)) throw new Error(`${out} exists; not overwriting a key`);
    writeFileSync(out, k.seed + "\n", { mode: 0o600 });
    console.log(`agent id: ${k.id}\nseed written to ${out}`);
  } else {
    console.log(`agent id: ${k.id}\nseed:     ${k.seed}\nKeep the seed secret.`);
  }
}

async function check() {
  const file = args[1];
  if (!file) throw new Error("check needs a .eml file");
  const raw = readFileSync(file);
  const now = flag("now") ? new Date(flag("now")!) : new Date();
  const cardsFile = flag("cards");
  const cards = cardsFile ? (() => { const f = JSON.parse(readFileSync(cardsFile, "utf8")); return new StaticCardResolver(f.cards, f.key_set); })() : undefined;
  const pv = await personView(raw, { cards, now });
  console.log(`For a person: ${pv.verdict === "matches" ? "the text matches the signed message" : pv.verdict === "warn" ? "WARNING: the text differs from the signed message" : "FAIL: do not trust this email"}`);
  for (const c of pv.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (pv.verdict === "warn" && pv.signed) console.log(`  The signed message says: ${JSON.stringify(pv.signed)}`);
  const as = flag("as");
  if (as) {
    const v = await receiveEmail(raw, { self: as, memory: new DuplicateMemory(), cards, roster: { contacts: [] } }, { now });
    console.log(`For the agent ${as.slice(0, 10)}…: ${v.action}${v.refusal ? ` (${v.refusal})` : ""}${v.standing ? `, ${v.standing.tier} sender` : ""}`);
    for (const s of v.signals) console.log(`  signal: ${s}`);
    for (const f of v.files ?? []) console.log(`  file ${f.entry.name}: ${f.status}`);
  }
}

const cmd = args[0];
const run = cmd === "serve" ? serve : cmd === "keygen" ? keygen : cmd === "check" ? check : undefined;
if (!run) {
  console.log("usage:\n  agent-emailing-server serve --config config.json\n  agent-emailing-server keygen [--out file]\n  agent-emailing-server check message.eml [--as <agent id>] [--cards cards.json] [--now <time>]");
  process.exit(cmd ? 2 : 0);
}
Promise.resolve(run()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
