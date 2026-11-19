# AGENT-PORT-PLAN — Call Center agent mode for GLMWebrtc

Port of the **MicroSIP v1** call center agent toolbar (`call-center-project`,
branch `Microsip_v1`, commit `4014ea8`) into GLMWebrtc, plus a **native SIP
(UDP/TCP) + G.729** engine alongside the existing **WebRTC (WSS)** engine.

Status: **P1 done** (agent clone: login, status, queues, CRM pop, TLS trust).
**P2 done** (native engine: the pjsua helper, the facade, the engine switch).
**P3 code done** (the engine toggle in the agent login, the helper-presence
fallback, no renderer ringtone/mic on a native call, the helper stopped on a
window reload). **Live run (a) done** on 2026-11-19 with `agent2`/1003 (the
helper under wine, the real middleware): register 200, G.729 negotiated
(`#0 audio G729 @8kHz, sendrecv`), status_update, CRM pop, hold, hangup.
1002 has no extension in Issabel — `test` can log in but cannot register.

---

## 0. Scope and locked decisions

| # | Decision |
|---|---|
| D1 | Native mode is **Windows x64 only**. The prebuilt pjproject `.lib`s with G.729 cross-compile today via `cargo-xwin`. Linux/Android stay WebRTC-only. |
| D2 | The Rust crate is **copied into this repo** as `native/sip-engine/` (build artifacts gitignored, rebuilt by `tools/build-native.sh`). GLMWebrtc stays self-contained. |
| D3 | The **native helper owns the sound device** (WASAPI shared mode on Windows) and **plays the incoming ringtone itself**. Chromium never opens the audio device during native calls. |
| D4 | If `sip-helper.exe` is missing (Linux/Android), the **SIP option is hidden** and WebRTC becomes the default. |
| D5 | Self-signed certificates: **in-app per-host "allow untrusted certificate" toggle**, enabled by default for the configured agent host. |
| D6 | Live testing runs **against the mock middleware first (b)**, then a **spare production extension (a)**. `agent` / 1005 is **never** touched — a login as that extension drops the live session (`server.js:650`, "superseded by new login"). |

---

## 1. What is being ported, and from where

### 1.1 The middleware contract (authoritative source)

`call-center-project/MicroSIP-3.22.16-src/docs/agent-toolbar.md` is the
protocol specification. The implementation is
`call-center-project/middleware/server.js` and the executable specification is
`call-center-project/MicroSIP-3.22.16-src/tests/contract_test.js`.

**REST — `POST /api/login`** (`server.js:599`)

```jsonc
// request
{"username": "agent1", "password": "secret"}
// answer 200
{
  "sip_extension":   "1000",
  "sip_password":    "<secret of the sip table>",
  "sip_server_ip":   "192.168.2.22",
  "sip_server_port": 5060,
  "assigned_queues": ["800", "801"],
  "pause_reasons":   ["Break", "Pray"],
  "token":           "<jwt>",
  "timestamp":       1731380000
}
```

Notes:

* The answer carries **no `sip_domain`, no `ws_url` and no WSS port**. The WSS
  port (8089) and the SIP domain must be configured in the client.
* A wrong password answers **401** with `{"error": "Invalid credentials"}`.
* The agent password is stored **in plaintext** in `cc_agents.password`
  (`middleware/db.js:22-28`) and travels over **plain HTTP**. Flagged, not
  blocking on the LAN.

**WebSocket — `ws://<host>:8080/ws`**

* Auth: `Authorization: Bearer <token>` **in the header**. The server accepts
  the admin token in the query string, but **refuses the agent token there**
  (`server.js:1600-1612`).
* The url is derived from the api url (`http`→`ws`, `https`→`wss`, path `/ws`).

Server → client:

