// Building an agent email (Agent Emailing §3): the human part first, then
// exactly one envelope part, then the file parts each envelope entry refers to
// with a cid: reference.
import { randomBytes } from "node:crypto";
import type { Envelope, FileRef } from "./envelope/envelope.js";
import { sha256hex, signEnvelope, verifyEnvelope } from "./envelope/envelope.js";
import type { AgentKey } from "./envelope/keys.js";
import { ENVELOPE_MEDIA_TYPE, EMAILING_VERSION, isSealed, returnedFiles, withHuman, type HumanContext } from "./human.js";
import {
  attachmentPart, encodeWords, foldHeader, formatAddress, multipart, newBoundary, newMessageId, rfc5322Date, textPart, type Attachment,
} from "./mime/mime.js";

/** One email to send, in the shape of the adapter's send() (§11.4). */
export interface OutboundMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  /** Extra headers. A carrier adapter drops the ones its carrier refuses. */
  headers?: Record<string, string>;
  attachments: Attachment[];
}

/** The default limit for a whole encoded email when the endpoint states none (§3.7). */
export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** A file to carry in the same email. Returns the envelope entry, with its
 *  cid: reference, size and digest (§3.4), and the attachment that goes with it. */
export function attachFile(bytes: Uint8Array, file: { name: string; media_type: string; domain?: string }): { entry: FileRef; attachment: Attachment } {
  const cid = `${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}.${randomBytes(6).toString("hex")}@${file.domain ?? "agent-emailing.invalid"}`;
  return {
    entry: { name: file.name, media_type: file.media_type, ref: `cid:${cid}`, size: bytes.length, digest: `sha256:${sha256hex(bytes)}` },
    attachment: { filename: file.name, contentType: file.media_type, contentId: cid, bytes },
  };
}

/** Every file entry the envelope shows in the clear: payload.files and the
 *  ref parts of its artifacts. */
export function fileEntries(env: Envelope): FileRef[] {
  if (isSealed(env)) return [];
  return [...((env.payload?.files ?? []) as FileRef[]), ...returnedFiles(env)];
}

export interface ComposeOptions {
  /** The unsigned envelope. Its meta.agent_emailing is replaced. */
  envelope: Envelope;
  /** The sending agent's key. Omit it to get the prepared envelope back unsigned (see prepareEnvelope). */
  key: AgentKey;
  human: HumanContext;
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
  /** File parts. Each must match an entry with a cid: reference, unless the
   *  envelope is sealed and the part is ciphertext referred to from inside it. */
  attachments?: Attachment[];
  /** Threading (§3.6). */
  inReplyTo?: string;
  references?: string[];
  /** Add the hint headers of §3.5 (default true). */
  hints?: boolean;
  /** The receiving endpoint's max_message_bytes, when it states one (§3.7). */
  maxMessageBytes?: number;
}

export interface ComposedEmail {
  envelope: Envelope;
  mail: OutboundMail;
}

/** Add the signed summary and sign: the steps of §3.3 in order. */
export function prepareEnvelope(env: Envelope, human: HumanContext, key: AgentKey): { envelope: Envelope; text: string; subject: string } {
  const { env: withMeta, text, subject } = withHuman(env, human);
  const envelope = signEnvelope(withMeta, key);
  if (!verifyEnvelope(envelope)) throw new Error("the signed envelope does not verify");
  return { envelope, text, subject };
}

