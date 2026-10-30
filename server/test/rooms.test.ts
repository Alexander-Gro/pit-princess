import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPhoneToPcMsg, isPushEndpoint, isPushSub, type ServerMsg } from '@pit/shared';
import { RoomHub, type Conn } from '../src/rooms.ts';

const ROOM = 'room-AAAAAAAAAAAAAAAA';
const ROOM2 = 'room-BBBBBBBBBBBBBBBB';
const ICE: RTCIceServer[] = [{ urls: 'stun:test.invalid:3478' }];

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  closed = 0;
  constructor(readonly name: string) {}
  send(msg: ServerMsg): void {
    this.msgs.push(msg);
  }
  close(): void {
    this.closed++;
  }
  /** Return and clear recorded messages. */
  take(): ServerMsg[] {
    const m = this.msgs;
    this.msgs = [];
    return m;
  }
  last(): ServerMsg | undefined {
    return this.msgs[this.msgs.length - 1];
  }
}

function makeHub(opts: Partial<ConstructorParameters<typeof RoomHub>[0]> = {}) {
  return new RoomHub({ getIceServers: async () => ICE, ...opts });
}

async function setup(hub = makeHub()) {
  const pc = new FakeConn('pc');
  const phone = new FakeConn('phone');
  await hub.handle(pc, { t: 'host', room: ROOM });
  await hub.handle(phone, { t: 'join', room: ROOM });
  pc.take();
  phone.take();
  return { hub, pc, phone };
}

describe('host / join', () => {
  it('host gets a welcome with no peer, idle floor and the ICE servers', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    expect(pc.take()).toEqual([{ t: 'welcome', role: 'pc', iceServers: ICE, peerPresent: false, floor: 'idle' }]);
    expect(hub.rooms.has(ROOM)).toBe(true);
  });

  it('phone joining gets peerPresent=true, and the PC gets peer_joined', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    await hub.handle(pc, { t: 'host', room: ROOM });
    pc.take();
    await hub.handle(phone, { t: 'join', room: ROOM });
    expect(phone.take()).toEqual([{ t: 'welcome', role: 'phone', iceServers: ICE, peerPresent: true, floor: 'idle' }]);
    expect(pc.take()).toEqual([{ t: 'peer_joined' }]);
  });

  it('join on a room with no host -> no_host, and no room is created', async () => {
    const hub = makeHub();
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM });
    expect(phone.take()).toEqual([{ t: 'error', code: 'no_host' }]);
    expect(hub.rooms.size).toBe(0);
    // Not a member: room messages are refused
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
  });

  it('join is refused with no_host even when maxRooms is reached (no room table growth)', async () => {
    const hub = makeHub({ maxRooms: 1 });
    await hub.handle(new FakeConn('pc'), { t: 'host', room: ROOM });
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM2 });
    expect(phone.take()).toEqual([{ t: 'error', code: 'no_host' }]);
    expect(hub.rooms.size).toBe(1);
  });

  it('phone stays in the room after the PC leaves; a returning PC sees it and it gets peer_joined', async () => {
    const { hub, pc, phone } = await setup();
    hub.disconnect(pc);
    expect(phone.take()).toEqual([{ t: 'peer_left' }]);
    expect(hub.rooms.get(ROOM)?.phone).toBe(phone);
    const pc2 = new FakeConn('pc2');
    await hub.handle(pc2, { t: 'host', room: ROOM });
    expect(pc2.take()).toMatchObject([{ t: 'welcome', role: 'pc', peerPresent: true, floor: 'idle' }]);
    expect(phone.take()).toEqual([{ t: 'peer_joined' }]);
  });

  it('welcome reports the current floor holder', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'floor_request' });
    hub.disconnect(phone); // the PC still holds the floor
    const phone2 = new FakeConn('phone2');
    await hub.handle(phone2, { t: 'join', room: ROOM });
    expect(phone2.take()).toMatchObject([{ t: 'welcome', floor: 'pc', peerPresent: true }]);
  });

  it('peer_left goes to the remaining side and the room is deleted when empty', async () => {
    const { hub, pc, phone } = await setup();
    hub.disconnect(phone);
    expect(pc.take()).toEqual([{ t: 'peer_left' }]);
    expect(hub.rooms.has(ROOM)).toBe(true);
    hub.disconnect(pc);
    expect(hub.rooms.has(ROOM)).toBe(false);
    expect(phone.msgs).toEqual([]);
  });

  it('getIceServers rejecting falls back to an empty list', async () => {
    const hub = makeHub({ getIceServers: async () => Promise.reject(new Error('nope')) });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    expect(pc.take()).toMatchObject([{ t: 'welcome', iceServers: [] }]);
  });

  it('re-sending the same host is idempotent (welcome again, no peer notices)', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'host', room: ROOM });
    expect(pc.take()).toMatchObject([{ t: 'welcome', role: 'pc', peerPresent: true }]);
    expect(phone.take()).toEqual([]);
  });
});

