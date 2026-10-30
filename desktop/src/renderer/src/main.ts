import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@pit/shared/theme.css';
import './style.css';
import QRCode from 'qrcode';
import {
  DEFAULT_FX,
  FX_RANGES,
  MAX_PHONES,
  PC_ID,
  PushDirectory,
  RadioFx,
  RadioLink,
  RemoteAudio,
  pingText,
  type MemberInfo,
  type RadioFxSettings,
  RevLights,
  TxProcessor,
  bytesToB64,
  micConstraints,
  generateRoomCode,
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
/** One audio source per phone, shared by the radio effect (what you hear) and the relay */
const remotes = new RemoteAudio(ctx);
/** The room's notification directory, synced with the phones (loaded in boot) */
let dir = new PushDirectory();
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
    // Without any usable device (or before mic permission) the list is empty or unnamed
    if (!list.some((d) => d.deviceId)) {
      sel.replaceChildren(Object.assign(document.createElement('option'), { value: 'default', textContent: kind === 'audioinput' ? 'No microphone found' : 'System default' }));
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
  $('v-cc').textContent = ok ? 'LOADED' : loaded.length ? `PARTIAL (${loaded.length}/4)` : 'BUILT-IN';
  $('t-cc').className = `tile cc${ok ? '' : ' flag-amber'}`;
  $('v-cc-path').textContent = res.folder ?? 'Point this at your CrewChiefV4\\Sounds folder';
  sendSoundsToPhone();
}

/** Send the Crew Chief sounds to one phone (when its channel opens), or to all after a reload. */
function sendSoundsToPhone(to?: string): void {
  if (!link) return;
  for (const [name, bytes] of Object.entries(ccFiles)) {
    const msg: FxFileMsg = { t: 'fx', name: name as CcSoundName, b64: bytesToB64(bytes) };
    link.sendData(msg, to);
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
    onRemoteStream: (id, stream) => {
      const node = remotes.set(id, stream);
      if (node) fx.addRemote(id, node);
      else fx.removeRemote(id);
    },
    onDataOpen: (id) => sendSoundsToPhone(id),
    onPairCode: showPairCode,
    onDir: (entries) => {
      if (dir.merge(entries)) dirChanged();
    },
    pingTargets: () => dir.absent(activePushIds(link?.getState().members ?? [])),
    onWelcome: (members) => {
      sentNames = '';
      sendNames(members);
      link?.setPhonesHear(settings.relayPhones);
      link?.shareDir(dir.toJSON());
      // "PC is online" goes out once per app launch, not on every reconnect, and only to phones
      // that aren't here with the app open
      if (announced) return;
      const subs = dir.absent(activePushIds(members));
      if (!subs.length || link?.announce(subs)) announced = true;
    },
    onRoster: (members) => sendNames(members),
    onAnnounced: (sent, gone) => {
      if (gone.length) forgetEndpoints(gone);
      $('v-push').textContent = sent ? `Notified ${sent} phone${sent > 1 ? 's' : ''} that the PC is online.` : pushHint();
    },
    onPinged: (r) => {
      if (r.gone.length) forgetEndpoints(r.gone);
      $('v-push').textContent = pingText(r);
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
  if (s.peer === 'connected' && lastPeer !== 'connected' && pttSources.size) link?.pttDown(true);
  lastPeer = s.peer;
  tx?.setActive(s.tx);

  const phones = s.members.filter((m) => m.role === 'phone');
  const connected = s.peers.filter((p) => p.status === 'connected').length;
  if (s.error && s.signaling === 'closed') {
    setTile('link', 'DENIED', 'red');
    $('v-server').textContent = s.error;
  } else if (s.signaling !== 'open') setTile('link', 'SERVER…', 'amber');
  else if (!phones.length) setTile('link', 'NO PHONE', null);
  else if (connected && connected < phones.length) setTile('link', 'PARTIAL', 'amber');
  else if (connected) setTile('link', connected > 1 ? `${connected} PHONES` : 'CONNECTED', 'green');
  else if (s.peer === 'failed') setTile('link', 'FAILED', 'red');
  else setTile('link', 'LINKING', 'amber');

  if (s.tx) setTile('state', 'TX', 'red', true);
  else if (s.rx) setTile('state', 'RX', 'blue', true);
  else if (s.pending) setTile('state', 'KEYING', 'amber');
  else setTile('state', 'STANDBY', null);
  $('l-state').textContent = s.tx ? 'Transmitting' : s.rx ? `${phoneName(s.talker)} talking` : 'Radio';

  setTile('ping', s.rttMs == null ? '—' : `${s.rttMs} ms`, null);
  setTile('route', s.route === 'relay' ? 'RELAY' : s.route === 'direct' ? 'DIRECT' : '—', s.route === 'relay' ? 'purple' : null);

  // The code is single-use: hide it once a phone we hadn't seen arrives. A phone that just
  // reconnects (same device) must not hide a code someone is still typing in.
  const devices = phones.map((m) => m.device ?? m.id);
  if (pairTimer && devices.some((d) => !seenDevices.has(d))) clearPairCode('Phone paired.');
  for (const d of devices) seenDevices.add(d);
  const full = phones.length >= MAX_PHONES;
  const pairBtn = $<HTMLButtonElement>('b-paircode');
  pairBtn.disabled = full;
  pairBtn.title = full ? `Room is full (${MAX_PHONES}/${MAX_PHONES}). Kick a phone to pair another.` : '';
  renderPhones(s);
}

/** Devices seen this session, so a reconnecting phone isn't mistaken for a newly paired one */
const seenDevices = new Set<string>();

/** What a phone is called: the name you gave it, or "Phone 1/2" */
function phoneName(m: MemberInfo | null | undefined): string {
  if (!m) return 'Phone';
  if (m.role === 'pc') return settings.pcName;
  return (m.device && settings.deviceNames[m.device]) || m.name || `Phone ${m.slot ?? ''}`.trim();
}

/** The phone rows. Rows are kept (not rebuilt) so typing a name isn't interrupted. */
function renderPhones(s: LinkState): void {
  const list = $('phones');
  const phones = s.members.filter((m) => m.role === 'phone');
  $('l-phones').textContent = `Phones (${phones.length}/${MAX_PHONES})`;
  const rows = new Map([...list.querySelectorAll<HTMLElement>('.phone-row')].map((r) => [r.dataset.id!, r]));
  for (const [id, row] of rows) if (!phones.some((p) => p.id === id)) row.remove();
  list.querySelector('.empty')?.remove();
  if (!phones.length) list.insertAdjacentHTML('beforeend', '<span class="hint empty">No phone connected</span>');
  for (const m of phones) {
    let row = rows.get(m.id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'phone-row';
      row.dataset.id = m.id;
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.spellcheck = false;
      input.title = 'Click to rename this phone';
      input.addEventListener('change', () => void renamePhone(m, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      const status = document.createElement('span');
      status.className = 'status';
      const kick = document.createElement('button');
      kick.className = 'btn small';
      kick.type = 'button';
      kick.textContent = 'Kick';
      kick.title = 'Disconnect this phone. It can rejoin with the link; use New code to lock it out.';
      kick.addEventListener('click', () => link?.kick(m.id));
      row.append(input, status, kick);
      list.appendChild(row);
    }
    const input = row.querySelector('input')!;
    if (document.activeElement !== input) input.value = phoneName(m);
    input.placeholder = `Phone ${m.slot ?? ''}`.trim();
    const peer = s.peers.find((p) => p.id === m.id);
    const status = row.querySelector<HTMLElement>('.status')!;
    status.textContent =
      m.away
        ? 'away'
        : peer?.status === 'connected'
          ? peer.rttMs != null
            ? `${peer.rttMs} ms`
            : 'connected'
          : peer?.status === 'failed'
            ? 'failed'
            : 'linking';
    status.classList.toggle('ok', peer?.status === 'connected');
    row.classList.toggle('talking', s.floor === m.id);
  }
}

async function renamePhone(m: MemberInfo, value: string): Promise<void> {
  if (!m.device) return;
  const names = { ...settings.deviceNames };
  const name = value.trim();
  // Re-insert so a renamed phone counts as recently used when old names are dropped
  delete names[m.device];
  if (name) names[m.device] = name.slice(0, 24);
  settings = await pit.setSettings({ deviceNames: names });
  sendNames(link?.getState().members ?? []);
  if (link) render(link.getState());
}

let sentNames = '';

/** Tell the server the names to show on the phones (by member id), when they change. */
function sendNames(members: MemberInfo[]): void {
  const names: Record<string, string | null> = { [PC_ID]: settings.pcName };
  for (const m of members) {
    // null clears a name, so renaming a phone back to blank sticks
    if (m.role === 'phone' && m.device) names[m.id] = settings.deviceNames[m.device] ?? null;
  }
  const json = JSON.stringify(names);
  if (json === sentNames) return;
  sentNames = json;
  link?.setNames(names);
}

// ---------- push notifications ----------

let announced = false;

function pushHint(): string {
  const n = dir.liveCount();
  const alerts = n ? `"PC online" alerts: ${n} phone${n > 1 ? 's' : ''}. ` : '';
  return `${alerts}Triple-press talk to ping phones that aren't on.`;
}

let pushSave: Promise<void> = Promise.resolve();

/** Save the directory (chained, so overlapping changes can't overwrite each other). */
function saveDir(): Promise<void> {
  pushSave = pushSave
    .then(async () => {
      settings = await pit.setSettings({ pushDir: dir.toJSON() });
      $('v-push').textContent = pushHint();
    })
    .catch((e) => console.warn('[push] save failed', e));
  return pushSave;
}

/** Changes spread to every phone (via the server), so everyone's copy stays current. */
function dirChanged(): void {
  void saveDir();
  link?.shareDir(dir.toJSON());
}

/** Push ids of phones here with the app on screen; any other phone can be pinged */
function activePushIds(members: MemberInfo[]): (string | undefined)[] {
  return members.filter((m) => !m.away).map((m) => m.pushId);
}

/** The push service says these endpoints are gone: mark them off for everyone. */
function forgetEndpoints(endpoints: string[]): void {
  if (dir.dropEndpoints(endpoints)) dirChanged();
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
    dir = new PushDirectory();
    await saveDir();
    startLink();
  });
  const pcName = $<HTMLInputElement>('i-pcname');
  pcName.value = settings.pcName;
  pcName.addEventListener('change', async () => {
    settings = await pit.setSettings({ pcName: pcName.value });
    pcName.value = settings.pcName;
    sendNames(link?.getState().members ?? []);
  });
  pcName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pcName.blur();
  });
  const relay = $<HTMLInputElement>('c-relay');
  relay.checked = settings.relayPhones;
  relay.addEventListener('change', async () => {
    settings = await pit.setSettings({ relayPhones: relay.checked });
    link?.setPhonesHear(relay.checked);
  });
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
    // Shown next to the mic picker; devicechange retries once a mic appears
    $('v-mic').textContent = 'No microphone found. Plug in your headset (it reconnects automatically).';
    console.warn('[mic] unavailable', e);
  }
  await populateDevices();
  joys = await pit.listJoysticks();
  renderBinding();
  dir = new PushDirectory(settings.pushDir);
  $('v-push').textContent = pushHint();
  startLink();
  // Network back (laptop woke up, Wi-Fi reconnected): reconnect now rather than after the backoff
  window.addEventListener('online', () => link?.nudge());
  await applyCrewChief(await pit.loadCrewChief());
  requestAnimationFrame(meterLoop);
}

void boot();
