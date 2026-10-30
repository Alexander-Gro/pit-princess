import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@pit/shared/theme.css';
import './style.css';
import {
  NOISE_MODES,
  RadioFx,
  RemoteAudio,
  pingText,
  generateDeviceId,
  isDeviceId,
  PC_ID,
  PushDirectory,
  CC_SOUND_NAMES,
  type CcSoundName,
  type PushSub,
  type MemberInfo,
  RadioLink,
  RevLights,
  PAIR_CODE_RE,
  ROOM_CODE_RE,
  TxProcessor,
  b64ToBytes,
  isFxFileMsg,
  micConstraints,
  readLevel,
  type LinkState,
  type NoiseMode,
} from '@pit/shared';
import { createRadioContext, prepareRnnoise } from '@pit/shared/noise';
import { initPush, renewSubscription, syncOwnEntry } from './push.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ptt = $<HTMLButtonElement>('ptt');
const pttText = $('ptt-text');
const pttSub = $('ptt-sub');
const footMsg = $('foot-msg');
const fxStatus = $('fx-status');
const meter = new RevLights($('meter'), 15);

// The room code lives in the URL fragment so it never reaches server logs. It is also
// remembered, because a home-screen PWA launches at start_url without the fragment.
const ROOM_KEY = 'pit-princess-room';
const room = (() => {
  const raw = new URLSearchParams(location.hash.slice(1)).get('room');
  const fromHash = raw && ROOM_CODE_RE.test(raw) ? raw : null;
  try {
    if (fromHash) localStorage.setItem(ROOM_KEY, fromHash);
    return fromHash ?? localStorage.getItem(ROOM_KEY) ?? raw ?? '';
  } catch {
    return fromHash ?? raw ?? '';
  }
})();

// Server access key (only for servers that set ACCESS_KEY), handled like the room code
const ACCESS_KEY_KEY = 'pit-princess-access-key';
const accessKey = (() => {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('key');
  try {
    if (fromHash) localStorage.setItem(ACCESS_KEY_KEY, fromHash);
    return fromHash ?? localStorage.getItem(ACCESS_KEY_KEY) ?? '';
  } catch {
    return fromHash ?? '';
  }
})();

// Identifies this phone across reconnects, so it keeps its seat and the name the PC gave it
const DEVICE_KEY = 'pit-princess-device';
const device = (() => {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (isDeviceId(saved)) return saved;
    const fresh = generateDeviceId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return generateDeviceId();
  }
})();

/** A random id for the notification directory, so other phones never see our device id */
const PUSH_ID_KEY = 'pit-princess-push-id';
const pushId = (() => {
  try {
    const saved = localStorage.getItem(PUSH_ID_KEY);
    if (isDeviceId(saved)) return saved;
    const fresh = generateDeviceId();
    localStorage.setItem(PUSH_ID_KEY, fresh);
    return fresh;
  } catch {
    return generateDeviceId();
  }
})();

/** Small localStorage helpers that never throw (private mode, full storage) */
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// The name the PC gave us, so the other phone still sees it while the PC is off
const NAME_KEY = 'pit-princess-name';

// The room's notification directory. Kept per room code, so after "New code" / re-pairing an
// old room's phones are forgotten.
const DIR_KEY = `pit-princess-dir:${room}`;
const dir = (() => {
  try {
    return new PushDirectory(JSON.parse(load(DIR_KEY) ?? '[]'));
  } catch {
    return new PushDirectory();
  }
})();

function dirChanged(): void {
  store(DIR_KEY, JSON.stringify(dir.toJSON()));
  link?.shareDir(dir.toJSON());
}

/** Merge another device's copy of the directory (relayed by the server). */
function onDir(entries: unknown[]): void {
  if (!dir.merge(entries)) return;
  dirChanged();
  // Someone marked our own entry off (the push service said it's gone): renew it
  if (dir.get(pushId)?.sub === null) void ownEntryWentOff();
}

/** Push ids of phones that are here with the app on screen; everyone else gets pinged */
function activePushIds(): (string | undefined)[] {
  return (link?.getState().members ?? []).filter((m) => !m.away).map((m) => m.pushId);
}

/** Our entry was marked off by someone else (the push service said our endpoint is gone). */
async function ownEntryWentOff(): Promise<void> {
  const sub = await renewSubscription();
  if (sub) publishOwnSub(sub);
}

