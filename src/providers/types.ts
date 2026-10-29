// The carrier adapter contract of Agent Emailing §11.4, as this server uses it.
//
// The four operations are the spec's: capabilities, send, receive and status.
// Three optional members are additions this implementation needs and the
// spec's interface does not name (see docs/provider-interface.md):
//
// - `webhook` lets the server's HTTP listener hand a carrier's webhook call
//   to the adapter, which checks the carrier's own signature (§7.2 step 1)
//   and turns the call into received mail or a status event.
// - `onStatus` is the push form of status(), for carriers that report
//   bounces and deferrals by webhook instead of by a returned email.
// - `start` and `close` begin and end the adapter's connections.
import type { OutboundMail } from "../compose.js";
import type { AuthResults } from "../mailauth.js";

export type { OutboundMail };

export interface CarrierCapabilities {
  rawInbound: boolean;
  attachmentDownload: boolean;
  push: "webhook" | "websocket" | "sse" | "imap-idle" | "none";
  authResults: boolean;
  threading: boolean;
  customHeaders: "any" | "some" | "none";
  maxOutboundBytes: number;
}

export interface InboundAttachment {
  filename?: string;
  contentType: string;
  contentId?: string;
  bytes: Uint8Array;
}

/** One received email, as §11.4's receive() hands it over. `text` and `html`
 *  are additions: a carrier that gives no raw message still has to give the
 *  human part, or the §3.3 check and the carrier test cannot run. */
export interface InboundMail {
  carrierEventId: string;
  raw?: Uint8Array;
  headers: [string, string][];
  attachments: InboundAttachment[];
  text?: string;
  html?: string;
  auth?: AuthResults;
  receivedAt: string;
}

export type InboundHandler = (mail: InboundMail) => Promise<void>;

export interface SendResult {
  carrierId: string;
  messageId?: string;
}

export interface DeliveryStatus {
  state: "delivered" | "deferred" | "bounced" | "unknown";
  dsnStatus?: string;
}

export interface StatusEvent extends DeliveryStatus {
  carrierId: string;
  messageId?: string;
  at?: string;
}

export interface WebhookRequest {
  /** Header names lowercased. */
  headers: Record<string, string>;
  /** The raw request body, exactly as received. */
  body: Buffer;
  path: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
}

export interface CarrierAdapter {
  readonly name: string;
  capabilities(): CarrierCapabilities;
  send(mail: OutboundMail): Promise<SendResult>;
  receive(handler: InboundHandler): void;
  status(carrierId: string): Promise<DeliveryStatus>;

  webhook?(req: WebhookRequest): Promise<WebhookResponse>;
  onStatus?(handler: (ev: StatusEvent) => Promise<void>): void;
  start?(): Promise<void>;
  close?(): Promise<void>;
}

/** Headers an adapter can never pass as custom headers: the carrier or the
 *  MIME structure sets them. */
export const STRUCTURAL_HEADERS = /^(from|to|cc|bcc|subject|date|message-id|mime-version|content-type|content-transfer-encoding|reply-to|in-reply-to|references|return-path|received|dkim-signature)$/i;
