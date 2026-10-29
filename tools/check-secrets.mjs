#!/usr/bin/env node
// Fails when a file git would commit looks like it holds a secret: an agent
// seed, a JWT, a private key, an email provider's API key or webhook secret,
// a cloud or service token, a password in a URL, or a file named like a
// credential.
//
//   node tools/check-secrets.mjs [--self-test]
//
// The test vectors the specifications publish are seeds by shape and control
// nothing; each is allowed by its exact value, with the reason, so a new seed
// anywhere still fails.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PATTERNS = [
  ["agent seed", /\bS[UACON][A-Z2-7]{54,56}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["service account key", /"private_key"\s*:\s*"-----BEGIN/g],
  ["Resend API key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g],
  ["webhook secret", /\bwhsec_[A-Za-z0-9+/=]{20,}/g],
  ["Primitive key", /\b(prim_oat_|prim_|pconn_)[A-Za-z0-9]{20,}\b/g],
  ["AgentMail key", /\bam_[A-Za-z0-9_-]{24,}/g],
  ["token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[\w-]{10,}|npm_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,})\b/g],
  ["password in a URL", /\b(imaps?|smtps?|postgres(?:ql)?|mysql|redis|amqps?|https?):\/\/[^\s"'@/:]+:[^\s"'@/]{3,}@[^\s"']+/gi],
];

const ALLOWED = [
  [/^SUAEGDPNTWXACIF45CA23BUY36RIMWZXW5LEHSEOK2ONS5JWJ7PBC2EWBA$/, "Agent Messaging's published test identity, the fixtures' requester"],
  [/^SUAKVYKT5CTPSYGY5O33NNA6Y55KPSJBUBC32V7BXOQ6JLZB4YMV32IDIY$/, "Agent Emailing's published test responder"],
  [/^SUAIS7DHJA747AXDSEES5OCJD5ARXEJXL4UNHE76CQHO26EU6VLTGBYZEE$/, "Agent Emailing's published test third party"],
  [/^SUAOCZP4AUB3CI4DVIVMCTM2K6SFGXVH62ZFQ4UEQA25WONA3KAZJMB4U4$/, "Agent Emailing's published test registrar"],
];

function scan(name, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [kind, re] of PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (ALLOWED.some(([v]) => v.test(m[0]))) continue;
        out.push(`FINDING  ${kind.padEnd(20)} ${name}:${i + 1}  ${m[0].slice(0, 12)}...`);
      }
    }
  });
  return out;
}

if (process.argv.includes("--self-test")) {
  // Built from pieces, so this file does not hold what it looks for.
  const bad = ["SU" + "A".repeat(56), "re" + "_AbCdEfGh_0123456789abcdefXYZ", "whsec" + "_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "imaps://agent:" + "hunter22@mail.example.org", "\"private_key\": \"" + "-----BEGIN " + "PRIVATE KEY-----"];
  const missed = bad.filter((b) => scan("self-test", b).length === 0);
  const good = ["SUAEGDPNTWXACIF45CA23BUY36RIMWZXW5LEHSEOK2ONS5JWJ7PBC2EWBA", "re_test", "apiKeyEnv: RESEND_API_KEY"];
  const flagged = good.filter((g) => scan("self-test", g).length > 0);
  if (missed.length || flagged.length) { console.log({ missed, flagged }); process.exit(1); }
  console.log("self-test passed");
}

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter((f) => f && existsSync(join(ROOT, f)));

let found = 0;
for (const f of files) {
  if (/(^|\/)\.env(\.(?!example$)|$)|\.(pem|key|p12|pfx|creds|nk|token|password|seed)$|(^|\/)id_(rsa|ed25519)$/.test(f)) {
    console.log(`FINDING  credential-shaped file  ${f}`);
    found++;
  }
  const buf = readFileSync(join(ROOT, f));
  if (buf.includes(0)) continue;
  const findings = scan(f, buf.toString("utf8"));
  findings.forEach((x) => console.log(x));
  found += findings.length;
}
console.log(`${files.length} files checked, ${found} finding(s).`);
process.exit(found ? 1 : 0);
