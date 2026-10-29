// The built-in IMAP and SMTP clients against two small fake servers on
// localhost, which speak just enough of each protocol: an SMTP server that
// stores what it receives, and an IMAP server that serves those messages.
// The live round trip against a real mailbox is tools/live-imap.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { smtpSend } from "../dist/providers/smtp.js";
import { ImapSmtpCarrier } from "../dist/providers/imap-smtp.js";

function fakeSmtp(store) {
  return createServer((sock) => {
    sock.setEncoding("latin1");
    let buf = "", data = false, msg = "", auth = false, from, rcpt = [];
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") { data = false; store.push({ from, rcpt, raw: Buffer.from(msg.replace(/^\.\./gm, "."), "latin1") }); msg = ""; sock.write("250 2.0.0 Ok: queued as ABC123\r\n"); }
          else msg += line + "\r\n";
          continue;
        }
        if (/^EHLO/i.test(line)) sock.write("250-fake\r\n250-SIZE 10000000\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (/^AUTH PLAIN /i.test(line)) { auth = Buffer.from(line.slice(11), "base64").toString() === "\0agent@example.org\0pw"; sock.write(auth ? "235 ok\r\n" : "535 no\r\n"); }
        else if (/^MAIL FROM:<([^>]*)>/i.test(line)) { if (!auth) { sock.write("530 auth first\r\n"); continue; } from = line.match(/<([^>]*)>/)[1]; sock.write("250 ok\r\n"); }
        else if (/^RCPT TO:/i.test(line)) { rcpt.push(line.match(/<([^>]*)>/)[1]); sock.write("250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { data = true; sock.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("500 what\r\n");
      }
    });
  });
}

function fakeImap(messages) {
  // messages: [{ uid, raw, seen }]
  return createServer((sock) => {
    let buf = "", idleTag = null, authed = false;
    sock.write("* OK fake IMAP ready\r\n");
    const onData = (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (idleTag) { if (line === "DONE") { sock.write(`${idleTag} OK IDLE done\r\n`); idleTag = null; } continue; }
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        if (/^CAPABILITY/i.test(cmd)) sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE\r\n${tag} OK\r\n`);
        else if (/^AUTHENTICATE PLAIN/i.test(cmd)) {
          sock.write("+ \r\n");
          const wait = (d2) => {
            const s = d2.toString("latin1").trim();
            authed = Buffer.from(s, "base64").toString() === "\0agent@example.org\0pw";
            sock.write(authed ? `${tag} OK authenticated\r\n` : `${tag} NO bad\r\n`);
            sock.off("data", wait); sock.on("data", onData);
          };
          sock.off("data", onData); sock.on("data", wait);
          return;
        }
        else if (!authed) sock.write(`${tag} NO login first\r\n`);
        else if (/^SELECT/i.test(cmd)) sock.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (/^UID SEARCH UNSEEN/i.test(cmd)) sock.write(`* SEARCH ${messages.filter((m) => !m.seen).map((m) => m.uid).join(" ")}\r\n${tag} OK\r\n`);
        else if (/^UID FETCH (\d+)/i.test(cmd)) {
          const m = messages.find((x) => x.uid === Number(cmd.match(/^UID FETCH (\d+)/i)[1]));
          sock.write(Buffer.concat([Buffer.from(`* ${m.uid} FETCH (UID ${m.uid} BODY[] {${m.raw.length}}\r\n`, "latin1"), m.raw, Buffer.from(`)\r\n${tag} OK\r\n`, "latin1")]));
        }
        else if (/^UID STORE (\d+) \+FLAGS/i.test(cmd)) { messages.find((x) => x.uid === Number(cmd.match(/(\d+)/)[1])).seen = true; sock.write(`${tag} OK\r\n`); }
        else if (/^IDLE/i.test(cmd)) { idleTag = tag; sock.write("+ idling\r\n"); }
        else if (/^NOOP/i.test(cmd)) sock.write(`${tag} OK\r\n`);
        else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK\r\n`); sock.end(); }
        else sock.write(`${tag} BAD what\r\n`);
      }
    };
    sock.on("data", onData);
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("SMTP: AUTH PLAIN, dot-stuffing, and the queue id", async () => {
  const store = [];
  const srv = fakeSmtp(store);
  const port = await listen(srv);
  try {
    const raw = Buffer.from("From: agent@example.org\r\nTo: peer@example.com\r\nSubject: t\r\n\r\n.a line that starts with a dot\r\nend\r\n", "latin1");
    const r = await smtpSend({ host: "127.0.0.1", port, security: "none", user: "agent@example.org", pass: "pw" }, { from: "agent@example.org", to: ["peer@example.com"] }, raw);
    assert.match(r.reply, /queued as ABC123/);
    assert.deepEqual(store[0].raw, raw);
    assert.deepEqual(store[0].rcpt, ["peer@example.com"]);
    await assert.rejects(smtpSend({ host: "127.0.0.1", port, security: "none", user: "agent@example.org", pass: "wrong" }, { from: "a@example.org", to: ["b@example.com"] }, raw), /535/);
  } finally { srv.close(); }
});

test("IMAP: an agent email sent over SMTP comes back byte for byte, is handed over, and marked seen", async () => {
  const store = [];
  const smtp = fakeSmtp(store);
  const smtpPort = await listen(smtp);
  const fixture = readFileSync(new URL("../conformance/fixtures/01-request.eml", import.meta.url));
  const messages = [{ uid: 7, raw: fixture, seen: false }];
  const imap = fakeImap(messages);
  const imapPort = await listen(imap);
  const carrier = new ImapSmtpCarrier({
    imap: { host: "127.0.0.1", port: imapPort, security: "none", user: "agent@example.org", pass: "pw" },
    smtp: { host: "127.0.0.1", port: smtpPort, security: "none", user: "agent@example.org", pass: "pw" },
    pollMs: 200,
  });
  const got = [];
  carrier.receive(async (m) => { got.push(m); });
  try {
    await carrier.start();
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 1);
    assert.deepEqual(Buffer.from(got[0].raw), fixture, "the raw message, exactly as the server holds it");
    assert.equal(got[0].carrierEventId, "imap:agent@example.org:42:7");
    for (let i = 0; i < 50 && !messages[0].seen; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(messages[0].seen, true);
    const sent = await carrier.send({ from: "agent@example.org", to: ["peer@example.com"], subject: "Book a meeting — request", text: "hello", attachments: [{ filename: "envelope.json", contentType: "application/vnd.agentmessaging.envelope+json", bytes: Buffer.from("{}") }] });
    assert.equal(sent.carrierId, "smtp:ABC123");
    assert.match(store[0].raw.toString("latin1"), /Subject: =\?UTF-8\?B\?/);
  } finally { await carrier.close(); smtp.close(); imap.close(); }
});
