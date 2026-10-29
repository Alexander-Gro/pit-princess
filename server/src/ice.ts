// ICE server configuration. TURN credentials come from env, from one of:
//   Cloudflare:  CF_TURN_KEY_ID + CF_TURN_KEY_TOKEN
//   Metered:     METERED_DOMAIN (e.g. myapp.metered.live) + METERED_API_KEY
//   Static:      TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL

const STUN: RTCIceServer = { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };
const CRED_TTL_S = 12 * 3600;

type Fetcher = () => Promise<RTCIceServer[]>;

export function createIceProvider(env: NodeJS.ProcessEnv = process.env): { get: Fetcher; describe: string } {
  let fetcher: Fetcher | null = null;
  let describe = 'STUN only (no TURN configured)';

  if (env.CF_TURN_KEY_ID && env.CF_TURN_KEY_TOKEN) {
    describe = 'Cloudflare TURN';
    fetcher = async () => {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CF_TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: CRED_TTL_S }),
        },
      );
      if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
      const body = (await res.json()) as { iceServers: RTCIceServer | RTCIceServer[] };
      return Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    };
  } else if (env.METERED_DOMAIN && env.METERED_API_KEY) {
    describe = 'Metered TURN';
    fetcher = async () => {
      const res = await fetch(
        `https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY!)}`,
      );
      if (!res.ok) throw new Error(`Metered TURN ${res.status}`);
      return (await res.json()) as RTCIceServer[];
    };
  } else if (env.TURN_URLS) {
    describe = 'static TURN';
    const servers: RTCIceServer[] = [
      { urls: env.TURN_URLS.split(',').map((s) => s.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
    ];
    fetcher = async () => servers;
  }

  let cache: { at: number; servers: RTCIceServer[] } | null = null;
  let inflight: Promise<RTCIceServer[]> | null = null;

  const get: Fetcher = async () => {
    if (!fetcher) return [STUN];
    // Refresh halfway through the credential lifetime
    if (cache && Date.now() - cache.at < (CRED_TTL_S * 1000) / 2) return cache.servers;
    inflight ??= fetcher()
      .then((turn) => {
        const servers = [STUN, ...turn];
        cache = { at: Date.now(), servers };
        return servers;
      })
      .catch((e) => {
        console.warn('[ice] TURN credential fetch failed:', e instanceof Error ? e.message : e);
        return cache?.servers ?? [STUN];
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return { get, describe };
}
