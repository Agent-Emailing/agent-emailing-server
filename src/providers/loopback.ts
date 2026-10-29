// A loopback carrier: mailboxes in one process, joined by a LoopbackNetwork.
// Mail is rendered to raw MIME and parsed again on arrival, exactly as a real
// carrier would carry it. For tests, examples and the conformance harness.
import { randomUUID } from "node:crypto";
import { renderMime } from "../compose.js";
import type { AuthResults } from "../mailauth.js";
import { parseAddresses } from "../mime/mime.js";
import type { CarrierAdapter, CarrierCapabilities, DeliveryStatus, InboundHandler, InboundMail, OutboundMail, SendResult } from "./types.js";
import { parseMail } from "../mime/mime.js";

export class LoopbackNetwork {
  readonly boxes = new Map<string, LoopbackCarrier>();
  readonly log: { from: string; to: string; raw: Buffer; messageId: string; carrierId: string }[] = [];
  private inflight = new Set<Promise<void>>();
  /** Authentication results the network reports for mail from an address.
   *  Every sender on a loopback network passes DMARC unless told otherwise. */
  authFor: (fromAddress: string) => AuthResults | undefined = (from) => ({ spf: "pass", dkim: [{ domain: from.split("@")[1] ?? "", result: "pass", aligned: true }], dmarc: "pass" });

  mailbox(address: string): LoopbackCarrier {
    const a = address.toLowerCase();
    let box = this.boxes.get(a);
    if (!box) { box = new LoopbackCarrier(this, a); this.boxes.set(a, box); }
    return box;
  }

  /** Deliver raw mail to an address, later, as a carrier does. */
  deliver(to: string, raw: Buffer, auth?: AuthResults, eventId = randomUUID()): void {
    const box = this.boxes.get(to.toLowerCase());
    if (!box) return;
    const p = new Promise<void>((resolve) => setImmediate(resolve)).then(() => box.arrive(raw, auth, eventId)).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Wait until no mail is in flight. */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}

export class LoopbackCarrier implements CarrierAdapter {
  readonly name = "loopback";
  private handlers: InboundHandler[] = [];
  readonly sent: { raw: Buffer; messageId: string; carrierId: string; to: string[] }[] = [];
  constructor(private net: LoopbackNetwork, readonly address: string) {}

  capabilities(): CarrierCapabilities {
    return { rawInbound: true, attachmentDownload: false, push: "none", authResults: true, threading: true, customHeaders: "any", maxOutboundBytes: 25 * 1024 * 1024 };
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    const { raw, messageId } = renderMime(mail);
    const carrierId = randomUUID();
    const to = mail.to.flatMap((t) => parseAddresses(t).map((a) => a.address));
    this.sent.push({ raw, messageId, carrierId, to });
    const from = parseAddresses(mail.from)[0]?.address ?? this.address;
    for (const addr of to) {
      this.net.log.push({ from, to: addr, raw, messageId, carrierId });
      this.net.deliver(addr, raw, this.net.authFor(from));
    }
    return { carrierId, messageId };
  }

  receive(handler: InboundHandler): void { this.handlers.push(handler); }

  async status(carrierId: string): Promise<DeliveryStatus> {
    const e = this.net.log.find((x) => x.carrierId === carrierId);
    if (!e) return { state: "unknown" };
    return this.net.boxes.has(e.to.toLowerCase()) ? { state: "delivered" } : { state: "bounced", dsnStatus: "5.1.1" };
  }

  /** Hand raw mail to this mailbox's handlers now, and wait for them. */
  async arrive(raw: Uint8Array, auth?: AuthResults, eventId: string = randomUUID()): Promise<void> {
    const mail: InboundMail = {
      carrierEventId: eventId, raw, headers: parseMail(raw).headers, attachments: [], auth, receivedAt: new Date().toISOString(),
    };
    for (const h of this.handlers) await h(mail);
  }
}
