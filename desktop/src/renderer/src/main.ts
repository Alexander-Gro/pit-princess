import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@pit/shared/theme.css';
import './style.css';
import QRCode from 'qrcode';
import {
  DEFAULT_FX,
  FX_RANGES,
  RadioFx,
  RadioLink,
  type RadioFxSettings,
  RevLights,
  TxProcessor,
  bytesToB64,
  micConstraints,
  generateRoomCode,
  isPhoneToPcMsg,
  MAX_PUSH_SUBS,
  type PushSub,
  readLevel,
  type CcSoundName,
  type FxFileMsg,
  type LinkState,
} from '@pit/shared';
import { createRadioContext, prepareRnnoise } from '@pit/shared/noise';
import type { CrewChiefResult, JoystickInfo, PitApi, PttBinding, Settings } from '../../common/types';

declare global {
  interface Window {
    pit: PitApi;
  }
}

const pit = window.pit;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let link: RadioLink | null = null;
let micStream: MediaStream | null = null;
/** Mic processing (level, feedback suppression, limiter); its track is what the phone hears */
let tx: TxProcessor | null = null;
let ccFiles: CrewChiefResult['files'] = {};
let joys: JoystickInfo[] = [];
let binding = false;
const pttSources = new Set<'wheel' | 'mouse'>();

// 48 kHz so the RNNoise model can run
const ctx = createRadioContext();
const fx = new RadioFx(ctx);
const txMeter = new RevLights($('m-tx'), 24);
const rxMeter = new RevLights($('m-rx'), 24);

function renderNotches(count: number): void {
  $('v-fb').textContent = !settings.feedbackSuppression
    ? 'Off'
    : count
      ? `Caught ${count} feedback tone${count > 1 ? 's' : ''}`
      : 'Listening';
}

function setTile(id: string, value: string, flag: string | null, pulse = false): void {
  $(`v-${id}`).textContent = value;
  $(`t-${id}`).className = `tile${flag ? ` flag-${flag}` : ''}${pulse ? ' pulse' : ''}${id === 'state' ? ' state' : ''}`;
}

// ---------- audio devices ----------

let micGeneration = 0;

async function openMic(deviceId: string): Promise<void> {
  const gen = ++micGeneration;
  const rnnoise = settings.noise === 'strong' ? await prepareRnnoise(ctx) : null;
  // No RNNoise here (e.g. not 48 kHz): fall back to the browser's own suppression
  const noise = settings.noise === 'strong' && !rnnoise ? 'standard' : settings.noise;
  const constraints = (id: string): MediaStreamConstraints => ({ audio: micConstraints(id, noise) });
  let stream: MediaStream;
  let fellBack = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (e) {
    console.warn('[mic] falling back to default', e);
    stream = await navigator.mediaDevices.getUserMedia(constraints('default'));
    fellBack = deviceId !== 'default';
  }
  // A newer openMic call started while we waited: discard this stream
  if (gen !== micGeneration) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  $('v-mic').textContent = fellBack ? 'Selected microphone unavailable, using system default' : '';
  micStream?.getTracks().forEach((t) => t.stop());
  tx?.dispose();
  micStream = stream;
  const raw = stream.getAudioTracks()[0];
  // Unplugged headset: retry the chosen device (or default) so TX doesn't silently go dead
  raw.addEventListener('ended', () => {
    if (micStream === stream) void openMic(settings.inputDeviceId).catch(() => {});
  });
  tx = new TxProcessor(ctx, stream, { noiseNode: rnnoise });
  $('v-noise').textContent = settings.noise === 'strong' && !rnnoise ? 'AI filter unavailable, using Standard' : '';
  tx.applySettings({ micGain: settings.micGain, feedbackSuppression: settings.feedbackSuppression });
  tx.onNotches = renderNotches;
  tx.setActive(link?.getState().tx ?? false);
  renderNotches(0);
  link?.setMicTrack(tx.track);
}

async function applyOutput(deviceId: string): Promise<void> {
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!c.setSinkId) return;
  try {
    await c.setSinkId(deviceId === 'default' ? '' : deviceId);
  } catch (e) {
    console.warn('[output] setSinkId failed, using default', e);
    await c.setSinkId('').catch(() => {});
  }
}

