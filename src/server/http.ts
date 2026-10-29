// The server's HTTP listener: the agent's API, the owner's decisions, and the
// carriers' webhooks. See docs/agent-interface.md.
//
//   GET  /healthz                         no token
//   POST /webhooks/<carrier>              no token; the adapter checks the carrier's signature
//   POST /v1/respond                      answer a request
//   POST /v1/request                      send a request, continue a task, or cancel one
//   GET  /v1/held                         who is waiting: held senders and knocks (never what they said)
//   POST /v1/held/<sender>                {"stance":"allow"|"block"}
//   GET  /v1/tasks[/<task_id>]
//   GET  /v1/outcomes                     bounces and deferrals
//   GET  /v1/signals                      recent local signals
//
// Every /v1 route needs "Authorization: Bearer <token>". The listener binds to
// 127.0.0.1 unless configured otherwise.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AgentEmailServer, AgentAnswer, OutboundRequest } from "./server.js";

const MAX_BODY = 30 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function tokenOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), "utf8");
  const want = Buffer.from(token, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function startHttp(server: AgentEmailServer, opts: { host?: string; port: number; token?: string }): Promise<Server> {
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, agent: server.self, carrier: server.o.carrier.name });
      if (path.startsWith("/webhooks/")) {
        if (req.method !== "POST" || !server.o.carrier.webhook) return send(res, 404, { error: "no webhook here" });
        const body = await readBody(req);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v ?? ""]));
        const out = await server.o.carrier.webhook({ headers, body, path });
        res.writeHead(out.status, { "content-type": "application/json" });
        return res.end(out.body ?? "");
      }
      if (!path.startsWith("/v1/")) return send(res, 404, { error: "not found" });
      if (!tokenOk(req, opts.token)) return send(res, 401, { error: "a bearer token is required" });

      if (req.method === "POST" && path === "/v1/respond") {
        const j = JSON.parse((await readBody(req)).toString("utf8")) as AgentAnswer & { in_reply_to: string };
        const out = await server.respond(j.in_reply_to, j);
        return send(res, 200, { id: out.envelope.id, task_id: out.envelope.task_id, message_id: out.messageId });
      }
      if (req.method === "POST" && path === "/v1/request") {
        const j = JSON.parse((await readBody(req)).toString("utf8")) as OutboundRequest;
        const out = await server.request(j);
        return send(res, 200, { id: out.envelope.id, context_id: out.envelope.context_id, message_id: out.messageId });
      }
      if (req.method === "GET" && path === "/v1/held") return send(res, 200, { held: server.heldAttempts() });
      const held = path.match(/^\/v1\/held\/([^/]+)$/);
      if (req.method === "POST" && held) {
        const j = JSON.parse((await readBody(req)).toString("utf8")) as { stance: "allow" | "block" };
        if (j.stance !== "allow" && j.stance !== "block") return send(res, 400, { error: "stance is allow or block" });
        return send(res, 200, await server.decide(decodeURIComponent(held[1]!), j.stance));
      }
      if (req.method === "GET" && path === "/v1/tasks") return send(res, 200, { tasks: server.tasks.all() });
      const task = path.match(/^\/v1\/tasks\/([^/]+)$/);
      if (req.method === "GET" && task) {
        const t = server.tasks.get(decodeURIComponent(task[1]!));
        return t ? send(res, 200, t) : send(res, 404, { error: "no such task" });
      }
      if (req.method === "GET" && path === "/v1/outcomes") return send(res, 200, { outcomes: server.outcomesList() });
      if (req.method === "GET" && path === "/v1/signals") return send(res, 200, { signals: server.signals });
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => http.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(http)));
}