```jsonc
{"event":"ping"}                                              // every 30 s
{"event":"state_update","extension":"1000","status":"pause","reason":"Break",
 "assigned_queues":["800","801"],"timestamp":1731380000}
{"event":"crm_screen_pop","extension":"1005","agent_ext":"1005",
 "caller_id":"1333","uniqueid":"1794882400.1","is_new":false,
 "customer":{"id":4,"full_name":"Test Customer","tag":"VIP",
             "company":"Test Company","primary_phone":"1333",
             "secondary_phone":"","category_code":"Normal"},
 "last_interaction":{"disposition_code":"RESOLVED","notes":"…","created_at":"…"}}
```

Client → server:

```jsonc
{"event":"pong"}                                              // answer the ping, un-queued
{"event":"status_change","extension":"1000","status":"pause","reason":"Break"}
{"event":"status_change","extension":"1000","status":"offline","reason":""}  // logout
```

Rules that matter:

* **Two missed pongs → the middleware fires the AMI QueueRemove** and the agent
  leaves the queue. The pong is sent immediately and never queued.
* A `status_change` is **echoed** as a `state_update` carrying exactly what was
  sent. The echo must not restart the status timer.
* `pause_reasons` arrive with the login only; the production middleware never
  refreshes them on the socket (`server.js:1758-1766`).
* The `crm_screen_pop` goes **to the socket of the called agent only**
  (`server.js:2227-2245`).

### 1.2 The CRM record rules (ported from `Service/AgentUtil.h`)

| Rule | C++ | TS equivalent |
|---|---|---|
| Same caller | `AgentSameCaller` | last 10 digits equal, empty never matches |
| Freshness | `AgentCrmPopIsFresh(at, now, 30)` | `0 <= now - at <= 30 s` |
| Workspace url | `AgentWorkspaceUrl` | `CrmBaseUrl` + `?phone=…&uid=…` |
| Dashboard url | `AgentDashboardUrl` | `<apiUrl>/?token=…&phone=…&uid=…#crm-customers` |
| Status change detection | `AgentStatusChanged` | only a real change restarts the timer |

The record is shown **in the incoming call window**, and the browser opens the
record **when the call is answered**, never while it rings
(`call-center-project` commit `4014ea8`).

### 1.3 The native engine (already exists, proven)

`phonebar-project/crates/sip-engine` — a Rust crate over pjsua through bindgen
FFI:

| Need | Where |
|---|---|
| Commands | `src/lib.rs:52-63` — `Register / Unregister / Call / Answer / Mute / Hangup / Hold / Dtmf / Transfer / Shutdown` |
| Events | `src/engine.rs:32-60` — `Registration / Incoming / CallState / Media / Codecs / Error` |
| Codec priority | `src/engine.rs:412-437` — first name in the list gets priority 255 → `["G729","PCMA","PCMU"]` puts G.729 first |
| Owns the audio | `src/engine.rs:138-155` — the call slot is connected to sound device 0 |
| Threading | pjsua lives in its own thread, commands and events travel over channels |
| Reference app | `phonebar-project/dynamic-island-softphone/src-tauri/src/lib.rs:70-210` — the same command names in Tauri |

Build facts:

* The pjproject tree is patched for the codecs —
  `patch_pjproject.py:36` → `PJMEDIA_HAS_BCG729_CODEC=1;PJMEDIA_HAS_OPUS_CODEC=1`.
  G.729 and bcg729 symbols are present in the prebuilt
  `libpjproject-x64-Win32-vc14-Release-Static.lib`.
* The libs live in `crates/sip-engine/third_party/pjproject-win-x64/lib/`
  (`libpjproject-…Static.lib`, `bcg729.lib`, `opus.lib`) and are **gitignored**
  in the source project — rebuilt by `tools/build-pjproject-x64.sh` in the
  `msvc-wine:local` container.
* Toolchain present: rustc/cargo 1.100, `cargo-xwin`, target
  `x86_64-pc-windows-msvc`, libclang 21.
* Windows audio: `pjmedia-audiodev` ships `wasapi_dev.cpp`, `wmme_dev.c`,
  `alsa_dev.c`.

