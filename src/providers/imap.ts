// An IMAP4rev1 client (RFC 3501) over node's tls: LOGIN or AUTHENTICATE
// (PLAIN, XOAUTH2), SELECT, UID SEARCH, UID FETCH of the raw message, UID
// STORE to mark it seen, and IDLE (RFC 2177). Only the subset an agent's
// mailbox needs. Literals are read as bytes, so a message comes out exactly
// as the server holds it.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface ImapOptions {
  host: string;
  port: number;
  /** "tls" for implicit TLS (993), "starttls" to upgrade (143), "none" only for a local test server. */
  security: "tls" | "starttls" | "none";
  user: string;
  pass?: string;
  /** An OAuth access token source, for XOAUTH2 (Gmail, Microsoft 365). */
  accessToken?: () => Promise<string>;
  timeoutMs?: number;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
}

/** One server response: its text, with each literal replaced by a marker, and the literals' bytes. */
export interface ImapResponse { text: string; literals: Buffer[] }

export class ImapError extends Error {}

export class ImapClient {
  private sock!: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  private queue: ImapResponse[] = [];
  private waiter?: { resolve: (r: ImapResponse) => void; reject: (e: Error) => void };
  private closed?: Error;
  private tag = 0;
  capabilities: string[] = [];
  /** Untagged responses that arrived outside a command, such as EXISTS during IDLE. */
  onUntagged?: (r: ImapResponse) => void;

  constructor(private o: ImapOptions) {}

  private get timeout() { return this.o.timeoutMs ?? 60_000; }

  private attach(sock: Socket | TLSSocket): void {
    this.sock = sock;
    sock.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    const fail = (e: Error) => { this.closed = e; this.waiter?.reject(e); this.waiter = undefined; };
    sock.on("error", fail);
    sock.on("close", () => fail(new ImapError("the IMAP connection closed")));
  }

  /** Cut complete responses out of the buffer, reading literals by length. */
  private drain(): void {
    for (;;) {
      let pos = 0;
      let text = "";
      const literals: Buffer[] = [];
      let complete = false;
      for (;;) {
        const eol = this.buf.indexOf("\r\n", pos);
        if (eol < 0) break;
        const line = this.buf.subarray(pos, eol).toString("latin1");
        const m = line.match(/\{(\d+)\+?\}$/);
        if (m) {
          const n = Number(m[1]);
          if (this.buf.length < eol + 2 + n) break;
          literals.push(Buffer.from(this.buf.subarray(eol + 2, eol + 2 + n)));
          text += line.slice(0, line.length - m[0].length) + `\x00${literals.length - 1}\x00`;
          pos = eol + 2 + n;
          continue;
        }
        text += line;
        pos = eol + 2;
        complete = true;
        break;
      }
      if (!complete) return;
      this.buf = this.buf.subarray(pos);
      const r = { text, literals };
      if (this.waiter) { const w = this.waiter; this.waiter = undefined; w.resolve(r); } else this.queue.push(r);
    }
  }