describe('invalid input', () => {
  it.each([
    ['too short', 'abc'],
    ['15 chars', 'a'.repeat(15)],
    ['65 chars', 'a'.repeat(65)],
    ['bad chars', 'aaaaaaaaaaaaaaaa!'],
    ['spaces', 'aaaaaaaa aaaaaaaa'],
    ['empty', ''],
  ])('rejects room code (%s)', async (_label, code) => {
    const hub = makeHub();
    const c = new FakeConn('c');
    await hub.handle(c, { t: 'host', room: code });
    await hub.handle(c, { t: 'join', room: code });
    expect(c.take()).toEqual([
      { t: 'error', code: 'bad_room' },
      { t: 'error', code: 'bad_room' },
    ]);
    expect(hub.rooms.size).toBe(0);
  });

  it('accepts 16 and 64 char codes', async () => {
    const hub = makeHub();
    for (const code of ['a'.repeat(16), 'Z_-9'.repeat(16)]) {
      const c = new FakeConn('c');
      await hub.handle(c, { t: 'host', room: code });
      expect(c.take()).toMatchObject([{ t: 'welcome' }]);
    }
  });

  it.each([
    null,
    42,
    'host',
    {},
    { t: 'nope' },
    { t: 'host' },
    { t: 'host', room: 5 },
    { t: 'signal' },
    { t: 'signal', data: { kind: 'offer' } },
    { t: 'signal', data: { kind: 'ice', candidate: 'x' } },
  ])('bad message %j -> bad_message', async (raw) => {
    const hub = makeHub();
    const c = new FakeConn('c');
    await hub.handle(c, raw);
    expect(c.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
  });

  it('room messages before host/join -> not_in_room', async () => {
    const hub = makeHub();
    const c = new FakeConn('c');
    for (const m of [{ t: 'floor_request' }, { t: 'floor_release' }, { t: 'kick' }, { t: 'signal', data: { kind: 'offer', sdp: 'x' } }]) {
      await hub.handle(c, m);
    }
    expect(c.take()).toEqual(Array(4).fill({ t: 'error', code: 'not_in_room' }));
  });

  it('maxRooms is enforced', async () => {
    const hub = makeHub({ maxRooms: 1 });
    const a = new FakeConn('a');
    const b = new FakeConn('b');
    await hub.handle(a, { t: 'host', room: ROOM });
    await hub.handle(b, { t: 'host', room: ROOM2 });
    expect(b.take()).toEqual([{ t: 'error', code: 'bad_room' }]);
    expect(hub.rooms.size).toBe(1);
  });
});

describe('replacement', () => {
  it('a second phone replaces the first', async () => {
    const { hub, pc, phone } = await setup();
    const phone2 = new FakeConn('phone2');
    await hub.handle(phone2, { t: 'join', room: ROOM });
    expect(phone.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(phone.closed).toBe(1);
    expect(phone2.take()).toMatchObject([{ t: 'welcome', role: 'phone', peerPresent: true }]);
    // No peer_left, since the slot is refilled immediately
    expect(pc.take()).toEqual([{ t: 'peer_joined' }]);
    // The old phone is no longer a member
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    // Its later socket close is harmless
    hub.disconnect(phone);
    expect(pc.take()).toEqual([]);
    expect(hub.rooms.has(ROOM)).toBe(true);
  });

  it('a second PC replaces the first', async () => {
    const { hub, pc, phone } = await setup();
    const pc2 = new FakeConn('pc2');
    await hub.handle(pc2, { t: 'host', room: ROOM });
    expect(pc.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(pc.closed).toBe(1);
    expect(pc2.take()).toMatchObject([{ t: 'welcome', role: 'pc', peerPresent: true }]);
    expect(phone.take()).toEqual([{ t: 'peer_joined' }]);
    hub.disconnect(pc);
    expect(phone.take()).toEqual([]);
  });

  it('replacing the floor holder releases the floor', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    pc.take();
    phone.take();
    const phone2 = new FakeConn('phone2');
    await hub.handle(phone2, { t: 'join', room: ROOM });
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }, { t: 'peer_joined' }]);
    expect(phone2.take()).toMatchObject([{ t: 'welcome', floor: 'idle' }]);
    expect(phone.msgs[0]).toEqual({ t: 'kicked', reason: 'replaced' });
  });

  it('a kicked floor holder gets nothing after its kicked farewell', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    pc.take();
    phone.take();
    const phone2 = new FakeConn('phone2');
    await hub.handle(phone2, { t: 'join', room: ROOM });
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }, { t: 'peer_joined' }]);
    expect(phone2.take()).toMatchObject([{ t: 'welcome', floor: 'idle' }]);
    // The kicked phone should not get anything after its 'kicked' farewell
    expect(phone.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
  });
});

describe('kick', () => {
  it('PC kicks the phone', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'kick' });
    expect(phone.take()).toEqual([{ t: 'kicked', reason: 'kicked' }]);
    expect(phone.closed).toBe(1);
    expect(pc.take()).toEqual([{ t: 'peer_left' }]);
    expect(hub.rooms.has(ROOM)).toBe(true);
  });

  it('phone cannot kick the PC; kick with no phone is a no-op', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'kick' });
    expect(pc.take()).toEqual([]);
    expect(pc.closed).toBe(0);
    hub.disconnect(phone);
    pc.take();
    await hub.handle(pc, { t: 'kick' });
    expect(pc.take()).toEqual([]);
  });

  it('kicking a phone that holds the floor releases it', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    pc.take();
    await hub.handle(pc, { t: 'kick' });
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }, { t: 'peer_left' }]);
  });
});

