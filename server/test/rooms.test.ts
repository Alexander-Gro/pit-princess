import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PHONES, PROTOCOL_VERSION, isPhoneToPcMsg, isPushEndpoint, isPushSub, type MemberInfo, type ServerMsg } from '@pit/shared';
import { RoomHub, type Conn } from '../src/rooms.ts';

const ROOM = 'room-AAAAAAAAAAAAAAAA';
const ROOM2 = 'room-BBBBBBBBBBBBBBBB';
const ICE: RTCIceServer[] = [{ urls: 'stun:test.invalid:3478' }];
const V = PROTOCOL_VERSION;
/** Phone device ids (what the phone keeps in localStorage) */
const DEV_A = 'devAAAAAAAAAAAAAAAAAAA';
const DEV_B = 'devBBBBBBBBBBBBBBBBBBB';
const DEV_C = 'devCCCCCCCCCCCCCCCCCCC';
/** Server-assigned phone member ids: 'm' + 9 random bytes in base64url */
const MEMBER_ID = /^m[A-Za-z0-9_-]{12}$/;
const CID = 'call-0001';

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  /** Everything ever sent to this connection (take() does not clear it) */
  all: ServerMsg[] = [];
  closed = 0;
  /** Member id from the most recent welcome */
  you: string | null = null;
  constructor(readonly name: string) {}
  send(msg: ServerMsg): void {
    this.msgs.push(msg);
    this.all.push(msg);
    if (msg.t === 'welcome') this.you = msg.you;
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
  get id(): string {
    if (!this.you) throw new Error(`${this.name} was never welcomed`);
    return this.you;
  }
}

function makeHub(opts: Partial<ConstructorParameters<typeof RoomHub>[0]> = {}) {
  return new RoomHub({ getIceServers: async () => ICE, ...opts });
}

const host = (hub: RoomHub, c: Conn, room = ROOM, extra: Record<string, unknown> = {}) =>
  hub.handle(c, { t: 'host', v: V, room, ...extra });
const join = (hub: RoomHub, c: Conn, device?: string, room = ROOM, extra: Record<string, unknown> = {}) =>
  hub.handle(c, { t: 'join', v: V, room, ...(device === undefined ? {} : { device }), ...extra });

const pcInfo = (name: string | null = null): MemberInfo => ({ id: 'pc', role: 'pc', name });
/** A phone as the PC sees it (with its device id) */
const phoneForPc = (c: FakeConn, slot: number, device: string, name: string | null = null): MemberInfo => ({
  id: c.id,
  role: 'phone',
  name,
  slot,
  device,
});
/** A phone as the other phones see it (no device id) */
const phoneForPhones = (c: FakeConn, slot: number, name: string | null = null): MemberInfo => ({ id: c.id, role: 'phone', name, slot });

/** PC + one phone (DEV_A), recorded messages cleared */
async function setup(hub = makeHub()) {
  const pc = new FakeConn('pc');
  const phone = new FakeConn('phone');
  await host(hub, pc);
  await join(hub, phone, DEV_A);
  pc.take();
  phone.take();
  return { hub, pc, phone };
}

/** PC + two phones (A = DEV_A slot 1, B = DEV_B slot 2), recorded messages cleared */
async function setup2(hub = makeHub()) {
  const { pc, phone: a } = await setup(hub);
  const b = new FakeConn('b');
  await join(hub, b, DEV_B);
  for (const c of [pc, a, b]) c.take();
  return { hub, pc, a, b };
}

const room = (hub: RoomHub, code = ROOM) => hub.rooms.get(code);

describe('host / join', () => {
  it('host gets a welcome with itself as the only member, idle floor and the ICE servers, then a roster', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await host(hub, pc);
    expect(pc.take()).toEqual([
      { t: 'welcome', role: 'pc', you: 'pc', iceServers: ICE, floor: 'idle', members: [pcInfo()] },
      { t: 'roster', members: [pcInfo()] },
    ]);
    expect(hub.rooms.has(ROOM)).toBe(true);
  });

  it('a phone joining gets a server-assigned id and the roster; the PC gets peer_joined {id} and a roster with the device', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    await host(hub, pc);
    pc.take();
    await join(hub, phone, DEV_A);
    const id = phone.id;
    expect(id).toMatch(MEMBER_ID);
    expect(id).not.toBe(DEV_A);
    const forPhone = [pcInfo(), phoneForPhones(phone, 1)];
    expect(phone.take()).toEqual([
      { t: 'welcome', role: 'phone', you: id, iceServers: ICE, floor: 'idle', members: forPhone },
      { t: 'roster', members: forPhone },
    ]);
    expect(pc.take()).toEqual([
      { t: 'peer_joined', id },
      { t: 'roster', members: [pcInfo(), phoneForPc(phone, 1, DEV_A)] },
    ]);
  });

  it('a phone without a (valid) device id still joins; the PC roster then has no device for it', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await host(hub, pc);
    pc.take();
    for (const device of [undefined, 'short', 'has spaces in it!!', 'x'.repeat(65)]) {
      const phone = new FakeConn('phone');
      await join(hub, phone, device);
      expect(phone.take()[0]).toMatchObject({ t: 'welcome', role: 'phone' });
      const roster = pc.take().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }>;
      const me = roster.members.find((m) => m.id === phone.id)!;
      expect(me.role).toBe('phone');
      expect('device' in me).toBe(false);
      hub.disconnect(phone);
      pc.take();
    }
  });

  it('a non-string device is a bad message', async () => {
    const hub = makeHub();
    await host(hub, new FakeConn('pc'));
    const phone = new FakeConn('phone');
    await join(hub, phone, undefined, ROOM, { device: 12345678 });
    expect(phone.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
  });

  it('join on a room with no host -> no_host, and no room is created', async () => {
    const hub = makeHub();
    const phone = new FakeConn('phone');
    await join(hub, phone, DEV_A);
    expect(phone.take()).toEqual([{ t: 'error', code: 'no_host' }]);
    expect(hub.rooms.size).toBe(0);
    // Not a member: room messages are refused
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
  });

  it('join is refused with no_host even when maxRooms is reached (no room table growth)', async () => {
    const hub = makeHub({ maxRooms: 1 });
    await host(hub, new FakeConn('pc'));
    const phone = new FakeConn('phone');
    await join(hub, phone, DEV_A, ROOM2);
    expect(phone.take()).toEqual([{ t: 'error', code: 'no_host' }]);
    expect(hub.rooms.size).toBe(1);
  });

  it('phone stays in the room after the PC leaves; a returning PC sees it and it gets peer_joined {id: pc}', async () => {
    const { hub, pc, phone } = await setup();
    hub.disconnect(pc);
    expect(phone.take()).toEqual([
      { t: 'peer_left', id: 'pc' },
      { t: 'roster', members: [phoneForPhones(phone, 1)] },
    ]);
    expect(room(hub)?.phones.size).toBe(1);
    expect(room(hub)?.pc).toBeNull();
    const pc2 = new FakeConn('pc2');
    await host(hub, pc2);
    expect(pc2.take()).toEqual([
      { t: 'welcome', role: 'pc', you: 'pc', iceServers: ICE, floor: 'idle', members: [pcInfo(), phoneForPc(phone, 1, DEV_A)] },
      { t: 'roster', members: [pcInfo(), phoneForPc(phone, 1, DEV_A)] },
    ]);
    expect(phone.take()).toEqual([
      { t: 'peer_joined', id: 'pc' },
      { t: 'roster', members: [pcInfo(), phoneForPhones(phone, 1)] },
    ]);
  });

  it('welcome reports the current floor holder', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'floor_request' });
    hub.disconnect(phone); // the PC still holds the floor
    const phone2 = new FakeConn('phone2');
    await join(hub, phone2, DEV_B);
    expect(phone2.take()[0]).toMatchObject({ t: 'welcome', floor: 'pc' });
  });

  it('peer_left goes to the remaining side and the room is deleted when empty', async () => {
    const { hub, pc, phone } = await setup();
    const id = phone.id;
    hub.disconnect(phone);
    expect(pc.take()).toEqual([
      { t: 'peer_left', id },
      { t: 'roster', members: [pcInfo()] },
    ]);
    expect(hub.rooms.has(ROOM)).toBe(true);
    hub.disconnect(pc);
    expect(hub.rooms.has(ROOM)).toBe(false);
    expect(phone.msgs).toEqual([]);
  });

  it('getIceServers rejecting falls back to an empty list', async () => {
    const hub = makeHub({ getIceServers: async () => Promise.reject(new Error('nope')) });
    const pc = new FakeConn('pc');
    await host(hub, pc);
    expect(pc.take()[0]).toMatchObject({ t: 'welcome', iceServers: [] });
  });

  it('re-sending the same host is idempotent (welcome again, no peer notices, no roster)', async () => {
    const { hub, pc, phone } = await setup();
    await host(hub, pc);
    expect(pc.take()).toEqual([
      { t: 'welcome', role: 'pc', you: 'pc', iceServers: ICE, floor: 'idle', members: [pcInfo(), phoneForPc(phone, 1, DEV_A)] },
    ]);
    expect(phone.take()).toEqual([]);
  });

  it('re-sending the same join on the same connection is idempotent (same id, no notices)', async () => {
    const { hub, pc, phone } = await setup();
    const id = phone.id;
    await join(hub, phone, DEV_A);
    expect(phone.take()).toEqual([
      { t: 'welcome', role: 'phone', you: id, iceServers: ICE, floor: 'idle', members: [pcInfo(), phoneForPhones(phone, 1)] },
    ]);
    expect(pc.take()).toEqual([]);
  });
});