/** Our own subscription (or "off") into the directory, shared with everyone */
function publishOwnSub(sub: PushSub | null): void {
  if (!sub && !dir.get(pushId)) return; // never subscribed: nothing to turn off
  if (dir.set(pushId, sub)) dirChanged();
}

// Crew Chief bleeps come from the PC; keep a copy so phone-to-phone (PC off) sounds the same
const CC_KEY = 'pit-princess-cc:';
function cachedSounds(): Partial<Record<CcSoundName, ArrayBuffer>> {
  const out: Partial<Record<CcSoundName, ArrayBuffer>> = {};
  for (const name of CC_SOUND_NAMES) {
    const b64 = load(CC_KEY + name);
    if (!b64) continue;
    try {
      out[name] = b64ToBytes(b64).buffer;
    } catch {
      /* corrupt: skip */
    }
  }
  return out;
}

let link: RadioLink | null = null;
let remotes: RemoteAudio | null = null;
let aloneSince = 0;
let pingMsgTimer: ReturnType<typeof setTimeout> | null = null;
let fx: RadioFx | null = null;
let micAnalyser: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let tx: TxProcessor | null = null;
let micGeneration = 0;
/** Copy of the mic track that is sent in the raw path; the original stays on for analysis */
let sentClone: MediaStreamTrack | null = null;

const NOISE_KEY = 'pit-princess-noise';
const NOISE_LABEL: Record<NoiseMode, string> = { strong: 'Strong (AI)', standard: 'Standard', off: 'Off' };
let noiseMode: NoiseMode = (() => {
  try {
    const v = localStorage.getItem(NOISE_KEY) as NoiseMode | null;
    return v && NOISE_MODES.includes(v) ? v : 'strong';
  } catch {
    return 'strong';
  }
})();
let wakeLock: { release(): Promise<void> } | null = null;
/** Pointer holding the PTT tile; 'key' for the space bar. Other touches are ignored. */
let pressing: number | 'key' | null = null;

function setTile(id: string, value: string, flag: string | null): void {
  const tile = $(`t-${id}`);
  $(`v-${id}`).textContent = value;
  tile.className = `tile${flag ? ` flag-${flag}` : ''}`;
}

function setPtt(text: string, sub: string, cls: string): void {
  pttText.textContent = text;
  pttSub.textContent = sub;
  ptt.className = `tile ptt ${cls}`;
}

if (!ROOM_CODE_RE.test(room)) {
  // A home-screen app on iOS starts without the QR link's room and key, and with storage
  // separate from Safari's, so it pairs itself with a short code shown on the PC.
  showPairing();
} else {
  setTile('link', 'READY', null);
  ptt.addEventListener('click', connect, { once: true });
}