describe('re-hosting a new code', () => {
  it('moves the PC to the new room and kicks the phone from the old one', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'host', room: ROOM2 });
    const phoneMsgs = phone.take();
    expect(phoneMsgs).toContainEqual({ t: 'kicked', reason: 'room_closed' });
    expect(phone.closed).toBe(1);
    expect(pc.take()).toEqual([{ t: 'welcome', role: 'pc', iceServers: ICE, peerPresent: false, floor: 'idle' }]);
    expect(hub.rooms.has(ROOM)).toBe(false);
    expect(hub.rooms.has(ROOM2)).toBe(true);
    // Phone is gone
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
  });

  it('releases the floor and clears the old room timer', async () => {
    vi.useFakeTimers();
    try {
      const { hub, pc, phone } = await setup(makeHub({ maxTxMs: 1000 }));
      await hub.handle(pc, { t: 'floor_request' });
      pc.take();
      await hub.handle(pc, { t: 'host', room: ROOM2 });
      pc.take();
      phone.take();
      vi.advanceTimersByTime(5000);
      expect(pc.msgs).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-host sent while the previous host is still waiting for ICE wins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = makeHub({ getIceServers: async () => (await gate, ICE) });
    const pc = new FakeConn('pc');
    const p1 = hub.handle(pc, { t: 'host', room: ROOM });
    const p2 = hub.handle(pc, { t: 'host', room: ROOM2 });
    release();
    await Promise.all([p1, p2]);
    expect(hub.rooms.has(ROOM2)).toBe(true);
    expect(pc.last()).toMatchObject({ t: 'welcome', role: 'pc' });
  });
});

describe('floor', () => {
  it('grant goes to both sides; request from the other side is busy', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'floor', holder: 'phone' }]);
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'phone' }]);
    await hub.handle(pc, { t: 'floor_request' });
    expect(pc.take()).toEqual([{ t: 'busy' }]);
    expect(phone.take()).toEqual([]);
  });

  it('holder re-requesting just gets the floor echoed back', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'floor_request' });
    pc.take();
    phone.take();
    await hub.handle(pc, { t: 'floor_request' });
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'pc' }]);
    expect(phone.take()).toEqual([]);
  });

  it('release by the holder goes idle; release by the non-holder is ignored', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'floor_request' });
    pc.take();
    phone.take();
    await hub.handle(phone, { t: 'floor_release' });
    expect(pc.take()).toEqual([]);
    expect(phone.take()).toEqual([]);
    await hub.handle(pc, { t: 'floor_release' });
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
    expect(phone.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
    // Releasing an idle floor does nothing
    await hub.handle(pc, { t: 'floor_release' });
    expect(pc.take()).toEqual([]);
  });

  it('request while the other side is absent -> busy', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    pc.take();
    await hub.handle(pc, { t: 'floor_request' });
    expect(pc.take()).toEqual([{ t: 'busy' }]);
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM });
    hub.disconnect(pc);
    phone.take();
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'busy' }]);
  });

  it('floor auto-released when the holder disconnects', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    pc.take();
    hub.disconnect(phone);
    expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }, { t: 'peer_left' }]);
    const phone2 = new FakeConn('phone2');
    await hub.handle(phone2, { t: 'join', room: ROOM });
    expect(phone2.take()).toMatchObject([{ t: 'welcome', floor: 'idle' }]);
  });

  it('non-holder disconnecting leaves the floor with the holder', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'floor_request' });
    pc.take();
    hub.disconnect(phone);
    expect(pc.take()).toEqual([{ t: 'peer_left' }]);
  });

  describe('max TX timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('releases the floor after maxTxMs', async () => {
      const { hub, pc, phone } = await setup(makeHub({ maxTxMs: 1000 }));
      await hub.handle(pc, { t: 'floor_request' });
      pc.take();
      phone.take();
      vi.advanceTimersByTime(999);
      expect(pc.msgs).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
      expect(phone.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
      // Floor is free again
      await hub.handle(phone, { t: 'floor_request' });
      expect(pc.take()).toEqual([{ t: 'floor', holder: 'phone' }]);
    });

    it('defaults to MAX_TX_MS (60 s)', async () => {
      const { hub, pc } = await setup();
      await hub.handle(pc, { t: 'floor_request' });
      pc.take();
      vi.advanceTimersByTime(59_999);
      expect(pc.msgs).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
    });

    it('a release cancels the timer; a fresh grant gets a fresh timer', async () => {
      const { hub, pc, phone } = await setup(makeHub({ maxTxMs: 1000 }));
      await hub.handle(pc, { t: 'floor_request' });
      vi.advanceTimersByTime(800);
      await hub.handle(pc, { t: 'floor_release' });
      await hub.handle(phone, { t: 'floor_request' });
      pc.take();
      phone.take();
      vi.advanceTimersByTime(500); // old timer would have fired at 1000
      expect(pc.msgs).toEqual([]);
      vi.advanceTimersByTime(500);
      expect(pc.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
    });

    it('timer cleared when the room is deleted', async () => {
      const { hub, pc, phone } = await setup(makeHub({ maxTxMs: 1000 }));
      await hub.handle(pc, { t: 'floor_request' });
      hub.disconnect(phone);
      hub.disconnect(pc);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('signal relay', () => {
  it('relays offer/answer/ice to the other side only', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
    expect(phone.take()).toEqual([{ t: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } }]);
    expect(pc.take()).toEqual([]);
    await hub.handle(phone, { t: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
    expect(pc.take()).toEqual([{ t: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } }]);
    const cand = { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    await hub.handle(phone, { t: 'signal', data: { kind: 'ice', candidate: cand } });
    await hub.handle(phone, { t: 'signal', data: { kind: 'ice', candidate: null } });
    expect(pc.take()).toEqual([
      { t: 'signal', data: { kind: 'ice', candidate: cand } },
      { t: 'signal', data: { kind: 'ice', candidate: null } },
    ]);
  });

  it('strips unknown fields from relayed signals', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'signal', data: { kind: 'offer', sdp: 'x', evil: 1 }, extra: true });
    expect(phone.take()).toEqual([{ t: 'signal', data: { kind: 'offer', sdp: 'x' } }]);
  });

  it('signal with no peer is dropped silently', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    pc.take();
    await hub.handle(pc, { t: 'signal', data: { kind: 'offer', sdp: 'x' } });
    expect(pc.take()).toEqual([]);
  });

  it('signals do not cross rooms', async () => {
    const { hub, pc } = await setup();
    const pcB = new FakeConn('pcB');
    const phoneB = new FakeConn('phoneB');
    await hub.handle(pcB, { t: 'host', room: ROOM2 });
    await hub.handle(phoneB, { t: 'join', room: ROOM2 });
    phoneB.take();
    await hub.handle(pc, { t: 'signal', data: { kind: 'offer', sdp: 'x' } });
    expect(phoneB.take()).toEqual([]);
  });
});

