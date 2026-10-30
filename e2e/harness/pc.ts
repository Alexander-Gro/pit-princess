// Test-only harness: runs RadioLink with role 'pc' in a browser page and exposes its state.
// Audio is wired the way desktop/src/renderer/src/main.ts does it: one RemoteAudio source per
// phone, fanned out to RadioFx (what the PC hears) and to PcMixer (what each phone hears).
// Not part of any production build. Query params: ws=<signaling url>&room=<code>
import { PcMixer, RadioFx, RadioLink, RemoteAudio, isPhoneToPcMsg, type LinkState, type PushSub } from '@pit/shared';

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
      setNames(names: Record<string, string>): void;
      /** PcMixer.setRelayEnabled (the desktop's "Relay between phones" setting) */
      setRelay(on: boolean): void;
      /** Test-only peek at the mixer's relay gates: member id -> current gain */
      relayGains(): Record<string, number>;
      /** bytesReceived on the inbound audio RTP stream from one phone (default: the first) */
      rxBytes(id?: string): Promise<number>;
      /** bytesSent on the outbound audio RTP stream to one phone (default: the first) */
      txBytes(id?: string): Promise<number>;
      /** Data channel messages from the phones, and whether each passed isPhoneToPcMsg (what the PC app checks) */
      data: { msg: unknown; valid: boolean; from: string }[];
      dataOpenCount: number;
      /** Send {t:'announce'} to the server; replies land in `announced` */
      announce(subs: PushSub[]): boolean;
      announced: { sent: number; gone: string[] }[];
    };
  }
}

const q = new URLSearchParams(location.search);
let link: RadioLink | null = null;
let mixer: PcMixer | null = null;

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
  setNames: (names) => link?.setNames(names),
  setRelay: (on) => mixer?.setRelayEnabled(on),
  relayGains: () => {
    const relays = (mixer as unknown as { relays: Map<string, { gate: GainNode }> } | null)?.relays;
    return Object.fromEntries([...(relays ?? new Map()).entries()].map(([id, r]) => [id, r.gate.gain.value]));
  },
  data: [],
  dataOpenCount: 0,
  announce: (subs) => link?.announce(subs) ?? false,
  announced: [],
  rxBytes: (id) => rtpBytes(id, 'inbound-rtp'),
  txBytes: (id) => rtpBytes(id, 'outbound-rtp'),
};
window.pit = pit;

async function main(): Promise<void> {
  const ctx = new AudioContext({ sampleRate: 48000 });
  void ctx.resume();
  const fx = new RadioFx(ctx);
  const remotes = new RemoteAudio(ctx);
  mixer = new PcMixer(ctx);
  const playBusy = fx.playBusy.bind(fx);
  fx.playBusy = () => {
    pit.busyCount++;
    playBusy();
  };
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = mic.getAudioTracks()[0];
  track.enabled = false;
  const m = mixer;
  link = new RadioLink({
    role: 'pc',
    wsUrl: q.get('ws')!,
    room: q.get('room')!,
    fx,
    onChange: (s) => {
      pit.state = s;
      pit.history.push(s);
      m.setFloor(s.floor);
      document.getElementById('state')!.textContent = JSON.stringify(s, null, 1);
    },
    sendTrackFor: (id) => m.outputFor(id),
    onRemoteStream: (id, stream) => {
      const node = remotes.set(id, stream);
      if (node) {
        fx.addRemote(id, node);
        m.addRemote(id, node);
        if (!pit.remotes.includes(id)) pit.remotes.push(id);
      } else {
        fx.removeRemote(id);
        m.removePhone(id);
        pit.remotes = pit.remotes.filter((r) => r !== id);
      }
      pit.remoteTrack = pit.remotes.length > 0;
    },
    onData: (msg, from) => pit.data.push({ msg, valid: isPhoneToPcMsg(msg), from }),
    onDataOpen: () => pit.dataOpenCount++,
    onAnnounced: (sent, gone) => pit.announced.push({ sent, gone }),
  });
  // As on the desktop: the link mutes the mic unless we transmit; the mixer sends it to the phones
  link.setMicTrack(track);
  m.setPcTrack(track);
  link.start();
  pit.state = link.getState();
  pit.ready = true;
}

main().catch((e) => {
  pit.error = String(e);
  console.error(e);
});
