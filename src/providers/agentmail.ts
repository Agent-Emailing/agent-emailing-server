// AgentMail (https://docs.agentmail.to), from its public API documentation.
//
//   send     POST /v0/inboxes/{inbox_id}/messages/send. The sender is the
//            inbox. Threading goes in the headers map, not through the reply
//            endpoint, because the reply endpoint writes its own subject and
//            Agent Emailing signs the subject (§3.3).
//   inbound  the message.received webhook, then the raw message from
//            GET .../messages/{message_id}/raw (a signed download URL). Without
//            a webhook, it can poll GET .../messages instead.
//   status   no per-message status; the message.delivered, message.bounced and
//            message.rejected webhooks
//   webhook  Svix signatures; event_id is the id for deduplication
import { createHash } from "node:crypto";
import { parseMail, firstAddress } from "../mime/mime.js";
import { ENVELOPE_MEDIA_TYPE } from "../human.js";
import { aligned, type AuthResults } from "../mailauth.js";
import { apiJson, download, verifySvix } from "./http-util.js";
import {
  STRUCTURAL_HEADERS, type CarrierAdapter, type CarrierCapabilities, type DeliveryStatus, type InboundHandler, type InboundMail,
  type OutboundMail, type SendResult, type StatusEvent, type WebhookRequest, type WebhookResponse,
} from "./types.js";

export interface AgentMailOptions {
  apiKey: string;
  /** The inbox, usually its email address. */
  inboxId: string;
  webhookSecret?: string;
  baseUrl?: string;
  pollMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface AmMessage {
  inbox_id: string;
  message_id: string;
  from?: string;
  timestamp?: string;
  created_at?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { attachment_id: string; filename?: string; content_type: string; content_id?: string }[];
  authentication_results?: { spf?: string; dkim?: string; dmarc?: string; dkim_domain?: string };
}

export class AgentMailCarrier implements CarrierAdapter {
  readonly name = "agentmail";
  private handlers: InboundHandler[] = [];
  private statusHandlers: ((ev: StatusEvent) => Promise<void>)[] = [];
  private f: typeof fetch;
  private base: string;
  private timer?: NodeJS.Timeout;
  private since?: string;
  constructor(private o: AgentMailOptions) {
    this.f = o.fetch ?? fetch;
    this.base = (o.baseUrl ?? "https://api.agentmail.to").replace(/\/$/, "");
  }
  private get auth() { return { authorization: `Bearer ${this.o.apiKey}` }; }
  private inboxPath() { return `${this.base}/v0/inboxes/${encodeURIComponent(this.o.inboxId)}`; }

