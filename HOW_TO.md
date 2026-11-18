# HOW_TO — GLMWebrtc

> Cross-platform WebRTC SIP softphone (Electron 33 + React 18 + SIP.js 0.21). This guide is the minimal path from clone to call.

## 1. Prerequisites

- **Node.js 20+** (tested on 22) + **npm 10+**
- A **SIP/WebRTC PBX** with WSS transport (Asterisk / Issabel / FreeSWITCH / Kamailio)
  - Must expose `wss://your-pbx:8089/ws` (or similar)
  - WebRTC enabled: ICE / DTLS-SRTP accepted
  - Valid TLS cert, or self-signed CA installed in OS trust store (Electron uses OS store)

Check:
```bash
node -v  # >=20
npm -v   # >=10
```

## 2. Install & Run

```bash
cd glmwebrtc
npm install          # one-time
```

### Dev (hot reload — daily workflow)

```bash
npm run dev
```
- Starts `electron-vite dev` → Vite HMR for renderer (`http://localhost:5173`) + rebuilds `src/main/*` and `src/preload/*` on change.
- Electron window opens automatically (`src/main/window.ts:6` — 420×720).

### Production preview (tests the built output)

```bash
npm run build        # → out/main, out/preload, out/renderer
npm run preview      # launches Electron against out/
```

### Headless / VM (no GPU)

If you see `GPU process launch failed` / `FATAL: GPU process isn't usable`:
```bash
npx electron --no-sandbox --disable-gpu --in-process-gpu --disable-software-rasterizer out/main/index.js
```

## 3. Configure a SIP Profile

1. App opens on **Login** screen (`src/renderer/src/components/Login.tsx:1`).
2. Fill one profile:
   - `Label` — friendly name e.g. `Office`
   - `Display Name` — SIP Display-Name header
   - `Username` / `Password` — extension + secret
   - `SIP Domain` — `pbx.example.com`
   - `WSS URL` — `wss://pbx.example.com:8089/ws`
   - `ICE Servers` — optional, defaults to `stun:stun.l.google.com:19302` (add TURN for symmetric NAT)
3. Click **Test WSS** — raw WebSocket probe, reports success/timeout/error.
4. Click **Connect / Save & Connect** — `sipEngine.initialize()` (`src/renderer/src/sip/SipEngine.ts:881`) creates one `UserAgent` + `Registerer`. Status bar (`src/renderer/src/components/StatusBar.tsx:1`) shows `Registered` / `Online`.

Settings persist encrypted (AES-256-CBC) via `electron-store` (`src/main/store.ts:1`) — on Linux `~/.config/glmwebrtc/glmwebrtc-settings.json`. Multiple profiles can be saved, one active (`activeProfileId`).

> **PBX quick hints (Asterisk):** `http.conf` `enabled=yes` + TLS cert, `pjsip.conf` `transports=wss`, endpoint `media_use_received_transport=yes`, `rtp_symmetric=yes`, `force_rport=yes`, `rewrite_contact=yes`.

## 4. Make / Receive Calls

- **Dial:** `Dialpad` tab → type number / pick contact / recent → **Call** → `useCall.makeCall()` → `sipEngine.makeCall()` → `SIP.js Inviter` → `RTCPeerConnection` → `<audio id="remoteAudio">` plays remote stream (`src/renderer/src/App.tsx:1` — callback ref re-registers on every mount).
- **Incoming:** full-screen overlay (`src/renderer/src/components/IncomingCall.tsx:1`) with Web Audio ringtone (`src/renderer/src/audio/AudioManager.ts:154`) → **Answer / Decline**. DND / auto-answer toggles per profile.
- **In-call controls** (`src/renderer/src/components/CallView.tsx:1`):
  - **Mute** — toggles `sender.track.enabled`
  - **Hold / Resume** — re-INVITE with `sessionDescriptionHandlerOptions: { hold: true/false }`
  - **DTMF** — RFC 4733 via SDH, fallback to `INFO` (`application/dtmf-relay`)
  - **Transfer** — blind REFER with NOTIFY tracking; on `terminated + 200 OK` original call hangs up
  - **Hangup** — state-based `bye()` / `cancel()` / `reject()`

Second app launch focuses the first window (single-instance lock `src/main/index.ts:10`).

## 5. Other Features

- **Contacts** — `Contacts` tab → add / search / CSV import-export (`dialog:open-csv` / `dialog:save-csv` via `src/main/ipc.ts:1`), capped 2000, stored in `localStorage` (`glmwebrtc:contacts`).
- **History** — `History` tab → filters + CSV export, capped 500 (`localStorage` `glmwebrtc:history`).
- **Settings** — Audio devices, echo cancellation / noise suppression, codecs (`opus`, `G722`, `PCMU…`), transport timers, UI/behavior, tray.
- **Logs** — `Logs` tab (`src/renderer/src/components/Logs.tsx:1`) — live ring buffer (500) forwarded to main; disk logs at `<userData>/logs/app-YYYY-MM-DD.log` (7-day retention `src/main/logger.ts:1`). Diagnose audio with `sipEngine.diagnoseAudioPipeline()` in DevTools.

## 6. Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | dev with HMR |
| `npm run build` | build all 3 targets to `out/` |
| `npm run preview` | run built app (no HMR) |
| `npm run typecheck` | `tsc --noEmit` (node + web, strict) |
| `npm run lint` | ESLint `.ts/.tsx` |
| `npm run format` | Prettier |
| `npm run dist` / `dist:win` / `dist:linux` / `dist:mac` | `electron-builder` installers → `dist/` |

## 7. Build Installers

```bash
npm run dist          # current OS
npm run dist:win      # NSIS .exe
npm run dist:linux    # AppImage + .deb + .rpm
npm run dist:mac      # .dmg (x64+arm64)
```
Config: `electron-builder.yml`. Put icons in `build/` (`icon.ico/.png/.icns`). Set `CSC_LINK` + `CSC_KEY_PASSWORD` for signing, `GH_TOKEN` + `owner/repo` for publish.

## 8. Troubleshooting

- **WSS test failed / Registered failed: connection error** — wrong `wsUrl`, firewall, PBX WSS not enabled, or self-signed cert not trusted.
- **No audio during call** — Logs: `attachRemoteAudio: no audio element` → callback ref broken; `play() FAILED: NotAllowedError` → autoplay blocked; `DOM audio elements: 0/2` → missing/duplicate `<audio>`; `packetsReceived=0` → PBX/ICE issue. Run `sipEngine.diagnoseAudioPipeline()`.
- **No audio after resume from hold** — already fixed via `sessionDescriptionHandlerOptions` (do not reintroduce `holdModifier`).
- **Channel stays alive on PBX after hangup** — already fixed via state-based `bye()` dispatch.
- **App won't start after crash** — delete `~/.config/glmwebrtc/glmwebrtc-settings.json` (Linux) / `%APPDATA%/glmwebrtc/` (Win) / `~/Library/Application Support/glmwebrtc/` (macOS).
- **Self-checks:**
  ```bash
  node src/shared/selfcheck.test.mjs          # helpers
  node src/renderer/src/sip/SipService.test.mjs  # state machine
  npm run typecheck && npm run lint
  ```

## 9. Project Map

`src/main/*` (Node), `src/preload/*` (bridge → `window.api`), `src/renderer/src/*` (React), `src/shared/*` (types/constants). See `README.md` File-by-file map for full table. Two singletons: `sipEngine` (`SipEngine.ts:881`) and `audioManager` (`AudioManager.ts:154`) — do not duplicate.

---
*If code and this guide disagree, code wins — fix the guide.*
