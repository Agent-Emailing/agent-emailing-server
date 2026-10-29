#!/usr/bin/env node
// A live check of the built-in IMAP and SMTP clients' transport against a real
// mail service, sending no mail:
//
//   MAILBOX_SA_JSON='{...}' node tools/live-handshake.mjs --mailbox mailbox@example.org
//
// - IMAP on imap.gmail.com:993: implicit TLS, the greeting, CAPABILITY, and an
//   XOAUTH2 attempt with whatever token the service account can get. When the
//   account is not allowed the IMAP scope, the server's refusal must come back
//   as a clean error, not a hang.
// - SMTP on smtp.gmail.com:587: STARTTLS, EHLO before and after, then MAIL FROM
//   without signing in, which Gmail refuses with 530. Nothing is sent.
// - SMTP on smtp.gmail.com:465: implicit TLS and EHLO, refused the same way.
import { ImapClient } from "../dist/providers/imap.js";
import { smtpSend } from "../dist/providers/smtp.js";
import { googleAccessToken } from "../dist/providers/google-auth.js";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const MAILBOX = arg("mailbox");
if (!MAILBOX || !process.env.MAILBOX_SA_JSON) { console.error("needs --mailbox and MAILBOX_SA_JSON"); process.exit(2); }
const log = (s) => console.log(`${new Date().toISOString()}  ${s}`);
let ok = true;

// IMAP: try the full scope first, then the read-only one, whose token Gmail's IMAP refuses.
let token, scope;
for (const s of ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.readonly"]) {
  try { token = await googleAccessToken(process.env.MAILBOX_SA_JSON, MAILBOX, s); scope = s; break; }
  catch (e) { log(`token for ${s}: ${e.message}`); }
}
const imap = new ImapClient({ host: "imap.gmail.com", port: 993, security: "tls", user: MAILBOX, accessToken: async () => token, timeoutMs: 20_000 });
const t0 = Date.now();
try {
  await imap.connect();
  const { uidValidity, exists } = await imap.select("INBOX");
  log(`IMAP: signed in with the ${scope} token; INBOX has ${exists} messages (UIDVALIDITY ${uidValidity})`);
} catch (e) {
  const greeted = imap.capabilities.length > 0;
  log(`IMAP: TLS and greeting ${greeted ? "ok" : "FAILED"}; capabilities ${imap.capabilities.filter((c) => /IMAP4REV1|IDLE|AUTH=XOAUTH2|UIDPLUS/.test(c)).join(" ")}`);
  log(`IMAP: sign-in with the ${scope} token refused as expected in ${Date.now() - t0} ms: ${e.message}`);
  if (!greeted || scope === "https://mail.google.com/") ok = false;
} finally { imap.destroy(); }

for (const [port, security] of [[587, "starttls"], [465, "tls"]]) {
  try {
    await smtpSend({ host: "smtp.gmail.com", port, security, timeoutMs: 20_000 }, { from: MAILBOX, to: [MAILBOX] }, Buffer.from("Subject: never sent\r\n\r\nnever sent\r\n"));
    log(`SMTP ${port}: the server accepted mail without sign-in, which it should not`);
    ok = false;
  } catch (e) {
    const refusedAtMail = e.code === 530;
    log(`SMTP ${port} (${security}): TLS and EHLO ok; MAIL FROM without sign-in refused: ${e.message.slice(0, 90)}`);
    if (!refusedAtMail) ok = false;
  }
}
log(ok ? "HANDSHAKE CHECK PASSED" : "HANDSHAKE CHECK FAILED");
process.exit(ok ? 0 : 1);