describe('protocol version', () => {
  it.each([
    ['missing', undefined],
    ['1', 1],
    ['3', 3],
    ['0', 0],
  ])('host and join with v %s -> update_required, and the connection is closed', async (_label, v) => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    const hostMsg: Record<string, unknown> = { t: 'host', room: ROOM };
    if (v !== undefined) hostMsg.v = v;
    await hub.handle(pc, hostMsg);
    expect(pc.take()).toEqual([{ t: 'error', code: 'update_required' }]);
    expect(pc.closed).toBe(1);
    expect(hub.rooms.size).toBe(0);

    // A current PC hosts, an old phone tries to join
    const pcOk = new FakeConn('pcOk');
    await host(hub, pcOk);
    pcOk.take();
    const phone = new FakeConn('phone');
    const joinMsg: Record<string, unknown> = { t: 'join', room: ROOM, device: DEV_A };
    if (v !== undefined) joinMsg.v = v;
    await hub.handle(phone, joinMsg);
    expect(phone.take()).toEqual([{ t: 'error', code: 'update_required' }]);
    expect(phone.closed).toBe(1);
    expect(pcOk.take()).toEqual([]);
    expect(room(hub)?.phones.size).toBe(0);
    // Not a member afterwards
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
  });

  it('the old (v1) message shape, with no v at all, gets update_required rather than bad_message', async () => {
    const hub = makeHub();
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'join', room: ROOM });
    expect(phone.take()).toEqual([{ t: 'error', code: 'update_required' }]);
  });

  it('update_required is checked before the access key', async () => {
    const hub = makeHub({ accessKey: 'secret-key-0123456789' });
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', room: ROOM, key: 'wrong' });
    expect(pc.take()).toEqual([{ t: 'error', code: 'update_required' }]);
  });

  it('a non-number v is a bad message (connection left open)', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await hub.handle(pc, { t: 'host', v: '2', room: ROOM });
    expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
    expect(pc.closed).toBe(0);
  });

  it('pair_claim does not need a version', async () => {
    const hub = makeHub();
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'pair_claim', code: '123456' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'bad_code' }]);
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
    await host(hub, c, code);
    await join(hub, c, DEV_A, code);
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
      await host(hub, c, code);
      expect(c.take()[0]).toMatchObject({ t: 'welcome' });
    }
  });

  it.each([
    null,
    42,
    'host',
    {},
    { t: 'nope' },
    { t: 'host', v: V },
    { t: 'host', v: V, room: 5 },
    { t: 'signal' },
    { t: 'signal', cid: CID, data: { kind: 'offer' } },
    { t: 'signal', cid: CID, data: { kind: 'ice', candidate: 'x' } },
    // cid is required and must look like one
    { t: 'signal', data: { kind: 'offer', sdp: 'x' } },
    { t: 'signal', cid: 'abc', data: { kind: 'offer', sdp: 'x' } },
    { t: 'signal', cid: 'a'.repeat(33), data: { kind: 'offer', sdp: 'x' } },
    { t: 'signal', cid: 'bad cid!', data: { kind: 'offer', sdp: 'x' } },
    { t: 'signal', cid: 42, data: { kind: 'offer', sdp: 'x' } },
    // `to` must be a member id
    { t: 'signal', to: 'a b c d', cid: CID, data: { kind: 'offer', sdp: 'x' } },
    { t: 'signal', to: 'abc', cid: CID, data: { kind: 'offer', sdp: 'x' } },
    { t: 'signal', to: 7, cid: CID, data: { kind: 'offer', sdp: 'x' } },
    { t: 'kick', id: 'no spaces allowed' },
    { t: 'kick', id: 5 },
    { t: 'names' },
    { t: 'names', names: null },
    { t: 'names', names: ['Emma'] },
    { t: 'names', names: 'Emma' },
  ])('bad message %j -> bad_message', async (raw) => {
    const hub = makeHub();
    const c = new FakeConn('c');
    await hub.handle(c, raw);
    expect(c.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
  });

  it('room messages before host/join -> not_in_room', async () => {
    const hub = makeHub();
    const c = new FakeConn('c');
    const msgs = [
      { t: 'floor_request' },
      { t: 'floor_release' },
      { t: 'kick' },
      { t: 'kick', id: 'pc' },
      { t: 'signal', cid: CID, data: { kind: 'offer', sdp: 'x' } },
      { t: 'names', names: { pc: 'Pit wall' } },
      { t: 'pair_create' },
    ];
    for (const m of msgs) await hub.handle(c, m);
    expect(c.take()).toEqual(Array(msgs.length).fill({ t: 'error', code: 'not_in_room' }));
  });

  it('maxRooms is enforced', async () => {
    const hub = makeHub({ maxRooms: 1 });
    const a = new FakeConn('a');
    const b = new FakeConn('b');
    await host(hub, a);
    await host(hub, b, ROOM2);
    expect(b.take()).toEqual([{ t: 'error', code: 'bad_room' }]);
    expect(hub.rooms.size).toBe(1);
  });
});

