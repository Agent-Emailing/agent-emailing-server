// Resend (https://resend.com/docs), from its public API documentation.
//
//   send     POST /emails, with base64 attachments (content_id for file parts)
//            and threading and Auto-Submitted in the headers map
//   inbound  the email.received webhook carries metadata only; the server
//            fetches GET /emails/receiving/{id}, then the raw message from
//            raw.download_url. Without a webhook, it can poll
//            GET /emails/receiving instead.
//   status   GET /emails/{id} (last_event), and the email.delivered,
//            email.delivery_delayed and email.bounced webhooks
//   webhook  Svix signatures; svix-id is the event id for deduplication
import { createHash } from "node:crypto";
import { parseMail, firstAddress } from "../mime/mime.js";
import { ENVELOPE_MEDIA_TYPE } from "../human.js";
import type { AuthResults } from "../mailauth.js";
import { apiJson, download, verifySvix } from "./http-util.js";
import {
  STRUCTURAL_HEADERS, type CarrierAdapter, type CarrierCapabilities, type DeliveryStatus, type InboundHandler, type InboundMail,
  type OutboundMail, type SendResult, type StatusEvent, type WebhookRequest, type WebhookResponse,
} from "./types.js";

export interface ResendOptions {
  apiKey: string;
  webhookSecret?: string;
  baseUrl?: string;
  /** Poll GET /emails/receiving this often when no webhook is set up. */
  pollMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface ReceivedEmail {
  id: string;
  message_id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
  attachments?: { id: string; filename?: string; content_type: string; content_id?: string }[];
  raw?: { download_url: string; expires_at?: string } | null;
  created_at?: string;
}

export class ResendCarrier implements CarrierAdapter {
  readonly name = "resend";
  private handlers: InboundHandler[] = [];
  private statusHandlers: ((ev: StatusEvent) => Promise<void>)[] = [];
  private f: typeof fetch;
  private base: string;
  private timer?: NodeJS.Timeout;
  private seenPolled = new Set<string>();
  constructor(private o: ResendOptions) {
    this.f = o.fetch ?? fetch;
    this.base = (o.baseUrl ?? "https://api.resend.com").replace(/\/$/, "");
  }
  private get auth() { return { authorization: `Bearer ${this.o.apiKey}` }; }