async function populateDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel: HTMLSelectElement, kind: MediaDeviceKind, current: string) => {
    sel.replaceChildren();
    const list = devices.filter((d) => d.kind === kind && d.deviceId !== 'communications');
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.deviceId === 'default' ? `System default` : d.label || 'Unnamed device';
      sel.appendChild(o);
    }
    sel.value = list.some((d) => d.deviceId === current) ? current : 'default';
  };
  fill($('s-in'), 'audioinput', settings.inputDeviceId);
  fill($('s-out'), 'audiooutput', settings.outputDeviceId);
}

// ---------- Crew Chief ----------

async function applyCrewChief(res: CrewChiefResult): Promise<void> {
  ccFiles = res.files;
  const buffers: Partial<Record<CcSoundName, ArrayBuffer>> = {};
  for (const [name, bytes] of Object.entries(res.files)) {
    buffers[name as CcSoundName] = bytes.slice().buffer;
  }
  const loaded = await fx.loadSounds(buffers);
  const ok = loaded.length > 0 && res.missing.length === 0;
  $('v-cc').textContent = ok ? 'LOADED ✓' : loaded.length ? `PARTIAL (${loaded.length}/4)` : 'NOT FOUND — using built-in';
  $('t-cc').className = `tile cc${ok ? '' : ' flag-amber'}`;
  $('v-cc-path').textContent = res.folder ?? 'Point this at your CrewChiefV4\\Sounds folder';
  sendSoundsToPhone();
}

function sendSoundsToPhone(): void {
  if (!link) return;
  for (const [name, bytes] of Object.entries(ccFiles)) {
    const msg: FxFileMsg = { t: 'fx', name: name as CcSoundName, b64: bytesToB64(bytes) };
    link.sendData(msg);
  }
}

// ---------- link ----------

function wsUrl(): string {
  return `${settings.serverUrl.replace(/^http/, 'ws')}/ws`;
}

function startLink(): void {
  link?.stop();
  link = new RadioLink({
    role: 'pc',
    wsUrl: wsUrl(),
    room: settings.room!,
    accessKey: settings.accessKey,
    fx,
    onChange: render,
    onDataOpen: sendSoundsToPhone,
    onPairCode: showPairCode,
    onData: onPhoneMessage,
    onWelcome: () => {
      // "PC is online" goes out once per app launch, not on every reconnect
      if (announced || !settings.pushSubs.length) return;
      if (link?.announce(settings.pushSubs)) announced = true;
    },
    onAnnounced: (sent, gone) => {
      if (gone.length) void updatePushSubs((subs) => subs.filter((s) => !gone.includes(s.endpoint)));
      $('v-push').textContent = sent ? `Notified ${sent} phone${sent > 1 ? 's' : ''} that the PC is online.` : pushHint();
    },
  });
  const track = tx?.track ?? null;
  link.setMicTrack(track);
  lastPeer = 'none';
  link.start();
  render(link.getState());
  void updatePairing();
}

async function updatePairing(): Promise<void> {
  let base = settings.serverUrl;
  try {
    const res = await fetch(`${settings.serverUrl}/api/info`, { cache: 'no-store' });
    const info = (await res.json()) as { publicUrl?: string };
    if (info.publicUrl) base = info.publicUrl;
    $('v-server').textContent = 'Server reachable';
  } catch {
    $('v-server').textContent = 'Server not reachable';
  }
  const key = settings.accessKey ? `&key=${encodeURIComponent(settings.accessKey)}` : '';
  const url = `${base}/#room=${settings.room}${key}`;
  const a = $<HTMLAnchorElement>('phone-link');
  a.href = url;
  // Show the link without the key; the QR code and Copy link still carry it
  a.textContent = settings.accessKey ? url.replace(key, '&key=••••••') : url;
  await QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, { width: 168, margin: 1, errorCorrectionLevel: 'M' });
}

let lastPeer: LinkState['peer'] = 'none';