### 1.4 Why SIP.js cannot do the native mode

* `sip.js` 0.21 ships the **web platform only** (`node_modules/sip.js/lib/platform/web`).
  Its transport accepts a `udp:` url in the validator
  (`transport.js:52`) but `connect()` always builds a `new WebSocket(...)`
  (`transport.js:197`). No UDP, no TCP, no Node platform.
* G.729 is not a WebRTC codec. A native stack is genuinely required.

### 1.5 Why the middleware client lives in the Electron main process

* **CORS** — the middleware sends no CORS headers; the Tauri app hit this and
  routed the login through the Rust side
  (`phonebar-project/dynamic-island-softphone/src/services/MiddlewareApi.ts:20-24`).
  Chromium in the renderer would be blocked; the main process is not.
* **The web socket needs an `Authorization` header** — the browser `WebSocket`
  cannot set one, and Electron 33's main process is Node **20.18.3**, which has
  **no global `WebSocket`** (verified). The `ws` package is the way.

### 1.6 Facts verified against the live box (`192.168.2.22`)

| Check | Result |
|---|---|
| Middleware `/health` | `{"ok":true,"database":"up","agents":1}` |
| Asterisk | 20.12.0 |
| `wss://192.168.2.22:8089/ws` | **101 Switching Protocols** — but only with `Sec-WebSocket-Protocol: sip`, which SIP.js sends (`transport.js:197`) |
| TLS certificate | **self-signed**, `CN=issabel.local`, not in the trust store → D5 |
| Live agent | `agent` / ext **1005**, queue 802 — **do not log in as it** |

---

## 2. Architecture

```
┌─ renderer (React) ─────────────────────────────────────────────┐
│  AgentLogin (mode toggle)  →  agent store  →  AgentPanel       │
│  IncomingCall (+CRM card)  →  CallView / Dialpad               │
│  ┌──────────────────┐                                         │
│  │ engine facade    │  same API and events as today's SipEngine│
│  └────────┬─────────┘                                         │
└───────────┼─────────────────────────────────────────────────────┘
            │ IPC (preload, contextBridge)
┌───────────▼─────────────────────────────────────────────────────┐
│  Electron main                                                  │
│   agent.ts      middleware client: fetch login + ws (auth hdr)  │
│   sipBridge.ts  mode dispatch, pjsua state → CallSession        │
│   sipHelper.ts  spawn sip-helper.exe, JSON lines over stdio    │
└───────────┬──────────────────────────────┬──────────────────────┘
            │ wss + Authorization          │ stdio JSON
   ┌────────▼─────────┐          ┌─────────▼──────────────────┐
   │ Middleware :8080 │          │ sip-helper.exe             │
   │ (ws + REST)      │          │ Rust + pjsua + bcg729      │
   └──────────────────┘          │ owns the sound device      │
                                 └────────────────────────────┘
```

**Both modes share** the middleware web socket, the status dropdown, the queue
badges and the CRM screen-pop card. Only the media engine differs.

---

## 3. The three contracts

### 3.1 Contract A — helper protocol (stdin/stdout, one JSON per line)

```
→ {"id":1,"cmd":"register","server":"192.168.2.22","port":5060,
   "extension":"1002","password":"…","transport":"udp",
   "codecs":["G729","PCMA","PCMU"]}
← {"id":1,"ok":true}          |  {"id":1,"error":"…"}
← {"event":"registration","ok":true,"status":"…"}
← {"event":"incoming","callId":0,"from":"…","to":"…"}
← {"event":"callState","callId":0,"state":"CONFIRMED","text":"…"}
← {"event":"media","callId":0,"active":true}
← {"event":"codecs","codecs":["G729/8000/1","PCMA/8000/1"]}
← {"event":"error","message":"…"}
```

Commands: `register · unregister · call · answer · hangup · mute · hold · dtmf ·
transfer · shutdown`.

