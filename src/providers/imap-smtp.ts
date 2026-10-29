// The built-in carrier: any mailbox, through IMAP for inbound and SMTP
// submission for outbound. Inbound mail is found with UID SEARCH UNSEEN,
// fetched raw without marking it, handed to the server, and only then marked
// \Seen, so mail the server could not take is fetched again. IDLE is used
// when the server offers it, polling otherwise.
import { randomUUID } from "node:crypto";
import { renderMime } from "../compose.js";
import { parseAddresses, parseMail } from "../mime/mime.js";
import { ImapClient, type ImapOptions } from "./imap.js";
import { smtpSend, type SmtpOptions } from "./smtp.js";
import type { CarrierAdapter, CarrierCapabilities, DeliveryStatus, InboundHandler, OutboundMail, SendResult } from "./types.js";

export interface ImapSmtpOptions {
  imap: ImapOptions & { mailbox?: string };
  smtp: SmtpOptions;
  /** How often to look for mail when IDLE is not offered, and the longest IDLE. */
  pollMs?: number;
  /** The envelope sender for SMTP (the bounce address). Defaults to the From address. */
  envelopeFrom?: string;
  log?: (line: string) => void;
}

export class ImapSmtpCarrier implements CarrierAdapter {
  readonly name = "imap-smtp";
  private handlers: InboundHandler[] = [];
  private stopping = false;
  private loop?: Promise<void>;
  private client?: ImapClient;
  constructor(private o: ImapSmtpOptions) {}

  capabilities(): CarrierCapabilities {
    return { rawInbound: true, attachmentDownload: false, push: "imap-idle", authResults: false, threading: true, customHeaders: "any", maxOutboundBytes: 25 * 1024 * 1024 };
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    const { raw, messageId } = renderMime(mail);
    const from = this.o.envelopeFrom ?? parseAddresses(mail.from)[0]?.address;
    if (!from) throw new Error("no From address");
    const to = mail.to.flatMap((t) => parseAddresses(t).map((a) => a.address));
    const { reply } = await smtpSend(this.o.smtp, { from, to }, raw);
    const queued = (reply.match(/(?:queued as|id=|<)\s*([A-Za-z0-9._@-]+)/i) ?? [])[1];
    return { carrierId: queued ? `smtp:${queued}` : `smtp:${randomUUID()}`, messageId };
  }

  receive(handler: InboundHandler): void { this.handlers.push(handler); }

  /** SMTP gives no delivery status after the hand-over. Bounces come back as
   *  delivery status notifications in the mailbox, which the server reads. */
  async status(_carrierId: string): Promise<DeliveryStatus> { return { state: "unknown" }; }

  private log(line: string) { this.o.log?.(line); }

  async start(): Promise<void> {
    this.stopping = false;
    this.loop = this.run();
  }

  /** Look for unseen mail once. Exposed for tests and one-shot tools. */
  async pollOnce(client: ImapClient, uidValidity: number): Promise<number> {
    const uids = await client.uidSearch("UNSEEN");
    let n = 0;
    for (const uid of uids) {
      if (this.stopping) break;
      const raw = await client.uidFetchRaw(uid);
      if (!raw) continue;
      const mail = { carrierEventId: `imap:${this.o.imap.user}:${uidValidity}:${uid}`, raw, headers: parseMail(raw).headers, attachments: [], receivedAt: new Date().toISOString() };
      try {
        for (const h of this.handlers) await h(mail);
        await client.markSeen(uid);
        n++;
      } catch (e) {
        this.log(`imap: message ${uid} was not taken and stays unseen: ${(e as Error).message}`);
      }
    }
    return n;
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopping) {
      const client = new ImapClient(this.o.imap);
      this.client = client;
      try {
        await client.connect();
        const { uidValidity } = await client.select(this.o.imap.mailbox ?? "INBOX");
        this.log(`imap: watching ${this.o.imap.mailbox ?? "INBOX"} on ${this.o.imap.host}${client.capabilities.includes("IDLE") ? " with IDLE" : ", polling"}`);
        backoff = 1000;
        while (!this.stopping) {
          await this.pollOnce(client, uidValidity);
          if (this.stopping) break;
          const wait = this.o.pollMs ?? (client.capabilities.includes("IDLE") ? 25 * 60_000 : 60_000);
          if (client.capabilities.includes("IDLE")) await client.idle(wait);
          else { await new Promise((r) => setTimeout(r, wait)); await client.command("NOOP"); }
        }
      } catch (e) {
        if (this.stopping) break;
        this.log(`imap: ${(e as Error).message}; reconnecting in ${Math.round(backoff / 1000)} s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 5 * 60_000);
      } finally {
        await client.logout();
      }
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.client?.logout();
    await this.loop;
  }
}