describe('two phones per room', () => {
  it(`MAX_PHONES is 2`, () => {
    expect(MAX_PHONES).toBe(2);
  });

  it('two phones join; each gets its own id and slot; the PC is told about each', async () => {
    const { hub, pc, phone: a } = await setup();
    const b = new FakeConn('b');
    await join(hub, b, DEV_B);
    expect(b.id).toMatch(MEMBER_ID);
    expect(b.id).not.toBe(a.id);
    const forPhones = [pcInfo(), phoneForPhones(a, 1), phoneForPhones(b, 2)];
    expect(b.take()).toEqual([
      { t: 'welcome', role: 'phone', you: b.id, iceServers: ICE, floor: 'idle', members: forPhones },
      { t: 'roster', members: forPhones },
    ]);
    expect(pc.take()).toEqual([
      { t: 'peer_joined', id: b.id },
      { t: 'roster', members: [pcInfo(), phoneForPc(a, 1, DEV_A), phoneForPc(b, 2, DEV_B)] },
    ]);
    // A hears about B only through the roster (phones never set up WebRTC with each other)
    expect(a.take()).toEqual([{ t: 'roster', members: forPhones }]);
    expect(room(hub)?.phones.size).toBe(2);
  });

  it('a third phone gets room_full; the connection stays open but is not a member, and nobody is told', async () => {
    const { hub, pc, a, b } = await setup2();
    const c = new FakeConn('c');
    await join(hub, c, DEV_C);
    expect(c.take()).toEqual([{ t: 'error', code: 'room_full' }]);
    expect(c.closed).toBe(0);
    expect(c.you).toBeNull();
    for (const x of [pc, a, b]) expect(x.take()).toEqual([]);
    expect(room(hub)?.phones.size).toBe(2);
    await hub.handle(c, { t: 'floor_request' });
    expect(c.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    await hub.handle(c, { t: 'signal', cid: CID, data: { kind: 'offer', sdp: 'x' } });
    expect(c.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    expect(pc.take()).toEqual([]);
    // Its later socket close is harmless
    hub.disconnect(c);
    for (const x of [pc, a, b]) expect(x.take()).toEqual([]);
  });

  it('a third phone without a device id also gets room_full', async () => {
    const { hub } = await setup2();
    const c = new FakeConn('c');
    await join(hub, c);
    expect(c.take()).toEqual([{ t: 'error', code: 'room_full' }]);
  });

  it('the refused phone gets in once a seat frees up (it retries the join)', async () => {
    const { hub, pc, a, b } = await setup2();
    const c = new FakeConn('c');
    await join(hub, c, DEV_C);
    expect(c.take()).toEqual([{ t: 'error', code: 'room_full' }]);
    hub.disconnect(a);
    pc.take();
    b.take();
    await join(hub, c, DEV_C);
    expect(c.take()[0]).toMatchObject({ t: 'welcome', role: 'phone', you: c.id });
    expect(pc.take()).toEqual([
      { t: 'peer_joined', id: c.id },
      { t: 'roster', members: [pcInfo(), phoneForPc(b, 2, DEV_B), phoneForPc(c, 1, DEV_C)] },
    ]);
  });

  it('a full room with no PC still refuses a third phone', async () => {
    const { hub, pc } = await setup2();
    hub.disconnect(pc);
    const c = new FakeConn('c');
    await join(hub, c, DEV_C);
    expect(c.take()).toEqual([{ t: 'error', code: 'room_full' }]);
  });

  it('the PC is not counted against the phone limit, and a PC can always (re)host a full room', async () => {
    const { hub, pc, a, b } = await setup2();
    const pc2 = new FakeConn('pc2');
    await host(hub, pc2);
    expect(pc.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(pc2.take()[0]).toMatchObject({ t: 'welcome', role: 'pc' });
    expect(room(hub)?.phones.size).toBe(2);
    expect(a.closed + b.closed).toBe(0);
  });

  it('member ids are random per connection, never the device id, and differ on every reconnect of the same device', async () => {
    const { hub, phone } = await setup();
    const ids = new Set([phone.id]);
    for (let i = 0; i < 5; i++) {
      const again = new FakeConn(`again${i}`);
      await join(hub, again, DEV_A);
      expect(again.id).toMatch(MEMBER_ID);
      expect(again.id).not.toBe(DEV_A);
      ids.add(again.id);
    }
    expect(ids.size).toBe(6);
  });
});

describe('device ids are only shown to the PC', () => {
  it('phones never see any device id, in any message; the PC sees both', async () => {
    const { hub, pc, a, b } = await setup2();
    // Plenty of traffic: names, floor, signals, a leave and a replace
    await hub.handle(pc, { t: 'names', names: { pc: 'Pit wall', [a.id]: 'Emma', [b.id]: 'Lou' } });
    await hub.handle(a, { t: 'floor_request' });
    await hub.handle(a, { t: 'floor_release' });
    await hub.handle(pc, { t: 'signal', to: b.id, cid: CID, data: { kind: 'offer', sdp: 'v=0' } });
    const a2 = new FakeConn('a2');
    await join(hub, a2, DEV_A);
    hub.disconnect(a2);

    for (const phone of [a, b, a2]) {
      const json = JSON.stringify(phone.all);
      expect(json).not.toContain(DEV_A);
      expect(json).not.toContain(DEV_B);
      for (const m of phone.all) {
        if (m.t === 'welcome' || m.t === 'roster') for (const info of m.members) expect('device' in info).toBe(false);
      }
    }
    const pcJson = JSON.stringify(pc.all);
    expect(pcJson).toContain(DEV_A);
    expect(pcJson).toContain(DEV_B);
    // Every phone entry in every PC roster carries its device
    for (const m of pc.all) {
      if (m.t === 'roster' || m.t === 'welcome') {
        for (const info of m.members) if (info.role === 'phone') expect(info.device).toMatch(/^dev[ABC]/);
      }
    }
  });

  it("the PC's welcome after a reconnect includes the devices of the phones already there", async () => {
    const { hub, pc, a, b } = await setup2();
    hub.disconnect(pc);
    const pc2 = new FakeConn('pc2');
    await host(hub, pc2);
    expect(pc2.take()[0]).toMatchObject({
      t: 'welcome',
      members: [pcInfo(), phoneForPc(a, 1, DEV_A), phoneForPc(b, 2, DEV_B)],
    });
  });
});

describe('slots', () => {
  const slotsFor = (pc: FakeConn) => {
    const roster = [...pc.all].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }>;
    return Object.fromEntries(roster.members.filter((m) => m.role === 'phone').map((m) => [m.device, m.slot]));
  };

  it('first phone is slot 1, second slot 2; a leaver frees its slot without renumbering the other', async () => {
    const { hub, pc, a, b } = await setup2();
    expect(slotsFor(pc)).toEqual({ [DEV_A]: 1, [DEV_B]: 2 });
    hub.disconnect(a);
    expect(slotsFor(pc)).toEqual({ [DEV_B]: 2 });
    const c = new FakeConn('c');
    await join(hub, c, DEV_C);
    expect(slotsFor(pc)).toEqual({ [DEV_B]: 2, [DEV_C]: 1 });
    // ...and B's own view agrees
    const bView = [...b.all].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }>;
    expect(bView.members.find((m) => m.id === b.id)?.slot).toBe(2);
    expect(bView.members.find((m) => m.id === c.id)?.slot).toBe(1);
  });

  it('slot 2 leaving: the next phone gets slot 2', async () => {
    const { hub, pc, b } = await setup2();
    hub.disconnect(b);
    await join(hub, new FakeConn('c'), DEV_C);
    expect(slotsFor(pc)).toEqual({ [DEV_A]: 1, [DEV_C]: 2 });
  });

  it('the same device reconnecting keeps its slot, even though it gets a new member id', async () => {
    const { hub, pc, a, b } = await setup2();
    hub.disconnect(a); // A leaves first: slot 1 is free, B stays on 2
    const a2 = new FakeConn('a2');
    await join(hub, a2, DEV_A);
    expect(slotsFor(pc)).toEqual({ [DEV_A]: 1, [DEV_B]: 2 });
    // Replace B while it's still connected: keeps slot 2
    const b2 = new FakeConn('b2');
    await join(hub, b2, DEV_B);
    expect(b2.id).not.toBe(b.id);
    expect(slotsFor(pc)).toEqual({ [DEV_A]: 1, [DEV_B]: 2 });
  });

  it('a PC reconnect does not change any slot', async () => {
    const { hub, pc, a, b } = await setup2();
    hub.disconnect(pc);
    const pc2 = new FakeConn('pc2');
    await host(hub, pc2);
    expect(slotsFor(pc2)).toEqual({ [DEV_A]: 1, [DEV_B]: 2 });
    void a;
    void b;
  });
});

describe('replacement', () => {
  it('a second phone with a different device does not replace the first', async () => {
    const { hub, pc, phone } = await setup();
    const phone2 = new FakeConn('phone2');
    await join(hub, phone2, DEV_B);
    expect(phone.take()).toEqual([{ t: 'roster', members: [pcInfo(), phoneForPhones(phone, 1), phoneForPhones(phone2, 2)] }]);
    expect(phone.closed).toBe(0);
    expect(pc.take().map((m) => m.t)).toEqual(['peer_joined', 'roster']);
  });

  it('the same device rejoining replaces its old connection: PC gets peer_left(old) then peer_joined(new)', async () => {
    const { hub, pc, phone } = await setup();
    const oldId = phone.id;
    const again = new FakeConn('again');
    await join(hub, again, DEV_A);
    expect(phone.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(phone.closed).toBe(1);
    const newId = again.id;
    expect(newId).not.toBe(oldId);
    expect(again.take()[0]).toEqual({
      t: 'welcome',
      role: 'phone',
      you: newId,
      iceServers: ICE,
      floor: 'idle',
      members: [pcInfo(), phoneForPhones(again, 1)],
    });
    expect(pc.take()).toEqual([
      { t: 'peer_left', id: oldId },
      { t: 'roster', members: [pcInfo()] },
      { t: 'peer_joined', id: newId },
      { t: 'roster', members: [pcInfo(), phoneForPc(again, 1, DEV_A)] },
    ]);
    // The old connection is no longer a member
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    // Its later socket close is harmless
    hub.disconnect(phone);
    expect(pc.take()).toEqual([]);
    expect(hub.rooms.has(ROOM)).toBe(true);
  });

  it('replacing a device in a full room is allowed (not room_full), and the other phone only sees roster changes', async () => {
    const { hub, pc, a, b } = await setup2();
    const a2 = new FakeConn('a2');
    await join(hub, a2, DEV_A);
    expect(a2.take()[0]).toMatchObject({ t: 'welcome', you: a2.id });
    expect(a.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(b.take()).toEqual([
      { t: 'roster', members: [pcInfo(), phoneForPhones(b, 2)] },
      { t: 'roster', members: [pcInfo(), phoneForPhones(b, 2), phoneForPhones(a2, 1)] },
    ]);
    expect(pc.take().map((m) => m.t)).toEqual(['peer_left', 'roster', 'peer_joined', 'roster']);
    expect(room(hub)?.phones.size).toBe(2);
  });

  it('replacing a phone in a room with no PC keeps the room alive', async () => {
    const { hub, pc, phone } = await setup();
    hub.disconnect(pc);
    phone.take();
    const again = new FakeConn('again');
    await join(hub, again, DEV_A);
    expect(phone.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(again.take()[0]).toMatchObject({ t: 'welcome', you: again.id });
    expect(room(hub)?.phones.size).toBe(1);
  });

  it('a second PC replaces the first; the phones see peer_left(pc) then peer_joined(pc)', async () => {
    const { hub, pc, a, b } = await setup2();
    const pc2 = new FakeConn('pc2');
    await host(hub, pc2);
    expect(pc.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    expect(pc.closed).toBe(1);
    expect(pc2.take()[0]).toMatchObject({ t: 'welcome', role: 'pc', you: 'pc' });
    for (const p of [a, b]) {
      expect(p.take().map((m) => (m.t === 'peer_joined' || m.t === 'peer_left' ? `${m.t}:${m.id}` : m.t))).toEqual([
        'peer_left:pc',
        'roster',
        'peer_joined:pc',
        'roster',
      ]);
    }
    hub.disconnect(pc);
    expect(a.take()).toEqual([]);
  });

  it('replacing the floor holder (same device) releases the floor before peer_left', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'floor_request' });
    for (const c of [pc, a, b]) c.take();
    const oldId = a.id;
    const a2 = new FakeConn('a2');
    await join(hub, a2, DEV_A);
    expect(pc.take()).toEqual([
      { t: 'floor', holder: 'idle' },
      { t: 'peer_left', id: oldId },
      { t: 'roster', members: [pcInfo(), phoneForPc(b, 2, DEV_B)] },
      { t: 'peer_joined', id: a2.id },
      { t: 'roster', members: [pcInfo(), phoneForPc(b, 2, DEV_B), phoneForPc(a2, 1, DEV_A)] },
    ]);
    expect(b.take()[0]).toEqual({ t: 'floor', holder: 'idle' });
    expect(a2.take()[0]).toMatchObject({ t: 'welcome', floor: 'idle' });
    // The kicked floor holder gets nothing after its 'kicked' farewell
    expect(a.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
    // The floor is really free: B can take it
    await hub.handle(b, { t: 'floor_request' });
    expect(b.take()).toEqual([{ t: 'floor', holder: b.id }]);
  });

  it('replacing the floor holder clears the max-TX timer', async () => {
    vi.useFakeTimers();
    try {
      const { hub, pc, phone } = await setup(makeHub({ maxTxMs: 1000 }));
      await hub.handle(phone, { t: 'floor_request' });
      await join(hub, new FakeConn('again'), DEV_A);
      pc.take();
      vi.advanceTimersByTime(5000);
      expect(pc.msgs).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('kick', () => {
  it('PC kick without an id kicks every phone', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(pc, { t: 'kick' });
    for (const p of [a, b]) {
      expect(p.msgs).toContainEqual({ t: 'kicked', reason: 'kicked' });
      // nothing after the farewell
      expect(p.last()).toEqual({ t: 'kicked', reason: 'kicked' });
      expect(p.closed).toBe(1);
    }
    const left = pc.take().filter((m) => m.t === 'peer_left');
    expect(left).toEqual([
      { t: 'peer_left', id: a.id },
      { t: 'peer_left', id: b.id },
    ]);
    expect(pc.all.filter((m) => m.t === 'roster').at(-1)).toEqual({ t: 'roster', members: [pcInfo()] });
    expect(room(hub)?.phones.size).toBe(0);
    expect(hub.rooms.has(ROOM)).toBe(true);
  });

  it('PC kick {id} kicks only that phone; the other stays and sees a roster', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(pc, { t: 'kick', id: b.id });
    expect(b.take()).toEqual([{ t: 'kicked', reason: 'kicked' }]);
    expect(b.closed).toBe(1);
    expect(a.take()).toEqual([{ t: 'roster', members: [pcInfo(), phoneForPhones(a, 1)] }]);
    expect(a.closed).toBe(0);
    expect(pc.take()).toEqual([
      { t: 'peer_left', id: b.id },
      { t: 'roster', members: [pcInfo(), phoneForPc(a, 1, DEV_A)] },
    ]);
    // A is still a working member
    await hub.handle(a, { t: 'floor_request' });
    expect(a.take()).toEqual([{ t: 'floor', holder: a.id }]);
  });

  it('kick with an unknown id, the PC id, or a device id is a no-op', async () => {
    const { hub, pc, a, b } = await setup2();
    for (const id of ['mUnknownUnknown', 'pc', DEV_A]) await hub.handle(pc, { t: 'kick', id });
    for (const c of [pc, a, b]) expect(c.take()).toEqual([]);
    expect(a.closed + b.closed).toBe(0);
  });

  it('a kicked phone can rejoin (with a new id)', async () => {
    const { hub, pc, phone } = await setup();
    const oldId = phone.id;
    await hub.handle(pc, { t: 'kick', id: oldId });
    const again = new FakeConn('again');
    await join(hub, again, DEV_A);
    expect(again.id).not.toBe(oldId);
    expect(again.take()[0]).toMatchObject({ t: 'welcome', you: again.id });
  });

  it('phones cannot kick the PC or each other; kick with no phone is a no-op', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'kick' });
    await hub.handle(a, { t: 'kick', id: b.id });
    await hub.handle(a, { t: 'kick', id: 'pc' });
    for (const c of [pc, a, b]) expect(c.take()).toEqual([]);
    expect(pc.closed + b.closed).toBe(0);
    hub.disconnect(a);
    hub.disconnect(b);
    pc.take();
    await hub.handle(pc, { t: 'kick' });
    expect(pc.take()).toEqual([]);
  });

  it('kicking a phone that holds the floor releases it', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'floor_request' });
    pc.take();
    b.take();
    await hub.handle(pc, { t: 'kick', id: a.id });
    expect(pc.take().map((m) => m.t)).toEqual(['floor', 'peer_left', 'roster']);
    expect(b.take()).toEqual([
      { t: 'floor', holder: 'idle' },
      { t: 'roster', members: [pcInfo(), phoneForPhones(b, 2)] },
    ]);
  });
});

