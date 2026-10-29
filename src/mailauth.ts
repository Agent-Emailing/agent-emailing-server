// What email authentication adds (Agent Emailing §6.3): the carrier's SPF,
// DKIM and DMARC results, read from the carrier's API or from the
// Authentication-Results header (RFC 8601) the receiving mail server added.
// They are used for bridged mode (§4.2) and for deciding whether a From
// address is safe to reply to (§5.3), and for nothing else.
import { headersAll, type Headers } from "./mime/mime.js";

export interface AuthResults {
  spf: string;
  dkim: { domain: string; result: string; aligned: boolean }[];
  dmarc: string;
}

/** Relaxed alignment (RFC 7489 §3.1): the two domains share an organizational
 *  domain. Without the public suffix list this compares the last two labels,
 *  or the last three when the second-to-last label is two letters or a common
 *  second-level label (example.co.uk). */
export function orgDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const sld = labels[labels.length - 2]!;
  const take = /^(co|com|net|org|gov|edu|ac|ltd|plc)$/.test(sld) && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  return labels.slice(-take).join(".");
}
export const aligned = (a: string, b: string): boolean => orgDomain(a) === orgDomain(b);

/** An aligned DMARC pass with an aligned, passing DKIM signature: the
 *  credential of bridged mode (§4.2) and the test of §5.3 item 2. */
export function hasAlignedDmarcPass(auth: AuthResults | undefined, fromAddress: string | undefined): boolean {
  if (!auth || !fromAddress) return false;
  const domain = fromAddress.split("@").pop()!.toLowerCase();
  return auth.dmarc === "pass" && auth.dkim.some((d) => d.result === "pass" && (d.aligned || aligned(d.domain, domain)));
}

/** Read Authentication-Results headers. Only a header whose authserv-id is
 *  one the operator trusts counts: anyone can write an
 *  Authentication-Results header into the mail they send. The topmost trusted
 *  header wins. */
export function parseAuthResults(headers: Headers, trustedAuthservIds: string[], fromAddress?: string): AuthResults | undefined {
  const trusted = trustedAuthservIds.map((s) => s.toLowerCase());
  const fromDomain = fromAddress?.split("@").pop()?.toLowerCase();
  for (const value of headersAll(headers, "authentication-results")) {
    const v = value.replace(/\([^)]*\)/g, " ");
    const servId = v.split(";")[0]!.trim().split(/\s+/)[0]!.toLowerCase();
    if (!trusted.includes(servId)) continue;
    const out: AuthResults = { spf: "none", dkim: [], dmarc: "none" };
    for (const clause of v.split(";").slice(1)) {
      const m = clause.trim().match(/^(spf|dkim|dmarc)\s*=\s*([a-z]+)(.*)$/i);
      if (!m) continue;
      const method = m[1]!.toLowerCase();
      const result = m[2]!.toLowerCase();
      if (method === "spf") out.spf = result;
      else if (method === "dmarc") out.dmarc = result;
      else {
        const d = (m[3]!.match(/header\.(?:d|i)\s*=\s*@?([^\s;]+)/i) ?? [])[1]?.replace(/^.*@/, "").toLowerCase() ?? "";
        out.dkim.push({ domain: d, result, aligned: Boolean(fromDomain && d && aligned(d, fromDomain)) });
      }
    }
    return out;
  }
  return undefined;
}