The helper **rings on its own** when a call comes in (`pjmedia_tonegen`,
double-ring cadence) and stops when the call is answered or rejected — no
round trip, and the renderer stays silent in native mode (D3).

### 3.2 Contract B — IPC channels

Renderer → main (`ipcRenderer.invoke`):

| Channel | Payload |
|---|---|
| `agent:login` | `{apiUrl, username, password}` → `{profile}` — the token stays in main |
| `agent:logout` | — |
| `agent:status` | `{status, reason}` |
| `agent:open-record` | `{phone, uid}` → opens the record in the browser |
| `sip:register` | `{server, port, extension, password, transport, codecs}` |
| `sip:unregister` | — |
| `sip:call` | `{target}` → `{callId}` |
| `sip:answer` / `sip:hangup` | `{callId}` |
| `sip:mute` / `sip:hold` | `{callId, on}` |
| `sip:dtmf` | `{callId, digits}` |
| `sip:transfer` | `{callId, target}` |

Main → renderer (`webContents.send`):

| Channel | Payload |
|---|---|
| `agent:state` | `{status, reason, queues, pauseReasons, connected, loginAt, statusAt, error}` |
| `agent:pop` | `{callerId, uniqueid, isNew, customer{…}, lastInteraction{…}, at}` |
| `sip:event` | `{kind, callId, …}` — the helper events of contract A |

### 3.3 Contract C — renderer facade

Identical names and events to today's `SipEngine`, so `store/call.ts`,
`CallView`, `Dialpad`, `IncomingCall` and `CallsPage` need **no engine change**.

```ts
makeCall(target): Promise<string>     answer(id): Promise<void>
reject(id): Promise<void>              hangup(id): Promise<void>
hold(id): Promise<void>                resume(id): Promise<void>
setMute(id, on): void                  sendDtmf(id, digit): Promise<void>
blindTransfer(id, target): Promise<void>
```

Events: `presence · stateChange · registered · unregistered ·
registrationFailed · transport · incoming · outgoing · callUpdate · callEnded ·
log`.

Call ids are strings in both modes: `"sipjs:<id>"` / `"native:<id>"`.

---

## 4. File map

### P1 — the clone (mode independent)

| File | Kind | Content |
|---|---|---|
| `src/shared/agent.ts` | new | pure helpers: `deriveWsUrl`, `callerDigits`, `sameCaller`, `crmPopIsFresh`, `workspaceUrl`, `dashboardUrl`, `statusChangeJson`, `pongJson`, `parseAgentEvent`, `statusChanged`, server-clock offset |
| `src/shared/agent.test.mjs` | new | node `assert` self-check — the port of `tests/agent_util_test.cpp` |
| `src/main/agent.ts` | new | middleware client: `fetch` login, `ws` with the auth header, un-queued pong, backoff reconnect, `status_change`, `offline` on logout |
| `src/main/ipc.ts` | change | the channels of contract B |
| `src/shared/types.ts` | change | `AgentState`, `AgentPop`, `AgentLoginResponse`, the new channels |
| `src/preload/index.ts` | change | the preload methods |
| `src/renderer/src/lib/webApi.ts` | change | web shims (no-ops, the web build stays a plain softphone) |
| `src/renderer/src/store/agent.ts` | new | zustand: status, reason, queues, pauseReasons, connected, timers, pop |
| `src/renderer/src/components/AgentLogin.tsx` | new | middleware url, username, password, **mode toggle** |
| `src/renderer/src/components/AgentPanel.tsx` | new | status dropdown (Available + pause reasons), queue badges, connection dot, timers, logout |
| `src/renderer/src/components/IncomingCall.tsx` | change | the CRM card (name, tag, company, last interaction, copy number, open record) |
| `src/main/index.ts` | change | `certificate-error` handler + the per-host allowlist (D5) |
| `package.json` | change | **+ `ws`**, **+ `@types/ws`** |

