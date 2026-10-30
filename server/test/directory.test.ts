// Unit tests for the client-side notification directory (shared/src/directory.ts).
// Every device keeps a copy and they sync over the data channels as {t:'dir', entries}.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DIR_ENTRIES, MAX_PUSH_SUBS, PushDirectory, type PushEntry, type PushSub } from '@pit/shared';

const sub = (n: number | string): PushSub => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/ep-${n}`,
  keys: { p256dh: `p${n}`, auth: `a${n}` },
});
const owner = (n: number | string) => `owner${String(n).padStart(17, '0')}`;
const entry = (o: number | string, s: PushSub | null, ts: number): PushEntry => ({ owner: owner(o), sub: s, ts });

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('PushDirectory', () => {
  describe('merge', () => {
    it('keeps the newest entry per owner, from either side, and reports whether anything changed', () => {
      const d = new PushDirectory([entry(1, sub('1a'), 100)]);
      expect(d.merge([entry(1, sub('1old'), 50)])).toBe(false);
      expect(d.get(owner(1))?.sub).toEqual(sub('1a'));
      expect(d.merge([entry(1, sub('1new'), 200)])).toBe(true);
      expect(d.get(owner(1))).toEqual(entry(1, sub('1new'), 200));
      // An equal timestamp is not newer
      expect(d.merge([entry(1, sub('1same'), 200)])).toBe(false);
      expect(d.get(owner(1))?.sub).toEqual(sub('1new'));
    });

    it('several owners merge independently, and the order in one message does not matter', () => {
      const d = new PushDirectory();
      expect(d.merge([entry(1, sub(1), 300), entry(2, sub(2), 100), entry(1, sub('x'), 200)])).toBe(true);
      expect(d.get(owner(1))?.sub).toEqual(sub(1));
      expect(d.get(owner(2))?.sub).toEqual(sub(2));
      expect(d.toJSON()).toHaveLength(2);
    });

    it('two copies converge after exchanging entries both ways', () => {
      const a = new PushDirectory([entry(1, sub('1a'), 100), entry(2, sub('2a'), 300)]);
      const b = new PushDirectory([entry(1, sub('1b'), 200), entry(3, sub('3b'), 50)]);
      a.merge(b.toJSON());
      b.merge(a.toJSON());
      const norm = (d: PushDirectory) => [...d.toJSON()].sort((x, y) => x.owner.localeCompare(y.owner));
      expect(norm(a)).toEqual(norm(b));
      expect(a.get(owner(1))?.sub).toEqual(sub('1b'));
      expect(a.get(owner(2))?.sub).toEqual(sub('2a'));
    });

    it('stores copies: changing the input objects afterwards does not change the directory', () => {
      const e = entry(1, sub(1), 100);
      const d = new PushDirectory([e]);
      e.ts = 999;
      expect(d.get(owner(1))?.ts).toBe(100);
    });
  });

  describe('set', () => {
    it('is strictly newer than what we have, even when the stored ts is ahead of our clock', () => {
      const d = new PushDirectory([entry(1, sub(1), T0 + 60_000)]); // peer clock 1 min ahead
      expect(d.set(owner(1), sub(2))).toBe(true);
      expect(d.get(owner(1))).toEqual(entry(1, sub(2), T0 + 60_001));
      // and that newer entry wins over the old one at a peer
      const peer = new PushDirectory([entry(1, sub(1), T0 + 60_000)]);
      expect(peer.merge(d.toJSON())).toBe(true);
      expect(peer.get(owner(1))?.sub).toEqual(sub(2));
    });

    it("uses the clock when it's ahead of the stored ts", () => {
      const d = new PushDirectory([entry(1, sub(1), 100)]);
      d.set(owner(1), sub(2));
      expect(d.get(owner(1))?.ts).toBe(T0);
    });

    it('a new owner gets an entry', () => {
      const d = new PushDirectory();
      expect(d.set(owner(1), sub(1))).toBe(true);
      expect(d.toJSON()).toEqual([entry(1, sub(1), T0)]);
    });

    it('the same endpoint again is no change (no new ts, nothing to broadcast)', () => {
      const d = new PushDirectory();
      d.set(owner(1), sub(1));
      vi.advanceTimersByTime(1000);
      expect(d.set(owner(1), sub(1))).toBe(false);
      expect(d.get(owner(1))?.ts).toBe(T0);
    });

    it('two quick sets within the same millisecond still get increasing timestamps', () => {
      const d = new PushDirectory();
      d.set(owner(1), sub(1));
      d.set(owner(1), sub(2));
      d.set(owner(1), null);
      expect(d.get(owner(1))?.ts).toBe(T0 + 2);
    });
  });

  describe('tombstones (sub: null)', () => {
    it('set(owner, null) leaves an "off" marker that beats the older live entry at a peer', () => {
      const peer = new PushDirectory([entry(1, sub(1), 100)]);
      const mine = new PushDirectory(peer.toJSON());
      expect(mine.set(owner(1), null)).toBe(true);
      expect(mine.get(owner(1))).toEqual(entry(1, null, T0));
      expect(mine.liveCount()).toBe(0);
      expect(peer.merge(mine.toJSON())).toBe(true);
      expect(peer.get(owner(1))?.sub).toBeNull();
      // The old live entry coming back from a third copy does not undo it
      expect(peer.merge([entry(1, sub(1), 100)])).toBe(false);
      expect(peer.absent([])).toEqual([]);
    });

    it('turning off twice is no change', () => {
      const d = new PushDirectory([entry(1, sub(1), 100)]);
      expect(d.set(owner(1), null)).toBe(true);
      expect(d.set(owner(1), null)).toBe(false);
    });

    it('a newer live entry (re-subscribed) beats the tombstone', () => {
      const d = new PushDirectory([entry(1, null, 200)]);
      expect(d.merge([entry(1, sub(9), 300)])).toBe(true);
      expect(d.absent([])).toEqual([sub(9)]);
    });

    it('tombstones are kept in toJSON (so they spread) but are not counted or pinged', () => {
      const d = new PushDirectory([entry(1, null, 200), entry(2, sub(2), 100)]);
      expect(d.toJSON()).toHaveLength(2);
      expect(d.liveCount()).toBe(1);
      expect(d.absent([])).toEqual([sub(2)]);
    });
  });

  describe('dropEndpoints', () => {
    it('turns the owners of gone endpoints into tombstones (newer than before), others untouched', () => {
      const d = new PushDirectory([entry(1, sub(1), 100), entry(2, sub(2), 100), entry(3, sub(3), 100)]);
      expect(d.dropEndpoints([sub(1).endpoint, sub(3).endpoint])).toBe(true);
      expect(d.get(owner(1))).toEqual(entry(1, null, T0));
      expect(d.get(owner(3))).toEqual(entry(3, null, T0));
      expect(d.get(owner(2))).toEqual(entry(2, sub(2), 100));
      // The tombstones spread: a peer still holding the live entries accepts them
      const peer = new PushDirectory([entry(1, sub(1), 100)]);
      expect(peer.merge(d.toJSON())).toBe(true);
      expect(peer.get(owner(1))?.sub).toBeNull();
    });

    it('unknown endpoints, or none, are no change', () => {
      const d = new PushDirectory([entry(1, sub(1), 100), entry(2, null, 100)]);
      expect(d.dropEndpoints([])).toBe(false);
      expect(d.dropEndpoints(['https://fcm.googleapis.com/fcm/send/nope'])).toBe(false);
      expect(d.toJSON()).toEqual([entry(1, sub(1), 100), entry(2, null, 100)]);
    });
  });

  describe('absent', () => {
    it('returns the live subs of owners that are not present', () => {
      const d = new PushDirectory([entry(1, sub(1), 1), entry(2, sub(2), 1), entry(3, null, 1)]);
      expect(d.absent([owner(1)])).toEqual([sub(2)]);
      expect(d.absent([owner(1), owner(2)])).toEqual([]);
      expect(d.absent([])).toEqual([sub(1), sub(2)]);
    });

    it('newest first', () => {
      const d = new PushDirectory([entry(1, sub(1), 100), entry(2, sub(2), 300), entry(3, sub(3), 200)]);
      expect(d.absent([])).toEqual([sub(2), sub(3), sub(1)]);
    });

    it(`at most MAX_PUSH_SUBS (${MAX_PUSH_SUBS}) subs, the newest ones (what the server accepts)`, () => {
      const d = new PushDirectory(Array.from({ length: 9 }, (_, i) => entry(i, sub(i), 100 + i)));
      expect(d.liveCount()).toBe(9);
      expect(d.absent([])).toEqual([sub(8), sub(7), sub(6), sub(5), sub(4)]);
      // Present owners don't use up a slot
      expect(d.absent([owner(8), owner(7)])).toEqual([sub(6), sub(5), sub(4), sub(3), sub(2)]);
      // Tombstones don't either
      d.set(owner(6), null);
      expect(d.absent([owner(8), owner(7)])).toEqual([sub(5), sub(4), sub(3), sub(2), sub(1)]);
    });

    it('deduplicates by endpoint (two owners with the same subscription: one push, the newest entry)', () => {
      const shared = sub('same');
      const d = new PushDirectory([entry(1, shared, 100), entry(2, { ...shared, keys: { p256dh: 'newer', auth: 'n' } }, 200), entry(3, sub(3), 50)]);
      expect(d.absent([])).toEqual([{ ...shared, keys: { p256dh: 'newer', auth: 'n' } }, sub(3)]);
      // The newer owner being present leaves the older one's copy
      expect(d.absent([owner(2)])).toEqual([shared, sub(3)]);
    });

    it('takes roster pushIds as they are: undefined (PC, phones without one) is ignored', () => {
      const d = new PushDirectory([entry(1, sub(1), 1), entry(2, sub(2), 1)]);
      expect(d.absent([undefined, owner(2), undefined])).toEqual([sub(1)]);
      // Any iterable works
      expect(d.absent(new Set([owner(1)]))).toEqual([sub(2)]);
    });
  });

  describe('size cap', () => {
    it(`MAX_DIR_ENTRIES is 12`, () => expect(MAX_DIR_ENTRIES).toBe(12));

    it('over the cap, tombstones go first (oldest first), then the oldest live entries', () => {
      const d = new PushDirectory();
      // 10 live (ts 101..110) + 2 tombstones (ts 500, 501) = 12
      const initial = [
        ...Array.from({ length: 10 }, (_, i) => entry(i, sub(i), 101 + i)),
        entry('t1', null, 500),
        entry('t2', null, 501),
      ];
      d.merge(initial);
      expect(d.toJSON()).toHaveLength(12);
      // One more live entry: the oldest tombstone (t1) goes, even though it is newer than every live one
      d.merge([entry('n1', sub('n1'), 50)]);
      expect(d.toJSON()).toHaveLength(12);
      expect(d.get(owner('t1'))).toBeUndefined();
      expect(d.get(owner('t2'))).toBeDefined();
      // Two more: t2 goes, then the oldest live entry (n1 at ts 50)
      d.merge([entry('n2', sub('n2'), 600), entry('n3', sub('n3'), 601)]);
      expect(d.toJSON()).toHaveLength(12);
      expect(d.get(owner('t2'))).toBeUndefined();
      expect(d.get(owner('n1'))).toBeUndefined();
      expect(d.liveCount()).toBe(12);
      expect(d.get(owner('n3'))).toBeDefined();
    });

    it('set() over the cap also trims', () => {
      const d = new PushDirectory(Array.from({ length: 12 }, (_, i) => entry(i, sub(i), 100 + i)));
      d.set(owner('new'), sub('new'));
      expect(d.toJSON()).toHaveLength(12);
      expect(d.get(owner(0))).toBeUndefined();
      expect(d.get(owner('new'))?.sub).toEqual(sub('new'));
    });

    it('a big incoming list (or a big stored one) is cut down to the cap', () => {
      const d = new PushDirectory(Array.from({ length: 30 }, (_, i) => entry(i, sub(i), 1000 + i)));
      expect(d.toJSON()).toHaveLength(12);
      // The 12 newest are kept
      expect(Math.min(...d.toJSON().map((e) => e.ts))).toBe(1018);
    });
  });

  describe('invalid entries are ignored', () => {
    const good = entry(1, sub(1), 100);
    const bad: [string, unknown][] = [
      ['null', null],
      ['a string', 'x'],
      ['a number', 5],
      ['owner too short', { ...good, owner: 'abc' }],
      ['owner "pc"', { ...good, owner: 'pc' }],
      ['owner with spaces', { ...good, owner: 'owner with spaces!!' }],
      ['owner missing', { sub: good.sub, ts: 100 }],
      ['sub not a push service', { ...good, sub: { ...sub(1), endpoint: 'https://evil.example/x' } }],
      ['sub http', { ...good, sub: { ...sub(1), endpoint: 'http://fcm.googleapis.com/fcm/send/x' } }],
      ['sub without keys', { ...good, sub: { endpoint: sub(1).endpoint } }],
      ['sub undefined', { owner: good.owner, ts: 100 }],
      ['ts 0', { ...good, ts: 0 }],
      ['ts negative', { ...good, ts: -1 }],
      ['ts NaN', { ...good, ts: NaN }],
      ['ts Infinity', { ...good, ts: Infinity }],
      ['ts a string', { ...good, ts: '100' }],
    ];
    for (const [name, e] of bad) {
      it(name, () => {
        const d = new PushDirectory([e as unknown]);
        expect(d.toJSON()).toEqual([]);
        expect(d.merge([e as unknown])).toBe(false);
        // A good entry next to it still gets in
        expect(d.merge([e as unknown, good])).toBe(true);
        expect(d.toJSON()).toEqual([good]);
      });
    }

    it('extra fields on the entry are not kept', () => {
      const d = new PushDirectory([{ ...good, junk: 'x'.repeat(100) }]);
      expect(d.toJSON()).toEqual([good]);
    });

    // Regression: peers must not be able to store arbitrary extra data inside `sub`
    it('extra fields inside sub (and sub.keys) are stripped', () => {
      const d = new PushDirectory([{ ...good, sub: { ...sub(1), blob: 'x'.repeat(10_000), keys: { ...sub(1).keys, more: 1 } } }]);
      expect(d.toJSON()).toEqual([good]);
    });
  });
});