describe('disconnect during async getIceServers', () => {
  function gatedHub() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = makeHub({ getIceServers: async () => (await gate, ICE) });
    return { hub, release: () => release() };
  }

  it('a conn that disconnects while waiting never enters the room', async () => {
    const { hub, release } = gatedHub();
    const pc = new FakeConn('pc');
    const p = hub.handle(pc, { t: 'host', room: ROOM });
    hub.disconnect(pc);
    release();
    await p;
    expect(pc.msgs).toEqual([]);
    expect(hub.rooms.size).toBe(0);
  });

  it('phone disconnecting while waiting does not notify the PC', async () => {
    let gated = false;
    let release!: () => void;
    const hub = makeHub({
      getIceServers: async () => {
        if (gated) await new Promise<void>((r) => (release = r));
        return ICE;
      },
    });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    pc.take();
    gated = true;
    const phone = new FakeConn('phone');
    const p = hub.handle(phone, { t: 'join', room: ROOM });
    await Promise.resolve();
    hub.disconnect(phone);
    release();
    await p;
    expect(phone.msgs).toEqual([]);
    expect(pc.msgs).toEqual([]);
    expect(hub.rooms.get(ROOM)?.phone).toBeNull();
  });

  it('an already-joined phone disconnecting during a re-join is fully removed', async () => {
    let gated = false;
    let release!: () => void;
    const hub = makeHub({
      getIceServers: async () => {
        if (gated) await new Promise<void>((r) => (release = r));
        return ICE;
      },
    });
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    await hub.handle(pc, { t: 'host', room: ROOM });
    await hub.handle(phone, { t: 'join', room: ROOM });
    pc.take();
    phone.take();
    gated = true;
    const p = hub.handle(phone, { t: 'join', room: ROOM });
    await Promise.resolve();
    hub.disconnect(phone);
    expect(pc.take()).toEqual([{ t: 'peer_left' }]);
    release();
    await p;
    expect(phone.msgs).toEqual([]);
    expect(pc.msgs).toEqual([]);
    expect(hub.rooms.get(ROOM)?.phone).toBeNull();
  });

  it('a second join while the first is pending is ignored (no double welcome)', async () => {
    const { hub, release } = gatedHub();
    const pc = new FakeConn('pc');
    const hosted = hub.handle(pc, { t: 'host', room: ROOM });
    release();
    await hosted;
    const phone = new FakeConn('phone');
    const p1 = hub.handle(phone, { t: 'join', room: ROOM });
    const p2 = hub.handle(phone, { t: 'join', room: ROOM });
    release();
    await Promise.all([p1, p2]);
    expect(phone.msgs.filter((m) => m.t === 'welcome')).toHaveLength(1);
  });
});

describe('refreshIce', () => {
  it('sends fresh ICE servers to every member of every room', async () => {
    let n = 0;
    const hub = makeHub({ getIceServers: async () => [{ urls: `turn:t.invalid?v=${n++}` }] });
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    const pcB = new FakeConn('pcB');
    await hub.handle(pc, { t: 'host', room: ROOM });
    await hub.handle(phone, { t: 'join', room: ROOM });
    await hub.handle(pcB, { t: 'host', room: ROOM2 });
    for (const c of [pc, phone, pcB]) c.take();
    await hub.refreshIce();
    const fresh = { t: 'ice', iceServers: [{ urls: 'turn:t.invalid?v=3' }] };
    expect(pc.take()).toEqual([fresh]);
    expect(phone.take()).toEqual([fresh]);
    expect(pcB.take()).toEqual([fresh]);
  });

  it('skips the ICE fetch when nobody is connected, and does not reach departed or non-members', async () => {
    const getIceServers = vi.fn(async () => ICE);
    const hub = makeHub({ getIceServers });
    await hub.refreshIce();
    expect(getIceServers).not.toHaveBeenCalled();
    const { pc, phone } = await setup(hub);
    const stranger = new FakeConn('stranger');
    await hub.handle(stranger, { t: 'join', room: ROOM2 }); // no_host
    stranger.take();
    hub.disconnect(phone);
    pc.take();
    await hub.refreshIce();
    expect(pc.take()).toEqual([{ t: 'ice', iceServers: ICE }]);
    expect(phone.msgs).toEqual([]);
    expect(stranger.msgs).toEqual([]);
  });

  it('propagates a getIceServers failure to the caller (index.ts catches it)', async () => {
    let fail = false;
    const hub = makeHub({ getIceServers: async () => (fail ? Promise.reject(new Error('turn down')) : ICE) });
    const { pc } = await setup(hub);
    fail = true;
    await expect(hub.refreshIce()).rejects.toThrow('turn down');
    expect(pc.msgs).toEqual([]);
  });
});