  capabilities(): CarrierCapabilities {
    // The whole request is limited to 6 MB, base64 included.
    return { rawInbound: true, attachmentDownload: true, push: "webhook", authResults: true, threading: true, customHeaders: "any", maxOutboundBytes: 6 * 1024 * 1024 };
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mail.headers ?? {})) if (!STRUCTURAL_HEADERS.test(k)) headers[k] = v;
    if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
    if (mail.references?.length) headers["References"] = mail.references.join(" ");
    const body = {
      to: mail.to, subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), headers,
      attachments: mail.attachments.map((a) => ({
        filename: a.filename, content_type: a.contentType, content_disposition: "attachment",
        ...(a.contentId ? { content_id: a.contentId } : {}), content: Buffer.from(a.bytes).toString("base64"),
      })),
    };
    const env = mail.attachments.find((a) => a.contentType === ENVELOPE_MEDIA_TYPE);
    const idem = createHash("sha256").update(JSON.stringify([mail.from, mail.to, mail.subject])).update(env ? env.bytes : Buffer.from(JSON.stringify(body))).digest("hex").slice(0, 48);
    const r = await apiJson<{ message_id: string; thread_id?: string }>(this.f, `${this.inboxPath()}/messages/send`, {
      method: "POST", what: "AgentMail send",
      headers: { ...this.auth, "content-type": "application/json", "idempotency-key": `ae-${idem}` },
      body: JSON.stringify(body),
    });
    return { carrierId: r.message_id, messageId: r.message_id };
  }

  receive(handler: InboundHandler): void { this.handlers.push(handler); }
  onStatus(handler: (ev: StatusEvent) => Promise<void>): void { this.statusHandlers.push(handler); }

  /** AgentMail keeps no per-message delivery state to ask for; status arrives by webhook. */
  async status(_carrierId: string): Promise<DeliveryStatus> { return { state: "unknown" }; }

  private authOf(m: AmMessage): AuthResults | undefined {
    const a = m.authentication_results;
    if (!a || !Object.keys(a).length) return undefined;
    const fromDomain = firstAddress(m.from)?.split("@")[1] ?? "";
    return {
      spf: a.spf ?? "none", dmarc: a.dmarc ?? "none",
      dkim: a.dkim ? [{ domain: a.dkim_domain ?? "", result: a.dkim, aligned: Boolean(a.dkim_domain && fromDomain && aligned(a.dkim_domain, fromDomain)) }] : [],
    };
  }

  async fetchInbound(messageId: string, eventId: string, known?: AmMessage): Promise<InboundMail> {
    const m = known ?? await apiJson<AmMessage>(this.f, `${this.inboxPath()}/messages/${encodeURIComponent(messageId)}`, { headers: this.auth, what: "AgentMail message" });
    const auth = this.authOf(m);
    try {
      const r = await apiJson<{ download_url: string }>(this.f, `${this.inboxPath()}/messages/${encodeURIComponent(messageId)}/raw`, { headers: this.auth, what: "AgentMail raw" });
      const raw = await download(this.f, r.download_url);
      return { carrierEventId: eventId, raw, headers: parseMail(raw).headers, attachments: [], auth, receivedAt: m.created_at ?? m.timestamp ?? new Date().toISOString() };
    } catch (e) {
      this.o.log?.(`agentmail: no raw message (${(e as Error).message}); rebuilding from attachments`);
    }
    const attachments = [];
    for (const a of m.attachments ?? []) {
      const meta = await apiJson<{ download_url: string; filename?: string; content_type: string; content_id?: string }>(this.f, `${this.inboxPath()}/messages/${encodeURIComponent(messageId)}/attachments/${a.attachment_id}`, { headers: this.auth, what: "AgentMail attachment" });
      attachments.push({ filename: meta.filename, contentType: meta.content_type, contentId: meta.content_id, bytes: await download(this.f, meta.download_url) });
    }
    return { carrierEventId: eventId, headers: Object.entries(m.headers ?? {}) as [string, string][], attachments, text: m.text, html: m.html, auth, receivedAt: m.created_at ?? new Date().toISOString() };
  }

  async webhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.o.webhookSecret || !verifySvix(req.headers, req.body, this.o.webhookSecret)) return { status: 401, body: '{"error":"bad signature"}' };
    const ev = JSON.parse(req.body.toString("utf8")) as { event_type: string; event_id: string; message?: AmMessage; [k: string]: any };
    if (ev.event_type === "message.received" && ev.message) {
      const mail = await this.fetchInbound(ev.message.message_id, `agentmail:${ev.event_id}`);
      for (const h of this.handlers) await h(mail);
    } else if (ev.event_type === "message.bounced" || ev.event_type === "message.delivered" || ev.event_type === "message.rejected") {
      const d = ev.bounce ?? ev.delivery ?? ev.reject ?? {};
      const state = ev.event_type === "message.delivered" ? "delivered" : "bounced";
      const dsnStatus = state === "bounced" ? (d.type === "Transient" || d.type === "Temporary" ? "4.0.0" : "5.0.0") : undefined;
      for (const h of this.statusHandlers) await h({ carrierId: d.message_id, messageId: d.message_id, state, dsnStatus, at: d.timestamp });
    }
    return { status: 200, body: "{}" };
  }

  private polled = new Set<string>();

  /** Polling, for a server with no public webhook URL. A message's timestamp
   *  is its sender's Date, in whole seconds, so it can be earlier than the
   *  moment it arrived: the poller looks back a few minutes behind the newest
   *  message it has seen, and remembers each message it handed over. */
  async start(): Promise<void> {
    if (!this.o.pollMs) return;
    this.since = new Date(Date.now() - 60_000).toISOString();
    const tick = async () => {
      try {
        const u = new URL(`${this.inboxPath()}/messages`);
        u.searchParams.set("ascending", "true");
        u.searchParams.set("after", this.since!);
        u.searchParams.set("labels", "received");
        const list = await apiJson<{ messages: AmMessage[] }>(this.f, u.toString(), { headers: this.auth, what: "AgentMail list" });
        for (const m of list.messages ?? []) {
          if (this.polled.has(m.message_id)) continue;
          const mail = await this.fetchInbound(m.message_id, `agentmail-msg:${m.inbox_id}:${m.message_id}`);
          for (const h of this.handlers) await h(mail);
          this.polled.add(m.message_id);
          const t = Date.parse(m.timestamp ?? m.created_at ?? "");
          if (Number.isFinite(t)) this.since = new Date(Math.max(Date.parse(this.since!), t - 5 * 60_000)).toISOString();
        }
      } catch (e) { this.o.log?.(`agentmail poll: ${(e as Error).message}`); }
    };
    this.timer = setInterval(() => void tick(), this.o.pollMs);
  }

  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); }
}
