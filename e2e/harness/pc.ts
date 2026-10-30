// Test-only harness: runs RadioLink with role 'pc' in a browser page and exposes its state.
// Audio is wired the way desktop/src/renderer/src/main.ts does it since the full mesh: one
// RemoteAudio source per phone into RadioFx (what the PC hears), and the mic goes straight to
// every peer with setMicTrack (each phone gets its own audio from the other phone directly).
// Not part of any production build. Query params: ws=<signaling url>&room=<code>
import { RadioFx, RadioLink, RemoteAudio, isDirMsg, type LinkState, type PingResult, type PushEntry, type PushSub } from '@pit/shared';

declare global {
  interface Window {
    pit: {
      ready: boolean;
      state: LinkState | null;
      history: LinkState[];
      busyCount: number;
      /** At least one phone's audio has arrived (and is still attached) */
      remoteTrack: boolean;
      /** Member ids whose audio is currently attached */
      remotes: string[];
      error: string | null;
      down(): void;
      up(immediate?: boolean): void;
      kick(id?: string): void;
      setNames(names: Record<string, string | null>): void;
      /** RadioLink.setPhonesHear (the desktop's "Phones hear each other" setting) */
      setPhonesHear(on: boolean): void;
      /** bytesReceived on the inbound audio RTP stream from one phone (default: the first) */
      rxBytes(id?: string): Promise<number>;
      /** bytesSent on the outbound audio RTP stream to one phone (default: the first) */
      txBytes(id?: string): Promise<number>;
      /** Data channel messages from the phones, and whether each passed isDirMsg (what the PC app checks) */
      data: { msg: unknown; valid: boolean; from: string }[];
      /** v4: directory copies relayed by the server (from a member id, or 'server' for its cache) */
      dirs: { entries: PushEntry[]; from: string; valid: boolean }[];
      dataOpenCount: number;
      /** Send {t:'announce'} to the server; replies land in `announced` */
      announce(subs: PushSub[]): boolean;
      announced: { sent: number; gone: string[] }[];
      /** RadioLink.ping(); replies land in `pinged`. `targets` is what pingTargets() returns. */
      ping(): boolean;
      targets: PushSub[];
      pinged: PingResult[];
      pingSentCount: number;
      /** Close the link (the PC goes offline) */
      stop(): void;
      /** Start the link again after stop() (the PC comes back online) */
      start(): void;
    };
  }
}

const q = new URLSearchParams(location.search);
let link: RadioLink | null = null;

/** Test-only peek at the link's private per-phone peer connections. */
function peerConn(id?: string): RTCPeerConnection | null {
  const peers = (link as unknown as { peers: Map<string, { pc: RTCPeerConnection }> } | null)?.peers;
  if (!peers) return null;
  const p = id ? peers.get(id) : peers.values().next().value;
  return p?.pc ?? null;
}

async function rtpBytes(id: string | undefined, type: 'inbound-rtp' | 'outbound-rtp'): Promise<number> {
  const pc = peerConn(id);
  if (!pc) return -1;
  let n = 0;
  (await pc.getStats()).forEach((r) => {
    if (r.type === type && r.kind === 'audio') n = (type === 'inbound-rtp' ? r.bytesReceived : r.bytesSent) ?? 0;
  });
  return n;
}

const pit: Window['pit'] = {
  ready: false,
  state: null,
  history: [],
  busyCount: 0,
  remoteTrack: false,
  remotes: [],
  error: null,
  down: () => link?.pttDown(),
  up: (immediate) => link?.pttUp(immediate),
  kick: (id) => link?.kick(id),
  setNames: (names) => link?.setNames(names as Record<string, string>),
  setPhonesHear: (on) => link?.setPhonesHear(on),
  data: [],
  dirs: [],
  dataOpenCount: 0,
  announce: (subs) => link?.announce(subs) ?? false,
  announced: [],
  ping: () => link?.ping() ?? false,
  targets: [],
  pinged: [],
  pingSentCount: 0,
  stop: () => link?.stop(),
  start: () => link?.start(),
  rxBytes: (id) => rtpBytes(id, 'inbound-rtp'),
  txBytes: (id) => rtpBytes(id, 'outbound-rtp'),
};
window.pit = pit;

async function main(): Promise<void> {
  const ctx = new AudioContext({ sampleRate: 48000 });
  void ctx.resume();
  const fx = new RadioFx(ctx);
  const remotes = new RemoteAudio(ctx);
  const playBusy = fx.playBusy.bind(fx);
  fx.playBusy = () => {
    pit.busyCount++;
    playBusy();
  };
  const playPingSent = fx.playPingSent.bind(fx);
  fx.playPingSent = () => {
    pit.pingSentCount++;
    playPingSent();
  };
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = mic.getAudioTracks()[0];
  track.enabled = false;
  link = new RadioLink({
    role: 'pc',
    wsUrl: q.get('ws')!,
    room: q.get('room')!,
    fx,
    onChange: (s) => {
      pit.state = s;
      pit.history.push(s);
      document.getElementById('state')!.textContent = JSON.stringify(s, null, 1);
    },
    onRemoteStream: (id, stream) => {
      const node = remotes.set(id, stream);
      if (node) {
        fx.addRemote(id, node);
        if (!pit.remotes.includes(id)) pit.remotes.push(id);
      } else {
        fx.removeRemote(id);
        pit.remotes = pit.remotes.filter((r) => r !== id);
      }
      pit.remoteTrack = pit.remotes.length > 0;
    },
    onData: (msg, from) => pit.data.push({ msg, valid: isDirMsg(msg), from }),
    onDir: (entries, from) => pit.dirs.push({ entries, from, valid: isDirMsg({ t: 'dir', entries }) }),
    onDataOpen: () => pit.dataOpenCount++,
    onAnnounced: (sent, gone) => pit.announced.push({ sent, gone }),
    pingTargets: () => pit.targets,
    onPinged: (r) => pit.pinged.push(r),
  });
  // As on the desktop: the mic goes to every peer; the link keeps it muted unless we transmit
  link.setMicTrack(track);
  link.start();
  pit.state = link.getState();
  pit.ready = true;
}

main().catch((e) => {
  pit.error = String(e);
  console.error(e);
});