  capabilities(): CarrierCapabilities {
    return { rawInbound: true, attachmentDownload: true, push: "webhook", authResults: true, threading: true, customHeaders: "any", maxOutboundBytes: 40 * 1024 * 1024 };
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mail.headers ?? {})) if (!STRUCTURAL_HEADERS.test(k)) headers[k] = v;
    if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
    if (mail.references?.length) headers["References"] = mail.references.join(" ");
    const body = {
      from: mail.from, to: mail.to, subject: mail.subject,
      // An empty html is not sent: Resend would otherwise make a text part from it.
      text: mail.text, ...(mail.html ? { html: mail.html } : {}),
      headers,
      attachments: mail.attachments.map((a) => ({
        filename: a.filename, content: Buffer.from(a.bytes).toString("base64"), content_type: a.contentType,
        ...(a.contentId ? { content_id: a.contentId } : {}),
      })),
    };
    // The same email sent twice (a retry) is sent once.
    const env = mail.attachments.find((a) => a.contentType === ENVELOPE_MEDIA_TYPE);
    const idem = createHash("sha256").update(env ? env.bytes : Buffer.from(JSON.stringify(body))).digest("hex").slice(0, 48);
    const r = await apiJson<{ id: string }>(this.f, `${this.base}/emails`, {
      method: "POST", what: "Resend send",
      headers: { ...this.auth, "content-type": "application/json", "idempotency-key": `ae-${idem}` },
      body: JSON.stringify(body),
    });
    // Resend sets the Message-ID; read it back for threading and bounces.
    let messageId: string | undefined;
    try {
      const e = await apiJson<{ message_id?: string }>(this.f, `${this.base}/emails/${r.id}`, { headers: this.auth, what: "Resend retrieve" });
      messageId = e.message_id ? (e.message_id.startsWith("<") ? e.message_id : `<${e.message_id}>`) : undefined;
    } catch { /* threading falls back to what the receiver records */ }
    return { carrierId: r.id, messageId };
  }

  receive(handler: InboundHandler): void { this.handlers.push(handler); }
  onStatus(handler: (ev: StatusEvent) => Promise<void>): void { this.statusHandlers.push(handler); }

  async status(carrierId: string): Promise<DeliveryStatus> {
    const e = await apiJson<{ last_event?: string }>(this.f, `${this.base}/emails/${carrierId}`, { headers: this.auth, what: "Resend retrieve" });
    switch (e.last_event) {
      case "delivered": case "opened": case "clicked": return { state: "delivered" };
      case "delivery_delayed": return { state: "deferred" };
      case "bounced": case "failed": case "suppressed": return { state: "bounced" };
      default: return { state: "unknown" };
    }
  }

  /** Fetch one received email and turn it into InboundMail. */
  async fetchInbound(emailId: string, eventId: string): Promise<InboundMail> {
    const e = await apiJson<ReceivedEmail>(this.f, `${this.base}/emails/receiving/${emailId}`, { headers: this.auth, what: "Resend received email" });
    const fromAddr = firstAddress(e.from ?? e.headers?.from);
    const auth: AuthResults | undefined = e.authentication
      ? {
        spf: e.authentication.spf ?? "none", dmarc: e.authentication.dmarc ?? "none",
        // Resend reports one DKIM result without its domain. A DKIM pass with a
        // DMARC pass is counted as aligned; that is the closest reading.
        dkim: e.authentication.dkim ? [{ domain: fromAddr?.split("@")[1] ?? "", result: e.authentication.dkim, aligned: e.authentication.dkim === "pass" && e.authentication.dmarc === "pass" }] : [],
      }
      : undefined;
    if (e.raw?.download_url) {
      const raw = await download(this.f, e.raw.download_url);
      return { carrierEventId: eventId, raw, headers: parseMail(raw).headers, attachments: [], auth, receivedAt: e.created_at ?? new Date().toISOString() };
    }
    // No raw message: rebuild from the parsed fields and the attachment downloads.
    const attachments = [];
    for (const a of e.attachments ?? []) {
      const meta = await apiJson<{ download_url: string; filename?: string; content_type: string; content_id?: string }>(this.f, `${this.base}/emails/receiving/${emailId}/attachments/${a.id}`, { headers: this.auth, what: "Resend attachment" });
      attachments.push({ filename: meta.filename, contentType: meta.content_type, contentId: meta.content_id, bytes: await download(this.f, meta.download_url) });
    }
    return {
      carrierEventId: eventId, headers: Object.entries(e.headers ?? {}) as [string, string][], attachments,
      text: e.text ?? undefined, html: e.html ?? undefined, auth, receivedAt: e.created_at ?? new Date().toISOString(),
    };
  }

  async webhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.o.webhookSecret || !verifySvix(req.headers, req.body, this.o.webhookSecret)) return { status: 401, body: '{"error":"bad signature"}' };
    const ev = JSON.parse(req.body.toString("utf8")) as { type: string; created_at?: string; data: any };
    const eventId = req.headers["svix-id"]!;
    if (ev.type === "email.received") {
      const mail = await this.fetchInbound(ev.data.email_id, `resend:${eventId}`);
      for (const h of this.handlers) await h(mail);
    } else if (ev.type === "email.bounced" || ev.type === "email.delivery_delayed" || ev.type === "email.delivered" || ev.type === "email.failed") {
      const diag = [ev.data?.bounce?.diagnosticCode ?? []].flat().join(" ");
      const code = (diag.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/) ?? [])[1];
      const state = ev.type === "email.delivered" ? "delivered" : ev.type === "email.delivery_delayed" ? "deferred" : "bounced";
      const dsnStatus = code ?? (state === "bounced" ? (ev.data?.bounce?.type === "Temporary" ? "4.0.0" : "5.0.0") : undefined);
      for (const h of this.statusHandlers) await h({ carrierId: ev.data.email_id, state, dsnStatus, at: ev.created_at });
    }
    return { status: 200, body: "{}" };
  }

  async start(): Promise<void> {
    if (!this.o.pollMs) return;
    const tick = async () => {
      try {
        const list = await apiJson<{ data: { id: string; created_at?: string }[] }>(this.f, `${this.base}/emails/receiving?limit=50`, { headers: this.auth, what: "Resend list received" });
        for (const item of [...list.data].reverse()) {
          if (this.seenPolled.has(item.id)) continue;
          const mail = await this.fetchInbound(item.id, `resend-email:${item.id}`);
          for (const h of this.handlers) await h(mail);
          this.seenPolled.add(item.id);
        }
      } catch (e) { this.o.log?.(`resend poll: ${(e as Error).message}`); }
    };
    await tick();
    this.timer = setInterval(() => void tick(), this.o.pollMs);
  }

  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); }
}