describe('re-hosting a new code', () => {
  it('moves the PC to the new room and kicks every phone from the old one', async () => {
    const { hub, pc, a, b } = await setup2();
    await host(hub, pc, ROOM2);
    for (const p of [a, b]) {
      expect(p.take()).toContainEqual({ t: 'kicked', reason: 'room_closed' });
      expect(p.closed).toBe(1);
    }
    expect(pc.take()).toEqual([
      { t: 'welcome', role: 'pc', you: 'pc', iceServers: ICE, floor: 'idle', members: [pcInfo()] },
      { t: 'roster', members: [pcInfo()] },
    ]);
    expect(hub.rooms.has(ROOM)).toBe(false);
    expect(hub.rooms.has(ROOM2)).toBe(true);
    // Phones are gone
    for (const p of [a, b]) {
      await hub.handle(p, { t: 'floor_request' });
      expect(p.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    }
  });

  it('releases the floor and clears the old room timer', async () => {
    vi.useFakeTimers();
    try {
      const { hub, pc, phone } = await setup(makeHub({ maxTxMs: 1000 }));
      await hub.handle(pc, { t: 'floor_request' });
      pc.take();
      await host(hub, pc, ROOM2);
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
    const p1 = host(hub, pc);
    const p2 = host(hub, pc, ROOM2);
    release();
    await Promise.all([p1, p2]);
    expect(hub.rooms.has(ROOM2)).toBe(true);
    expect(hub.rooms.has(ROOM)).toBe(false);
    expect(pc.msgs.filter((m) => m.t === 'welcome')).toHaveLength(1);
  });

  // Regression: the "close the old room" branch used to check the new role instead of the old one
  it('a phone that switches to hosting another code does not kick the other phone from its room', async () => {
    const { hub, pc, a, b } = await setup2();
    await host(hub, a, ROOM2);
    expect(b.all).not.toContainEqual({ t: 'kicked', reason: 'room_closed' });
    expect(b.closed).toBe(0);
    expect(room(hub)?.phones.has(b.id)).toBe(true);
    void pc;
  });
});

describe('floor', () => {
  it('grant goes to both sides as the member id; request from the other side is busy', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    expect(phone.take()).toEqual([{ t: 'floor', holder: phone.id }]);
    expect(pc.take()).toEqual([{ t: 'floor', holder: phone.id }]);
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

  it('request while the other side is absent -> busy (PC needs a phone, a phone needs the PC)', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await host(hub, pc);
    pc.take();
    await hub.handle(pc, { t: 'floor_request' });
    expect(pc.take()).toEqual([{ t: 'busy' }]);
    const a = new FakeConn('a');
    const b = new FakeConn('b');
    await join(hub, a, DEV_A);
    await join(hub, b, DEV_B);
    hub.disconnect(pc);
    a.take();
    b.take();
    // Two phones but no PC: still busy (phones only ever talk through the PC)
    await hub.handle(a, { t: 'floor_request' });
    expect(a.take()).toEqual([{ t: 'busy' }]);
    expect(b.take()).toEqual([]);
  });

  it('floor auto-released when the holder disconnects', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(phone, { t: 'floor_request' });
    pc.take();
    const id = phone.id;
    hub.disconnect(phone);
    expect(pc.take()).toEqual([
      { t: 'floor', holder: 'idle' },
      { t: 'peer_left', id },
      { t: 'roster', members: [pcInfo()] },
    ]);
    const phone2 = new FakeConn('phone2');
    await join(hub, phone2, DEV_B);
    expect(phone2.take()[0]).toMatchObject({ t: 'welcome', floor: 'idle' });
  });

  it('non-holder disconnecting leaves the floor with the holder', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'floor_request' });
    pc.take();
    hub.disconnect(phone);
    expect(pc.take().map((m) => m.t)).toEqual(['peer_left', 'roster']);
    expect(room(hub)?.floor).toBe('pc');
  });

  describe('across three members', () => {
    it('phone A holds: B and the PC get busy; everyone saw the same holder', async () => {
      const { hub, pc, a, b } = await setup2();
      await hub.handle(a, { t: 'floor_request' });
      for (const c of [pc, a, b]) expect(c.take()).toEqual([{ t: 'floor', holder: a.id }]);
      await hub.handle(b, { t: 'floor_request' });
      expect(b.take()).toEqual([{ t: 'busy' }]);
      await hub.handle(pc, { t: 'floor_request' });
      expect(pc.take()).toEqual([{ t: 'busy' }]);
      expect(a.take()).toEqual([]);
      // Non-holders releasing does nothing
      await hub.handle(b, { t: 'floor_release' });
      await hub.handle(pc, { t: 'floor_release' });
      for (const c of [pc, a, b]) expect(c.take()).toEqual([]);
      expect(room(hub)?.floor).toBe(a.id);
      await hub.handle(a, { t: 'floor_release' });
      for (const c of [pc, a, b]) expect(c.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
      // and B can take it now
      await hub.handle(b, { t: 'floor_request' });
      for (const c of [pc, a, b]) expect(c.take()).toEqual([{ t: 'floor', holder: b.id }]);
    });

    it('the PC holds: both phones get busy', async () => {
      const { hub, pc, a, b } = await setup2();
      await hub.handle(pc, { t: 'floor_request' });
      for (const c of [pc, a, b]) expect(c.take()).toEqual([{ t: 'floor', holder: 'pc' }]);
      await hub.handle(a, { t: 'floor_request' });
      await hub.handle(b, { t: 'floor_request' });
      expect(a.take()).toEqual([{ t: 'busy' }]);
      expect(b.take()).toEqual([{ t: 'busy' }]);
      expect(pc.take()).toEqual([]);
    });

    it('holder A leaving releases the floor for the PC and B', async () => {
      const { hub, pc, a, b } = await setup2();
      await hub.handle(a, { t: 'floor_request' });
      pc.take();
      b.take();
      hub.disconnect(a);
      expect(pc.take()[0]).toEqual({ t: 'floor', holder: 'idle' });
      expect(b.take()[0]).toEqual({ t: 'floor', holder: 'idle' });
    });

    it('non-holder A leaving leaves the floor with B', async () => {
      const { hub, pc, a, b } = await setup2();
      await hub.handle(b, { t: 'floor_request' });
      pc.take();
      b.take();
      hub.disconnect(a);
      expect(pc.take().map((m) => m.t)).toEqual(['peer_left', 'roster']);
      expect(b.take().map((m) => m.t)).toEqual(['roster']);
      expect(room(hub)?.floor).toBe(b.id);
    });

    it('PC leaving while phone A holds the floor releases it (nobody could relay A any more)', async () => {
      vi.useFakeTimers();
      try {
        const { hub, pc, a, b } = await setup2(makeHub({ maxTxMs: 1000 }));
        await hub.handle(a, { t: 'floor_request' });
        a.take();
        b.take();
        hub.disconnect(pc);
        for (const p of [a, b]) {
          expect(p.take()).toEqual([
            { t: 'floor', holder: 'idle' },
            { t: 'peer_left', id: 'pc' },
            { t: 'roster', members: [phoneForPhones(a, 1), phoneForPhones(b, 2)] },
          ]);
        }
        expect(room(hub)?.floor).toBe('idle');
        expect(vi.getTimerCount()).toBe(0);
        // A's late release is a no-op
        await hub.handle(a, { t: 'floor_release' });
        expect(a.take()).toEqual([]);
        expect(b.take()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('PC leaving with a single phone holding the floor releases it too', async () => {
      const { hub, pc, phone } = await setup();
      await hub.handle(phone, { t: 'floor_request' });
      phone.take();
      hub.disconnect(pc);
      expect(phone.take()[0]).toEqual({ t: 'floor', holder: 'idle' });
      // and the returning PC's welcome shows idle
      const pc2 = new FakeConn('pc2');
      await host(hub, pc2);
      expect(pc2.take()[0]).toMatchObject({ t: 'welcome', floor: 'idle' });
    });

    it('PC replaced by a new PC connection while a phone holds the floor: released before peer_left', async () => {
      const { hub, pc, a, b } = await setup2();
      await hub.handle(a, { t: 'floor_request' });
      for (const c of [pc, a, b]) c.take();
      await host(hub, new FakeConn('pc2'));
      expect(pc.take()).toEqual([{ t: 'kicked', reason: 'replaced' }]);
      expect(b.take().map((m) => m.t)).toEqual(['floor', 'peer_left', 'roster', 'peer_joined', 'roster']);
    });

    it('the max TX timeout applies to a phone holder too and reaches all three', async () => {
      vi.useFakeTimers();
      try {
        const { hub, pc, a, b } = await setup2(makeHub({ maxTxMs: 1000 }));
        await hub.handle(b, { t: 'floor_request' });
        for (const c of [pc, a, b]) c.take();
        vi.advanceTimersByTime(1000);
        for (const c of [pc, a, b]) expect(c.take()).toEqual([{ t: 'floor', holder: 'idle' }]);
      } finally {
        vi.useRealTimers();
      }
    });
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
      expect(pc.take()).toEqual([{ t: 'floor', holder: phone.id }]);
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
  const offer = { kind: 'offer', sdp: 'v=0 offer' } as const;
  const answer = { kind: 'answer', sdp: 'v=0 answer' } as const;
  const cand = { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };

  it('relays offer/answer/ice between the PC and a phone, tagged with from and the cid', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'signal', to: phone.id, cid: CID, data: offer });
    expect(phone.take()).toEqual([{ t: 'signal', from: 'pc', cid: CID, data: offer }]);
    expect(pc.take()).toEqual([]);
    await hub.handle(phone, { t: 'signal', cid: CID, data: answer });
    expect(pc.take()).toEqual([{ t: 'signal', from: phone.id, cid: CID, data: answer }]);
    await hub.handle(phone, { t: 'signal', cid: CID, data: { kind: 'ice', candidate: cand } });
    await hub.handle(phone, { t: 'signal', cid: CID, data: { kind: 'ice', candidate: null } });
    expect(pc.take()).toEqual([
      { t: 'signal', from: phone.id, cid: CID, data: { kind: 'ice', candidate: cand } },
      { t: 'signal', from: phone.id, cid: CID, data: { kind: 'ice', candidate: null } },
    ]);
  });

  it('the PC addresses each phone by `to`; only that phone gets it', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(pc, { t: 'signal', to: a.id, cid: 'cid-for-a', data: offer });
    await hub.handle(pc, { t: 'signal', to: b.id, cid: 'cid-for-b', data: offer });
    expect(a.take()).toEqual([{ t: 'signal', from: 'pc', cid: 'cid-for-a', data: offer }]);
    expect(b.take()).toEqual([{ t: 'signal', from: 'pc', cid: 'cid-for-b', data: offer }]);
    expect(pc.take()).toEqual([]);
  });

  it('each phone reaches the PC tagged with its own id, and never the other phone', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'signal', cid: 'cid-from-a', data: answer });
    await hub.handle(b, { t: 'signal', cid: 'cid-from-b', data: answer });
    expect(pc.take()).toEqual([
      { t: 'signal', from: a.id, cid: 'cid-from-a', data: answer },
      { t: 'signal', from: b.id, cid: 'cid-from-b', data: answer },
    ]);
    expect(a.take()).toEqual([]);
    expect(b.take()).toEqual([]);
  });

  it('a phone cannot address the other phone: `to` from a phone is ignored and it goes to the PC', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'signal', to: b.id, cid: CID, data: offer });
    expect(b.take()).toEqual([]);
    expect(pc.take()).toEqual([{ t: 'signal', from: a.id, cid: CID, data: offer }]);
  });

  it('a spoofed `from` is overwritten by the server', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'signal', from: b.id, cid: CID, data: answer });
    await hub.handle(a, { t: 'signal', from: 'pc', cid: CID, data: answer });
    expect(pc.take()).toEqual([
      { t: 'signal', from: a.id, cid: CID, data: answer },
      { t: 'signal', from: a.id, cid: CID, data: answer },
    ]);
    await hub.handle(pc, { t: 'signal', to: a.id, from: b.id, cid: CID, data: offer });
    expect(a.take()).toEqual([{ t: 'signal', from: 'pc', cid: CID, data: offer }]);
  });

  it('PC signals without `to`, to an unknown id, to itself or to a device id are dropped', async () => {
    const { hub, pc, a, b } = await setup2();
    for (const to of [undefined, 'mUnknownUnknown', 'pc', DEV_A]) {
      const msg: Record<string, unknown> = { t: 'signal', cid: CID, data: offer };
      if (to) msg.to = to;
      await hub.handle(pc, msg);
    }
    for (const c of [pc, a, b]) expect(c.take()).toEqual([]);
  });

  it('strips unknown fields from relayed signals', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'signal', to: phone.id, cid: CID, data: { kind: 'offer', sdp: 'x', evil: 1 }, extra: true });
    expect(phone.take()).toEqual([{ t: 'signal', from: 'pc', cid: CID, data: { kind: 'offer', sdp: 'x' } }]);
  });

  it('a signal with no peer is dropped silently', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await host(hub, pc);
    pc.take();
    await hub.handle(pc, { t: 'signal', to: 'mUnknownUnknown', cid: CID, data: offer });
    expect(pc.take()).toEqual([]);
    // A phone with no PC in the room
    const { hub: hub2, pc: pc2, phone } = await setup();
    hub2.disconnect(pc2);
    phone.take();
    await hub2.handle(phone, { t: 'signal', cid: CID, data: answer });
    expect(phone.take()).toEqual([]);
  });

  it('signals do not cross rooms, even when addressed to a phone id in another room', async () => {
    const { hub, pc } = await setup();
    const pcB = new FakeConn('pcB');
    const phoneB = new FakeConn('phoneB');
    await host(hub, pcB, ROOM2);
    await join(hub, phoneB, DEV_B, ROOM2);
    phoneB.take();
    pcB.take();
    await hub.handle(pc, { t: 'signal', to: phoneB.id, cid: CID, data: offer });
    expect(phoneB.take()).toEqual([]);
    expect(pcB.take()).toEqual([]);
  });
});

