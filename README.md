# GLMWebrtc

A cross-platform WebRTC SIP softphone built with Electron + React + SIP.js.
Connects to any SIP/WebRTC PBX (Asterisk, Issabel, FreeSWITCH, Kamailio, etc.)
over WSS, places and receives audio calls with SRTP/DTLS-encrypted media via
ICE, and ships as a single desktop window for Windows, Linux, and macOS.

---

## Table of contents

1. [What this is](#what-this-is)
2. [Tech stack](#tech-stack)
3. [Project layout](#project-layout)
4. [Architecture](#architecture)
5. [Getting started](#getting-started)
6. [Scripts](#scripts)
7. [Configuration](#configuration)
8. [The SIP/WebRTC media pipeline](#the-sipwebrtc-media-pipeline)
9. [State management](#state-management)
10. [IPC bridge](#ipc-bridge)
11. [Logging](#logging)
12. [Persistence](#persistence)
13. [Audio diagnostics](#audio-diagnostics)
14. [Code conventions](#code-conventions)
15. [Testing & self-checks](#testing--self-checks)
16. [Building installers](#building-installers)
17. [Troubleshooting](#troubleshooting)
18. [Security notes](#security-notes)
19. [File-by-file map](#file-by-file-map)
20. [Known bugs & fixes](#known-bugs--fixes)

---

## What this is

A desktop softphone that:

- Registers to a SIP PBX over secure WebSocket (`wss://`).
- Places outgoing calls and answers incoming calls with WebRTC media.
- Uses ICE/STUN/TURN for NAT traversal, DTLS for key exchange, SRTP for media.
- Synthesizes its own ringtone (Web Audio API — no audio files needed).
- Keeps a local call history, contact list with CSV import/export, and a
  live in-app log viewer with disk persistence.
- Supports DTMF (RFC 4733 with INFO fallback), hold/resume, mute, blind transfer.
- Persists settings (profiles, audio devices, UI prefs) to an encrypted
  electron-store on disk.
- Runs as a single instance — a second launch focuses the first window.

The PBX is **not** part of this app. This is the client only. The PBX must
expose a WebSocket transport (WSS) and WebRTC media endpoint.

---

## Tech stack

| Layer        | Choice                                           | Why                                      |
|--------------|--------------------------------------------------|------------------------------------------|
| Shell        | Electron 33                                      | Cross-platform desktop, system audio     |
| Build        | electron-vite 2 + Vite 5                         | Fast HMR for renderer, bundled main      |
| UI           | React 18 + react-router-dom 6                    | Component model + light routing          |
| State        | Zustand 5                                        | No boilerplate, no providers             |
| Styling      | Tailwind CSS 3                                   | Utility-first, dark theme baked in       |
| Language     | TypeScript 5.6 (strict)                          | Two tsconfig projects: web + node        |
| SIP/WebRTC   | sip.js 0.21                                      | SIP over WebSocket + WebRTC SDH          |
| Storage      | electron-store 8 (AES-256-CBC)                   | Encrypted settings at rest               |
| Packaging    | electron-builder 25                              | NSIS / AppImage / deb / rpm / dmg        |
| Notifications| Electron `Notification`                          | Native OS notifications for incoming     |

No test framework is used. Self-checks are plain Node `assert` scripts (see
[Testing](#testing--self-checks)).

---

## Project layout

```
glmwebrtc/
├── electron.vite.config.ts        # 3-target build config (main/preload/renderer)
├── electron-builder.yml           # packaging config (win/linux/mac targets)
├── package.json                   # scripts, deps, electron main entry
├── tsconfig.json                  # composite root (references node + web)
├── tsconfig.node.json             # main + preload + shared (node types)
├── tsconfig.web.json              # renderer + shared (DOM lib)
├── tailwind.config.cjs            # brand/danger/ok/warn palette + animations
├── postcss.config.cjs
├── .eslintrc.cjs
├── .prettierrc
├── build/                         # packaging resources (icons go here)
├── out/                           # built output (gitignored)
├── dist/                          # installers (gitignored)
└── src/
    ├── shared/                    # imported by BOTH main and renderer
    │   ├── types.ts               # IPC channel map, AppSettings, SipProfile…
    │   ├── constants.ts           # DEFAULT_SETTINGS, formatDuration, genId…
    │   └── selfcheck.test.mjs     # pure-helper self-check
    ├── main/                      # Electron main process (Node)
    │   ├── index.ts               # app lifecycle, single-instance lock
    │   ├── window.ts              # BrowserWindow factory
    │   ├── ipc.ts                 # ipcMain handlers + validators
    │   ├── store.ts               # electron-store wrapper (encrypted settings)
    │   └── logger.ts              # FileLogger: daily files, 7-day retention
    ├── preload/                   # Electron preload (runs in isolated context)
    │   └── index.ts               # contextBridge.exposeInMainWorld('api', …)
    └── renderer/                  # React app (browser context)
        ├── index.html             # CSP meta, root div, entry script
        └── src/
            ├── main.tsx           # ReactDOM root + HashRouter (no StrictMode)
            ├── App.tsx            # top-level layout + remote <audio> element
            ├── index.css          # tailwind imports + scrollbar styling
            ├── sip/
            │   ├── SipEngine.ts   # SIP.js wrapper, state machine, call control
            │   └── SipService.test.mjs  # state-machine transition self-check
            ├── audio/
            │   └── AudioManager.ts# device enumeration, ringtone synth, mic meter
            ├── store/             # Zustand stores
            │   ├── settings.ts    # profiles, audio prefs, UI prefs
            │   ├── sip.ts         # presence + connect/disconnect
            │   ├── call.ts        # active calls + history
            │   └── contacts.ts    # contact list (localStorage)
            ├── lib/
            │   └── logger.ts      # renderer ring buffer + forward-to-main
            └── components/        # React UI
                ├── ui.tsx         # Button, Input, Card, Toggle, Select, PresenceDot
                ├── StatusBar.tsx  # presence + nav
                ├── Login.tsx      # profile editor + WSS tester + connect
                ├── Dialpad.tsx    # dial input, keypad, recents, DtmfPad export
                ├── CallView.tsx   # in-call UI (mute/hold/dtmf/transfer/hangup)
                ├── IncomingCall.tsx  # full-screen incoming call overlay
                ├── Settings.tsx   # audio devices, codecs, transport, UI, logs
                ├── Contacts.tsx   # contact list + CSV import/export
                ├── History.tsx    # call history with filters + CSV export
                └── Logs.tsx       # live in-app log viewer
```

---

## Architecture

This is a standard 3-process Electron app. Each process has a clear boundary.

### Process model

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│   MAIN PROCESS (Node)      │        │   RENDERER (browser context)  │
│   src/main/*               │  IPC   │   src/renderer/*              │
│                            │◄──────►│                              │
│  • window.ts (BrowserWin)  │        │  • React UI                  │
│  • store.ts (electron-store)│       │  • sipEngine (SIP.js)        │
│  • ipc.ts (handlers)       │        │  • audioManager (Web Audio)  │
│  • logger.ts (disk logs)   │        │  • Zustand stores            │
│  • Notification, dialog    │        │  • <audio> element for remote│
└────────────────────────────┘        └──────────────────────────────┘
                  ▲
                  │ contextBridge
                  ▼
         ┌─────────────────┐
         │   PRELOAD        │
         │   src/preload/*  │
         │   exposes window │
         │   .api           │
         └─────────────────┘
```

### Why three processes

- **Main** has Node access — reads/writes disk (settings, logs), shows native
  dialogs and notifications, controls the window lifecycle. No DOM.
- **Renderer** has the DOM — runs React, SIP.js, WebRTC, Web Audio. No Node
  access (`nodeIntegration: false`, `contextIsolation: true`).
- **Preload** is the only bridge — runs in an isolated context with Node
  access and exposes a minimal `window.api` via `contextBridge`. The renderer
  never touches `ipcRenderer` directly.

This is the Electron security best practice. The renderer is untrusted code
(even though it's ours) — keeping Node out of it means a compromised renderer
can't spawn processes or read the filesystem.

### Data flow for a call

```
User clicks "Call"
  └─ Dialpad.tsx → useCall.makeCall(target)
       └─ store/call.ts → sipEngine.makeCall(target)
            └─ SipEngine.ts → new SIP.js Inviter
                 ├─ session.stateChange → bindSession listener
                 ├─ SDP offer/answer over WSS (SIP.js handles)
                 └─ RTCPeerConnection → ICE → DTLS → SRTP
                      └─ ontrack → remote MediaStream
                           └─ attachRemoteAudio() →
                                audio.srcObject = stream
                                audio.play()
                                ↑ sound comes out here
```

### Singleton discipline

Two singletons are load-bearing:

1. **`sipEngine`** (`src/renderer/src/sip/SipEngine.ts:881`) — exactly one
   SIP.js `UserAgent` and one `Registerer` per app lifetime. The state
   machine in `SipEngine.ts` enforces this: duplicate `initialize()` calls
   are deduped by `initPromise`, and a `generation` counter invalidates stale
   async inits after `shutdown()`.

2. **`audioManager`** (`src/renderer/src/audio/AudioManager.ts:154`) — owns
   the shared `AudioContext` for ringtones and the mic level meter.

Do not create a second `UserAgent`, a second `AudioContext`, or a second
`<audio>` element wired to `sipEngine.setRemoteAudio()` — all three will
break call audio (see [Troubleshooting](#troubleshooting)).

---

## Getting started

### Prerequisites

- **Node.js 20+** (LTS recommended; tested on 22)
- **npm 10+** (bundled with Node)
- A **SIP/WebRTC PBX** reachable over WSS with a valid certificate (or a
  self-signed cert installed in the OS trust store — Electron uses the OS
  cert store, not its own)

### Install

```bash
cd glmwebrtc
npm install
```

### Run in dev (hot reload)

```bash
npm run dev
```

This launches electron-vite's dev server with HMR for the renderer and
rebuilds main/preload on change. The Electron window opens automatically.

### Run the built output

```bash
npm run build       # builds main + preload + renderer into out/
npm run preview     # launches Electron against the built files (no HMR)
```

---

## Scripts

| Script                | What it does                                                |
|-----------------------|-------------------------------------------------------------|
| `npm run dev`         | electron-vite dev server with HMR — the main dev loop       |
| `npm run build`       | Build all 3 targets into `out/`                             |
| `npm run preview`     | Launch Electron against `out/` (no HMR, tests the build)    |
| `npm run typecheck`   | `tsc --noEmit` on both `tsconfig.node.json` and `.web.json` |
| `npm run lint`        | ESLint on all `.ts`/`.tsx`                                  |
| `npm run format`      | Prettier write on renderer source                           |
| `npm run dist`        | Build + package installers for current OS into `dist/`      |
| `npm run dist:win`    | Build + package Windows NSIS installer                      |
| `npm run dist:linux`  | Build + package AppImage + deb + rpm                        |
| `npm run dist:mac`    | Build + package dmg (x64 + arm64)                           |

---

## Configuration

### App settings

All user-tunable settings live in one object — see `src/shared/types.ts`
for `AppSettings`. Defaults are in `src/shared/constants.ts:DEFAULT_SETTINGS`.

```ts
interface AppSettings {
  activeProfileId: string | null;
  profiles: SipProfile[];          // one or more PBX accounts
  audio: AudioPrefs;               // devices, DSP, ringtone
  ui: UiPrefs;                     // theme, tray, startup
  log: { level: LogLevel; retentionDays: number };
  codecs: string[];                // preference order: opus, G722, PCMU…
  transport: {
    reconnectionAttempts: number;  // 0 = infinite
    reconnectionDelay: number;     // seconds (base for backoff)
    keepAliveInterval: number;
    ackTimer: number;
  };
}
```

Settings are stored to disk via `electron-store` with AES-256-CBC encryption
(`src/main/store.ts`). The store path is logged on startup — look for
`settingsPath: …` in the logs. On Linux this is typically
`~/.config/glmwebrtc/glmwebrtc-settings.json` (encrypted blob, not plaintext).

### SIP profiles

A profile is one PBX account:

```ts
interface SipProfile {
  id: string;
  label: string;                   // human name: "Office", "Issabel"
  displayName: string;             // SIP Display-Name header
  username: string;                // extension or username
  password: string;                // stored encrypted at rest
  sipDomain: string;               // pbx.example.com
  wsUrl: string;                   // wss://pbx.example.com:8089/ws
  iceServers?: IceServerSpec[];    // STUN/TURN; defaults to Google STUN
  preferredCodec?: string;
  autoAnswer?: boolean;            // answer incoming without user interaction
  dnd?: boolean;                   // do-not-disturb (UI hint)
}
```

Profiles are managed in the Login screen. Multiple profiles can be saved;
only one is active at a time (`activeProfileId`).

### PBX requirements

The PBX must provide:

1. **WSS transport** — a WebSocket Secure endpoint speaking the SIP protocol.
   For Asterisk this is `http.conf` with `enabled=yes` and a TLS cert, plus
   `transports=ws` in `pjsip.conf`. The `wsUrl` field points here, e.g.
   `wss://pbx.example.com:8089/ws`.
2. **WebRTC-enabled endpoint** — the SIP endpoint must accept WebRTC SDP
   offers (ICE, DTLS-SRTP). For Asterisk: `media_use_received_transport=yes`,
   `dtls_verify=no` (or a real cert), `rtp_symmetric=yes`,
   `force_rport=yes`, `rewrite_contact=yes`.
3. **STUN/TURN** (if NAT is involved) — configure `iceServers` in the profile.
   The default is `stun:stun.l.google.com:19302` which is fine for testing
   but insufficient for symmetric NAT — add a TURN server for production.
4. **Valid TLS certificate** — Electron uses the OS trust store. Self-signed
   certs must be installed as a trusted CA at the OS level, or the WSS
   handshake will fail silently.

---

## The SIP/WebRTC media pipeline

This is the heart of the app. Read this section before touching anything in
`SipEngine.ts` or `App.tsx`.

### Layers

```
SIP.js (sip.js 0.21)
  └─ UserAgent              — SIP stack, WebSocket transport
  └─ Registerer             — handles REGISTER/401/407 auth cycle
  └─ Inviter / Invitation   — outbound/inbound call session
       └─ SessionDescriptionHandler (SDH)
            └─ RTCPeerConnection
                 ├─ getSenders()    — our mic → PBX
                 ├─ getReceivers()  — PBX → our speaker
                 └─ ontrack event   — fired when a remote track arrives
                      └─ MediaStream → <audio>.srcObject → speaker
```

### The remote audio element — critical wiring

There is **exactly one** `<audio>` element in the app, rendered in `App.tsx`.
It is the sink for all remote audio. SIP.js's SDH puts remote tracks into a
`MediaStream` accessible as `sdh.remoteMediaStream`; our `attachRemoteAudio()`
pipes that stream into the `<audio>` element and calls `play()`.

```html
<!-- App.tsx -->
<audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
```

**The callback ref is load-bearing.** `App.tsx` renders the `<audio>` element
in two separate conditional branches (offline/Login vs online). A plain
`useRef` + `useEffect([])` only registers the *first* element. When the user
logs in, React unmounts the Login branch's element and creates a new one in
the online branch — but `sipEngine.remoteAudio` would still hold the old,
**detached** element. `srcObject` would be set on a detached node and no
sound would play. The callback ref re-registers on every mount.

If you restructure `App.tsx`, preserve this property: the audio element must
re-register with `sipEngine.setRemoteAudio()` every time it mounts.

### When audio attaches

`attachRemoteAudio(session)` runs on `SessionState.Established` — the SIP
session is connected, SDP answer is in, ICE has succeeded. It:

1. Reads `sdh.remoteMediaStream` (the stream SIP.js built from `ontrack`).
2. Sets `audio.srcObject = stream`.
3. Calls `audio.play()` and logs success or the exact `DOMException`.
4. Dumps all `<audio>` elements in the DOM (catches accidental duplicates).
5. Dumps `pc.getReceivers()` — verifies an audio receiver with a `live` track.
6. Calls `pc.getStats()` — finds the inbound audio RTP report and logs
   `packetsReceived`, `bytesReceived`, `jitter`, `audioLevel`.
7. Starts a 3-second poll that logs `packetsReceived` deltas — if the number
   is increasing, media is arriving at the peer connection.
8. Applies `setSinkId()` if a non-default output device is configured.

### The `ontrack` listener

SIP.js sets `pc.ontrack` internally (`session-description-handler.js:881`)
to feed remote tracks into its `remoteMediaStream`. We attach a **second**
listener via `addEventListener('track')` in `hookPeerConnection()` — this
**always** sets `audio.srcObject = event.streams[0]` and calls `play()` on
every audio track event. This is idempotent (setting `srcObject` to the
stream it already has is harmless; `play()` on an already-playing element
resolves immediately) and covers three cases:

1. **Initial call setup** — `srcObject` is null → first attach.
2. **Resume from hold** — SIP.js's `setRemoteTrack` replaces the track (old
   track stopped, new track added); the stream object is reused so
   `srcObject` is non-null, but the element needs `play()` called again.
3. **Any PBX-initiated renegotiation** that produces a new track.

Do **not** re-add a `!this.remoteAudio.srcObject` guard to this handler —
it will skip the resume case. See BUGS.md #003.

### Mute, hold, DTMF, hangup

- **Mute** (`setMute`): toggles `sender.track.enabled` on the audio sender.
  The track stays live; bytes still flow (comfort noise may be sent). This
  is the standard WebRTC mute — no SIP re-INVITE needed.
- **Hold** (`hold`): sends a re-INVITE with
  `sessionDescriptionHandlerOptions: { hold: true }`. This makes SIP.js's
  `updateDirection()` call `transceiver.setDirection("sendonly")` *before*
  `createOffer()`, so the offer naturally contains `a=sendonly` and the
  transceiver's internal state stays consistent. Do **not** use the
  `holdModifier` — it modifies SDP text *after* `createOffer()`, which
  desyncs the transceiver's direction state and breaks resume. See
  BUGS.md #003.
- **Resume** (`resume`): sends a re-INVITE with
  `sessionDescriptionHandlerOptions: { hold: false }` (resets transceiver
  direction to `sendrecv` before `createOffer`), then re-attaches the
  remote audio via `attachRemoteAudio` inside the `requestDelegate.onAccept`
  callback. The `onAccept` hook is load-bearing: `s.invite()` resolves when
  the INVITE is **sent**, not when the 200 OK arrives — so `await
  s.invite()` runs before the SDP answer is applied. `onAccept` fires
  after `setAnswer` → `setRemoteDescription` completes (SIP.js
  `session.js:374-378`), which is the earliest point where the track
  direction is updated and RTP can flow. `attachRemoteAudio` also
  explicitly re-enables the receiver track (`enabled = true`) as a safety
  net. See BUGS.md #003.
- **DTMF** (`sendDtmf`): tries RFC 4733 telephone-event via the SDH first;
  falls back to SIP INFO with `application/dtmf-relay` body if the SDH
  doesn't support it or throws.
- **Blind transfer** (`blindTransfer`): sends a REFER to the PBX with
  `Refer-To: sip:target@domain`. The `onNotify` callback tracks transfer
  progress via NOTIFY messages (sipfrag body: `SIP/2.0 200 OK` = success,
  `SIP/2.0 486 Busy Here` = failure). On success
  (`Subscription-State: terminated` + `200 OK`), the original call is
  hung up via BYE. On failure, the original call stays alive. See
  BUGS.md #004.
- **Hangup** (`hangup` → `terminateInternal`): dispatches on session **state**,
  not method existence:
  - `Established` → `session.bye()` — sends SIP BYE, tears down the confirmed
    dialog. This is the only correct way to end a connected call.
  - `Initial` / `Establishing` + `Inviter` → `session.cancel()` — sends SIP
    CANCEL (pre-answer hangup of an outbound call).
  - `Initial` / `Establishing` + `Invitation` → `session.reject()` — sends
    487 Request Terminated (pre-answer reject of an inbound call).

  The state-based dispatch is load-bearing. An `Inviter` has *both* `cancel()`
  and `bye()`. If you check `typeof session.cancel === 'function'` first and
  the call is `Established`, `cancel()` rejects with `"Invalid session state
  Established"` — and if the catch block swallows that error, **no BYE is
  sent** and the remote channel stays alive on the PBX. See BUGS.md #002.

### Reconnection

Transport drops are handled by an exponential-backoff reconnect that reuses
the existing `UserAgent` — never creates a new one. State machine:

```
registered → reconnecting → (backoff) → ua.reconnect()
                                  ↓
                       connected → registering → registered
                                  ↓ (if still registered)
                              registered (no re-REGISTER needed)
```

Up to 10 attempts (configurable via `maxReconnectAttempts`), doubling from
2s up to a 60s cap. `shuttingDown` flag prevents reconnect during intentional
disconnect.

---

## State management

Four Zustand stores, no React Context. Each store is a singleton created with
`create()` and consumed via hooks `useX(selector)`.

| Store              | File                          | Owns                                       |
|--------------------|-------------------------------|--------------------------------------------|
| `useSettings`      | `store/settings.ts`           | AppSettings, profiles CRUD, load/patch     |
| `useSip`           | `store/sip.ts`                | presence, transport flag, connect/disconnect |
| `useCall`          | `store/call.ts`               | active calls, currentId, history, all call ops |
| `useContacts`      | `store/contacts.ts`           | contact list (localStorage), CSV, search   |

### Binding pattern

The stores bind to `sipEngine` events **once** via a module-level `bound`
flag (`store/call.ts:25`, `store/sip.ts:33`). The first call to a store
action triggers `bind(set, get)` which subscribes to `sipEngine.on('…')`.
This avoids a separate init step and survives React's effect lifecycle.

### Why Zustand over Redux/Context

- No provider tree, no boilerplate, no action types.
- Selectors prevent unnecessary re-renders (`useSip((s) => s.presence)`
  only re-renders when presence changes).
- Stores are plain objects — testable without React.

### Persistence

- **Settings** → main process electron-store (encrypted), via IPC.
- **Call history** → renderer `localStorage` under `glmwebrtc:history`
  (capped at 500 records).
- **Contacts** → renderer `localStorage` under `glmwebrtc:contacts`
  (capped at 2000).

History and contacts use localStorage because they're renderer-only data
with no security sensitivity. Settings use the encrypted electron-store
because they contain SIP passwords.

---

## IPC bridge

The IPC channel map is the single source of truth — `src/shared/types.ts:IPC`.
Adding a new channel is three edits:

1. **`src/shared/types.ts`** — add the channel name to `IPC` and the method
   signature to `MainApi`.
2. **`src/preload/index.ts`** — add the `ipcRenderer.invoke(IPC.YOUR, …)` line.
3. **`src/main/ipc.ts`** — add the `ipcMain.handle(IPC.YOUR, …)` with a
   validator.

### Existing channels

| Channel                    | Direction  | Payload                | Returns           |
|----------------------------|------------|------------------------|-------------------|
| `settings:get`             | render→main| —                      | `AppSettings`     |
| `settings:set`             | render→main| `Partial<AppSettings>` | `AppSettings`     |
| `log:write`                | render→main| `LogEntry`             | `void`            |
| `log:export`               | render→main| —                      | `string` (all logs)|
| `notify:show`              | render→main| `NotifyOptions`        | `void`            |
| `app:quit`                 | render→main| —                      | `void`            |
| `app:minimize`             | render→main| —                      | `void`            |
| `app:launch-at-startup`    | render→main| `boolean`              | `void`            |
| `dialog:open-csv`          | render→main| —                      | `string \| null`  |
| `dialog:save-csv`          | render→main| `defaultName`          | `string \| null`  |

### Validators

`ipc.ts` has per-channel type guards (`isObject`, `isLogEntry`, `isNotify`).
They throw on bad input — the renderer's `ipcRenderer.invoke` rejects.
Promote to a zod schema if the IPC surface grows significantly.

### Content Security Policy

The renderer HTML ships a CSP (`src/renderer/index.html:5`):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
media-src 'self' blob:;          ← allows MediaStream → <audio> (blob:)
connect-src 'self' wss: ws:;     ← allows WebSocket to PBX
```

`'unsafe-inline'` on styles is required by Tailwind's injected styles. Do
**not** add `'unsafe-inline'` to `script-src`. The `blob:` on `media-src`
is what lets the WebRTC `MediaStream` play through `<audio>` — don't remove it.

---

## Logging

Two-tier logging: renderer ring buffer + main-process disk files.

### Renderer side (`src/renderer/src/lib/logger.ts`)

- In-memory ring buffer (500 entries) for the live Logs viewer.
- Every entry is forwarded to main via `window.api.writeLog(entry)`.
- `subscribeLogs(cb)` — the Logs component subscribes for live updates.
- Levels: `debug`, `info`, `warn`, `error`.

### Main side (`src/main/logger.ts`)

- `FileLogger` writes to `<userData>/logs/app-YYYY-MM-DD.log`.
- Daily rotation by filename; 7-day retention swept on startup.
- `exportLog()` reads all log files concatenated (newest last).
- Disk writes are wrapped in try/catch — logging never throws.

### Log scopes

Conventions for the `scope` field:

| Scope      | Used by                                          |
|------------|--------------------------------------------------|
| `app`      | App.tsx lifecycle, auto-connect                  |
| `sip`      | SipEngine (all SIP state, calls, media pipeline) |
| `audio`    | AudioManager, audio element binding              |
| `settings` | settings store                                   |
| `history`  | call history writes                              |
| `incoming` | incoming call handling, auto-answer/reject       |
| `login`    | WSS test, profile save                           |
| `ipc`      | IPC handler activity                             |
| `main`     | main process lifecycle                           |

### Viewing logs

- **In-app**: the Logs tab (`/logs` route) shows the live ring buffer with
  level filters and export.
- **On disk**: `<userData>/logs/`. On Linux: `~/.config/glmwebrtc/logs/`.
  On Windows: `%APPDATA%/glmwebrtc/logs/`. On macOS:
  `~/Library/Application Support/glmwebrtc/logs/`.
- **DevTools console**: sip.js logs are suppressed (`logBuiltinEnabled:
  false`); our own logs go through the renderer logger only.

---

## Persistence

| What              | Where                          | Encrypted | Cleared when        |
|-------------------|--------------------------------|-----------|---------------------|
| Settings + profiles| electron-store on disk        | AES-256-CBC | Manual only       |
| Call history      | `localStorage` (renderer)      | No        | Clearable in UI     |
| Contacts          | `localStorage` (renderer)      | No        | Per-contact delete  |
| Logs              | `<userData>/logs/*.log`        | No        | 7-day auto-sweep    |

The encryption key in `src/main/store.ts` is a placeholder string — rotate
it before a real release, or better, migrate to Electron `safeStorage` which
uses the OS keychain (keytar-free on modern Electron). The `ponytail:`
comment in that file names this.

---

## Audio diagnostics

The app has a built-in media pipeline diagnostic system, added to debug the
"no remote audio" class of bugs. All of it is in `SipEngine.ts`.

### What gets logged during a call

On `SessionState.Established`, `attachRemoteAudio()` logs:

1. **`ontrack` events** — `kind`, `readyState`, `enabled`, `muted`,
   `streams.length` for every remote track.
2. **Audio element state before attach** — `srcObject`, `inDOM`, `muted`,
   `volume`, `paused`.
3. **Remote MediaStream tracks** — kind, readyState, enabled, muted.
4. **`srcObject` assignment** — confirms the stream is on the element.
5. **`play()` result** — logs `SUCCEEDED` with state, or `FAILED` with the
   exact `DOMException` name and message.
6. **All `<audio>` elements in the DOM** — catches accidental duplicates.
   Logs `id`, `inDOM`, `muted`, `volume`, `paused`, `currentTime`,
   `srcObject`, `autoplay`, `playsInline`.
7. **`pc.getReceivers()`** — verifies an audio receiver with a `live` track
   exists.
8. **`pc.getStats()` inbound-rtp** — `packetsReceived`, `bytesReceived`,
   `jitter`, `audioLevel`, `packetsLost`.
9. **3-second polling** — logs `packetsReceived` delta. If it's increasing,
   media is arriving at the peer connection.

### On-demand diagnosis

From the DevTools console during a call:

```js
sipEngine.diagnoseAudioPipeline()
```

(or `sipEngine.diagnoseAudioPipeline('callId')` to target a specific call).
This re-runs all the checks above and logs the result.

### Reading the logs to find the break

If there's no sound, check the Logs tab in this order:

1. **`ontrack` fired?** No `ontrack(…)` line = SIP.js never got a remote
   track. Problem is upstream (PBX, ICE, DTLS).
2. **`audio receiver OK — track is live`?** No = the receiver exists but
   the track isn't live. Media isn't flowing.
3. **`inbound audio RTP: packetsReceived=…`** Zero or not increasing = media
   isn't arriving at the peer connection, even if ICE succeeded. Check the
   PBX side.
4. **`audio.play() SUCCEEDED`?** If it threw, the error name tells you:
   `NotAllowedError` = autoplay policy blocked it (needs user gesture);
   `AbortError` = play() was interrupted by a load or pause.
5. **`inDOM=true`?** If `false`, the audio element is detached — the
   callback-ref wiring in `App.tsx` is broken.
6. **`srcObject=yes`?** If `null`, the stream never got attached.
7. **`DOM audio elements: 1`?** If more than 1, a second `<audio>` was
   created somewhere — find and remove it.

---

## Code conventions

### Strict TypeScript

Both `tsconfig.node.json` and `tsconfig.web.json` are `strict: true` with
`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. The
`typecheck` script enforces both. Run it before every commit.

### Path aliases

| Alias        | Resolves to              | Used in            |
|--------------|--------------------------|--------------------|
| `@shared/*`  | `src/shared/*`           | main, preload, renderer |
| `@renderer/*`| `src/renderer/src/*`     | renderer only      |

Aliases are wired in `electron.vite.config.ts` and both tsconfigs.

### `ponytail:` comments

The codebase uses `ponytail:` comments to mark deliberate simplifications —
shortcuts taken on purpose, with the upgrade path named. These are not TODOs
in the usual sense; they're documented decisions. Examples:

```ts
// ponytail: plaintext password in memory only; electron-store
// encryption-at-rest handles disk.
// ponytail: global lock, per-account locks if throughput matters.
// ponytail: full drag-and-drop reorder deferred — edit array in store.
```

When you encounter one, read the ceiling it names before "fixing" it. If the
ceiling hasn't been hit, leave it. If it has, upgrade and remove the comment.

### No comments otherwise

Per the project's code style: no comments unless they're a `ponytail:`
marker or explain a non-obvious *why*. The code is meant to be
self-documenting; comments are debt.

### State machine comments

`SipEngine.ts` opens with an ASCII state diagram. Keep it in sync if you
add states or transitions.

### ESM imports in `.mjs` test files

The self-check files import from `.ts` files directly:

```js
import { normalizeSipUri, safePhone, formatDuration } from './constants.ts';
```

This works because Node 22+ supports `--experimental-strip-types` implicitly
for `.ts` imports from `.mjs`. No compiler needed for the self-checks.

---

## Testing & self-checks

There is no test framework. Two `assert`-based self-checks exist:

```bash
# SipService state machine — verifies all valid transitions are allowed
# and all invalid ones are blocked.
node src/renderer/src/sip/SipService.test.mjs

# Pure helpers — normalizeSipUri, safePhone, formatDuration.
node src/shared/selfcheck.test.mjs
```

Both print `N/N passed` and exit non-zero on failure. Run them after
touching `SipEngine.ts` state transitions or `constants.ts` helpers.

### Type checking

```bash
npm run typecheck    # tsc --noEmit on both node and web projects
npm run lint         # eslint on .ts/.tsx
```

Run both before committing. `typecheck` catches the vast majority of
regressions in this codebase because of the strict config.

### Manual test checklist

Before releasing, verify by hand:

1. Register to a PBX — status bar shows "Online".
2. Place an outbound call — hear remote audio (the canonical test).
3. Receive an inbound call — ringtone plays, answer works, hear audio.
4. Mute / unmute — remote party confirms.
5. Hold / resume — remote party confirms hold music then return.
6. DTMF keypad — remote IVR responds to digits.
7. Hang up and re-dial — second call has audio (no stale state).
8. Kill the WSS connection (block network) — app shows "Connection Lost",
   reconnects when network returns.
9. Quit and relaunch — profile auto-connects, settings persisted.
10. Check the Logs tab — no `error` lines during a clean call.

---

## Building installers

```bash
# Build + package for the current OS
npm run dist

# Or target explicitly
npm run dist:win     # → dist/GLMWebrtc-0.1.0-x64-setup.exe (NSIS)
npm run dist:linux   # → dist/GLMWebrtc-0.1.0-x64.AppImage, .deb, .rpm
npm run dist:mac     # → dist/GLMWebrtc-0.1.0.dmg (x64 + arm64)
```

Config is in `electron-builder.yml`. Icons go in `build/` (`icon.ico`,
`icon.png`, `icon.icns`). The `build/` directory is gitignored except for
`.gitkeep` — add real icons before packaging.

### Code signing

Placeholders are in `electron-builder.yml`. Set the `CSC_LINK` and
`CSC_KEY_PASSWORD` environment variables before `dist:win` / `dist:mac`.
Linux packages aren't signed by default.

### Auto-update

`electron-builder.yml` has a GitHub `publish` block. Set `GH_TOKEN` and the
correct `owner`/`repo` before publishing. The auto-update consumer
(`electron-updater`) is **not** wired in yet — the `ponytail:` comment in
`electron-builder.yml` names this.

---

## Troubleshooting

### "Transfer button shows REFER accepted but call doesn't transfer"

The log shows "REFER accepted" but the call stays alive and the target
doesn't get the transferred call.

**Root cause**: `blindTransfer()` only handled the 202 Accepted response
and never processed the NOTIFY messages that carry the transfer status.
It also never hung up the original call after a successful transfer.

**The fix** (already applied): `blindTransfer()` now passes an `onNotify`
callback that logs each NOTIFY's `Subscription-State` and sipfrag body,
and hangs up the original call when the transfer succeeds (`terminated` +
`200 OK`). See BUGS.md #004.

### "No audio after resume from hold"

Hold works, but pressing Resume leaves the softphone silent. The remote
party can hear you; you can't hear them. The call shows as connected.

**Root cause**: the `holdModifier` modified SDP *text* after
`createOffer()`, desyncing the WebRTC transceiver's internal direction
state. On resume, the transceiver stayed stuck at `sendonly` internally —
the offer went out with the wrong direction, the PBX answered accordingly,
and the receiver never resumed. The track stayed `muted=true` and no RTP
flowed (confirmed by `getStats()` showing zero inbound-rtp reports).

**The fix** (already applied): replaced `holdModifier` with
`sessionDescriptionHandlerOptions: { hold: true/false }`, which calls
`transceiver.setDirection()` *before* `createOffer()` — keeping the
transceiver state consistent with the SDP. Resume also uses
`requestDelegate.onAccept` as the hook point for `attachRemoteAudio`
(fires after `setAnswer` completes). See BUGS.md #003.

### "Call ends on softphone but channel stays alive on Asterisk"

The softphone shows the call as ended, but `asterisk -rx "core show channels"`
shows the channel still up — announcements/queues keep running.

**Root cause**: `terminateInternal()` dispatched on *method existence* instead
of *session state*. An `Inviter` has both `cancel()` and `bye()`. The code
called `cancel()` first; SIP.js's `Inviter.cancel()` rejects with `"Invalid
session state Established"` for an established call, and the empty `catch {}`
swallowed the error — so `bye()` was never reached and no BYE went on the wire.

**The fix** (already applied): `terminateInternal` now dispatches on
`session.state`:
- `Established` → `bye()` (sends SIP BYE)
- `Initial`/`Establishing` + `Inviter` → `cancel()` (sends SIP CANCEL)
- `Initial`/`Establishing` + `Invitation` → `reject()` (sends 487)

The catch block also logs the error now instead of silently swallowing it.
See BUGS.md #002 for the full analysis.

### "No sound from the app during a call"

This is the canonical bug. The root cause (already fixed) was a **detached
audio element**: `App.tsx` rendered `<audio>` in two conditional branches,
but `sipEngine.setRemoteAudio()` was only called once on mount with the
Login branch's element. Logging in unmounted that element, leaving
`sipEngine` holding a detached node — `srcObject` was set on a node not in
the DOM.

**The fix**: `App.tsx` uses a **callback ref** (`setAudioRef`) that
re-registers the audio element every time it mounts. If you restructure
`App.tsx`, preserve this — never go back to `useRef` + `useEffect([])`.

**If it regresses**: open the Logs tab during a call and look for:

- `attachRemoteAudio: no audio element registered` → the callback ref
  isn't firing; check `App.tsx`.
- `audio.play() FAILED: NotAllowedError` → autoplay blocked; needs a user
  gesture before `play()`. The `autoPlay` attribute + user click to answer
  should cover this.
- `DOM audio elements: 0` → the `<audio>` isn't rendering at all.
- `DOM audio elements: 2` → a second `<audio>` was created somewhere.
- `NO audio receiver found` → PBX didn't negotiate an audio track.
- `inbound audio RTP: packetsReceived=0` → media isn't arriving (PBX/ICE
  issue, not this app).

Then run `sipEngine.diagnoseAudioPipeline()` from the DevTools console for
the full dump.

### "Registration failed: auth"

Wrong username or password. Check the profile in the Login screen. SIP.js
handles the 401/407 digest auth challenge automatically — if it fails, the
credentials are wrong.

### "Registration failed: connection error" / "WSS test failed"

The WSS endpoint is unreachable. Common causes:

- Wrong `wsUrl` — must include `wss://` and the path (often `/ws`).
- Self-signed cert not trusted — install the CA in the OS trust store.
- Firewall blocking the WSS port (commonly 8089).
- PBX not configured for WebSocket transport.

The Login screen has a "Test WSS" button that tries a raw WebSocket
connection to the `wsUrl` and reports success/timeout/error.

### "Calls connect but no audio in either direction"

Check the Logs tab for `inbound audio RTP: packetsReceived=…`. If it's
zero, the PBX is sending media but ICE/DTLS is failing — check the PBX's
RTP stats. If packets are arriving but no sound, it's the audio element
wiring — see the "No sound" section above.

### "Echo / audio feedback"

Enable Echo Cancellation in Settings → Audio. If still present, lower the
speaker volume or use a headset. The DSP flags (`echoCancellation`,
`noiseSuppression`, `autoGainControl`) are passed to `getUserMedia` in
`SipEngine.callSdhOptions()`.

### "Call audio is choppy / robotic"

Likely network jitter or codec mismatch. In Settings, prefer `opus` for
wideband quality or `PCMU`/`PCMA` for PSTN interop. Check `jitter` in the
`getStats()` log — sustained high jitter indicates network issues.

### "App won't start after a crash"

The encrypted settings store can be corrupted. Delete
`~/.config/glmwebrtc/glmwebrtc-settings.json` (Linux) or the equivalent
on your OS — the app recreates it with defaults. The path is logged on
startup as `settingsPath`.

### StrictMode warning

`src/renderer/src/main.tsx` deliberately does **not** wrap the app in
`<React.StrictMode>`. StrictMode double-invokes effects in dev, which
caused duplicate `sipEngine.initialize()` calls and two SIP UserAgents.
The `initPromise` guard in SipEngine would catch this, but removing
StrictMode eliminates the race entirely. Do not re-add it.

---

## Security notes

- **`nodeIntegration: false`**, **`contextIsolation: true`** — the renderer
  has no Node access. All native operations go through the preload bridge.
- **`sandbox: false`** — required for the preload to use `ipcRenderer` in
  our contextBridge setup. Context isolation is still on, so the renderer
  itself is sandboxed from Node.
- **`webSecurity: true`**, **`allowRunningInsecureContent: false`** — no
  mixed content, no insecure WSS.
- **CSP** in `index.html` — no `'unsafe-inline'` for scripts, no
  `unsafe-eval`, `connect-src` limited to `wss:`/`ws:`.
- **SIP passwords** stored encrypted at rest (electron-store AES-256-CBC).
  In memory they're plaintext (unavoidable — SIP.js needs them). The
  encryption key in `store.ts` is a placeholder — rotate before release.
- **Single instance lock** — a second app process quits and focuses the
  first, preventing concurrent access to the encrypted store.
- **External links** open in the system browser (`shell.openExternal`),
  never inside the app — prevents navigation to untrusted pages.

### Before a production release

1. Rotate the electron-store encryption key (or migrate to `safeStorage`).
2. Add code signing certs (`CSC_LINK`, `CSC_KEY_PASSWORD`).
3. Set the real GitHub `owner`/`repo` in `electron-builder.yml`.
4. Add real icons to `build/`.
5. Wire `electron-updater` if auto-update is needed.
6. Audit the CSP for your PBX's WSS origin (consider pinning the host
   instead of allowing all `wss:`).

---

## File-by-file map

A quick reference for "where does X live?"

### Main process

| File                 | Responsibility                                          |
|----------------------|---------------------------------------------------------|
| `src/main/index.ts`  | App lifecycle, single-instance lock, ready→window+IPC   |
| `src/main/window.ts` | BrowserWindow factory (size, preload, CSP-adjacent)     |
| `src/main/ipc.ts`    | All `ipcMain.handle` registrations + input validators   |
| `src/main/store.ts`  | electron-store wrapper, log dir path                    |
| `src/main/logger.ts` | FileLogger: daily files, sweep, readAll for export      |

### Preload

| File                  | Responsibility                                |
|-----------------------|-----------------------------------------------|
| `src/preload/index.ts`| `contextBridge.exposeInMainWorld('api', …)`   |

### Shared

| File                  | Responsibility                                    |
|-----------------------|---------------------------------------------------|
| `src/shared/types.ts` | All shared types + `IPC` channel map + `MainApi`  |
| `src/shared/constants.ts` | `DEFAULT_SETTINGS`, `formatDuration`, `genId`, `normalizeSipUri`, `safePhone`, `LEVEL_ORDER`, `CODEC_LABELS` |

### Renderer — SIP engine

| File                          | Responsibility                                           |
|-------------------------------|----------------------------------------------------------|
| `src/renderer/src/sip/SipEngine.ts` | SIP.js wrapper, state machine, call control, media pipeline diagnostics |

### Renderer — audio

| File                              | Responsibility                                          |
|-----------------------------------|---------------------------------------------------------|
| `src/renderer/src/audio/AudioManager.ts` | Device enumeration, ringtone synth (Web Audio), mic meter |

### Renderer — stores

| File                                  | Responsibility                                     |
|---------------------------------------|----------------------------------------------------|
| `src/renderer/src/store/settings.ts`  | Load/patch settings, profile CRUD                  |
| `src/renderer/src/store/sip.ts`       | presence, connect/disconnect, bind to sipEngine    |
| `src/renderer/src/store/call.ts`      | Active calls, history, all call actions, bind      |
| `src/renderer/src/store/contacts.ts`  | Contact list (localStorage), CSV import/export    |

### Renderer — components

| File                                      | Responsibility                                       |
|-------------------------------------------|------------------------------------------------------|
| `src/renderer/src/App.tsx`                | Root layout, `<audio>` element, auto-connect         |
| `src/renderer/src/main.tsx`               | ReactDOM root + HashRouter (no StrictMode)           |
| `src/renderer/src/components/ui.tsx`      | Button, Input, Field, Label, Card, Toggle, Select, PresenceDot |
| `src/renderer/src/components/StatusBar.tsx` | Presence dot + nav                                |
| `src/renderer/src/components/Login.tsx`   | Profile editor, WSS tester, connect button          |
| `src/renderer/src/components/Dialpad.tsx` | Dial input, keypad, recents, `DtmfPad` export        |
| `src/renderer/src/components/CallView.tsx`| In-call UI: mute/hold/dtmf/transfer/hangup           |
| `src/renderer/src/components/IncomingCall.tsx` | Full-screen incoming overlay, ringtone, auto-reject |
| `src/renderer/src/components/Settings.tsx`| Audio devices, codecs, transport, UI, logs, window  |
| `src/renderer/src/components/Contacts.tsx`| Contact list + CSV import/export                    |
| `src/renderer/src/components/History.tsx` | Call history with filters + CSV export              |
| `src/renderer/src/components/Logs.tsx`    | Live log viewer with level filters + export         |

### Config

| File                          | Responsibility                                          |
|-------------------------------|---------------------------------------------------------|
| `electron.vite.config.ts`     | 3-target Vite config (main/preload/renderer) + aliases |
| `electron-builder.yml`        | Packaging: appId, targets, icons, publish              |
| `tsconfig.json`               | Composite root referencing node + web                  |
| `tsconfig.node.json`          | Main + preload + shared (Node types, strict)           |
| `tsconfig.web.json`           | Renderer + shared (DOM lib, strict, JSX)               |
| `tailwind.config.cjs`         | brand/danger/ok/warn palette, pulseRing animation      |
| `postcss.config.cjs`          | tailwindcss + autoprefixer                              |
| `.eslintrc.cjs`               | TypeScript ESLint rules                                 |
| `.prettierrc`                 | Format config                                           |

---

*Generated from the source. When the code and this doc disagree, the code
is right — fix the doc.*

---

## Known bugs & fixes

See [BUGS.md](./BUGS.md) for the full bug ledger — root cause analysis,
fixes, and prevention notes for each issue found and resolved.
