// The carrier test of Agent Emailing §12.3. A carrier passes when it carries
// 01-request.eml from one of its addresses to another, and the receiving side
// recovers, from what the carrier delivers:
//
//   - an envelope whose canonical form equals envelopes.request.canonical;
//   - an agenda.txt whose SHA-256 equals the value in cases.json; and
//   - a text part whose digest equals the envelope's meta.agent_emailing.human_text.
//
// The sending side may rebuild the email through the carrier's interface, as
// long as it attaches the envelope and the file unchanged. fixtureAsOutbound
// does that rebuilding.
import type { OutboundMail } from "./compose.js";
import { canonical, sha256hex, type Envelope } from "./envelope/envelope.js";
import { ENVELOPE_MEDIA_TYPE, textDigest } from "./human.js";
import { contentId, decodeWords, filenameOf, header, leaves, parseMail, textOf } from "./mime/mime.js";
import type { InboundMail } from "./providers/types.js";
import { toMime } from "./receive.js";

/** 01-request.eml as an OutboundMail between two addresses of the carrier
 *  under test: the same subject, text, envelope part and file part. */
export function fixtureAsOutbound(raw: Uint8Array, from: string, to: string): OutboundMail {
  const m = parseMail(raw);
  const all = leaves(m);
  const text = all.find((p) => p.type === "text/plain" && !filenameOf(p))!;
  return {
    from, to: [to], subject: decodeWords(header(m, "subject")), text: textOf(text),
    headers: { "Auto-Submitted": "auto-generated" },
    attachments: all.filter((p) => filenameOf(p)).map((p) => ({ filename: filenameOf(p)!, contentType: p.type, contentId: contentId(p), bytes: p.bytes })),
  };
}

export interface CarrierTestResult {
  pass: boolean;
  envelope: boolean;
  file: boolean;
  text: boolean;
  details: string[];
}

/** Check what a carrier delivered against cases.json. */
export function carrierTest(delivered: InboundMail | Uint8Array, cases: { envelopes: { request: { canonical: string } }; files: Record<string, { sha256: string }> }): CarrierTestResult {
  const m = toMime(delivered);
  const all = leaves(m);
  const details: string[] = [];
  const envParts = all.filter((p) => p.type === ENVELOPE_MEDIA_TYPE);
  let env: Envelope | undefined;
  try { env = envParts.length === 1 ? JSON.parse(envParts[0]!.bytes.toString("utf8")) : undefined; } catch { env = undefined; }
  const strip = (e: Envelope) => { const { sig: _s, ...r } = e; return canonical(r); };
  const envelope = Boolean(env) && strip(env!) === cases.envelopes.request.canonical;
  if (!envelope) details.push(envParts.length !== 1 ? `${envParts.length} envelope parts arrived` : "the envelope's canonical form differs");
  const agenda = all.find((p) => filenameOf(p) === "agenda.txt");
  const file = Boolean(agenda) && sha256hex(agenda!.bytes) === cases.files["agenda.txt"]!.sha256;
  if (!file) details.push(agenda ? "agenda.txt arrived changed" : "agenda.txt did not arrive");
  const textPart = all.find((p) => p.type === "text/plain" && !filenameOf(p));
  const text = Boolean(textPart && env) && textDigest(textOf(textPart!)) === env!.meta?.agent_emailing?.human_text;
  if (!text) details.push(textPart ? "the text part's digest differs (a footer or banner?)" : "no text part arrived");
  return { pass: envelope && file && text, envelope, file, text, details };
}
