import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 8795);
const HARNESS_PORT = Number(process.env.E2E_HARNESS_PORT ?? 8796);
process.env.E2E_SERVER_PORT = String(SERVER_PORT);
process.env.E2E_HARNESS_PORT = String(HARNESS_PORT);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['microphone'],
  },
  webServer: [
    {
      // The real signaling server, serving the built phone app (phone/dist) by default.
      command: 'node --import tsx src/index.ts',
      cwd: '../server',
      url: `http://localhost:${SERVER_PORT}/healthz`,
      env: { PORT: String(SERVER_PORT) },
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 30_000,
    },
    {
      command: 'node serve-harness.mjs',
      url: `http://127.0.0.1:${HARNESS_PORT}/healthz`,
      env: { HARNESS_PORT: String(HARNESS_PORT) },
      reuseExistingServer: false,
      timeout: 15_000,
    },
  ],
});
