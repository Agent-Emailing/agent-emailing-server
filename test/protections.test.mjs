// Agent Messaging's own fixtures for the parts this server shares with every
// receiver: canonical JSON (conformance/canonical-json.json) and the receiver
// protections of §22 (conformance/inbound-protections.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonical, verifyEnvelope, signedBytes, isFresh, isAddressedTo, measure, isOversize, fenceText, frame, fencePayload,
} from "../dist/index.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../conformance/${f}`, import.meta.url), "utf8"));
const IP = load("inbound-protections.json");
const CJ = load("canonical-json.json");

test("canonical JSON matches every Agent Messaging vector", () => {
  for (const v of CJ.vectors) {
    if (v.input_json === undefined) continue;
    assert.equal(canonical(JSON.parse(v.input_json)), v.canonical, v.name);
  }
});

test("the fixture's signed envelopes verify, over the bytes it prints", () => {
  for (const [name, e] of Object.entries(IP.envelopes)) {
    if (!e || typeof e !== "object" || !e.envelope) continue;
    assert.equal(verifyEnvelope(e.envelope), true, name);
    if (e.canonical) assert.equal(signedBytes(e.envelope).toString("utf8"), IP.envelopes.signed_bytes_prefix + e.canonical, name);
  }
});

test("freshness: the mailbox window, to the millisecond", () => {
  const skew = IP.freshness.max_clock_skew_ahead_ms;
  for (const c of IP.freshness.cases) {
    const maxAge = c.source === "live" ? 10 * 60 * 1000 : IP.freshness.max_mailbox_age_ms;
    assert.equal(isFresh(c.ts, new Date(c.now), maxAge, skew), c.verdict === "accept", c.id);
  }
});

test("addressing: byte for byte, absent accepted", () => {
  for (const c of IP.addressing.cases) {
    const env = IP.envelopes[c.envelope].envelope;
    assert.equal(isAddressedTo(env, IP.addressing.self), c.verdict === "accept", c.id);
  }
});

test("size cap: UTF-16 code units, strictly greater than", () => {
  for (const c of IP.size_cap.cases) {
    assert.equal(measure(c.input).chars, c.measured_chars, c.id);
    assert.equal(isOversize(c.input, c.max_inbound_chars), c.verdict === "refuse", c.id);
  }
});

test("fencing: the three steps, in order", () => {
  for (const c of IP.fencing.sender_text_cases) assert.equal(fenceText(c.input), c.expected, c.id);
});

test("fencing: the frame, byte for byte", () => {
  for (const c of IP.fencing.frame_cases) assert.equal(frame(c.text, c.provenance), c.expected, c.id);
});

test("fencing: which field is framed, and what is left alone", () => {
  const prov = IP.fencing.frame_cases[0].provenance;
  for (const c of IP.fencing.payload_shape_cases) {
    const before = JSON.stringify(c.input);
    const got = fencePayload(c.input, prov);
    assert.equal(got.framed, c.framed, c.id);
    assert.deepEqual(got.payload, c.framed ? c.expected : c.input, c.id);
    assert.equal(JSON.stringify(c.input), before, `${c.id}: the input is copied, never changed`);
    // sender_text pins what the §22.5 walk measures: the text, or the compact JSON measured in its place.
    if (typeof c.sender_text === "string") assert.equal(measure(c.input).chars, c.sender_text.length, c.id);
  }
});
