// Agent keys in the NKey encoding Agent Messaging uses (Agent Messaging §4.3):
// an agent ID is "U..." (base32 of a prefix byte, the 32-byte Ed25519 public
// key and a CRC-16), and a seed is "SU...". Written against node:crypto only.
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** CRC-16/XMODEM, which NKeys append little-endian. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const PREFIX_USER = 20 << 3; // "U"
const PREFIX_SEED = 18 << 3; // "S"

function withCrc(bytes: Buffer): Buffer {
  const c = crc16(bytes);
  return Buffer.concat([bytes, Buffer.from([c & 0xff, c >> 8])]);
}

function checkCrc(b: Buffer): Buffer {
  const body = b.subarray(0, b.length - 2);
  const c = crc16(body);
  if (b[b.length - 2] !== (c & 0xff) || b[b.length - 1] !== c >> 8) throw new Error("NKey checksum does not match");
  return body;
}

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

export interface AgentKey {
  /** The agent ID, "U...". */
  id: string;
  /** The seed, "SU...". Keep it secret. */
  seed: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The raw 32-byte public key. */
  raw: Buffer;
}

/** Encode a raw 32-byte Ed25519 seed as an NKey user seed. */
export function encodeSeed(raw32: Uint8Array): string {
  if (raw32.length !== 32) throw new Error("a seed is 32 bytes");
  const head = Buffer.from([PREFIX_SEED | (PREFIX_USER >> 5), (PREFIX_USER & 31) << 3]);
  return b32encode(withCrc(Buffer.concat([head, Buffer.from(raw32)])));
}

/** The raw 32-byte Ed25519 seed inside an NKey user seed. */
export function decodeSeed(seed: string): Buffer {
  const body = checkCrc(b32decode(seed));
  if (body.length !== 34 || body[0] !== (PREFIX_SEED | (PREFIX_USER >> 5)) || body[1] !== ((PREFIX_USER & 31) << 3)) {
    throw new Error("not an NKey user seed");
  }
  return body.subarray(2, 34);
}

/** The key pair a seed holds. */
export function agentKeyFromSeed(seed: string): AgentKey {
  const raw = decodeSeed(seed);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  return { id: agentIdFromRaw(pub), seed, privateKey, publicKey, raw: pub };
}

/** A new random agent key. */
export function createAgentKey(): AgentKey {
  return agentKeyFromSeed(encodeSeed(randomBytes(32)));
}

/** The agent ID for a raw 32-byte public key. */
export function agentIdFromRaw(pub: Uint8Array): string {
  return b32encode(withCrc(Buffer.concat([Buffer.from([PREFIX_USER]), Buffer.from(pub)])));
}

/** The public key an agent ID names. Throws when the ID is not a valid user key. */
export function publicKeyFromId(id: string): KeyObject {
  const body = checkCrc(b32decode(id));
  if (body.length !== 33 || body[0] !== PREFIX_USER) throw new Error("not an NKey user public key");
  return createPublicKey({ key: Buffer.concat([SPKI, body.subarray(1, 33)]), format: "der", type: "spki" });
}

/** True when the string is a well-formed agent ID. */
export function isAgentId(id: unknown): id is string {
  if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) return false;
  try { publicKeyFromId(id); return true; } catch { return false; }
}