function showPairing(): void {
  ptt.hidden = true;
  setTile('link', 'NOT PAIRED', 'amber');
  const form = $<HTMLFormElement>('pair');
  const input = $<HTMLInputElement>('pair-code');
  const msg = $('pair-msg');
  form.hidden = false;
  input.focus();
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value;
    if (!PAIR_CODE_RE.test(code)) {
      msg.textContent = 'Enter the 6 digits shown on the PC';
      return;
    }
    msg.textContent = 'Pairing…';
    try {
      const { room: newRoom, key } = await claimPairCode(code);
      try {
        localStorage.setItem(ROOM_KEY, newRoom);
        localStorage.setItem(ACCESS_KEY_KEY, key);
      } catch {
        /* storage blocked: the URL below still carries them */
      }
      location.hash = `room=${newRoom}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
      location.reload();
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
      input.select();
    }
  });
}

function claimPairCode(code: string): Promise<{ room: string; key: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Server not responding, try again'));
    }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'pair_claim', code }));
    ws.onmessage = (ev) => {
      let m: { t?: string; code?: string; room?: string; key?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      clearTimeout(timer);
      ws.close();
      if (m.t === 'paired' && m.room && ROOM_CODE_RE.test(m.room)) resolve({ room: m.room, key: m.key ?? '' });
      else if (m.code === 'rate_limited') reject(new Error('Too many wrong codes, wait a few minutes'));
      else if (m.code === 'room_full')
        reject(new Error('Two phones are already connected. Kick one on the PC, then try this code again'));
      else reject(new Error('Wrong or expired code. Make a new one on the PC'));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Could not reach the server'));
    };
  });
}

async function connect(): Promise<void> {
  setPtt('…', 'Requesting microphone', 'disabled');
  // 48 kHz so the RNNoise model can run
  const ctx = createRadioContext();
  // iOS plays nothing from ctx.destination while the mic is open, so route through an <audio> element
  fx = new RadioFx(ctx, { output: 'element' });
  fx.unlock();

  try {
    await openMic();
  } catch (e) {
    setPtt('NO MIC', 'Allow microphone access and reload', 'flag-amber');
    footMsg.textContent = String(e instanceof Error ? e.message : e);
    return;
  }

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  remotes = new RemoteAudio(fx.ctx);
  void fx.loadSounds(cachedSounds()).then((loaded) => {
    if (loaded.length) fxStatus.textContent = 'CC sounds';
  });
  link = new RadioLink({
    role: 'phone',
    wsUrl,
    room,
    accessKey,
    device,
    name: load(NAME_KEY) ?? undefined,
    pushId,
    fx,
    onChange: render,
    onRemoteStream: (id, stream) => {
      if (!fx || !remotes) return;
      const node = remotes.set(id, stream);
      if (node) {
        fx.addRemote(id, node);
        applyPhonesHear();
      } else fx.removeRemote(id);
    },
    // On every (re)join, share our copy of the directory and make sure our own entry is current
    onWelcome: () => {
      link?.shareDir(dir.toJSON());
      void syncOwnEntry();
    },
    onDir: (entries) => onDir(entries),
    onData: (msg, from) => {
      // Sound files only from the PC (the other phone has no business sending them)
      if (!isFxFileMsg(msg) || !fx || from !== PC_ID) return;
      store(CC_KEY + msg.name, msg.b64);
      const bytes = b64ToBytes(msg.b64);
      void fx.loadSounds({ [msg.name]: bytes.buffer }).then(() => {
        fxStatus.textContent = 'CC sounds';
      });
    },
    pingTargets: () => dir.absent(activePushIds()),
    onPinged: (r) => {
      if (r.gone.length && dir.dropEndpoints(r.gone)) dirChanged();
      showPingMsg(pingText(r));
    },
  });
  link.setMicTrack(tx?.track ?? sentClone);
  link.start();
  render(link.getState());
  bindPtt();
  bindNoiseToggle();
  initPush(publishOwnSub, $<HTMLButtonElement>('notify'));
  // The "still alone?" hint depends on time, not on link changes
  setInterval(() => link && render(link.getState()), 30_000);
  // Back online or back on screen: reconnect now rather than after the backoff
  window.addEventListener('online', () => link?.nudge());
  void requestWakeLock();
  requestAnimationFrame(meterLoop);
}

/**
 * (Re)open the mic for the current noise mode. 'strong' sends the mic through RNNoise;
 * otherwise the raw track is sent, with the browser's suppression on or off.
 */
async function openMic(): Promise<void> {
  if (!fx) return;
  const ctx = fx.ctx;
  const gen = ++micGeneration;
  const rnnoise = noiseMode === 'strong' ? await prepareRnnoise(ctx) : null;
  // No RNNoise on this device: fall back to the browser's own suppression
  const effective: NoiseMode = noiseMode === 'strong' && !rnnoise ? 'standard' : noiseMode;
  const constraints = micConstraints('default', effective, true);

  // Each getUserMedia call can show the permission prompt again on iOS, so the mic is only
  // opened once per launch. Changing the noise mode adjusts the open track instead.
  const open = micStream?.getAudioTracks()[0];
  let notApplied = false;
  if (micStream && open?.readyState === 'live') {
    try {
      await open.applyConstraints(constraints);
    } catch (e) {
      console.warn('[mic] applyConstraints failed, keeping current settings', e);
    }
    if (gen !== micGeneration) return;
    // Some browsers accept the call but keep the old setting; say so rather than mislabel it
    const ns = open.getSettings().noiseSuppression;
    notApplied = typeof ns === 'boolean' && ns !== constraints.noiseSuppression;
  } else {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    if (gen !== micGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = stream;
  }
  const stream = micStream!;
  const raw = stream.getAudioTracks()[0];
  // Opening the mic switches the iOS audio session, which can interrupt the context and pause playback
  fx.unlock();
  tx?.dispose();
  tx = null;
  micSource?.disconnect();
  micSource = null;

  // The raw track always stays on (it feeds RNNoise and the meter). What gets sent and keyed is
  // either the RNNoise output or a clone, so swapping paths never puts the open mic on the wire.
  raw.enabled = true;
  const oldClone = sentClone;
  sentClone = null;
  let track: MediaStreamTrack;
  if (rnnoise) {
    tx = new TxProcessor(ctx, stream, { noiseNode: rnnoise });
    tx.applySettings({ feedbackSuppression: false });
    micAnalyser = tx.analyser;
    track = tx.track;
  } else {
    track = raw.clone();
    track.enabled = false;
    sentClone = track;
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micSource = ctx.createMediaStreamSource(stream);
    micSource.connect(micAnalyser);
  }
  link?.setMicTrack(track);
  oldClone?.stop();
  renderNoise(noiseMode !== effective, notApplied);
}

function renderNoise(fellBack = false, notApplied = false): void {
  const el = $<HTMLButtonElement>('nr');
  const label = fellBack ? 'Standard (AI unavailable)' : NOISE_LABEL[noiseMode];
  el.textContent = `Noise filter: ${label}${notApplied ? ' (reopen app to apply)' : ''}`;
  el.hidden = false;
}

/** Forget this room (code, key, directory) and go back to the pairing screen. */
function forgetRoom(): void {
  store(ROOM_KEY, null);
  store(ACCESS_KEY_KEY, null);
  store(DIR_KEY, null);
  location.replace(location.pathname);
}

$('repair').addEventListener('click', () => {
  if (!confirm('Forget this room and pair again? Pairing needs the PC to be on.')) return;
  forgetRoom();
});

function bindNoiseToggle(): void {
  const el = $<HTMLButtonElement>('nr');
  el.addEventListener('click', async () => {
    noiseMode = NOISE_MODES[(NOISE_MODES.indexOf(noiseMode) + 1) % NOISE_MODES.length];
    try {
      localStorage.setItem(NOISE_KEY, noiseMode);
    } catch {
      /* private mode */
    }
    renderNoise();
    try {
      await openMic();
    } catch (e) {
      footMsg.textContent = `Mic: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

function bindPtt(): void {
  const down = (e: PointerEvent) => {
    e.preventDefault();
    if (pressing !== null) return;
    pressing = e.pointerId;
    try {
      ptt.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may already be gone */
    }
    fx?.unlock();
    link?.pttDown();
  };
  const releaseAll = (immediate = false) => {
    if (pressing === null) return;
    pressing = null;
    link?.pttUp(immediate);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId === pressing) releaseAll();
  };
  ptt.addEventListener('pointerdown', down);
  ptt.addEventListener('pointerup', up);
  ptt.addEventListener('pointercancel', up);
  ptt.addEventListener('lostpointercapture', up);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  // Space bar for testing on a laptop
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    if (pressing !== null) return;
    pressing = 'key';
    link?.pttDown();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && pressing === 'key') releaseAll();
  });
  document.addEventListener('visibilitychange', () => {
    // Timers may not run once hidden, so end TX without the tail
    // Away (backgrounded or locked) counts as gone for pings, so the other phone can call us back
    link?.setAway(document.hidden);
    if (document.hidden) releaseAll(true);
    else {
      fx?.unlock();
      void requestWakeLock();
      link?.nudge();
    }
  });
  window.addEventListener('blur', () => releaseAll());
}