describe('access key', () => {
  const KEY = 'secret-key-0123456789';

  it('rejects host and join without the key, and closes the connection', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    expect(pc.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
    expect(pc.closed).toBe(1);
    expect(hub.rooms.size).toBe(0);

    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM, key: 'wrong' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
    expect(phone.closed).toBe(1);
  });

  it('a wrong key of the same length is still rejected', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM, key: KEY.replace(/.$/, 'X') });
    expect(pc.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
  });

  it('accepts the right key on both sides', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    await hub.handle(pc, { t: 'host', room: ROOM, key: KEY });
    await hub.handle(phone, { t: 'join', room: ROOM, key: KEY });
    expect(pc.take().map((m) => m.t)).toEqual(['welcome', 'peer_joined']);
    expect(phone.take().map((m) => m.t)).toEqual(['welcome']);
  });

  it('a server without a key accepts clients that send one anyway', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM, key: 'whatever' });
    expect(pc.take()[0].t).toBe('welcome');
  });

  it('a non-string key is a bad message', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM, key: 42 });
    expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
  });
});

describe('pairing codes', () => {
  const KEY = 'secret-key-0123456789';

  async function pcWithCode(hub: RoomHub) {
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM, key: KEY });
    pc.take();
    await hub.handle(pc, { t: 'pair_create' });
    const msg = pc.take()[0] as Extract<ServerMsg, { t: 'pair_code' }>;
    expect(msg.t).toBe('pair_code');
    expect(msg.code).toMatch(/^\d{6}$/);
    return { pc, code: msg.code };
  }

  it('a valid code hands over the room and access key, once', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { code } = await pcWithCode(hub);
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'pair_claim', code });
    expect(phone.take()).toEqual([{ t: 'paired', room: ROOM, key: KEY }]);
    // Single use
    const other = new FakeConn('other');
    await hub.handle(other, { t: 'pair_claim', code });
    expect(other.take()).toEqual([{ t: 'error', code: 'bad_code' }]);
  });

  it('creating a new code invalidates the old one', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { pc, code } = await pcWithCode(hub);
    await hub.handle(pc, { t: 'pair_create' });
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'pair_claim', code });
    const fresh = (pc.take()[0] as Extract<ServerMsg, { t: 'pair_code' }>).code;
    // (1-in-a-million chance the new random code equals the old one, in which case it's valid)
    const expected = fresh === code ? { t: 'paired', room: ROOM, key: KEY } : { t: 'error', code: 'bad_code' };
    expect(phone.take()).toEqual([expected]);
  });

  it('only the PC can create codes', async () => {
    const hub = makeHub({ accessKey: KEY });
    await pcWithCode(hub);
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM, key: KEY });
    phone.take();
    await hub.handle(phone, { t: 'pair_create' });
    expect(phone.take()).toEqual([]);
  });

  it('codes expire', async () => {
    vi.useFakeTimers();
    try {
      const hub = makeHub({ accessKey: KEY });
      const { code } = await pcWithCode(hub);
      vi.advanceTimersByTime(10 * 60_000 + 1);
      const phone = new FakeConn('phone');
      await hub.handle(phone, { t: 'pair_claim', code });
      expect(phone.take()).toEqual([{ t: 'error', code: 'bad_code' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a code stops working once the PC has gone', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { pc, code } = await pcWithCode(hub);
    hub.disconnect(pc);
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'pair_claim', code });
    expect(phone.take()).toEqual([{ t: 'error', code: 'bad_code' }]);
  });

  it('limits guesses per connection and server-wide', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { code } = await pcWithCode(hub);
    const wrong = code === '000000' ? '000001' : '000000';
    const guesser = new FakeConn('guesser');
    for (let i = 0; i < 5; i++) await hub.handle(guesser, { t: 'pair_claim', code: wrong });
    await hub.handle(guesser, { t: 'pair_claim', code });
    expect(guesser.last()).toEqual({ t: 'error', code: 'rate_limited' });
    expect(guesser.closed).toBe(1);

    // 25 more failures from fresh connections reach the server-wide cap of 30
    for (let i = 0; i < 25; i++) await hub.handle(new FakeConn(`g${i}`), { t: 'pair_claim', code: wrong });
    const late = new FakeConn('late');
    await hub.handle(late, { t: 'pair_claim', code });
    expect(late.take()).toEqual([{ t: 'error', code: 'rate_limited' }]);
  });
});

// ---------- "PC is online" push announce ----------

const SUB_A = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: { p256dh: 'BPa', auth: 'aa' } };
const SUB_B = { endpoint: 'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM', keys: { p256dh: 'BPb', auth: 'bb' } };
const FCM = 'https://fcm.googleapis.com/fcm/send/';

class FakePusher {
  calls: { subs: unknown[]; payload: object }[] = [];
  result: { sent: number; gone: string[] } = { sent: 0, gone: [] };
  error: Error | null = null;
  async send(subs: unknown[], payload: object) {
    this.calls.push({ subs, payload });
    if (this.error) throw this.error;
    return this.result;
  }
}

