// The signature the Worker and the server share: "t=<unix seconds>,v1=<hex>",
// HMAC-SHA256 over "<t>.<body>". Web Crypto only, so it runs in a Worker and
// in Node alike.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret, t, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const head = enc.encode(`${t}.`);
  const data = new Uint8Array(head.length + body.length);
  data.set(head, 0);
  data.set(body, head.length);
  return hex(await crypto.subtle.sign("HMAC", key, data));
}

export async function sign(body, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmac(secret, t, body)}`;
}

export async function verify(header, body, secret, toleranceS = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=")));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS || !parts.v1) return false;
  const want = await hmac(secret, parts.t, body);
  if (want.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

export async function sha256hex(body) {
  return hex(await crypto.subtle.digest("SHA-256", body));
}