describe('names', () => {
  const rosterOf = (c: FakeConn) => c.take().filter((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }>[];

  it('the PC names itself and each phone; everyone gets a roster with the names', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(pc, { t: 'names', names: { pc: 'Pit wall', [a.id]: 'Emma', [b.id]: 'Lou' } });
    expect(rosterOf(pc)).toEqual([
      { t: 'roster', members: [pcInfo('Pit wall'), phoneForPc(a, 1, DEV_A, 'Emma'), phoneForPc(b, 2, DEV_B, 'Lou')] },
    ]);
    const forPhones = { t: 'roster', members: [pcInfo('Pit wall'), phoneForPhones(a, 1, 'Emma'), phoneForPhones(b, 2, 'Lou')] };
    expect(a.take()).toEqual([forPhones]);
    expect(b.take()).toEqual([forPhones]);
    // A late joiner's welcome has them too
    hub.disconnect(b);
    const b2 = new FakeConn('b2');
    await join(hub, b2, DEV_B);
    const w = b2.take()[0] as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.members.find((m) => m.id === 'pc')?.name).toBe('Pit wall');
    expect(w.members.find((m) => m.id === a.id)?.name).toBe('Emma');
    // B2 is a new member id, so the old name doesn't carry over until the PC re-sends it
    expect(w.members.find((m) => m.id === b2.id)?.name).toBeNull();
  });

  it('names are trimmed, whitespace collapsed and control characters removed', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'names', names: { pc: '  Pit   wall  ', [phone.id]: 'Em\u0007ma  Lou\u007f' } });
    const [r] = rosterOf(phone);
    expect(r.members.map((m) => m.name)).toEqual(['Pit wall', 'Emma Lou']);
    // Tabs/newlines become spaces; other control characters are removed
    await hub.handle(pc, { t: 'names', names: { [phone.id]: 'Emma\tLou' } });
    expect(rosterOf(phone)[0].members[1].name).toBe('Emma Lou');
  });

  it('24 characters is fine', async () => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'names', names: { [phone.id]: 'x'.repeat(24) } });
    expect(rosterOf(phone)[0].members[1].name).toBe('x'.repeat(24));
  });

  it.each([
    ['too long (25)', 'x'.repeat(25)],
    ['empty', ''],
    ['only spaces', '    '],
    ['only control characters', '\u0001\u0002'],
    ['a number', 42],
    ['null', null],
    ['an object', { name: 'x' }],
  ])('a bad name (%s) rejects the whole message, and no roster is sent', async (_label, bad) => {
    const { hub, pc, phone } = await setup();
    await hub.handle(pc, { t: 'names', names: { pc: 'Pit wall', [phone.id]: bad } });
    expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
    expect(phone.take()).toEqual([]);
    expect(room(hub)?.names).toEqual({});
  });

  it.each([
    ['too short', 'abc'],
    ['spaces', 'm abc def'],
    ['65 chars', 'm'.repeat(65)],
  ])('a bad member id key (%s) is a bad message', async (_label, key) => {
    const { hub, pc } = await setup();
    await hub.handle(pc, { t: 'names', names: { [key]: 'X' } });
    expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
  });

  it('more than 1 + 10 * MAX_PHONES entries is a bad message', async () => {
    const { hub, pc } = await setup();
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`mId${String(i).padStart(4, '0')}`, `N${i}`]));
    await hub.handle(pc, { t: 'names', names: many(1 + MAX_PHONES * 10 + 1) });
    expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
    await hub.handle(pc, { t: 'names', names: many(1 + MAX_PHONES * 10) });
    expect(pc.take().map((m) => m.t)).toEqual(['roster']);
  });

  it('only the PC can set names: a phone sending names is ignored', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(a, { t: 'names', names: { pc: 'Hacked', [a.id]: 'Me', [b.id]: 'You' } });
    for (const c of [pc, a, b]) expect(c.take()).toEqual([]);
    expect(room(hub)?.names).toEqual({});
  });

  it('names for non-members (unknown ids, device ids, phones in other rooms) are dropped', async () => {
    const { hub, pc, phone } = await setup();
    const pcB = new FakeConn('pcB');
    const other = new FakeConn('other');
    await host(hub, pcB, ROOM2);
    await join(hub, other, DEV_B, ROOM2);
    other.take();
    await hub.handle(pc, {
      t: 'names',
      names: { pc: 'Pit wall', [phone.id]: 'Emma', mGhostGhostGh: 'Ghost', [DEV_A]: 'ByDevice', [other.id]: 'Elsewhere' },
    });
    expect(room(hub)?.names).toEqual({ pc: 'Pit wall', [phone.id]: 'Emma' });
    const [r] = rosterOf(phone);
    expect(r.members.map((m) => m.name)).toEqual(['Pit wall', 'Emma']);
    expect(JSON.stringify(phone.all)).not.toContain('Ghost');
    expect(JSON.stringify(phone.all)).not.toContain('Elsewhere');
    expect(other.take()).toEqual([]);
    expect(room(hub, ROOM2)?.names).toEqual({});
  });

  it('a later names message replaces the earlier one wholesale', async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(pc, { t: 'names', names: { pc: 'Pit wall', [a.id]: 'Emma', [b.id]: 'Lou' } });
    await hub.handle(pc, { t: 'names', names: { [b.id]: 'Lou' } });
    expect(room(hub)?.names).toEqual({ [b.id]: 'Lou' });
  });

  it("a member's name is dropped when it leaves (and isn't inherited by the next phone)", async () => {
    const { hub, pc, a, b } = await setup2();
    await hub.handle(pc, { t: 'names', names: { pc: 'Pit wall', [a.id]: 'Emma', [b.id]: 'Lou' } });
    hub.disconnect(a);
    expect(room(hub)?.names).toEqual({ pc: 'Pit wall', [b.id]: 'Lou' });
    const c = new FakeConn('c');
    await join(hub, c, DEV_C);
    const w = c.take()[0] as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.members.find((m) => m.id === c.id)).toEqual({ id: c.id, role: 'phone', name: null, slot: 1 });
    // The PC's own name goes when the PC leaves
    hub.disconnect(pc);
    expect(room(hub)?.names).toEqual({ [b.id]: 'Lou' });
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
    const p = host(hub, pc);
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
    await host(hub, pc);
    pc.take();
    gated = true;
    const phone = new FakeConn('phone');
    const p = join(hub, phone, DEV_A);
    await Promise.resolve();
    hub.disconnect(phone);
    release();
    await p;
    expect(phone.msgs).toEqual([]);
    expect(pc.msgs).toEqual([]);
    expect(room(hub)?.phones.size).toBe(0);
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
    await host(hub, pc);
    await join(hub, phone, DEV_A);
    pc.take();
    phone.take();
    const id = phone.id;
    gated = true;
    const p = join(hub, phone, DEV_A);
    await Promise.resolve();
    hub.disconnect(phone);
    expect(pc.take()).toEqual([
      { t: 'peer_left', id },
      { t: 'roster', members: [pcInfo()] },
    ]);
    release();
    await p;
    expect(phone.msgs).toEqual([]);
    expect(pc.msgs).toEqual([]);
    expect(room(hub)?.phones.size).toBe(0);
  });

  it('a second join while the first is pending is ignored (no double welcome)', async () => {
    const { hub, release } = gatedHub();
    const pc = new FakeConn('pc');
    const hosted = host(hub, pc);
    release();
    await hosted;
    const phone = new FakeConn('phone');
    const p1 = join(hub, phone, DEV_A);
    const p2 = join(hub, phone, DEV_A);
    release();
    await Promise.all([p1, p2]);
    expect(phone.msgs.filter((m) => m.t === 'welcome')).toHaveLength(1);
  });

  it('a room that fills up while a phone waits for ICE gives it room_full', async () => {
    let gated = false;
    let release!: () => void;
    const hub = makeHub({
      getIceServers: async () => {
        if (gated) await new Promise<void>((r) => (release = r));
        return ICE;
      },
    });
    await host(hub, new FakeConn('pc'));
    await join(hub, new FakeConn('a'), DEV_A);
    gated = true;
    const c = new FakeConn('c');
    const p = join(hub, c, DEV_C);
    await Promise.resolve();
    gated = false;
    await join(hub, new FakeConn('b'), DEV_B);
    release();
    await p;
    expect(c.take()).toEqual([{ t: 'error', code: 'room_full' }]);
    expect(room(hub)?.phones.size).toBe(2);
  });
});

