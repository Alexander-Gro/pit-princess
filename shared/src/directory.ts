// The room's notification directory: which phones can be pinged, and how.
//
// Every device (PC and phones) keeps a copy and they sync over the data channels, so whoever is
// online can ping the others even though the server keeps nothing (it sleeps and forgets). Each
// phone owns its entry: the newest timestamp per owner wins, and `sub: null` marks a phone that
// turned notifications off (kept briefly so the "off" spreads instead of being undone).

import { MAX_DIR_ENTRIES, MAX_PUSH_SUBS, isPushEntry, type PushEntry, type PushSub } from './protocol.ts';

/** Keep only the fields a subscription needs, so peers can't smuggle extra data into our storage */
function cleanSub(sub: PushSub | null): PushSub | null {
  return sub && { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

export class PushDirectory {
  private entries = new Map<string, PushEntry>();

  constructor(initial: unknown[] = []) {
    this.merge(initial);
  }

  /** Merge entries from a peer or storage. Returns true if anything changed. */
  merge(list: unknown[]): boolean {
    let changed = false;
    for (const e of list) {
      if (!isPushEntry(e)) continue;
      const cur = this.entries.get(e.owner);
      if (cur && cur.ts >= e.ts) continue;
      this.entries.set(e.owner, { owner: e.owner, sub: cleanSub(e.sub), ts: e.ts });
      changed = true;
    }
    if (changed) this.trim();
    return changed;
  }

  /** Set (or with null clear) one owner's subscription. Returns true if it changed. */
  set(owner: string, sub: PushSub | null): boolean {
    const cur = this.entries.get(owner);
    if (cur && (cur.sub?.endpoint ?? null) === (sub?.endpoint ?? null)) return false;
    // Strictly newer than what we have, even if clocks differ a little
    const ts = Math.max(Date.now(), (cur?.ts ?? 0) + 1);
    this.entries.set(owner, { owner, sub: cleanSub(sub), ts });
    this.trim();
    return true;
  }

  /** Mark these endpoints as gone (the push service said so). Returns true if anything changed. */
  dropEndpoints(endpoints: string[]): boolean {
    let changed = false;
    for (const e of [...this.entries.values()]) {
      if (e.sub && endpoints.includes(e.sub.endpoint)) changed = this.set(e.owner, null) || changed;
    }
    return changed;
  }

  get(owner: string): PushEntry | undefined {
    return this.entries.get(owner);
  }

  /**
   * Subscriptions of owners not in `present` (who to ping / tell the PC is online): newest first,
   * one per endpoint, at most what the server accepts in one message.
   */
  absent(present: Iterable<string | undefined>): PushSub[] {
    const here = new Set(present);
    const seen = new Set<string>();
    const out: PushSub[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => b.ts - a.ts)) {
      if (!e.sub || here.has(e.owner) || seen.has(e.sub.endpoint)) continue;
      seen.add(e.sub.endpoint);
      out.push(e.sub);
      if (out.length === MAX_PUSH_SUBS) break;
    }
    return out;
  }

  liveCount(): number {
    return [...this.entries.values()].filter((e) => e.sub).length;
  }

  toJSON(): PushEntry[] {
    return [...this.entries.values()];
  }

  /** Keep the newest entries within the cap; "off" markers go first. */
  private trim(): void {
    if (this.entries.size <= MAX_DIR_ENTRIES) return;
    const sorted = [...this.entries.values()].sort((a, b) => (a.sub ? 1 : 0) - (b.sub ? 1 : 0) || a.ts - b.ts);
    for (const e of sorted.slice(0, this.entries.size - MAX_DIR_ENTRIES)) this.entries.delete(e.owner);
  }
}
