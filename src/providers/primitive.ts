// Primitive (https://docs.primitive.dev), from its public API documentation.
//
// Primitive allows only three custom headers on outbound mail:
// Auto-Submitted, X-Auto-Response-Suppress and Precedence. Everything else is
// refused, so this adapter drops the hint headers of Agent Emailing §3.5.
// That is enough: the envelope travels as an attachment, every value comes
// from it, and threading uses Primitive's own in_reply_to and references
// fields.
//
//   send     POST /v1/send-mail, with base64 attachments and content_id
//   inbound  the email.received webhook, with the raw message inline when it is
//            small, or GET /v1/emails/{id}/raw
//   status   GET /v1/sent-emails/{id}, and the sent_email.delivered,
//            sent_email.failed and email.bounced webhooks
//   webhook  Primitive-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">;
//            the event's id is stable across retries
import { createHash } from "node:crypto";
import { parseMail } from "../mime/mime.js";
import { ENVELOPE_MEDIA_TYPE } from "../human.js";
import type { AuthResults } from "../mailauth.js";
import { apiJson, download, verifyTimestamped } from "./http-util.js";
import type {
  CarrierAdapter, CarrierCapabilities, DeliveryStatus, InboundHandler, InboundMail, OutboundMail, SendResult, StatusEvent, WebhookRequest, WebhookResponse,
} from "./types.js";

/** The only custom headers Primitive accepts. */
export const PRIMITIVE_HEADERS = ["auto-submitted", "x-auto-response-suppress", "precedence"];

export interface PrimitiveOptions {
  apiKey: string;
  webhookSecret?: string;
  /** Only accept webhook deliveries made for this endpoint. */
  endpointId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface PrimEmail {
  id: string;
  received_at?: string;
  content?: { raw?: { included?: boolean; encoding?: string; data?: string }; download?: { url?: string } };
  auth?: { spf?: string; dmarc?: string; dkimSignatures?: { domain: string; result: string; aligned: boolean }[] };
  analysis?: { bounce?: { sent_email_id?: string | null; failed_recipient?: string } };
}

export class PrimitiveCarrier implements CarrierAdapter {
  readonly name = "primitive";
  private handlers: InboundHandler[] = [];
  private statusHandlers: ((ev: StatusEvent) => Promise<void>)[] = [];
  private f: typeof fetch;
  private base: string;
  /** Headers dropped on the last send, for the record. */
  lastDropped: string[] = [];
  constructor(private o: PrimitiveOptions) {
    this.f = o.fetch ?? fetch;
    this.base = (o.baseUrl ?? "https://api.primitive.dev/v1").replace(/\/$/, "");
  }
  private get auth() { return { authorization: `Bearer ${this.o.apiKey}` }; }

  capabilities(): CarrierCapabilities {
    return { rawInbound: true, attachmentDownload: true, push: "webhook", authResults: true, threading: true, customHeaders: "some", maxOutboundBytes: 30 * 1024 * 1024 };
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    const headers: Record<string, string> = {};
    this.lastDropped = [];
    for (const [k, v] of Object.entries(mail.headers ?? {})) {
      if (PRIMITIVE_HEADERS.includes(k.toLowerCase())) headers[k] = v; else this.lastDropped.push(k);
    }
    const body = {
      from: mail.from, to: mail.to, subject: mail.subject, body_text: mail.text, ...(mail.html ? { body_html: mail.html } : {}),
      ...(mail.inReplyTo ? { in_reply_to: mail.inReplyTo } : {}), ...(mail.references?.length ? { references: mail.references.slice(-100) } : {}),
      headers,
      attachments: mail.attachments.map((a) => ({
        filename: a.filename, content_type: a.contentType, content_base64: Buffer.from(a.bytes).toString("base64"), ...(a.contentId ? { content_id: a.contentId } : {}),
      })),
    };
    const env = mail.attachments.find((a) => a.contentType === ENVELOPE_MEDIA_TYPE);
    const idem = createHash("sha256").update(env ? env.bytes : Buffer.from(JSON.stringify(body))).digest("hex").slice(0, 48);
    const r = await apiJson<{ data: { id: string; message_id?: string } }>(this.f, `${this.base}/send-mail`, {
      method: "POST", what: "Primitive send",
      headers: { ...this.auth, "content-type": "application/json", "idempotency-key": `ae-${idem}` },
      body: JSON.stringify(body),
    });
    let messageId = r.data.message_id;
    if (!messageId) {
      try {
        const s = await apiJson<{ data: { message_id?: string } }>(this.f, `${this.base}/sent-emails/${r.data.id}`, { headers: this.auth, what: "Primitive sent email" });
        messageId = s.data.message_id;
      } catch { /* not known yet */ }
    }
    return { carrierId: r.data.id, messageId };
  }