  private next(timeoutMs = this.timeout): Promise<ImapResponse> {
    const r = this.queue.shift();
    if (r) return Promise.resolve(r);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const t = timeoutMs > 0 ? setTimeout(() => { this.waiter = undefined; reject(new ImapError("the IMAP server did not answer in time")); }, timeoutMs) : undefined;
      this.waiter = { resolve: (x) => { if (t) clearTimeout(t); resolve(x); }, reject: (e) => { if (t) clearTimeout(t); reject(e); } };
    });
  }

  /** Send a command and collect its untagged responses until the tagged one. */
  async command(cmd: string, onContinue?: (r: ImapResponse) => string | undefined): Promise<ImapResponse[]> {
    const tag = `A${++this.tag}`;
    this.sock.write(`${tag} ${cmd}\r\n`);
    const out: ImapResponse[] = [];
    for (;;) {
      const r = await this.next();
      if (r.text.startsWith("+")) {
        const reply = onContinue?.(r);
        this.sock.write((reply ?? "") + "\r\n");
        continue;
      }
      if (r.text.startsWith(`${tag} `)) {
        const status = r.text.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new ImapError(`${cmd.split(" ")[0]} failed: ${status}`);
        return out;
      }
      out.push(r);
    }
  }

  async connect(): Promise<void> {
    const tlsOpts = { servername: this.o.host, ca: this.o.ca, rejectUnauthorized: this.o.rejectUnauthorized ?? true, minVersion: "TLSv1.2" as const };
    const sock: Socket | TLSSocket = await new Promise((resolve, reject) => {
      const s = this.o.security === "tls"
        ? tlsConnect({ host: this.o.host, port: this.o.port, ...tlsOpts }, () => resolve(s))
        : netConnect({ host: this.o.host, port: this.o.port }, () => resolve(s));
      s.once("error", reject);
    });
    sock.setKeepAlive(true, 60_000);
    this.attach(sock);
    const greeting = await this.next();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new ImapError(`unexpected greeting: ${greeting.text}`);
    if (this.o.security === "starttls") {
      await this.command("STARTTLS");
      this.sock.removeAllListeners("data"); this.sock.removeAllListeners("error"); this.sock.removeAllListeners("close");
      const up: TLSSocket = await new Promise((resolve, reject) => {
        const s = tlsConnect({ socket: this.sock, ...tlsOpts }, () => resolve(s));
        s.once("error", reject);
      });
      this.buf = Buffer.alloc(0);
      this.attach(up);
    }
    await this.refreshCapabilities();
    await this.login();
    await this.refreshCapabilities();
  }

  private async refreshCapabilities(): Promise<void> {
    const r = await this.command("CAPABILITY");
    const line = r.find((x) => /^\* CAPABILITY /i.test(x.text));
    if (line) this.capabilities = line.text.slice(13).toUpperCase().split(/\s+/);
  }

  private async login(): Promise<void> {
    const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    if (this.o.accessToken) {
      const token = await this.o.accessToken();
      const sasl = Buffer.from(`user=${this.o.user}\x01auth=Bearer ${token}\x01\x01`).toString("base64");
      // A failed XOAUTH2 answers with a continuation holding the error; an empty line ends it.
      await this.command(`AUTHENTICATE XOAUTH2 ${sasl}`, () => "");
    } else if (this.o.pass !== undefined && this.capabilities.includes("AUTH=PLAIN") && !/[\r\n]/.test(this.o.pass)) {
      const sasl = Buffer.from(`\0${this.o.user}\0${this.o.pass}`).toString("base64");
      await this.command("AUTHENTICATE PLAIN", () => sasl);
    } else if (this.o.pass !== undefined) {
      await this.command(`LOGIN ${quote(this.o.user)} ${quote(this.o.pass)}`);
    } else {
      throw new ImapError("no IMAP credentials: give pass or accessToken");
    }
  }

  async select(mailbox = "INBOX"): Promise<{ uidValidity: number; exists: number }> {
    const r = await this.command(`SELECT "${mailbox.replace(/(["\\])/g, "\\$1")}"`);
    const num = (re: RegExp) => Number((r.map((x) => x.text).join("\n").match(re) ?? [])[1] ?? 0);
    return { uidValidity: num(/UIDVALIDITY (\d+)/i), exists: num(/^\* (\d+) EXISTS/im) };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.command(`UID SEARCH ${criteria}`);
    return r.filter((x) => /^\* SEARCH/i.test(x.text)).flatMap((x) => x.text.slice(8).trim().split(/\s+/).filter(Boolean).map(Number));
  }

  /** The raw message, without setting \Seen. */
  async uidFetchRaw(uid: number): Promise<Buffer | undefined> {
    const r = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    for (const x of r) {
      if (!/FETCH \(/i.test(x.text)) continue;
      const u = Number((x.text.match(/UID (\d+)/i) ?? [])[1]);
      if (u !== uid) continue;
      const m = x.text.match(/BODY\[\] \x00(\d+)\x00/i);
      if (m) return x.literals[Number(m[1])];
      const q = x.text.match(/BODY\[\] "((?:[^"\\]|\\.)*)"/i);
      if (q) return Buffer.from(q[1]!.replace(/\\(.)/g, "$1"), "latin1");
    }
    return undefined;
  }

  async markSeen(uid: number): Promise<void> {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
  }

  /** Wait in IDLE until the server reports new mail or `ms` passes. Returns
   *  true when something arrived. */
  async idle(ms: number): Promise<boolean> {
    const tag = `A${++this.tag}`;
    this.sock.write(`${tag} IDLE\r\n`);
    const cont = await this.next();
    if (!cont.text.startsWith("+")) throw new ImapError(`IDLE refused: ${cont.text}`);
    let arrived = false;
    const deadline = Date.now() + ms;
    try {
      while (!arrived) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let r: ImapResponse;
        try { r = await this.next(left); } catch (e) { if (this.closed) throw e; break; }
        if (/^\* \d+ (EXISTS|RECENT)/i.test(r.text)) arrived = true;
        else this.onUntagged?.(r);
      }
    } finally {
      if (!this.closed) {
        this.sock.write("DONE\r\n");
        for (;;) {
          const r = await this.next();
          if (r.text.startsWith(`${tag} `)) break;
          if (/^\* \d+ EXISTS/i.test(r.text)) arrived = true;
        }
      }
    }
    return arrived;
  }

  async logout(): Promise<void> {
    try { if (!this.closed) await this.command("LOGOUT"); } catch { /* closing anyway */ }
    this.sock?.destroy();
  }

  get isClosed(): boolean { return Boolean(this.closed); }

  /** Drop the connection now. A command or IDLE in progress fails at once. */
  destroy(): void {
    const e = new ImapError("the IMAP connection was closed by this client");
    if (!this.closed) this.closed = e;
    this.waiter?.reject(e);
    this.waiter = undefined;
    this.sock?.destroy();
  }
}
