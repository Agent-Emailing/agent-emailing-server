// A small MIME reader and writer (RFC 2045 to 2049, RFC 2047, RFC 2231). It is
// the subset Agent Emailing needs, not a mail library: multipart trees, base64,
// quoted-printable, 7bit, 8bit and binary bodies, folded headers, encoded
// words and parameter continuations.
//
// The reader works on bytes. The message is read as latin1, which maps every
// byte to one character and back, so binary and 8bit bodies come out exactly
// as they went in.
import { randomBytes } from "node:crypto";

export type Headers = [string, string][];

export interface MimePart {
  /** Header names lowercased, values unfolded and decoded from UTF-8 bytes. */
  headers: Headers;
  /** The media type, lowercased, without parameters. */
  type: string;
  /** Content-Type parameters, names lowercased. */
  params: Record<string, string>;
  /** Child parts of a multipart. Empty for a leaf. */
  parts: MimePart[];
  /** A leaf's body, transfer-decoded. */
  bytes: Buffer;
  /** The Content-Transfer-Encoding as written, lowercased. */
  encoding: string;
}

// ── reading ─────────────────────────────────────────────────────────────────

function splitHead(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  if (lf >= 0) return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
  // No blank line: a message of headers only, or a part with only a body.
  if (/^[\x21-\x39\x3b-\x7e]+:/.test(raw)) return { head: raw, body: "" };
  return { head: "", body: raw };
}

/** Parse a header block. Values are unfolded; bytes are read as UTF-8 (RFC 6532). */
export function parseHeaders(head: string): Headers {
  const headers: Headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1]![1] += " " + line.trim();
    } else {
      const c = line.indexOf(":");
      if (c > 0) headers.push([line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim()]);
    }
  }
  return headers.map(([k, v]) => [k, Buffer.from(v, "latin1").toString("utf8")]);
}

export const header = (h: Headers | MimePart, name: string): string | undefined => {
  const list = Array.isArray(h) ? h : h.headers;
  return (list.find(([k]) => k === name.toLowerCase()) ?? [])[1];
};
export const headersAll = (h: Headers | MimePart, name: string): string[] =>
  (Array.isArray(h) ? h : h.headers).filter(([k]) => k === name.toLowerCase()).map(([, v]) => v);

/** Split "value; a=1; b="x;y"" into the value and its parameters, with RFC
 *  2231 continuations (name*0=, name*1=) and charsets (name*=UTF-8''...). */
