// Web Push (VAPID) sender. Configure with env:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  (generate: npx web-push generate-vapid-keys)
//   VAPID_SUBJECT  optional, a mailto: or https: URL identifying the sender
// The server stores no subscriptions: the PC app keeps them and hands them over when it comes online.

import webpush from 'web-push';
import type { PushSub } from '@pit/shared';
import type { Pusher } from './rooms.ts';

export function createPusher(env: NodeJS.ProcessEnv, fallbackSubject: string): { pusher: Pusher | null; publicKey: string | null } {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return { pusher: null, publicKey: null };
  const subject = env.VAPID_SUBJECT?.trim() || (fallbackSubject.startsWith('https://') ? fallbackSubject : '');
  if (!subject) {
    // Apple rejects pushes without a real contact (https URL or mailto)
    console.warn('[push] set VAPID_SUBJECT (mailto:you@example.com) or PUBLIC_URL (https); iPhones will refuse alerts');
  }
  webpush.setVapidDetails(subject || 'mailto:pit-princess@localhost', publicKey, privateKey);

  const pusher: Pusher = {
    async send(subs: PushSub[], payload: object) {
      const body = JSON.stringify(payload);
      let sent = 0;
      let failed = 0;
      const gone: string[] = [];
      await Promise.all(
        subs.map(async (sub) => {
          try {
            // Short TTL: "PC is online" is stale after a few minutes
            await webpush.sendNotification(sub, body, { TTL: 300, urgency: 'high', timeout: 10_000 });
            sent++;
          } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) gone.push(sub.endpoint);
            else {
              failed++;
              console.warn('[push] send failed', status ?? (e instanceof Error ? e.message : e));
            }
          }
        }),
      );
      return { sent, gone, failed };
    },
  };
  return { pusher, publicKey };
}
