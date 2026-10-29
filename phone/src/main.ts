import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@pit/shared/theme.css';
import './style.css';
import {
  NOISE_MODES,
  RadioFx,
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

let link: RadioLink | null = null;
let fx: RadioFx | null = null;
let micAnalyser: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let tx: TxProcessor | null = null;
let micGeneration = 0;

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
  link = new RadioLink({
    role: 'phone',
    wsUrl,
    room,
    accessKey,
    fx,
    onChange: render,
    onData: (msg) => {
      if (!isFxFileMsg(msg) || !fx) return;
      const bytes = b64ToBytes(msg.b64);
      void fx.loadSounds({ [msg.name]: bytes.buffer }).then(() => {
        fxStatus.textContent = 'CC sounds ✓';
      });
    },
  });
  link.setMicTrack(tx?.track ?? micStream?.getAudioTracks()[0] ?? null);
  link.start();
  render(link.getState());
  bindPtt();
  bindNoiseToggle();
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
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints('default', effective, true) });
  if (gen !== micGeneration) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  // Opening the mic switches the iOS audio session, which can interrupt the context and pause playback
  fx.unlock();
  tx?.dispose();
  tx = null;
  micSource?.disconnect();
  micSource = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = stream;

  let track: MediaStreamTrack;
  if (rnnoise) {
    tx = new TxProcessor(ctx, stream, { noiseNode: rnnoise });
    tx.applySettings({ feedbackSuppression: false });
    micAnalyser = tx.analyser;
    track = tx.track;
  } else {
    track = stream.getAudioTracks()[0];
    track.enabled = false;
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micSource = ctx.createMediaStreamSource(stream);
    micSource.connect(micAnalyser);
  }
  link?.setMicTrack(track);
  renderNoise(noiseMode !== effective);
}

function renderNoise(fellBack = false): void {
  const el = $<HTMLButtonElement>('nr');
  el.textContent = `Noise filter: ${fellBack ? 'Standard (AI unavailable)' : NOISE_LABEL[noiseMode]}`;
  el.hidden = false;
}

$('repair').addEventListener('click', () => {
  try {
    localStorage.removeItem(ROOM_KEY);
    localStorage.removeItem(ACCESS_KEY_KEY);
  } catch {
    /* ignore */
  }
  location.replace(location.pathname);
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
    if (document.hidden) releaseAll(true);
    else {
      fx?.unlock();
      void requestWakeLock();
    }
  });
  window.addEventListener('blur', () => releaseAll());
}

function render(s: LinkState): void {
  // Link tile
  if (s.error && s.signaling === 'closed') setTile('link', 'OFF', 'red');
  else if (s.signaling !== 'open') setTile('link', 'SERVER…', 'amber');
  else if (!s.peerPresent) setTile('link', 'PC OFFLINE', 'amber');
  else if (s.peer === 'connected') setTile('link', 'CONNECTED', 'green');
  else if (s.peer === 'failed') setTile('link', 'FAILED', 'red');
  else setTile('link', 'LINKING', 'amber');

  setTile('ping', s.rttMs == null ? '—' : `${s.rttMs}`, null);
  $('v-ping').insertAdjacentHTML('beforeend', s.rttMs == null ? '' : '<small style="font-size:14px"> ms</small>');
  setTile('route', s.route === 'relay' ? 'RELAY' : s.route === 'direct' ? 'DIRECT' : '—', s.route === 'relay' ? 'purple' : null);

  // PTT tile
  $('repair').hidden = !(s.error && s.signaling === 'closed');
  if (s.error && s.signaling === 'closed') {
    setPtt('OFFLINE', s.error, 'flag-red');
    footMsg.textContent = 'Reload the page to reconnect';
  } else if (s.tx) setPtt('TX', 'Transmitting', 'flag-red pulse');
  else if (s.rx) setPtt('RX', 'Pit wall talking', 'flag-blue pulse');
  else if (s.pending) setPtt('…', 'Keying up', 'flag-amber');
  else if (s.peer === 'connected') setPtt('HOLD TO TALK', 'Radio ready', 'idle');
  else if (!s.peerPresent && s.signaling === 'open') setPtt('WAITING', 'Waiting for the PC', 'disabled');
  else setPtt('LINKING', 'Connecting to the PC', 'disabled');

  if (!s.error) footMsg.textContent = '';
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