export function parseParams(value: string | undefined): { value: string; params: Record<string, string> } {
  const s = value ?? "";
  const items: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' && s[i - 1] !== "\\") quoted = !quoted;
    if (ch === ";" && !quoted) { items.push(cur); cur = ""; } else cur += ch;
  }
  items.push(cur);
  const params: Record<string, string> = {};
  const pieces: Record<string, { n: number; v: string; ext: boolean }[]> = {};
  for (const item of items.slice(1)) {
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    let name = item.slice(0, eq).trim().toLowerCase();
    let v = item.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = name.match(/^([^*]+)(?:\*(\d+))?(\*)?$/);
    if (!m) continue;
    name = m[1]!;
    if (m[2] === undefined && !m[3]) { params[name] = v; continue; }
    (pieces[name] ??= []).push({ n: m[2] ? Number(m[2]) : 0, v, ext: Boolean(m[3]) });
  }
  for (const [name, list] of Object.entries(pieces)) {
    list.sort((a, b) => a.n - b.n);
    let charset = "utf-8";
    const bytes: number[] = [];
    list.forEach((p, i) => {
      let v = p.v;
      if (p.ext && i === 0) {
        const q = v.match(/^([^']*)'[^']*'(.*)$/);
        if (q) { charset = q[1] || "utf-8"; v = q[2]!; }
      }
      if (p.ext) {
        for (let j = 0; j < v.length; j++) {
          if (v[j] === "%" && /^[0-9a-f]{2}$/i.test(v.slice(j + 1, j + 3))) { bytes.push(parseInt(v.slice(j + 1, j + 3), 16)); j += 2; }
          else bytes.push(...Buffer.from(v[j]!, "utf8"));
        }
      } else bytes.push(...Buffer.from(v, "utf8"));
    });
    params[name] = decodeCharset(Buffer.from(bytes), charset);
  }
  return { value: items[0]!.trim(), params };
}

export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function decodeQP(s: string): Buffer {
  const text = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "=" && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, cte: string): Buffer {
  if (cte === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (cte === "quoted-printable") return decodeQP(body);
  return Buffer.from(body, "latin1");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseNode(raw: string, depth: number, defaultType = "text/plain"): MimePart {
  const { head, body } = splitHead(raw);
  const headers = parseHeaders(head);
  const ct = parseParams(header(headers, "content-type") ?? defaultType);
  const type = (ct.value || defaultType).toLowerCase();
  const encoding = (header(headers, "content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  const node: MimePart = { headers, type, params: ct.params, parts: [], bytes: Buffer.alloc(0), encoding };
  const boundary = ct.params.boundary;
  if (type.startsWith("multipart/") && boundary && depth < 32) {
    const childDefault = type === "multipart/digest" ? "message/rfc822" : "text/plain";
    // RFC 2046 §5.1.1: the CRLF before a delimiter belongs to the delimiter.
    const re = new RegExp(`(?:^|\\r?\\n)--${escapeRe(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, "g");
    const marks: { start: number; end: number; close: boolean }[] = [];
    for (let m; (m = re.exec(body)); ) marks.push({ start: m.index, end: m.index + m[0].length, close: Boolean(m[1]) });
    for (let i = 0; i < marks.length; i++) {
      if (marks[i]!.close) break;
      const from = marks[i]!.end;
      const to = i + 1 < marks.length ? marks[i + 1]!.start : body.length;
      const chunk = body.slice(from, to).replace(/^\r?\n/, "");
      node.parts.push(parseNode(chunk, depth + 1, childDefault));
    }
    return node;
  }
  node.bytes = decodeBody(body, encoding);
  return node;
}

/** Parse a raw RFC 5322 message. */
export function parseMail(raw: Uint8Array | string): MimePart {
  const s = typeof raw === "string" ? Buffer.from(raw, "utf8").toString("latin1") : Buffer.from(raw).toString("latin1");
  return parseNode(s, 0);
}

/** Every leaf of the tree, depth first. A message/rfc822 part is a leaf: it is
 *  another email, and this reader does not open it. */
export const leaves = (n: MimePart): MimePart[] => (n.parts.length ? n.parts.flatMap(leaves) : [n]);

/** The Content-ID without its angle brackets. */
export function contentId(p: MimePart): string | undefined {
  const v = header(p, "content-id");
  if (!v) return undefined;
  const m = v.trim().match(/^<?([^<>]*)>?$/);
  return m ? m[1]!.trim() : v.trim();
}

/** The part's file name, from Content-Disposition or the Content-Type name. */
export function filenameOf(p: MimePart): string | undefined {
  const d = parseParams(header(p, "content-disposition"));
  const n = d.params.filename ?? p.params.name;
  return n === undefined ? undefined : decodeWords(n);
}

/** The text of a text part, decoded by its charset. */
export const textOf = (p: MimePart): string => decodeCharset(p.bytes, p.params.charset ?? "utf-8");

// ── RFC 2047 ────────────────────────────────────────────────────────────────

/** Encode a header value with RFC 2047 encoded words when it is not ASCII. */
export function encodeWords(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // Split on whole characters, so no encoded word ends inside a UTF-8 sequence.
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, "utf8") > 45) { words.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function decodeWords(s: string | undefined): string {
  return (s ?? "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?[^?]+\?[BbQq]\?))?/g, (_m, cs: string, enc: string, text: string) => {
    const charset = cs.split("*")[0]!;
    const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQP(text.replace(/_/g, " "));
    return decodeCharset(bytes, charset);
  });
}

// ── addresses ───────────────────────────────────────────────────────────────

/** The addr-specs in an address list header, lowercased domain kept as written. */
export function parseAddresses(value: string | undefined): { name?: string; address: string }[] {
  if (!value) return [];
  const out: { name?: string; address: string }[] = [];
  let cur = "", quoted = false, angle = 0, comment = 0;
  const flush = () => {
    const item = cur.trim();
    cur = "";
    if (!item) return;
    const m = item.match(/^(.*?)<([^<>]*)>\s*$/);
    if (m) {
      const name = decodeWords(m[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1")) || undefined;
      if (m[2]!.includes("@")) out.push({ name, address: m[2]!.trim() });
    } else {
      const bare = item.replace(/\([^)]*\)/g, "").trim();
      if (bare.includes("@")) out.push({ address: bare });
    }
  };
  for (const ch of value) {
    if (ch === '"' && comment === 0) quoted = !quoted;
    else if (!quoted && ch === "(") comment++;
    else if (!quoted && ch === ")" && comment > 0) comment--;
    else if (!quoted && comment === 0 && ch === "<") angle++;
    else if (!quoted && comment === 0 && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0 && comment === 0) flush();
    else if (ch === ";" && !quoted && angle === 0 && comment === 0) flush(); // end of a group
    else if (ch === ":" && !quoted && angle === 0 && comment === 0 && !cur.includes("@")) cur = ""; // group name
    else cur += ch;
  }
  flush();
  return out;
}

export const firstAddress = (value: string | undefined): string | undefined => parseAddresses(value)[0]?.address;

/** The Message-IDs in a header such as References, with their angle brackets. */
export const parseMessageIds = (value: string | undefined): string[] => (value ?? "").match(/<[^<>\s]+>/g) ?? [];

// ── writing ─────────────────────────────────────────────────────────────────

const CRLF = "\r\n";

export const base64Lines = (bytes: Uint8Array): string => {
  const b = Buffer.from(bytes).toString("base64");
  return b.length ? b.match(/.{1,76}/g)!.join(CRLF) : "";
};

/** Quoted-printable for text (RFC 2045 §6.7): line breaks become CRLF, and
 *  every line is kept under 76 characters with soft breaks. */
export function encodeQP(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    let enc = "";
    for (const byte of Buffer.from(line, "utf8")) {
      enc += (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9
        ? String.fromCharCode(byte)
        : "=" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
    enc = enc.replace(/[ \t]$/, (c) => "=" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
    while (enc.length > 75) {
      let cut = 75;
      if (enc[cut - 1] === "=") cut -= 1; else if (enc[cut - 2] === "=") cut -= 2;
      out.push(enc.slice(0, cut) + "=");
      enc = enc.slice(cut);
    }
    out.push(enc);
  }
  return out.join(CRLF);
}

/** Fold a header line at spaces so no line is longer than 78 characters. */
export function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes("\r\n")) return line;
  const words = line.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > 78) { lines.push(cur); cur = " " + w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.join(CRLF);
}

const quoteParam = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? `"${v.replace(/(["\\])/g, "\\$1")}"` : `"${encodeWords(v)}"`);

/** A text/plain part. ASCII text with short lines goes as 7bit, anything else
 *  as quoted-printable. Never format=flowed (Agent Emailing §3.3). */
export function textPart(text: string, subtype: "plain" | "html" = "plain"): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // RFC 5322 §2.1.1: a line is at most 998 characters.
  const ascii = /^[\x09\x20-\x7e\n\r]*$/.test(text) && lines.every((l) => l.length <= 998);
  return ascii
    ? [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: 7bit", "", lines.join(CRLF)].join(CRLF)
    : [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable", "", encodeQP(text)].join(CRLF);
}

export interface Attachment {
  filename: string;
  contentType: string;
  contentId?: string;
  bytes: Uint8Array;
}

/** An attachment part, always base64. */
export function attachmentPart(a: Attachment, extraParams = ""): string {
  return [
    `Content-Type: ${a.contentType}${extraParams}; name=${quoteParam(a.filename)}`,
    `Content-Disposition: attachment; filename=${quoteParam(a.filename)}`,
    ...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(a.bytes),
  ].join(CRLF);
}

export const newBoundary = (): string => `=_ae_${randomBytes(12).toString("hex")}`;

export function multipart(type: string, boundary: string, parts: string[]): string {
  return [`Content-Type: ${type}; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}${CRLF}${p}`), `--${boundary}--`, ""].join(CRLF);
}

/** An RFC 5322 date, in UTC. */
export function rfc5322Date(d = new Date()): string {
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day}, ${p(d.getUTCDate())} ${mon} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export const newMessageId = (domain: string): string => `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain}>`;

/** Format an address for a header: "Name" <addr> or just addr. */
export function formatAddress(a: { name?: string; address: string } | string): string {
  if (typeof a === "string") return a;
  if (!a.name) return a.address;
  return /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}" <${a.address}>` : `${encodeWords(a.name)} <${a.address}>`;
}
