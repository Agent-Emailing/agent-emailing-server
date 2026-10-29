// Delivery status notifications (RFC 3464) and automatic mail (RFC 3834), for
// Agent Emailing §7.3 and §8.
import { header, leaves, parseHeaders, parseMessageIds, textOf, type MimePart } from "./mime/mime.js";

export interface DeliveryReport {
  /** "undeliverable" for a class 5 status, "deferred" for class 4. */
  outcome: "undeliverable" | "deferred" | "delivered" | "unknown";
  /** The first recipient's status code, such as 5.1.1. */
  status?: string;
  recipients: { recipient?: string; action?: string; status?: string; diagnostic?: string }[];
  /** The Message-ID of the email the report is about, from the returned
   *  headers or message, so the sender can find its request. */
  originalMessageId?: string;
}

/** True for a multipart/report (§7.3: never answered). */
export const isReport = (mail: MimePart): boolean => mail.type === "multipart/report";

/** True when an Auto-Submitted header has a value other than "no" (RFC 3834). */
export function isAutoSubmitted(mail: MimePart): boolean {
  const v = (header(mail, "auto-submitted") ?? "no").trim().toLowerCase().split(/[;\s]/)[0];
  return v !== "" && v !== "no";
}

/** Read a delivery status notification. Returns undefined when the email is
 *  not one. */
export function parseDsn(mail: MimePart): DeliveryReport | undefined {
  if (!isReport(mail) || (mail.params["report-type"] ?? "delivery-status").toLowerCase() !== "delivery-status") return undefined;
  const all = leaves(mail);
  const statusPart = all.find((p) => p.type === "message/delivery-status" || p.type === "message/global-delivery-status");
  if (!statusPart) return undefined;
  // The per-message fields, then one group per recipient, separated by blank lines.
  const groups = textOf(statusPart).split(/\r?\n\s*\r?\n/).map((g) => parseHeaders(g));
  const recipients = groups.slice(1).filter((g) => g.length).map((g) => ({
    recipient: header(g, "final-recipient")?.replace(/^[^;]*;\s*/, ""),
    action: header(g, "action")?.toLowerCase(),
    status: header(g, "status")?.split(/\s/)[0],
    diagnostic: header(g, "diagnostic-code"),
  }));
  const status = recipients.find((r) => r.status)?.status;
  const cls = status?.[0];
  const outcome = cls === "5" ? "undeliverable" : cls === "4" ? "deferred" : cls === "2" ? "delivered" : "unknown";
  const orig = all.find((p) => p.type === "text/rfc822-headers" || p.type === "message/rfc822" || p.type === "message/global-headers");
  let originalMessageId: string | undefined;
  if (orig) {
    const text = orig.bytes.toString("latin1");
    const head = text.split(/\r?\n\r?\n/)[0]!;
    originalMessageId = parseMessageIds(header(parseHeaders(head), "message-id"))[0];
  }
  return { outcome, status, recipients, originalMessageId };
}
