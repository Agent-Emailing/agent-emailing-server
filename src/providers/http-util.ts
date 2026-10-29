// Small pieces the API carriers share: webhook signature checks and a JSON
// fetch that honours Retry-After.
import { createHmac, timingSafeEqual } from "node:crypto";

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Svix webhook signatures (used by Resend and AgentMail): HMAC-SHA256 over
 *  "<svix-id>.<svix-timestamp>.<raw body>", keyed with the base64 secret
 *  after its "whsec_" prefix; the header holds space-separated "v1,<base64>". */
export function verifySvix(headers: Record<string, string>, body: Buffer, secret: string, toleranceS = 300, now = Date.now()): boolean {
  const id = headers["svix-id"], ts = headers["svix-timestamp"], sig = headers["svix-signature"];
  if (!id || !ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", key).update(`${id}.${ts}.`).update(body).digest();
  return sig.split(" ").some((s) => {
    const [ver, val] = s.split(",");
    return ver === "v1" && val !== undefined && safeEqual(Buffer.from(val, "base64"), want);
  });
}

/** Make a Svix signature, for tests and mocks. */
export function signSvix(id: string, ts: number, body: Buffer | string, secret: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.`).update(body).digest("base64")}`;
}

/** A "t=<unix seconds>,v1=<hex>" signature: HMAC-SHA256 over "<t>.<raw body>"
 *  (Primitive's Primitive-Signature, and this server's own Worker relay). */
export function verifyTimestamped(header: string | undefined, body: Buffer, secret: string, toleranceS = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceS || !parts.v1) return false;
  const want = createHmac("sha256", secret).update(`${parts.t}.`).update(body).digest();
  return safeEqual(Buffer.from(parts.v1, "hex"), want);
}

export function signTimestamped(body: Buffer | string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string, what: string) { super(`${what}: HTTP ${status} ${body.slice(0, 300)}`); }
}

/** fetch JSON with a bearer key; waits out a 429's Retry-After a few times. */
export async function apiJson<T>(f: typeof fetch, url: string, init: RequestInit & { what: string }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await f(url, init);
    if (r.status === 429 && attempt < 3) {
      const wait = Math.min(Number(r.headers.get("retry-after") ?? "1") || 1, 30);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new ApiError(r.status, text, init.what);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Download bytes from a signed URL (no auth header: the URL carries it). */
export async function download(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const r = await f(url, { headers });
  if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => ""), "download");
  return Buffer.from(await r.arrayBuffer());
}

/** Headers as a plain lowercase map. */
export const headerMap = (h: [string, string][]): Record<string, string> => Object.fromEntries(h.map(([k, v]) => [k.toLowerCase(), v]));