async function pcAlone(hub: RoomHub, room = ROOM) {
  const pc = new FakeConn('pc');
  await hub.handle(pc, { t: 'host', room });
  pc.take();
  return pc;
}

describe('announce (push "PC is online")', () => {
  it('sends to the pusher when no phone is in the room and replies with the result', async () => {
    const push = new FakePusher();
    push.result = { sent: 2, gone: [] };
    const hub = makeHub({ push });
    const pc = await pcAlone(hub);
    await hub.handle(pc, { t: 'announce', subs: [SUB_A, SUB_B] });
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].subs).toEqual([SUB_A, SUB_B]);
    expect(push.calls[0].payload).toMatchObject({ title: 'Pit Princess', tag: 'pc-online' });
    expect(pc.take()).toEqual([{ t: 'announced', sent: 2, gone: [] }]);
  });

  it('skips when a phone is already in the room', async () => {
    const push = new FakePusher();
    const { hub, pc } = await setup(makeHub({ push }));
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    expect(push.calls).toHaveLength(0);
    expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
  });

  it('a skipped announce (phone present) does not start the cooldown', async () => {
    const push = new FakePusher();
    const { hub, pc, phone } = await setup(makeHub({ push }));
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    hub.disconnect(phone);
    pc.take();
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    expect(push.calls).toHaveLength(1);
  });

  it('with no pusher configured nothing is sent, but the PC still gets a reply', async () => {
    const hub = makeHub(); // push defaults to null
    const pc = await pcAlone(hub);
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
    const hub2 = makeHub({ push: null });
    const pc2 = await pcAlone(hub2);
    await hub2.handle(pc2, { t: 'announce', subs: [SUB_A] });
    expect(pc2.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
  });

  it('an empty subs list sends nothing and does not use up the cooldown', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const pc = await pcAlone(hub);
    await hub.handle(pc, { t: 'announce', subs: [] });
    expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    expect(push.calls).toHaveLength(1);
  });

  it('honours the cooldown per room (announceCooldownMs), across PC reconnects', async () => {
    vi.useFakeTimers();
    try {
      const push = new FakePusher();
      const hub = makeHub({ push, announceCooldownMs: 1000 });
      const pc = await pcAlone(hub);
      await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
      expect(push.calls).toHaveLength(1);
      pc.take();

      // Within the cooldown: skipped, even from a fresh PC connection to the same room
      vi.advanceTimersByTime(999);
      await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
      expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
      hub.disconnect(pc);
      const pc2 = await pcAlone(hub);
      await hub.handle(pc2, { t: 'announce', subs: [SUB_A] });
      expect(pc2.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
      expect(push.calls).toHaveLength(1);

      // Another room is not affected
      const other = await pcAlone(hub, ROOM2);
      await hub.handle(other, { t: 'announce', subs: [SUB_B] });
      expect(push.calls).toHaveLength(2);

      // After the cooldown: sent again
      vi.advanceTimersByTime(1);
      await hub.handle(pc2, { t: 'announce', subs: [SUB_A] });
      expect(push.calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the default cooldown is 2 minutes', async () => {
    vi.useFakeTimers();
    try {
      const push = new FakePusher();
      const hub = makeHub({ push });
      const pc = await pcAlone(hub);
      await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
      vi.advanceTimersByTime(120_000 - 1);
      await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
      expect(push.calls).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
      expect(push.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('concurrent announces for one room only send once', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const pc = await pcAlone(hub);
    await Promise.all([hub.handle(pc, { t: 'announce', subs: [SUB_A] }), hub.handle(pc, { t: 'announce', subs: [SUB_A] })]);
    expect(push.calls).toHaveLength(1);
    expect(pc.take()).toHaveLength(2);
  });

  it('only the PC role can announce', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM });
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM });
    hub.disconnect(pc); // phone alone in the room: "a phone is present" can't be what stops it
    phone.take();
    await hub.handle(phone, { t: 'announce', subs: [SUB_A] });
    expect(push.calls).toHaveLength(0);
    expect(phone.take()).toEqual([]);
  });

  it('connections that are not in a room cannot announce', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    await pcAlone(hub);
    const stranger = new FakeConn('stranger');
    await hub.handle(stranger, { t: 'announce', subs: [SUB_A] });
    expect(stranger.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    expect(push.calls).toHaveLength(0);
  });

  it('a host refused for a wrong access key cannot announce', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push, accessKey: 'secret-key' });
    const bad = new FakeConn('bad');
    await hub.handle(bad, { t: 'host', room: ROOM, key: 'wrong' });
    expect(bad.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
    await hub.handle(bad, { t: 'announce', subs: [SUB_A] });
    expect(bad.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    expect(push.calls).toHaveLength(0);
  });

  it('a PC replaced by a newer PC cannot announce any more', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const old = await pcAlone(hub);
    const fresh = new FakeConn('fresh');
    await hub.handle(fresh, { t: 'host', room: ROOM });
    old.take();
    await hub.handle(old, { t: 'announce', subs: [SUB_A] });
    expect(old.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    expect(push.calls).toHaveLength(0);
  });

  it('passes gone endpoints through to the PC', async () => {
    const push = new FakePusher();
    push.result = { sent: 1, gone: [SUB_B.endpoint] };
    const hub = makeHub({ push });
    const pc = await pcAlone(hub);
    await hub.handle(pc, { t: 'announce', subs: [SUB_A, SUB_B] });
    expect(pc.take()).toEqual([{ t: 'announced', sent: 1, gone: [SUB_B.endpoint] }]);
  });

  it('pusher.send throwing still produces a reply (and does not reject handle)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const push = new FakePusher();
      push.error = new Error('push service down');
      const hub = makeHub({ push });
      const pc = await pcAlone(hub);
      await expect(hub.handle(pc, { t: 'announce', subs: [SUB_A] })).resolves.toBeUndefined();
      expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('only forwards endpoint and keys to the pusher (extra fields are stripped)', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const pc = await pcAlone(hub);
    await hub.handle(pc, {
      t: 'announce',
      subs: [{ ...SUB_A, expirationTime: null, extra: 'x', keys: { ...SUB_A.keys, junk: 1 } }],
    });
    expect(push.calls[0].subs).toEqual([SUB_A]);
  });

  describe('parser rejects invalid subs with bad_message', () => {
    const cases: [string, unknown][] = [
      ['http endpoint', [{ ...SUB_A, endpoint: 'http://fcm.googleapis.com/fcm/send/a' }]],
      ['non-URL endpoint', [{ ...SUB_A, endpoint: 'fcm.googleapis.com/fcm/send/a' }]],
            ['endpoint too long', [{ ...SUB_A, endpoint: `${FCM}${'a'.repeat(1024 - FCM.length + 1)}` }]],
      ['p256dh too long', [{ ...SUB_A, keys: { ...SUB_A.keys, p256dh: 'x'.repeat(257) } }]],
      ['auth too long', [{ ...SUB_A, keys: { ...SUB_A.keys, auth: 'x'.repeat(257) } }]],
      ['more than 5 subs', Array.from({ length: 6 }, (_, i) => ({ ...SUB_A, endpoint: `${FCM}${i}` }))],
      ['missing keys', [{ endpoint: SUB_A.endpoint }]],
      ['missing auth', [{ endpoint: SUB_A.endpoint, keys: { p256dh: 'BPa' } }]],
      ['missing p256dh', [{ endpoint: SUB_A.endpoint, keys: { auth: 'aa' } }]],
      ['non-string key', [{ endpoint: SUB_A.endpoint, keys: { p256dh: 1, auth: 'aa' } }]],
      ['keys is null', [{ endpoint: SUB_A.endpoint, keys: null }]],
      ['one bad sub among good ones', [SUB_A, { endpoint: 'http://x.test/' , keys: SUB_A.keys }]],
      ['sub is null', [null]],
      ['sub is a string', [SUB_A.endpoint]],
      ['subs not an array', { 0: SUB_A }],
      ['subs missing', undefined],
    ];
    for (const [name, subs] of cases) {
      it(name, async () => {
        const push = new FakePusher();
        const hub = makeHub({ push });
        const pc = await pcAlone(hub);
        await hub.handle(pc, { t: 'announce', subs });
        expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
        expect(push.calls).toHaveLength(0);
      });
    }

    it('accepts exactly 5 subs and max-length fields', async () => {
      const push = new FakePusher();
      const hub = makeHub({ push });
      const pc = await pcAlone(hub);
      const subs = Array.from({ length: 5 }, (_, i) => ({
        endpoint: `${FCM}${i}`.padEnd(1024, 'a'),
        keys: { p256dh: 'p'.repeat(256), auth: 'a'.repeat(256) },
      }));
      await hub.handle(pc, { t: 'announce', subs });
      expect(push.calls).toHaveLength(1);
      expect(push.calls[0].subs).toHaveLength(5);
    });
  });

  // The server POSTs to whatever endpoint it is given, so only real push-service hosts are allowed (anti-SSRF)
  describe('endpoint host allowlist', () => {
    const rejected = [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://evil.example/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x', // suffix without a dot boundary
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/x',
      'https://fcm.googleapis.com:8443/fcm/send/x', // explicit port
      'https://user:pw@fcm.googleapis.com/fcm/send/x', // credentials
      'https://evil.example@fcm.googleapis.com/x', // credentials that look like a host
      'https://fcm.googleapis.com@evil.example/x', // the real host is evil.example
      'http://web.push.apple.com/x',
      'https://push.apple.com.evil.example/x',
      'https://apple.com/x',
      'wss://fcm.googleapis.com/x',
    ];
    for (const endpoint of rejected) {
      it(`rejects ${endpoint}`, async () => {
        const push = new FakePusher();
        const hub = makeHub({ push });
        const pc = await pcAlone(hub);
        await hub.handle(pc, { t: 'announce', subs: [{ ...SUB_A, endpoint }] });
        expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
        expect(push.calls).toHaveLength(0);
        expect(isPushEndpoint(endpoint)).toBe(false);
      });
    }

    const accepted = [
      'https://web.push.apple.com/QGuQyavXutnMH',
      'https://api.push.apple.com/x',
      'https://push.apple.com/x',
      'https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
      'https://wns2-by3p.notify.windows.com/w/?token=BQYAAAB',
      'https://FCM.GoogleAPIs.com/fcm/send/x', // hostnames are case-insensitive
      'https://fcm.googleapis.com:443/fcm/send/x', // the default port is the same URL
    ];
    for (const endpoint of accepted) {
      it(`accepts ${endpoint}`, async () => {
        const push = new FakePusher();
        const hub = makeHub({ push });
        const pc = await pcAlone(hub);
        await hub.handle(pc, { t: 'announce', subs: [{ ...SUB_A, endpoint }] });
        expect(push.calls).toHaveLength(1);
      });
    }
  });

  describe('rate limits', () => {
    it('at most 3 sends per connection, even across rooms the cooldown would allow', async () => {
      vi.useFakeTimers();
      try {
        const push = new FakePusher();
        const hub = makeHub({ push, announceCooldownMs: 1000 });
        const pc = await pcAlone(hub);
        for (let i = 0; i < 3; i++) {
          await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
          vi.advanceTimersByTime(1000);
        }
        expect(push.calls).toHaveLength(3);
        pc.take();
        await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
        expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
        expect(push.calls).toHaveLength(3);
        // The same connection re-hosting (room switch) does not reset its count
        await hub.handle(pc, { t: 'host', room: ROOM2 });
        pc.take();
        await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
        expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
        expect(push.calls).toHaveLength(3);
        // A new connection for the same room has its own allowance
        hub.disconnect(pc);
        const pc2 = await pcAlone(hub);
        await hub.handle(pc2, { t: 'announce', subs: [SUB_A] });
        expect(push.calls).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it('skipped announces (cooldown, phone present) do not use up the per-connection allowance', async () => {
      vi.useFakeTimers();
      try {
        const push = new FakePusher();
        const hub = makeHub({ push, announceCooldownMs: 1000 });
        const pc = await pcAlone(hub);
        await hub.handle(pc, { t: 'announce', subs: [SUB_A] }); // sent (1)
        for (let i = 0; i < 5; i++) await hub.handle(pc, { t: 'announce', subs: [SUB_A] }); // cooldown
        vi.advanceTimersByTime(1000);
        await hub.handle(pc, { t: 'announce', subs: [SUB_A] }); // sent (2)
        expect(push.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('at most 30 sends per minute server-wide, then the window frees up', async () => {
      vi.useFakeTimers();
      try {
        const push = new FakePusher();
        const hub = makeHub({ push });
        const roomN = (i: number) => `room-limit-${String(i).padStart(6, '0')}`;
        const pcs: FakeConn[] = [];
        for (let i = 0; i < 30; i++) {
          const pc = await pcAlone(hub, roomN(i));
          await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
          pcs.push(pc);
          vi.advanceTimersByTime(100);
        }
        expect(push.calls).toHaveLength(30);
        const late = await pcAlone(hub, roomN(30));
        await hub.handle(late, { t: 'announce', subs: [SUB_A] });
        expect(late.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
        expect(push.calls).toHaveLength(30);

        // The first announce was at t=0 and it's now t=3000: one slot frees at t=60000
        vi.advanceTimersByTime(60_000 - 3000 - 1);
        await hub.handle(late, { t: 'announce', subs: [SUB_A] });
        expect(push.calls).toHaveLength(30);
        vi.advanceTimersByTime(1);
        await hub.handle(late, { t: 'announce', subs: [SUB_A] });
        expect(push.calls).toHaveLength(31);
        void pcs;
      } finally {
        vi.useRealTimers();
      }
    });

    it('a refused announce (global limit) does not start the room cooldown', async () => {
      vi.useFakeTimers();
      try {
        const push = new FakePusher();
        const hub = makeHub({ push });
        for (let i = 0; i < 30; i++) {
          const pc = await pcAlone(hub, `room-fill-${String(i).padStart(8, '0')}`);
          await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
        }
        const pc = await pcAlone(hub);
        await hub.handle(pc, { t: 'announce', subs: [SUB_A] }); // refused: window full
        vi.advanceTimersByTime(60_000);
        await hub.handle(pc, { t: 'announce', subs: [SUB_A] }); // window empty, room cooldown never started
        expect(push.calls).toHaveLength(31);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('isPushSub / isPhoneToPcMsg', () => {
  it('isPushSub accepts a browser-shaped subscription and rejects junk', () => {
    expect(isPushSub(SUB_A)).toBe(true);
    expect(isPushSub({ ...SUB_A, expirationTime: null })).toBe(true);
    for (const bad of [null, undefined, 1, 'x', [], {}, { endpoint: SUB_A.endpoint }, { keys: SUB_A.keys }]) {
      expect(isPushSub(bad)).toBe(false);
    }
  });

  it('isPhoneToPcMsg: push_sub needs a valid sub, push_unsub a bounded string', () => {
    expect(isPhoneToPcMsg({ t: 'push_sub', sub: SUB_A })).toBe(true);
    expect(isPhoneToPcMsg({ t: 'push_sub', sub: { ...SUB_A, endpoint: 'https://evil.example/x' } })).toBe(false);
    expect(isPhoneToPcMsg({ t: 'push_sub' })).toBe(false);
    expect(isPhoneToPcMsg({ t: 'push_unsub', endpoint: SUB_A.endpoint })).toBe(true);
    expect(isPhoneToPcMsg({ t: 'push_unsub', endpoint: 'x'.repeat(1025) })).toBe(false);
    expect(isPhoneToPcMsg({ t: 'push_unsub', endpoint: 5 })).toBe(false);
    expect(isPhoneToPcMsg({ t: 'fx_file', name: 'a', b64: '' })).toBe(false);
    expect(isPhoneToPcMsg(null)).toBe(false);
    expect(isPhoneToPcMsg('push_sub')).toBe(false);
  });
});
