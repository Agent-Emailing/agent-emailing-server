// Persistent state, kept in plain files in one directory: the duplicate
// memory (an append-only log), and small collections written whole with an
// atomic rename. Enough for one agent's mailbox; nothing here needs a database.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAILBOX_MAX_AGE_MS, MAX_CLOCK_SKEW_AHEAD_MS } from "./protections.js";

/** The `(from, id)` memory of Agent Messaging §22.2, which Agent Emailing §7.1
 *  requires to persist across restarts for at least the mailbox max_age.
 *
 *  It is bounded twice. Entries older than the window (plus the clock-skew
 *  allowance) are dropped, because freshness already refuses anything that
 *  old. And it never holds more than `maxEntries`; when a flood would push it
 *  past that, the oldest entries go first and `onEvict` is told, because an
 *  entry evicted inside the window is a replay the memory can no longer catch. */
export class DuplicateMemory {
  private seen = new Map<string, number>();
  private file?: string;
  private lines = 0;
  constructor(
    private opts: { dir?: string; windowMs?: number; maxEntries?: number; onEvict?: (count: number) => void } = {},
  ) {
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      this.file = join(opts.dir, "seen.jsonl");
      if (existsSync(this.file)) {
        for (const line of readFileSync(this.file, "utf8").split("\n")) {
          if (!line) continue;
          try { const [k, t] = JSON.parse(line) as [string, number]; this.seen.delete(k); this.seen.set(k, t); this.lines++; } catch { /* a torn last line */ }
        }
      }
      this.prune(Date.now());
    }
  }
  private get windowMs() { return (this.opts.windowMs ?? MAILBOX_MAX_AGE_MS) + MAX_CLOCK_SKEW_AHEAD_MS; }
  private get maxEntries() { return this.opts.maxEntries ?? 200_000; }

  static key(from: string, id: string): string { return `${from}\n${id}`; }

  has(from: string, id: string): boolean { return this.seen.has(DuplicateMemory.key(from, id)); }

  /** Record the pair and say whether it was already there. Remember first,
   *  then judge (Agent Messaging §22.2). */
  remember(from: string, id: string, now = Date.now()): boolean {
    const k = DuplicateMemory.key(from, id);
    if (this.seen.has(k)) return true;
    this.seen.set(k, now);
    if (this.file) { appendFileSync(this.file, JSON.stringify([k, now]) + "\n"); this.lines++; }
    if (this.seen.size > this.maxEntries) {
      let n = 0;
      for (const key of this.seen.keys()) { if (this.seen.size <= this.maxEntries) break; this.seen.delete(key); n++; }
      this.opts.onEvict?.(n);
    }
    if (this.file && this.lines > Math.max(1000, this.seen.size * 2)) this.prune(now);
    return false;
  }

  /** Drop entries older than the window and rewrite the log. */
  prune(now = Date.now()): void {
    for (const [k, t] of this.seen) { if (now - t > this.windowMs) this.seen.delete(k); else break; }
    if (this.file) {
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, [...this.seen].map((e) => JSON.stringify(e)).join("\n") + (this.seen.size ? "\n" : ""));
      renameSync(tmp, this.file);
      this.lines = this.seen.size;
    }
  }

  get size(): number { return this.seen.size; }
  clear(): void { this.seen.clear(); if (this.file) this.prune(); }
}

/** A small keyed collection, written whole on every change. */
export class Collection<T> {
  private items = new Map<string, T>();
  private file?: string;
  constructor(dir: string | undefined, name: string, private limit = 50_000) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.file = join(dir, `${name}.json`);
      if (existsSync(this.file)) {
        try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, T>)) this.items.set(k, v); } catch { /* start empty */ }
      }
    }
  }
  get(key: string): T | undefined { return this.items.get(key); }
  has(key: string): boolean { return this.items.has(key); }
  values(): T[] { return [...this.items.values()]; }
  entries(): [string, T][] { return [...this.items.entries()]; }
  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
    this.save();
  }
  delete(key: string): void { if (this.items.delete(key)) this.save(); }
  private save(): void {
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.items), null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