function render(s: LinkState): void {
  // PTT held while the link (re)connected: key up once the phone is reachable
  if (s.peer === 'connected' && lastPeer !== 'connected' && pttSources.size) link?.pttDown();
  lastPeer = s.peer;
  tx?.setActive(s.tx);

  if (s.error && s.signaling === 'closed') {
    setTile('link', 'DENIED', 'red');
    $('v-server').textContent = s.error;
  } else if (s.signaling !== 'open') setTile('link', 'SERVER…', 'amber');
  else if (!s.peerPresent) setTile('link', 'NO PHONE', null);
  else if (s.peer === 'connected') setTile('link', 'CONNECTED', 'green');
  else if (s.peer === 'failed') setTile('link', 'FAILED', 'red');
  else setTile('link', 'LINKING', 'amber');

  if (s.tx) setTile('state', 'TX', 'red', true);
  else if (s.rx) setTile('state', 'RX', 'blue', true);
  else if (s.pending) setTile('state', 'KEYING', 'amber');
  else setTile('state', 'STANDBY', null);
  $('l-state').textContent = s.tx ? 'Transmitting' : s.rx ? 'Phone talking' : 'Radio';

  setTile('ping', s.rttMs == null ? '—' : `${s.rttMs} ms`, null);
  setTile('route', s.route === 'relay' ? 'RELAY' : s.route === 'direct' ? 'DIRECT' : '—', s.route === 'relay' ? 'purple' : null);

  // The code is single-use: once the phone is in, hide it
  if (s.peer === 'connected' && pairTimer) clearPairCode('Phone paired.');
  $('v-phone').textContent = !s.peerPresent ? 'No phone' : s.peer === 'connected' ? 'Phone connected' : 'Phone linking…';
}

// ---------- push notifications ----------

let announced = false;

function pushHint(): string {
  const n = settings.pushSubs.length;
  return n ? `"PC online" alerts: ${n} phone${n > 1 ? 's' : ''}.` : '';
}

let pushSave: Promise<void> = Promise.resolve();

/**
 * Change the stored subscriptions. Updates are chained, and each one starts from the result of
 * the previous, so overlapping changes (a new phone + an expired one) can't overwrite each other.
 */
function updatePushSubs(change: (subs: PushSub[]) => PushSub[]): Promise<void> {
  pushSave = pushSave
    .then(async () => {
      settings = await pit.setSettings({ pushSubs: change(settings.pushSubs) });
      $('v-push').textContent = pushHint();
    })
    .catch((e) => console.warn('[push] save failed', e));
  return pushSave;
}

function onPhoneMessage(msg: unknown): void {
  if (!isPhoneToPcMsg(msg)) return;
  if (msg.t === 'push_sub') {
    const sub = msg.sub;
    // Newest first; drop the oldest beyond the limit
    void updatePushSubs((subs) => [sub, ...subs.filter((s) => s.endpoint !== sub.endpoint)].slice(0, MAX_PUSH_SUBS));
  } else {
    const endpoint = msg.endpoint;
    void updatePushSubs((subs) => subs.filter((s) => s.endpoint !== endpoint));
  }
}

// ---------- pairing code ----------

let pairTimer: ReturnType<typeof setInterval> | null = null;

function showPairCode(code: string, expiresInMs: number): void {
  const until = Date.now() + expiresInMs;
  const el = $('v-paircode');
  el.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  el.hidden = false;
  if (pairTimer) clearInterval(pairTimer);
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    if (left === 0) {
      clearPairCode('Code expired. Make a new one if you still need it.');
      return;
    }
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    $('v-paircode-hint').textContent = `Type this on the phone. Valid for ${m}:${String(s).padStart(2, '0')}, works once.`;
  };
  tick();
  pairTimer = setInterval(tick, 1000);
}

function clearPairCode(hint: string): void {
  if (pairTimer) clearInterval(pairTimer);
  pairTimer = null;
  $('v-paircode').hidden = true;
  $('v-paircode-hint').textContent = hint;
}

// ---------- PTT ----------

function setPttSource(src: 'wheel' | 'mouse', down: boolean): void {
  const before = pttSources.size > 0;
  if (down) pttSources.add(src);
  else pttSources.delete(src);
  const after = pttSources.size > 0;
  if (before === after) return;
  void ctx.resume();
  $('b-hold').classList.toggle('on', after);
  if (after) link?.pttDown();
  else link?.pttUp();
}

