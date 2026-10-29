// Cloudflare Email, through a small Worker that sits beside the server
// (examples/cloudflare-worker/). From Cloudflare's public documentation.
//
//   inbound  Email Routing hands each message to the Worker's email() handler,
//            which POSTs the raw message to this server's /webhooks/cloudflare,
//            signed with a secret the two share.
//   send     the server POSTs the raw MIME message to the Worker's /send, signed
//            the same way, and the Worker sends it with its send_email binding
//            (EmailMessage from "cloudflare:email"), which takes raw MIME. Raw
//            MIME keeps every Content-ID, which the file parts' cid:
//            references need.
//   REST     without a Worker URL, the adapter sends through the Email Service
//            REST API instead (POST /accounts/{id}/email/sending/send). Its
//            documentation shows no Content-ID for attachments, so in this mode
//            an email with file parts is refused rather than sent broken.
//   status   Cloudflare reports the result of each send and nothing after it.
import { randomUUID } from "node:crypto";
import { renderMime } from "../compose.js";
import { parseAddresses, parseMail } from "../mime/mime.js";
import { ENVELOPE_MEDIA_TYPE } from "../human.js";
import { apiJson, signTimestamped, verifyTimestamped } from "./http-util.js";
import type {
  CarrierAdapter, CarrierCapabilities, DeliveryStatus, InboundHandler, OutboundMail, SendResult, WebhookRequest, WebhookResponse,
} from "./types.js";

/** The custom headers Cloudflare's sending accepts besides X- headers. */
const CF_ALLOWED = /^(x-[a-z0-9_-]+|in-reply-to|references|auto-submitted|precedence|thread-index|thread-topic|list-[a-z-]+|content-language|keywords|comments|importance|priority|sensitivity|organization|require-recipient-valid-since|expires|reply-by|archived-at)$/i;

export interface CloudflareOptions {
  /** The Worker's URL (https://<name>.<account>.workers.dev). */
  workerUrl?: string;
  /** The secret the server and the Worker share, for both directions. */
  workerSecret: string;
  /** For REST mode: the account and an API token with permission to send. */
  accountId?: string;
  apiToken?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export class CloudflareCarrier implements CarrierAdapter {
  readonly name = "cloudflare";
  private handlers: InboundHandler[] = [];
  private f: typeof fetch;
  private results = new Map<string, DeliveryStatus>();
  constructor(private o: CloudflareOptions) { this.f = o.fetch ?? fetch; }

  capabilities(): CarrierCapabilities {
    return {
      rawInbound: true, attachmentDownload: false, push: "webhook", authResults: false, threading: true,
      customHeaders: this.o.workerUrl ? "any" : "some",
      // 25 MiB to verified destinations; 5 MiB otherwise.
      maxOutboundBytes: 5 * 1024 * 1024,
    };
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    const from = parseAddresses(mail.from)[0]?.address;
    const to = mail.to.flatMap((t) => parseAddresses(t).map((a) => a.address));
    if (!from) throw new Error("no From address");
    if (this.o.workerUrl) {
      const { raw, messageId } = renderMime(mail);
      const body = JSON.stringify({ from, to, raw: raw.toString("base64") });
      const r = await apiJson<{ messageId?: string }>(this.f, new URL("/send", this.o.workerUrl).toString(), {
        method: "POST", what: "Cloudflare Worker send",
        headers: { "content-type": "application/json", "x-agent-emailing-signature": signTimestamped(body, this.o.workerSecret) },
        body,
      });
      const carrierId = r.messageId ?? messageId;
      this.results.set(carrierId, { state: "unknown" });
      return { carrierId, messageId: r.messageId ?? messageId };
    }
    if (!this.o.accountId || !this.o.apiToken) throw new Error("Cloudflare needs a Worker URL, or an account id and API token for REST");
    if (mail.attachments.some((a) => a.contentType !== ENVELOPE_MEDIA_TYPE && a.contentId)) {
      throw new Error("Cloudflare's REST API documents no Content-ID for attachments, which cid: file parts need; send files through the Worker");
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mail.headers ?? {})) if (CF_ALLOWED.test(k)) headers[k] = v;
    if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
    if (mail.references?.length) headers["References"] = mail.references.join(" ");
    const r = await apiJson<{ result?: { message_id?: string; delivered?: string[]; queued?: string[]; permanent_bounces?: string[] } }>(this.f,
      `https://api.cloudflare.com/client/v4/accounts/${this.o.accountId}/email/sending/send`, {
        method: "POST", what: "Cloudflare send",
        headers: { authorization: `Bearer ${this.o.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: mail.from, to, subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), headers,
          attachments: mail.attachments.map((a) => ({ content: Buffer.from(a.bytes).toString("base64"), filename: a.filename, type: a.contentType, disposition: "attachment" })),
        }),
      });
    const carrierId = r.result?.message_id ?? `cf:${randomUUID()}`;
    const res = r.result;
    this.results.set(carrierId, res?.permanent_bounces?.length ? { state: "bounced", dsnStatus: "5.0.0" } : res?.delivered?.length ? { state: "delivered" } : { state: "unknown" });
    return { carrierId, messageId: r.result?.message_id };
  }

  receive(handler: InboundHandler): void { this.handlers.push(handler); }

  async status(carrierId: string): Promise<DeliveryStatus> { return this.results.get(carrierId) ?? { state: "unknown" }; }

  /** The Worker's POST: the raw message as the body, the event id in a header. */
  async webhook(req: WebhookRequest): Promise<WebhookResponse> {
    if (!verifyTimestamped(req.headers["x-agent-emailing-signature"], req.body, this.o.workerSecret)) return { status: 401, body: '{"error":"bad signature"}' };
    const raw = req.body;
    const eventId = req.headers["x-event-id"] || randomUUID();
    const mail = { carrierEventId: `cloudflare:${eventId}`, raw, headers: parseMail(raw).headers, attachments: [], receivedAt: new Date().toISOString() };
    for (const h of this.handlers) await h(mail);
    return { status: 200, body: "{}" };
  }
}