describe('refreshIce', () => {
  it('sends fresh ICE servers to every member of every room', async () => {
    let n = 0;
    const hub = makeHub({ getIceServers: async () => [{ urls: `turn:t.invalid?v=${n++}` }] });
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    const phone2 = new FakeConn('phone2');
    const pcB = new FakeConn('pcB');
    await host(hub, pc);
    await join(hub, phone, DEV_A);
    await join(hub, phone2, DEV_B);
    await host(hub, pcB, ROOM2);
    for (const c of [pc, phone, phone2, pcB]) c.take();
    await hub.refreshIce();
    const fresh = { t: 'ice', iceServers: [{ urls: 'turn:t.invalid?v=4' }] };
    for (const c of [pc, phone, phone2, pcB]) expect(c.take()).toEqual([fresh]);
  });

  it('skips the ICE fetch when nobody is connected, and does not reach departed or non-members', async () => {
    const getIceServers = vi.fn(async () => ICE);
    const hub = makeHub({ getIceServers });
    await hub.refreshIce();
    expect(getIceServers).not.toHaveBeenCalled();
    const { pc, a, b } = await setup2(hub);
    const stranger = new FakeConn('stranger');
    await join(hub, stranger, DEV_C, ROOM2); // no_host
    const refused = new FakeConn('refused');
    await join(hub, refused, DEV_C); // room_full
    stranger.take();
    refused.take();
    hub.disconnect(a);
    pc.take();
    b.take();
    await hub.refreshIce();
    expect(pc.take()).toEqual([{ t: 'ice', iceServers: ICE }]);
    expect(b.take()).toEqual([{ t: 'ice', iceServers: ICE }]);
    expect(a.msgs).toEqual([]);
    expect(stranger.msgs).toEqual([]);
    expect(refused.msgs).toEqual([]);
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
    await host(hub, pc);
    expect(pc.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
    expect(pc.closed).toBe(1);
    expect(hub.rooms.size).toBe(0);

    const phone = new FakeConn('phone');
    await join(hub, phone, DEV_A, ROOM, { key: 'wrong' });
    expect(phone.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
    expect(phone.closed).toBe(1);
  });

  it('a wrong key of the same length is still rejected', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    await host(hub, pc, ROOM, { key: KEY.replace(/.$/, 'X') });
    expect(pc.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
  });

  it('accepts the right key on both sides', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    const phone = new FakeConn('phone');
    await host(hub, pc, ROOM, { key: KEY });
    await join(hub, phone, DEV_A, ROOM, { key: KEY });
    expect(pc.take().map((m) => m.t)).toEqual(['welcome', 'roster', 'peer_joined', 'roster']);
    expect(phone.take().map((m) => m.t)).toEqual(['welcome', 'roster']);
  });

  it('a server without a key accepts clients that send one anyway', async () => {
    const hub = makeHub();
    const pc = new FakeConn('pc');
    await host(hub, pc, ROOM, { key: 'whatever' });
    expect(pc.take()[0].t).toBe('welcome');
  });

  it('a non-string key is a bad message', async () => {
    const hub = makeHub({ accessKey: KEY });
    const pc = new FakeConn('pc');
    await host(hub, pc, ROOM, { key: 42 });
    expect(pc.take()).toEqual([{ t: 'error', code: 'bad_message' }]);
  });
});

describe('pairing codes', () => {
  const KEY = 'secret-key-0123456789';

  async function pcWithCode(hub: RoomHub) {
    const pc = new FakeConn('pc');
    await host(hub, pc, ROOM, { key: KEY });
    pc.take();
    const code = await newCode(hub, pc);
    return { pc, code };
  }

  async function newCode(hub: RoomHub, pc: FakeConn) {
    await hub.handle(pc, { t: 'pair_create' });
    const msg = pc.take().find((m) => m.t === 'pair_code') as Extract<ServerMsg, { t: 'pair_code' }>;
    expect(msg.code).toMatch(/^\d{6}$/);
    expect(msg.expiresInMs).toBe(10 * 60_000);
    return msg.code;
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
    const fresh = await newCode(hub, pc);
    const phone = new FakeConn('phone');
    await hub.handle(phone, { t: 'pair_claim', code });
    // (1-in-a-million chance the new random code equals the old one, in which case it's valid)
    const expected = fresh === code ? { t: 'paired', room: ROOM, key: KEY } : { t: 'error', code: 'bad_code' };
    expect(phone.take()).toEqual([expected]);
  });

  it('only the PC can create codes', async () => {
    const hub = makeHub({ accessKey: KEY });
    await pcWithCode(hub);
    const phone = new FakeConn('phone');
    await join(hub, phone, DEV_A, ROOM, { key: KEY });
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

  it('a code works while one phone is already connected (the second seat)', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { pc, code } = await pcWithCode(hub);
    await join(hub, new FakeConn('a'), DEV_A, ROOM, { key: KEY });
    pc.take();
    const second = new FakeConn('second');
    await hub.handle(second, { t: 'pair_claim', code });
    expect(second.take()).toEqual([{ t: 'paired', room: ROOM, key: KEY }]);
    await join(hub, second, DEV_B, ROOM, { key: KEY });
    expect(second.take()[0]).toMatchObject({ t: 'welcome', role: 'phone' });
  });

  it('on a full room: room_full, the code is not used up and the attempt does not count as a wrong guess', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { pc, code } = await pcWithCode(hub);
    const a = new FakeConn('a');
    const b = new FakeConn('b');
    await join(hub, a, DEV_A, ROOM, { key: KEY });
    await join(hub, b, DEV_B, ROOM, { key: KEY });
    const third = new FakeConn('third');
    // More tries than the per-connection limit (5): none of them count
    for (let i = 0; i < 7; i++) {
      await hub.handle(third, { t: 'pair_claim', code });
      expect(third.take()).toEqual([{ t: 'error', code: 'room_full' }]);
    }
    expect(third.closed).toBe(0);
    // A seat frees up: the same code, on the same connection, now works
    await hub.handle(pc, { t: 'kick', id: b.id });
    await hub.handle(third, { t: 'pair_claim', code });
    expect(third.take()).toEqual([{ t: 'paired', room: ROOM, key: KEY }]);
    // ...once
    await hub.handle(new FakeConn('x'), { t: 'pair_claim', code });
  });

  it('a wrong code on a full room is still bad_code (room_full does not leak for guesses)', async () => {
    const hub = makeHub({ accessKey: KEY });
    const { code } = await pcWithCode(hub);
    await join(hub, new FakeConn('a'), DEV_A, ROOM, { key: KEY });
    await join(hub, new FakeConn('b'), DEV_B, ROOM, { key: KEY });
    const wrong = code === '000000' ? '000001' : '000000';
    const g = new FakeConn('g');
    await hub.handle(g, { t: 'pair_claim', code: wrong });
    expect(g.take()).toEqual([{ t: 'error', code: 'bad_code' }]);
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

async function pcAlone(hub: RoomHub, code = ROOM) {
  const pc = new FakeConn('pc');
  await host(hub, pc, code);
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

  it('is no longer skipped when a phone is already in the room (the PC filters out phones that are there)', async () => {
    const push = new FakePusher();
    push.result = { sent: 1, gone: [] };
    const { hub, pc } = await setup(makeHub({ push }));
    await hub.handle(pc, { t: 'announce', subs: [SUB_B] });
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].subs).toEqual([SUB_B]);
    expect(pc.take()).toEqual([{ t: 'announced', sent: 1, gone: [] }]);
  });

  it('with one phone present, the announce starts the room cooldown like any other', async () => {
    const push = new FakePusher();
    const { hub, pc, phone } = await setup(makeHub({ push }));
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    hub.disconnect(phone);
    pc.take();
    await hub.handle(pc, { t: 'announce', subs: [SUB_A] });
    expect(push.calls).toHaveLength(1);
    expect(pc.take()).toEqual([{ t: 'announced', sent: 0, gone: [] }]);
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
    await host(hub, pc);
    const phone = new FakeConn('phone');
    await join(hub, phone, DEV_A);
    hub.disconnect(pc); // phone alone in the room
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
    await host(hub, bad, ROOM, { key: 'wrong' });
    expect(bad.take()).toEqual([{ t: 'error', code: 'unauthorized' }]);
    await hub.handle(bad, { t: 'announce', subs: [SUB_A] });
    expect(bad.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    expect(push.calls).toHaveLength(0);
  });

  it('a host refused with update_required cannot announce', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const old = new FakeConn('old');
    await hub.handle(old, { t: 'host', room: ROOM });
    old.take();
    await hub.handle(old, { t: 'announce', subs: [SUB_A] });
    expect(old.take()).toEqual([{ t: 'error', code: 'not_in_room' }]);
    expect(push.calls).toHaveLength(0);
  });

  it('a PC replaced by a newer PC cannot announce any more', async () => {
    const push = new FakePusher();
    const hub = makeHub({ push });
    const old = await pcAlone(hub);
    const fresh = new FakeConn('fresh');
    await host(hub, fresh);
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
      ['one bad sub among good ones', [SUB_A, { endpoint: 'http://x.test/', keys: SUB_A.keys }]],
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
        await host(hub, pc, ROOM2);
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

    it('skipped announces (cooldown) do not use up the per-connection allowance', async () => {
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