function renderBinding(): void {
  const b = settings.ptt;
  const btn = $('b-bind');
  btn.classList.toggle('binding', binding);
  btn.textContent = binding ? 'Press a wheel button… (click to cancel)' : 'Bind wheel button';
  if (!b) $('v-bind').textContent = 'Not bound';
  else {
    const connected = joys.some((j) => j.path === b.path || (j.guid === b.guid && j.name === b.name));
    $('v-bind').textContent = `${b.name ?? 'Device'} · Button ${b.button + 1}${connected ? '' : ' (not connected)'}`;
  }
  $('v-joys').textContent = joys.length
    ? `Devices: ${[...new Set(joys.map((j) => j.name ?? 'Unknown'))].join(', ')}`
    : 'No wheels or joysticks detected';
}

// ---------- wiring ----------

/**
 * Link a range slider and a typeable percentage box to one value (stored as a fraction).
 * Returns a function that refreshes both from the current value.
 */
function bindPercent(
  range: HTMLInputElement,
  num: HTMLInputElement,
  [min, max]: [number, number],
  get: () => number,
  set: (v: number) => void,
): () => void {
  range.min = String(min);
  range.max = String(max);
  num.min = String(min * 100);
  num.max = String(max * 100);
  num.step = '1';
  const sync = () => {
    range.value = String(get());
    num.value = String(Math.round(get() * 100));
  };
  range.addEventListener('input', () => {
    set(Number(range.value));
    sync();
  });
  num.addEventListener('change', () => {
    const n = Number(num.value);
    if (num.value.trim() !== '' && Number.isFinite(n)) set(Math.min(max, Math.max(min, n / 100)));
    sync();
  });
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.blur();
  });
  sync();
  return sync;
}

