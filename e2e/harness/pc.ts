// Test-only harness: runs RadioLink with role 'pc' in a browser page and exposes its state.
// Not part of any production build. Query params: ws=<signaling url>&room=<code>
import { RadioFx, RadioLink, type LinkState } from '@pit/shared';

declare global {
  interface Window {
    pit: {
      ready: boolean;
      state: LinkState | null;
      history: LinkState[];
      busyCount: number;
      remoteTrack: boolean;
      error: string | null;
      down(): void;
      up(immediate?: boolean): void;
      kick(): void;
      /** bytesReceived on the inbound audio RTP stream (Opus sends only tiny frames for a disabled track). */
      rxBytes(): Promise<number>;
    };
  }
}

const q = new URLSearchParams(location.search);
let link: RadioLink | null = null;
const pit: Window['pit'] = {
  ready: false,
  state: null,
  history: [],
  busyCount: 0,
  remoteTrack: false,
  error: null,
  down: () => link?.pttDown(),
  up: (immediate) => link?.pttUp(immediate),
  kick: () => link?.kick(),
  rxBytes: async () => {
    // Test-only peek at the private peer connection.
    const peer = (link as unknown as { pc: RTCPeerConnection | null } | null)?.pc;
    if (!peer) return -1;
    let n = 0;
    (await peer.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') n = r.bytesReceived ?? 0;
    });
    return n;
  },
};
window.pit = pit;

async function main(): Promise<void> {
  const ctx = new AudioContext();
  void ctx.resume();
  const fx = new RadioFx(ctx);
  const playBusy = fx.playBusy.bind(fx);
  fx.playBusy = () => {
    pit.busyCount++;
    playBusy();
  };
  const setRemote = fx.setRemoteStream.bind(fx);
  fx.setRemoteStream = (s) => {
    pit.remoteTrack = !!s;
    setRemote(s);
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
  });
  link.setMicTrack(track);
  link.start();
  pit.state = link.getState();
  pit.ready = true;
}

main().catch((e) => {
  pit.error = String(e);
  console.error(e);
});