### P2 — the native engine

| File | Kind | Content |
|---|---|---|
| `native/Cargo.toml` | new | cargo workspace: `sip-engine` + `sip-helper` |
| `native/sip-engine/` | copy | from `phonebar-project/crates/sip-engine` (`src/`, `build.rs`, `Cargo.toml`, `Cargo.lock`); `build.rs` gains `pjmedia_tonegen_.*` in the bindgen allowlist |
| `native/sip-helper/src/main.rs` | new | the JSON-lines loop over `sip_engine::{Engine, EngineEvent}`; rings via `pjmedia_tonegen` |
| `tools/build-native.sh` | new | pjproject x64 via `msvc-wine:local` if the libs are missing → `cargo xwin build --release --target x86_64-pc-windows-msvc` → `resources/sip-helper.exe` |
| `src/main/sipHelper.ts` | new | spawn, line protocol, crash → restart with backoff, the `win32` + `existsSync` guard (D4) |
| `src/main/sipBridge.ts` | new | `sip:*` ↔ helper; pjsua `CallState` → `CallSession` (`DISCONNECTED`→ended/failed, `CONFIRMED`→in-call, `HOLDING`→held, `INCOMING`→ringing, …) |
| `src/renderer/src/sip/engine.ts` | new | the facade of contract C + the mode switch |
| `src/renderer/src/store/call.ts` | change | **one line**: import the facade instead of `SipEngine` |
| `electron-builder.yml` | change | `extraResources` for `resources/sip-helper.exe` (Windows) |
| `.gitignore` | change | `native/sip-engine/third_party/`, `native/target/`, `resources/sip-helper.exe` |

### P3 — integration

* the helper-presence check hides the SIP option and makes WebRTC the default
  where the helper is missing (D4);
* native mode silences the renderer ringtone (D3);
* the live end-to-end run against a spare extension.

---

## 5. Execution order

**P1**

1. `src/shared/agent.ts` + `src/shared/agent.test.mjs` — pure helpers first,
   they carry the subtle rules (caller matching, freshness, url building).
2. `src/main/agent.ts` — the middleware client.
3. the IPC channels, the preload, the web shims.
4. `src/renderer/src/store/agent.ts`.
5. `AgentLogin.tsx`, `AgentPanel.tsx`, the CRM card in `IncomingCall.tsx`.
6. the `certificate-error` handler (D5).

**P2** (done 2026-11-19: `native/` workspace + helper JSON lines + tonegen ringtone, `tools/build-native.sh`, `src/main/{sipHelper,sipBridge}.ts`, `src/renderer/src/sip/{NativeEngine,engine}.ts`, the stores on the facade. Checks: the helper cross-compiles (`resources/sip-helper.exe`, 2.5 MB), `node src/main/sipHelper.contract.test.mjs` 5/5 (answers, events, error answers, garbage lines, crash→re-register), `cargo fmt --check`, typecheck/lint/build/build:web.)

7. `native/` — copy the crate, add the workspace, write `sip-helper`.
8. `tools/build-native.sh` → `resources/sip-helper.exe`.
9. `src/main/sipHelper.ts`, `src/main/sipBridge.ts`.
10. `src/renderer/src/sip/engine.ts` — the facade; `store/call.ts` one-liner.

**P3** (code done 2026-11-19; **live run done** 2026-11-19 with `agent2`/1003:
the helper under wine, SIP REGISTER 200, `#0 audio G729 @8kHz, sendrecv`, the
status_update echo, a real `crm_screen_pop`, hold (`active:false`), hangup,
12/12 checks of the one-off driver. Found live: Asterisk answers with its own
codec order, so a multi-codec offer negotiates PCMU — the engine now offers
G.729 only; `media.active` now follows the media *state*, not the section
count, so hold shows in the UI. The engine toggle in `AgentLogin` shown only when
`sip:available`, WebRTC as the default elsewhere, the native profile
(`engine`/`sipPort`/`transport: udp`), the renderer ringtone and `ensureMic`
skipped when `sipEngine.mode === 'native'`, the agent logout also disconnects
SIP, the helper disposed on a window reload, a second register deletes the old
pjsua account. Checks: sipHelper 5/5, agent 66/66, typecheck/lint/build/build:web.)