/** Build an agent email from an unsigned envelope. */
export function composeAgentEmail(o: ComposeOptions): ComposedEmail {
  const env = o.envelope;
  if (env.type !== "request" && env.type !== "respond") {
    throw new Error(`a ${env.type} does not travel by email (Agent Emailing §2.2)`);
  }
  if (env.type === "request" && env.payload?.config?.stream === true) {
    throw new Error("streaming does not travel by email (Agent Emailing §2.2)");
  }
  const attachments = o.attachments ?? [];
  const entries = fileEntries(env).filter((f) => typeof f.ref === "string" && f.ref.startsWith("cid:"));
  if (isSealed(env) && attachments.length && (env.payload?.files?.length || returnedFiles(env).length)) {
    throw new Error("a sealed envelope must not refer to a file in the clear (Agent Emailing §9)");
  }
  for (const f of entries) {
    if (typeof f.media_type !== "string" || typeof f.size !== "number" || typeof f.digest !== "string") {
      throw new Error(`the file entry ${f.name ?? f.ref} needs media_type, size and digest (Agent Emailing §3.4)`);
    }
    const part = attachments.find((a) => a.contentId === f.ref!.slice(4));
    if (!part) throw new Error(`no attachment for ${f.ref}`);
    if (part.bytes.length !== f.size || `sha256:${sha256hex(part.bytes)}` !== f.digest) {
      throw new Error(`the attachment for ${f.ref} does not match its entry's size and digest`);
    }
  }
  if (!isSealed(env)) {
    for (const a of attachments) {
      if (!a.contentId || !entries.some((f) => f.ref === `cid:${a.contentId}`)) {
        throw new Error(`the attachment ${a.filename} is not referred to by the envelope (Agent Emailing §3.4)`);
      }
    }
  }

  const { envelope, text, subject } = prepareEnvelope(env, o.human, o.key);
  const envelopeAttachment: Attachment = {
    filename: "envelope.json", contentType: ENVELOPE_MEDIA_TYPE, bytes: Buffer.from(JSON.stringify(envelope), "utf8"),
  };
  const headers: Record<string, string> = { "Auto-Submitted": "auto-generated" };
  if (o.hints !== false) {
    headers["Agent-Emailing-Version"] = EMAILING_VERSION;
    headers["Agent-Messaging-Type"] = envelope.type;
    if (envelope.task_id) headers["Agent-Messaging-Task"] = envelope.task_id;
    if (envelope.context_id) headers["Agent-Messaging-Context"] = envelope.context_id;
  }
  const mail: OutboundMail = {
    from: formatAddress(o.from),
    to: o.to.map(formatAddress),
    subject,
    text,
    inReplyTo: o.inReplyTo,
    references: o.references,
    headers,
    attachments: [envelopeAttachment, ...attachments],
  };
  const limit = o.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const size = estimateSize(mail);
  if (size > limit) {
    throw new Error(`the email would be about ${size} bytes, over the limit of ${limit} (Agent Emailing §3.7); carry large files by reference`);
  }
  return { envelope, mail };
}

/** The encoded size of a mail, near enough to compare with a limit. */
export function estimateSize(mail: OutboundMail): number {
  const b64 = (n: number) => Math.ceil(n / 3) * 4 * (78 / 76);
  return 2048 + Buffer.byteLength(mail.text, "utf8") * 1.1 + (mail.html ? Buffer.byteLength(mail.html, "utf8") * 1.1 : 0)
    + mail.attachments.reduce((s, a) => s + b64(a.bytes.length) + 300, 0);
}

/** Render an OutboundMail as a raw RFC 5322 message, for carriers that take
 *  raw MIME (SMTP). The envelope part is base64, the file parts are base64,
 *  and the text is 7bit or quoted-printable, never format=flowed. */
export function renderMime(mail: OutboundMail, opts: { messageId?: string; date?: Date } = {}): { raw: Buffer; messageId: string } {
  const fromDomain = (mail.from.match(/@([^>\s]+)>?\s*$/) ?? [])[1] ?? "agent-emailing.invalid";
  const messageId = opts.messageId ?? newMessageId(fromDomain);
  const lines: string[] = [
    foldHeader("From", mail.from),
    foldHeader("To", mail.to.join(", ")),
    foldHeader("Subject", encodeWords(mail.subject)),
    `Date: ${rfc5322Date(opts.date)}`,
    `Message-ID: ${messageId}`,
  ];
  if (mail.inReplyTo) lines.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references?.length) lines.push(foldHeader("References", mail.references.join(" ")));
  for (const [k, v] of Object.entries(mail.headers ?? {})) {
    if (/^(from|to|subject|date|message-id|in-reply-to|references|mime-version|content-type|content-transfer-encoding)$/i.test(k)) continue;
    if (/[\r\n]/.test(v) || !/^[\x21-\x39\x3b-\x7e]+$/.test(k)) throw new Error(`a bad header: ${k}`);
    lines.push(foldHeader(k, encodeWords(v)));
  }
  lines.push("MIME-Version: 1.0");
  const human = mail.html
    ? multipart("multipart/alternative", newBoundary(), [textPart(mail.text), textPart(mail.html, "html")])
    : textPart(mail.text);
  const parts = [human, ...mail.attachments.map((a) => attachmentPart(a, a.contentType === ENVELOPE_MEDIA_TYPE ? "; charset=utf-8" : ""))];
  const raw = lines.join("\r\n") + "\r\n" + multipart("multipart/mixed", newBoundary(), parts);
  return { raw: Buffer.from(raw, "utf8"), messageId };
}