/** What to call a member: the name the PC gave it, or a default */
function nameOf(m: MemberInfo | null | undefined): string {
  if (!m) return 'Someone';
  return m.name ?? (m.role === 'pc' ? 'Pit wall' : `Phone ${m.slot ?? ''}`.trim());
}

let closedHandled = false;

function showPingMsg(text: string): void {
  const el = $('ping-msg');
  el.textContent = text;
  if (pingMsgTimer) clearTimeout(pingMsgTimer);
  pingMsgTimer = setTimeout(() => (el.textContent = ''), 5000);
}

/** The PC can ask phones not to hear each other (both in one room = howl). Only while it's here. */
function applyPhonesHear(): void {
  const s = link?.getState();
  if (!s || !fx) return;
  const pcHere = s.members.some((m) => m.role === 'pc');
  for (const m of s.members) {
    if (m.role === 'phone' && m.id !== s.selfId) fx.setRemoteMuted(m.id, pcHere && !s.phonesHear);
  }
}

function render(s: LinkState): void {
  const roomFull = s.error === 'room_full';
  // The PC made a New code: this room is gone for good, so drop it and ask to pair again
  if (s.error === 'Room closed by the PC' && !closedHandled) {
    closedHandled = true;
    store(ROOM_KEY, null);
    store(ACCESS_KEY_KEY, null);
    store(DIR_KEY, null);
  }
  const me = s.members.find((m) => m.id === s.selfId);
  const pcHere = s.members.some((m) => m.role === 'pc');
  applyPhonesHear();
  // Remember the name the PC gave us for when it's off
  if (me && (me.name ?? null) !== load(NAME_KEY)) store(NAME_KEY, me.name ?? null);
  const alone = s.signaling === 'open' && !!s.selfId && !s.peerPresent;
  if (!alone) aloneSince = 0;
  else if (!aloneSince) aloneSince = Date.now();
  // Link tile
  if (roomFull) setTile('link', 'ROOM FULL', 'amber');
  else if (s.error && s.signaling === 'closed') setTile('link', 'OFF', 'red');
  else if (s.signaling !== 'open') setTile('link', 'SERVER…', 'amber');
  else if (!s.peerPresent) setTile('link', 'ALONE', 'amber');
  else if (s.peer === 'connected' && !s.allConnected) setTile('link', 'PARTIAL', 'amber');
  else if (s.peer === 'connected') setTile('link', pcHere ? 'CONNECTED' : 'PC OFF', 'green');
  else if (s.peer === 'failed') setTile('link', 'FAILED', 'red');
  else setTile('link', 'LINKING', 'amber');

  setTile('ping', s.rttMs == null ? '—' : `${s.rttMs}`, null);
  $('v-ping').insertAdjacentHTML('beforeend', s.rttMs == null ? '' : '<small style="font-size:14px"> ms</small>');
  setTile('route', s.route === 'relay' ? 'RELAY' : s.route === 'direct' ? 'DIRECT' : '—', s.route === 'relay' ? 'purple' : null);

  // PTT tile
  const fatal = !!s.error && !roomFull && s.signaling === 'closed';
  $('repair').hidden = !fatal;
  // Keep the talk tile to one word and, at most, a name
  if (roomFull) setPtt('ROOM FULL', '', 'flag-amber'); // keeps retrying; joins when a seat frees up
  else if (fatal) {
    setPtt('OFFLINE', s.error!, 'flag-red');
    footMsg.textContent = 'Reload to reconnect';
  } else if (s.tx) setPtt('TX', nameOf(me), 'flag-red pulse');
  else if (s.rx) setPtt('RX', nameOf(s.talker), 'flag-blue pulse');
  else if (s.pending) setPtt('TX', '', 'flag-amber');
  else if (s.peer === 'connected' && s.signaling === 'open') setPtt('TALK', nameOf(me), 'idle');
  else if (alone) setPtt('ALONE', '', 'disabled');
  else setPtt('LINKING', '', 'disabled');

  if (!fatal) {
    // Alone for a long time can mean the PC made a new code and this phone has an old one
    const stale = alone && Date.now() - aloneSince > 120_000;
    footMsg.textContent = stale ? 'Triple-tap to ping' : '';
    if (stale) $('repair').hidden = false;
  }
}

const levelBuf = new Float32Array(512);
function meterLoop(): void {
  const s = link?.getState();
  let level = 0;
  if (s?.tx && micAnalyser) level = readLevel(micAnalyser, levelBuf);
  else if (s?.rx && fx) level = readLevel(fx.rxAnalyser, levelBuf);
  meter.set(level);
  requestAnimationFrame(meterLoop);
}

async function requestWakeLock(): Promise<void> {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } })
    .wakeLock;
  if (!wl || document.hidden) return;
  try {
    await wakeLock?.release();
    wakeLock = await wl.request('screen');
  } catch {
    /* not supported or denied */
  }
}