11. ~~the helper-presence check and the mode default~~ done.
12. ~~the hermetic run against the mock middleware~~ done (P1: 10/10).
13. ~~the live run against a spare extension (a)~~ done with `agent2`/1003;
    the Windows box of the operator is the remaining manual pass.

---

## 6. Verification

| Phase | Check |
|---|---|
| P1 | `node src/shared/agent.test.mjs` · `node src/main/agent.contract.test.mjs` (login 401/200, ws with the auth header, ping→pong, the status_change echo, the remote admin pause, the `crm_screen_pop`, the offline event) · `npm run typecheck` · `npm run lint` · `npm run build` · `npm run build:web` |
| P2 | `cargo xwin build --release` succeeds · `sip-helper.exe` registers on the box over UDP 5060 and Asterisk shows it with **G729** negotiated · a call between two extensions carries audio both ways · DTMF, hold, transfer, hangup |
| P3 | live on `192.168.2.22` with a **spare** extension: incoming call → the CRM card is filled → answering opens the record in the browser → the status dropdown pauses the agent in Issabel |

---

## 7. Test strategy — (b) then (a)

**(b) Hermetic, no production data.** `call-center-project/MicroSIP-3.22.16-src/tests/mock_middleware.js`
implements `/api/login` (agent1/secret), `/ws`, `/simulate/crm_pop` and
`/simulate/state` with no dependency. `src/main/agent.contract.test.mjs`
drives it (spawns the mock on port 18080, 10 checks, all passing).

**(a) Live, one production row.** A spare extension is used — `test` / 1002 or
`agent2` / 1003, **never `agent` / 1005**. The password is set through the
admin api:

```
PUT /api/admin/agents/:id   {"password": "<…>"}
```

which writes the plaintext `cc_agents.password` column
(`middleware/db.js:196-199`). The password is chosen by the operator, so no
existing secret is overwritten and nothing has to be restored afterwards.

---

## 8. Risks and fallbacks

| Risk | Fallback |
|---|---|
| The Chromium audio device and the helper's device fight (Linux ALSA) | not applicable — the native mode is Windows only, and WASAPI is shared mode |
| The self-signed certificate of Asterisk | D5 — the in-app per-host toggle, default on for the agent host |
| pjsua crashes | the helper is a child process; `sipHelper.ts` restarts it with a backoff |
| The ws dies silently | the ping/pong and the liveness check of the middleware client |
| The SIP domain is wrong for the PJSIP endpoint | configurable in the agent login, default = the server ip (what MicroSIP v1 does and what works today) |
| The middleware has no CORS | the login and the ws live in the main process — no CORS there |

---

## 9. Security notes

* The SIP password and the agent token are **never written to disk**. The
  profile lives in the agent store (memory only); the token lives in the main
  process only.
* The renderer never sees the token — it asks the main process to open the CRM
  record, and the main process builds the dashboard url with the token.
* `src/main/store.ts` still holds a hardcoded `encryptionKey` for the ordinary
  settings. It does not cover the agent credentials (they are not persisted),
  but it should be replaced by `safeStorage` — a separate, smaller task.
* The middleware serves plain HTTP and stores the agent passwords in
  plaintext. The traffic of the LAN should move to HTTPS.

---

## 10. Open items for the operator

1. The password of the spare test extension (1002 or 1003) for step (a).
2. Whether the SIP domain should be the server ip (`192.168.2.22`, the
   behaviour of MicroSIP v1 today) or `issabel.local` (the name of the
   certificate).
3. The production middleware url to bake into the default of the login form:
   `http://192.168.2.22:8080`.
