// An OAuth access token for a Google Workspace mailbox, from a service account
// with domain-wide delegation (RFC 7523 JWT bearer grant). IMAP and SMTP use
// it through XOAUTH2. Tokens are cached until a minute before they expire.
import { createSign } from "node:crypto";

const cache = new Map<string, { token: string; until: number }>();
const b64u = (b: string | Buffer) => Buffer.from(b).toString("base64url");

export async function googleAccessToken(serviceAccountJson: string, subject: string, scope: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string };
  const key = `${sa.client_email}\n${subject}\n${scope}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: sa.client_email, sub: subject, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64u(sig)}` }),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`the token was refused: ${j.error ?? r.status} ${j.error_description ?? ""}`.trim());
  cache.set(key, { token: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 60) * 1000 });
  return j.access_token;
}
