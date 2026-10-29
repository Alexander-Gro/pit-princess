# Pit Princess

So here's the problem. When I'm in the sim with my headset on, I'm completely locked in and can't hear anything around me. My girlfriend tries to tell me something from the couch, I don't hear her, she gets annoyed, and eventually she has to get up and come over to me. Not great for either of us.

So I built this. She opens a page on her phone, holds a button and talks, and it comes through my headset like a race engineer on the radio, with static and bleeps and all of it. I can talk back with a button on my wheel without letting go of it. Now she's basically my pit engineer, and honestly she's better at it than some I've had in real races.

It's free and open source, so if you've got the same problem at home, go ahead and use it.

## What it is

Push-to-talk team radio between a phone and your sim-racing PC. Each side hears the other through a radio effect with Crew Chief V4's bleeps.

- **Phone**: a web app. You open a link or scan a QR code, then hold the big tile to talk.
- **PC**: a Windows app. A wheel button keys your mic, and the phone's voice plays on the output device you pick.
- **Radio rules**: one side talks at a time. If you key up while the channel is busy, you hear a busy tone.

```
phone (browser) ──WebRTC audio──► PC app (Electron)
        └──── WebSocket signaling + floor control ── server (Node) ────┘
```

## Layout

| Folder    | What it is                                                                |
| --------- | ------------------------------------------------------------------------- |
| `shared/` | Protocol types, `RadioLink` (WebRTC + PTT), `RadioFx` (radio effect), theme |
| `server/` | Signaling server, floor arbitration, TURN credentials, hosts the phone app |
| `phone/`  | Phone PWA (Vite)                                                          |
| `desktop/`| Electron PC app; wheel input via SDL2 (`@kmamal/sdl`)                     |
| `e2e/`    | Browser end-to-end tests                                                  |

## Run it locally

```bash
npm install
npm run build:phone
npm run dev:server          # http://localhost:8787
npm run dev:desktop         # PC app (in a second terminal)
```

> If you start Electron from the VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first, because VS Code sets it. In PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

### Phone on the same Wi-Fi
Phones only allow the microphone on HTTPS pages. To test over Wi-Fi:

1. Run the server with a self-signed certificate:
   ```bash
   npm run dev:https -w server   # https://<your-LAN-IP>:8443
   ```
2. In the PC app, set **Server** to `http://localhost:8787` (the PC talks to the server over plain HTTP). The QR code then points the phone at the HTTPS address.
3. Scan the QR code on the phone. Accept the certificate warning once, then tap **TAP TO CONNECT**.

If the page never loads on the phone, Windows Firewall is probably blocking port 8443. This happens when your Wi-Fi is set to **Public**. In an **administrator** PowerShell, run:
```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
New-NetFirewallRule -DisplayName "Pit Princess dev" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
```
The phone also has to be on the same Wi-Fi. Guest networks usually stop devices from seeing each other.

## Put it on the internet (Render, free)

The app ships with no server built in. It talks to `localhost` until you point it at your own server. Each household runs its own private server, and nobody else can use yours without its access key.

1. Fork or clone this repo to your own GitHub account.
2. In Render, create a **New → Blueprint** and pick the repo. It uses `render.yaml`.
3. When Render asks for `ACCESS_KEY`, enter a long random string. This makes the server private: only clients that send this key can connect. You can generate one in PowerShell:
   ```powershell
   -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
   ```
4. Optionally add TURN credentials. They let audio get through when the phone is on mobile data or a strict network. Set one of these provider pairs as environment variables in Render:
   - **Cloudflare TURN**: `CF_TURN_KEY_ID` and `CF_TURN_KEY_TOKEN`. Create these in Cloudflare → Calls/Realtime → TURN keys.
   - **Metered.ca**: `METERED_DOMAIN` (e.g. `yourapp.metered.live`) and `METERED_API_KEY`.
   - **Any TURN server**: `TURN_URLS` (comma separated), `TURN_USERNAME` and `TURN_CREDENTIAL`.
5. In the PC app, set **Server** to your Render URL (e.g. `https://your-app.onrender.com`) and **Access key** to the same `ACCESS_KEY`, then click **Save**. The QR code updates and includes the key. The key sits in the part of the link after `#`, which the browser never sends to the server, and the phone remembers it.

Keep the access key out of the repo. It belongs only in Render's environment settings and in your PC app.

The free Render tier sleeps after about 15 minutes with no traffic, and the first connection after that takes up to about a minute.

## Using it

1. **Bind wheel button**: click it, then press the button on your wheel. The button works while the sim has focus.
2. **Crew Chief sounds**: these are loaded automatically from `%LOCALAPPDATA%\CrewChiefV4\Sounds\fx`. You can change the folder with **Browse…**. The PC app sends them straight to the phone over the peer connection, and they are never uploaded to the server.
3. **Pair phone**: scan the QR code. **New code** disconnects the current phone and makes a new link. **Kick** drops the phone.
4. **Radio output**: pick the device the phone's voice should play on, e.g. your headset.

## Tests

```bash
npm test          # server unit + integration tests (vitest)
npm run test:e2e  # browser end-to-end test (Playwright)
npm run typecheck
```

## Build a Windows installer

```bash
npm run dist -w desktop     # → desktop/release/
```

## License

MIT. Use it, change it, share it, do whatever you want with it. See [LICENSE](LICENSE).

### About the Crew Chief sounds

Pit Princess is not affiliated with Crew Chief, and **this repo contains no Crew Chief files**. The radio bleeps belong to the Crew Chief V4 project. The PC app reads them from your own local Crew Chief install at runtime and sends them directly to your own phone. Without Crew Chief installed, the app plays its own synthesized bleeps instead. If you fork or package this project, don't bundle Crew Chief's sound files.