  receive(handler: InboundHandler): void { this.handlers.push(handler); }
  onStatus(handler: (ev: StatusEvent) => Promise<void>): void { this.statusHandlers.push(handler); }

  async status(carrierId: string): Promise<DeliveryStatus> {
    const s = await apiJson<{ data: { status?: string; delivery_status?: string } }>(this.f, `${this.base}/sent-emails/${carrierId}`, { headers: this.auth, what: "Primitive sent email" });
    const v = s.data.delivery_status ?? s.data.status;
    return { state: v === "delivered" ? "delivered" : v === "bounced" || v === "failed" ? "bounced" : v === "deferred" ? "deferred" : "unknown" };
  }

  private async inbound(email: PrimEmail, eventId: string): Promise<InboundMail> {
    let raw: Buffer;
    if (email.content?.raw?.included && email.content.raw.data) raw = Buffer.from(email.content.raw.data, "base64");
    else raw = await download(this.f, `${this.base}/emails/${email.id}/raw`, this.auth);
    const a = email.auth;
    const auth: AuthResults | undefined = a ? { spf: a.spf ?? "none", dmarc: a.dmarc ?? "none", dkim: (a.dkimSignatures ?? []).map((d) => ({ domain: d.domain, result: d.result, aligned: d.aligned })) } : undefined;
    return { carrierEventId: eventId, raw, headers: parseMail(raw).headers, attachments: [], auth, receivedAt: email.received_at ?? new Date().toISOString() };
  }

  async webhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.o.webhookSecret || !verifyTimestamped(req.headers["primitive-signature"], req.body, this.o.webhookSecret)) return { status: 401, body: '{"error":"bad signature"}' };
    const ev = JSON.parse(req.body.toString("utf8")) as { id: string; event: string; delivery?: { endpoint_id?: string }; email?: PrimEmail; sent_email?: any; outcome?: any };
    if (this.o.endpointId && ev.delivery?.endpoint_id !== this.o.endpointId) return { status: 200, body: "{}" };
    if (ev.event === "email.received" && ev.email) {
      const mail = await this.inbound(ev.email, `primitive:${ev.id}`);
      for (const h of this.handlers) await h(mail);
    } else if (ev.event === "email.bounced" && ev.email) {
      // A returned email: give it to the server as mail, so it reads the delivery
      // report itself, and report the status when Primitive linked it to a send.
      const mail = await this.inbound(ev.email, `primitive:${ev.id}`);
      for (const h of this.handlers) await h(mail);
    } else if ((ev.event === "sent_email.delivered" || ev.event === "sent_email.failed") && ev.sent_email) {
      const code = ev.outcome?.smtp_enhanced_status_code as string | undefined;
      const state = ev.event === "sent_email.delivered" ? "delivered" : ev.outcome?.failure_kind === "expired" || code?.startsWith("4") ? "deferred" : "bounced";
      for (const h of this.statusHandlers) await h({ carrierId: ev.sent_email.id, messageId: ev.sent_email.message_id, state, dsnStatus: code, at: ev.outcome?.at });
    }
    return { status: 200, body: "{}" };
  }
}
