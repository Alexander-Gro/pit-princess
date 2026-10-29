// RNNoise (AI noise suppression) as an AudioWorklet. Separate entry point
// (`@pit/shared/noise`) because it uses Vite `?url` asset imports, which the
// Node server can't load.

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import type { NoiseNodeFactory } from './txchain.ts';

const prepared = new WeakMap<AudioContext, Promise<NoiseNodeFactory | null>>();

/**
 * Load RNNoise into `ctx`. Resolves to a node factory, or null when RNNoise can't run here
 * (it only works at 48 kHz) and the caller should fall back to the browser's suppression.
 */
export function prepareRnnoise(ctx: AudioContext): Promise<NoiseNodeFactory | null> {
  let p = prepared.get(ctx);
  if (!p) {
    p = (async () => {
      if (ctx.sampleRate !== 48000 || !ctx.audioWorklet) {
        console.warn(`[noise] RNNoise needs 48 kHz, context runs at ${ctx.sampleRate}`);
        return null;
      }
      try {
        const wasmBinary = await loadRnnoise({ url: wasmUrl, simdUrl });
        await ctx.audioWorklet.addModule(workletUrl);
        return () => new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
      } catch (e) {
        console.warn('[noise] RNNoise unavailable', e);
        return null;
      }
    })();
    prepared.set(ctx, p);
  }
  return p;
}

/** An AudioContext at 48 kHz (what RNNoise needs), falling back to the device default. */
export function createRadioContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch {
    return new AudioContext({ latencyHint: 'interactive' });
  }
}
