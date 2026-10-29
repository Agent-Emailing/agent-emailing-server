// SMTP submission (RFC 6409) over node's tls and net: implicit TLS (port 465)
// or STARTTLS (port 587), AUTH PLAIN, LOGIN or XOAUTH2, and one message per
// connection. Only the subset an agent's mailbox needs.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface SmtpOptions {
  host: string;
  port: number;
  /** "tls" for implicit TLS, "starttls" to upgrade, "none" only for a local test server. */
  security: "tls" | "starttls" | "none";
  user?: string;
  pass?: string;
  /** An OAuth access token source, for XOAUTH2 (Gmail, Microsoft 365). */
  accessToken?: () => Promise<string>;
  /** The name to give in EHLO. */
  helo?: string;
  timeoutMs?: number;
  /** Extra CA certificates, for a server with a private CA. */
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
}

class Lines {
  private buf = "";
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private err?: Error;
  private errWaiters: ((e: Error) => void)[] = [];
  constructor(private sock: Socket | TLSSocket) { this.attach(sock); }
  attach(sock: Socket | TLSSocket): void {
    this.sock = sock;
    sock.setEncoding("latin1");
    sock.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\r\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        const w = this.waiters.shift();
        if (w) w(line); else this.lines.push(line);
      }
    });
    const fail = (e: Error) => { this.err = e; for (const w of this.errWaiters.splice(0)) w(e); };
    sock.on("error", fail);
    sock.on("close", () => fail(new Error("the SMTP connection closed")));
  }
  detach(): void { this.sock.removeAllListeners("data"); this.sock.removeAllListeners("error"); this.sock.removeAllListeners("close"); }
  next(timeoutMs: number): Promise<string> {
    const l = this.lines.shift();
    if (l !== undefined) return Promise.resolve(l);
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the SMTP server did not answer in time")), timeoutMs);
      this.waiters.push((line) => { clearTimeout(t); resolve(line); });
      this.errWaiters.push((e) => { clearTimeout(t); reject(e); });
    });
  }
}

export class SmtpError extends Error {
  constructor(readonly code: number, readonly reply: string) { super(`SMTP ${code}: ${reply}`); }
}

/** Send one raw RFC 5322 message. Returns the server's final reply, which
 *  usually names its queue id. */
export async function smtpSend(o: SmtpOptions, envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ reply: string }> {
  const timeout = o.timeoutMs ?? 60_000;
  const tlsOpts = { servername: o.host, ca: o.ca, rejectUnauthorized: o.rejectUnauthorized ?? true, minVersion: "TLSv1.2" as const };
  let sock: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const s = o.security === "tls"
      ? tlsConnect({ host: o.host, port: o.port, ...tlsOpts }, () => resolve(s))
      : netConnect({ host: o.host, port: o.port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(timeout, () => s.destroy(new Error("the SMTP connection timed out")));
  });
  const lines = new Lines(sock);
  const reply = async (): Promise<{ code: number; text: string[] }> => {
    const text: string[] = [];
    for (;;) {
      const l = await lines.next(timeout);
      text.push(l.slice(4));
      if (l[3] !== "-") return { code: Number(l.slice(0, 3)), text };
    }
  };
  const expect = async (ok: number[]): Promise<{ code: number; text: string[] }> => {
    const r = await reply();
    if (!ok.includes(r.code)) throw new SmtpError(r.code, r.text.join(" "));
    return r;
  };
  const cmd = async (line: string, ok: number[]) => { sock.write(line + "\r\n"); return expect(ok); };
  const helo = o.helo ?? "agent-emailing-server.invalid";
  try {
    await expect([220]);
    let ehlo = await cmd(`EHLO ${helo}`, [250]);
    if (o.security === "starttls") {
      if (!ehlo.text.some((t) => /^STARTTLS\b/i.test(t))) throw new Error("the SMTP server does not offer STARTTLS");
      await cmd("STARTTLS", [220]);
      lines.detach();
      sock = await new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect({ socket: sock, ...tlsOpts }, () => resolve(s));
        s.once("error", reject);
      });
      lines.attach(sock);
      ehlo = await cmd(`EHLO ${helo}`, [250]);
    }
    const authLine = ehlo.text.find((t) => /^AUTH[ =]/i.test(t)) ?? "";
    const mechs = authLine.slice(5).toUpperCase().split(/\s+/);
    if (o.accessToken) {
      const token = await o.accessToken();
      const sasl = Buffer.from(`user=${o.user ?? envelope.from}\x01auth=Bearer ${token}\x01\x01`).toString("base64");
      sock.write(`AUTH XOAUTH2 ${sasl}\r\n`);
      const r = await reply();
      if (r.code === 334) { sock.write("\r\n"); await expect([235]); }
      else if (r.code !== 235) throw new SmtpError(r.code, r.text.join(" "));
    } else if (o.user && o.pass !== undefined) {
      if (mechs.includes("PLAIN") || !mechs.includes("LOGIN")) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`).toString("base64")}`, [235]);
      } else {
        await cmd("AUTH LOGIN", [334]);
        await cmd(Buffer.from(o.user).toString("base64"), [334]);
        await cmd(Buffer.from(o.pass).toString("base64"), [235]);
      }
    }
    const size = ehlo.text.some((t) => /^SIZE\b/i.test(t)) ? ` SIZE=${raw.length}` : "";
    await cmd(`MAIL FROM:<${envelope.from}>${size}`, [250]);
    for (const to of envelope.to) await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd("DATA", [354]);
    // Dot-stuffing (RFC 5321 §4.5.2), and a final CRLF.
    let body = raw.toString("latin1").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    if (!body.endsWith("\r\n")) body += "\r\n";
    sock.write(Buffer.from(body + ".\r\n", "latin1"));
    const done = await expect([250]);
    sock.write("QUIT\r\n");
    return { reply: done.text.join(" ") };
  } finally {
    setTimeout(() => sock.destroy(), 1000).unref();
  }
}