function wireUi(): void {
  $('b-bind').addEventListener('click', async () => {
    binding = !binding;
    if (binding) await pit.startBind();
    else await pit.cancelBind();
    renderBinding();
  });
  $('b-unbind').addEventListener('click', async () => {
    settings = await pit.setSettings({ ptt: null });
    renderBinding();
  });

  const hold = $('b-hold');
  hold.addEventListener('pointerdown', (e) => {
    hold.setPointerCapture(e.pointerId);
    setPttSource('mouse', true);
  });
  const release = () => setPttSource('mouse', false);
  hold.addEventListener('pointerup', release);
  hold.addEventListener('pointercancel', release);
  hold.addEventListener('lostpointercapture', release);
  window.addEventListener('blur', release);

  $('b-copy').addEventListener('click', () => {
    void navigator.clipboard.writeText($<HTMLAnchorElement>('phone-link').href);
  });
  $('b-newcode').addEventListener('click', async () => {
    if (!confirm('Create a new pairing code? The current phone will be disconnected.')) return;
    link?.kick();
    // A new code shuts out the old phone, so stop notifying it too
    settings = await pit.setSettings({ room: generateRoomCode() });
    await updatePushSubs(() => []);
    startLink();
  });
  $('b-kick').addEventListener('click', () => link?.kick());
  $('b-paircode').addEventListener('click', () => {
    if (!link?.createPairCode()) clearPairCode('Not connected to the server yet.');
  });

  $('b-cc-browse').addEventListener('click', async () => {
    const res = await pit.browseCrewChief();
    if (res) await applyCrewChief(res);
  });
  $('b-cc-test').addEventListener('click', () => {
    void ctx.resume();
    fx.openChannel();
    setTimeout(() => fx.closeChannel(true), 1200);
  });

  $<HTMLSelectElement>('s-in').addEventListener('change', async (e) => {
    const id = (e.target as HTMLSelectElement).value;
    settings = await pit.setSettings({ inputDeviceId: id });
    await openMic(id);
  });
  $<HTMLSelectElement>('s-out').addEventListener('change', async (e) => {
    const id = (e.target as HTMLSelectElement).value;
    settings = await pit.setSettings({ outputDeviceId: id });
    await applyOutput(id);
  });
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void populateDevices();
    const t = micStream?.getAudioTracks()[0];
    if (!t || t.readyState === 'ended') void openMic(settings.inputDeviceId).catch(() => {});
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveFx = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      settings = await pit.setSettings({ fx: fx.getSettings() });
    }, 300);
  };
  const fxSyncs: (() => void)[] = [];
  for (const range of document.querySelectorAll<HTMLInputElement>('input[type=range][data-fx]')) {
    const key = range.dataset.fx as keyof RadioFxSettings;
    const num = document.querySelector<HTMLInputElement>(`input[data-pct="${key}"]`)!;
    fxSyncs.push(
      bindPercent(range, num, FX_RANGES[key], () => fx.getSettings()[key], (v) => {
        fx.applySettings({ [key]: v });
        saveFx();
      }),
    );
  }
  $('b-fx-reset').addEventListener('click', () => {
    fx.applySettings(DEFAULT_FX);
    fxSyncs.forEach((sync) => sync());
    saveFx();
  });

  let micSaveTimer: ReturnType<typeof setTimeout> | null = null;
  bindPercent(
    $<HTMLInputElement>('r-mic'),
    document.querySelector<HTMLInputElement>('input[data-pct="micGain"]')!,
    [0, 2],
    () => settings.micGain,
    (v) => {
      settings = { ...settings, micGain: v };
      tx?.applySettings({ micGain: v });
      if (micSaveTimer) clearTimeout(micSaveTimer);
      micSaveTimer = setTimeout(() => void pit.setSettings({ micGain: v }), 300);
    },
  );
  const noiseSel = $<HTMLSelectElement>('s-noise');
  noiseSel.value = settings.noise;
  noiseSel.addEventListener('change', async () => {
    settings = await pit.setSettings({ noise: noiseSel.value as Settings['noise'] });
    await openMic(settings.inputDeviceId);
  });

  const fb = $<HTMLInputElement>('c-fb');
  fb.checked = settings.feedbackSuppression;
  fb.addEventListener('change', async () => {
    settings = await pit.setSettings({ feedbackSuppression: fb.checked });
    tx?.applySettings({ feedbackSuppression: fb.checked });
    renderNotches(tx?.activeNotches() ?? 0);
  });

  const server = $<HTMLInputElement>('i-server');
  server.value = settings.serverUrl;
  $('b-server').addEventListener('click', async () => {
    const value = server.value.trim();
    if (!/^https?:\/\/\S+$/.test(value)) {
      $('v-server').textContent = 'Enter a URL starting with http:// or https://';
      return;
    }
    settings = await pit.setSettings({ serverUrl: value, accessKey: keyInput.value.trim() });
    server.value = settings.serverUrl;
    keyInput.value = settings.accessKey;
    // A different server hasn't heard we're online yet
    announced = false;
    startLink();
  });
  const keyInput = $<HTMLInputElement>('i-key');
  keyInput.value = settings.accessKey;
  $('b-key-show').addEventListener('click', () => {
    const hidden = keyInput.type === 'password';
    keyInput.type = hidden ? 'text' : 'password';
    $('b-key-show').textContent = hidden ? 'Hide' : 'Show';
  });

  pit.onPtt((down) => setPttSource('wheel', down));
  pit.onBindCaptured((b: PttBinding) => {
    binding = false;
    settings = { ...settings, ptt: b };
    renderBinding();
  });
  pit.onJoysticks((list) => {
    joys = list;
    renderBinding();
  });
  pit.onJoystickError((msg) => {
    $('v-joys').textContent = msg;
  });
}

const levelBuf = new Float32Array(512);
function meterLoop(): void {
  const s = link?.getState();
  txMeter.set(s?.tx && tx ? readLevel(tx.analyser, levelBuf) : 0);
  rxMeter.set(s?.rx ? readLevel(fx.rxAnalyser, levelBuf) : 0);
  requestAnimationFrame(meterLoop);
}

async function boot(): Promise<void> {
  settings = await pit.getSettings();
  if (!settings.room) settings = await pit.setSettings({ room: generateRoomCode() });
  fx.applySettings(settings.fx);
  wireUi();
  await applyOutput(settings.outputDeviceId);
  try {
    await openMic(settings.inputDeviceId);
  } catch (e) {
    $('v-server').textContent = `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  await populateDevices();
  joys = await pit.listJoysticks();
  renderBinding();
  $('v-push').textContent = pushHint();
  startLink();
  await applyCrewChief(await pit.loadCrewChief());
  requestAnimationFrame(meterLoop);
}

void boot();
