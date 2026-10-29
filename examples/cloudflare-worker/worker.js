// A Cloudflare Worker that carries Agent Emailing for an Agent Emailing Server.
//
// - email(): Email Routing hands it each message sent to the agent's address.
//   It posts the raw message, unchanged, to the server's /webhooks/cloudflare,
//   signed with the secret the two share. If the server does not take it, the
//   Worker throws, so the message is not silently lost.
// - fetch() POST /send: the server posts a raw MIME message, signed the same
//   way, and the Worker sends it with its send_email binding. Raw MIME keeps
//   the envelope part and every file part exactly as the server built them.
//
// Settings (wrangler.toml): SERVER_URL, the send_email binding EMAIL, and the
// secret SHARED_SECRET (wrangler secret put SHARED_SECRET).
import { EmailMessage } from "cloudflare:email";
import { sign, verify, sha256hex } from "./sig.js";

export default {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const r = await fetch(new URL("/webhooks/cloudflare", env.SERVER_URL), {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-agent-emailing-signature": await sign(raw, env.SHARED_SECRET),
        // The same message gives the same id, so a retry is recognized.
        "x-event-id": await sha256hex(raw),
        "x-envelope-from": message.from,
        "x-envelope-to": message.to,
      },
      body: raw,
    });
    if (!r.ok) throw new Error(`the Agent Emailing Server answered HTTP ${r.status}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/send") return new Response("not found", { status: 404 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (!(await verify(request.headers.get("x-agent-emailing-signature"), body, env.SHARED_SECRET))) {
      return new Response('{"error":"bad signature"}', { status: 401, headers: { "content-type": "application/json" } });
    }
    const { from, to, raw } = JSON.parse(new TextDecoder().decode(body));
    // The server writes 7bit, base64 and quoted-printable only, so the message is ASCII.
    const mime = atob(raw);
    let messageId;
    for (const rcpt of to) {
      const result = await env.EMAIL.send(new EmailMessage(from, rcpt, mime));
      messageId = result?.messageId ?? messageId;
    }
    return Response.json({ messageId });
  },
};
