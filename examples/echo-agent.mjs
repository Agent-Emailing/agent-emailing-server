// A small agent behind an Agent Emailing Server, in HTTP mode. The server
// POSTs each delivery here; the agent answers every request at once with what
// it was asked, and logs everything else.
//
//   AGENT_TOKEN=... node examples/echo-agent.mjs        (listens on 127.0.0.1:8080)
//
// Point the server's agentInterface.url at http://127.0.0.1:8080/deliver.
import { createServer } from "node:http";

const token = process.env.AGENT_TOKEN;
createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/deliver") { res.writeHead(404).end(); return; }
  if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  console.log(`${d.kind} from ${d.sender?.handle ?? d.sender?.agent_id ?? "the carrier"} (${d.sender?.tier ?? "-"})`);
  if (d.kind === "request" && d.can_respond) {
    // d.payload is the fenced copy: safe to show a model. d.envelope is the signed original.
    const asked = d.envelope.payload?.text ?? JSON.stringify(d.envelope.payload?.input ?? {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ respond: { status: "completed", text: `You asked: ${asked}` } }));
    return;
  }
  if (d.kind === "delivery_report") console.log(`  request ${d.report.request_id}: ${d.report.outcome} ${d.report.status ?? ""}`);
  res.writeHead(204).end();
}).listen(8080, "127.0.0.1", () => console.log("echo agent on http://127.0.0.1:8080/deliver"));
