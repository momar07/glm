# changes.md — Session Log (2026-09-21)

All changes made in this session, grouped by area. Verified with
`tsc --noEmit` (web + node) and `eslint` after every batch.

## Background reliability — Wave 1, JS-only (2026-09-23)

- **Network triggers** (`lib/lifecycle.ts`, `App.tsx`): `onForeground` also fires
  on `online`/`offline` (same 3 s debounce, same `recoverTransport()` path) —
  Wi-Fi→cell switches recover without waiting for reopen.
- **Background card** (`components/Settings.tsx`): new `isNative()`-gated
  "Background connection" card in the App tab — live exemption status +
  Open settings + Re-check. Survives the banner's Don't-ask-again dead-end
  (`BatteryPrompt.tsx` unchanged).
- **Transport** (`sip/SipEngine.ts`): mobile keep-alive clamped to ≤20 s
  (carrier NAT margin); `recoverTransport` logs alive→re-registering + outcome
  state instead of swallowing.
- **Retention tone** (`audio/AudioManager.ts`, `App.tsx`): tone logs
  start/stop/fail, explicit context resume, restart on foreground return while
  registered (no-op otherwise).
- **Notification preflight** (`lib/push.ts`, `store/sip.ts`): new
  `ensureNotifications()` at register — channel + permission prompt up front,
  denied logs a warning instead of failing mid-ring.
- **APK**: `npm run build:apk` → `app-debug.apk` (5.8 MB, debug-signed).
  Deferred: Wave 2 native (boot receiver, network callback, FGS split),
  Phase 3 FCM gateway for killed-app ringing.

## Windows support (2026-09-22)

- **Icons**: `build/icon.ico` (16–256px) + `build/icon.png` generated from the
  in-app G mark (Pillow script, Noto Sans Bold on brand-600 rounded square).
- **Installer scope**: NSIS `perMachine: false` → `true` (admin install, all users).
- **Build**: `npm run dist:win` → `dist/GLMWebrtc-0.1.0-x64-setup.exe` (83 MB,
  unsigned — SmartScreen will warn). Tester checklist in `winando.md`.

## Android — Phase 1 web-ready renderer (2026-09-22)

- **`window.api` shim** (`renderer/src/lib/webApi.ts`): MainApi-compatible,
  browser-backed (settings/logs in localStorage, Web Notifications, CSV via
  direct file handling). Installed in `main.tsx` only when no preload exists —
  desktop behavior untouched. Capacitor plugin hooks reserved for Phase 2.
- **Platform util** (`lib/platform.ts`): `isNativeShell` (import-time check, true
  only under Electron preload), `isMobile()` (Capacitor or UA).
- **Web build** (`vite.web.config.ts`, `npm run build:web` / `dev:web`):
  standalone renderer bundle to `dist-web/` — verified zero Electron imports.
- **PWA shell** (`renderer/public/`, `index.html`): manifest, 192/512px G icons,
  theme color, `viewport-fit=cover`; CSP widened with `https:` for connect.
- **Mobile adaptations**: Contacts CSV import/export via hidden file input +
  blob download on web; desktop-only Settings rows (launch-at-startup, Window
  tab) hidden without a native shell.

## Android — Phase 2 Capacitor shell (2026-09-22)

- **Deps**: `@capacitor/core/cli/android@8.5.2`, `local-notifications`,
  `push-notifications`. `capacitor.config.ts` (`io.glmwebrtc.app`, `dist-web`).
- **Manifest**: mic, audio-settings, notifications, vibration, wake-lock,
  full-screen-intent permissions. G-mark launcher icons (all densities).
- **Push module** (`lib/push.ts`): FCM register, token logging, incoming-type
  data-message fan-out (`onPushMessage`), loud call-channel notifications.
  `webApi.notify` routes through it on native, Web Notifications elsewhere.
- **APK**: `dist/GLMWebrtc-1.0-debug.apk` (5.8 MB, debug-signed, minSdk 24 /
  Android 7+, target 36). `npm run build:apk` rebuilds web + sync + APK.
- **Crash fix (instant-close on launch)**: the push-notifications native plugin
  called `FirebaseMessaging.getInstance()` with no `google-services.json` →
  native exception on every start. Plugin uninstalled; `lib/push.ts` loads it
  lazily at runtime only (bundler-safe variable import), `initPush()` deferred
  past first render and fully non-throwing. Re-add in Phase 3: `npm i
  @capacitor/push-notifications` + sync, zero code changes.
- **Phase 3 inputs still needed**: Firebase `google-services.json`, push-gateway
  service + Asterisk dialplan hook sending `{type:'incoming',from,callId}`.
- **Incoming-first calls silently dropped** (`store/call.ts`, BUGS.md #005):
  engine listeners were bound inside `makeCall()` only, so an incoming call
  arriving before any outgoing dial-out sat in the engine with no UI —
  Asterisk rang, app silent. Now bound once in the store initializer.
- **Mobile header overlap** (`@capacitor/status-bar`, `main.tsx`): WebView ran
  edge-to-edge under the system clock/icons. Now non-overlay with `#0f172a`
  background + dark icons; bottom gesture bar handled via
  `safe-area-inset-bottom` padding in `App.tsx`.
- **Background unregister** (`SipEngine.ts`, `lib/lifecycle.ts`): Android kills
  sockets without close events, leaving the engine 'registered' on a dead
  transport. New `recoverTransport()` ( deduped ): socket alive → re-REGISTER;
  dead → `reconnect()`; that fails + no live call → full shutdown + re-init.
  Fired on Capacitor `resume` / `visibilitychange` (debounced, no-op on Login).
- **Battery exemption prompt** (`SystemPlugin.java`, `lib/system.ts`,
  `BatteryPrompt.tsx`): local System plugin (`isIgnoringBattery`,
  `requestBatteryExemption`); one-time banner when online with Later /
  Don't-ask-again; `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission.
- **Foreground call service** (same plugin + `store/sip.ts`): `phoneCall`-type
  service with persistent "listening for calls" notification, started on
  REGISTER, stopped on unregister; manifest-verified in APK.
- **Wake locks in service** (`SystemPlugin.java`): `PARTIAL_WAKE_LOCK` +
  high-perf WiFi lock held while registered — without them screen-off sleep
  resets the socket (Asterisk: "reset by peer", contact removed). Trade-off:
  higher idle battery use while registered; released on logout/unregister.
- **Timer-throttling retention tone** (`AudioManager.ts`, `store/sip.ts`):
  Chromium freezes background timers ~5 min hidden, stopping keep-alives and
  re-REGISTERs. An inaudible 55 Hz tone at 0.001 gain while registered opts the
  page out via the "playing audio" exemption. Heuristic, not a guarantee —
  push gateway remains the bulletproof path.
- **Reconnecting splash** (`SipEngine.ts`, `store/sip.ts`, `App.tsx`): new
  `recovering` flag + `engineState` in store; mid-recovery renders a
  "Reconnecting…" splash instead of flashing the Login screen. Logged-out and
  registration-failed states still show Login.
- **Stuck splash (no way back)** (`SipEngine.ts`, `App.tsx`, BUGS.md #006):
  any throw mid-connect stranded the machine in `connecting` with the splash
  parked forever. `initialize()` now forces idle on failure, and the splash
  has a Cancel button (`cancelConnect()` drops the half-built UA, unsticks
  the Login form).
- **Slow answer + double-tap chaos** (`SipEngine.ts`, `IncomingCall.tsx`,
  `App.tsx`): `answer()` now guards in-flight accepts (`pendingAnswer`) and
  sets `connecting` optimistically so the overlay drops and CallView appears
  instantly instead of waiting for the ACK round trip; Accept/Reject lock with
  a "Connecting…" label after first press; `/` renders CallView for joining
  calls. Previously a second tap threw inside `accept()` and `failCall()`ed a
  call that was about to establish (the dialpad flash).
- **Dialpad soft keyboard** (`Dialpad.tsx`): `inputMode=none` + no autofocus or
  programmatic focus on mobile — the pad is the keyboard. Desktop unchanged.
- **⋮ menu** (`StatusBar.tsx`): tab row replaced by a top-right 3-dots dropdown
  (Dial, History, Contacts, Logs, Settings + Logout with confirm).
- **Dial number field** (`Dialpad.tsx`): restored missing styling — centered,
  transparent, borderless (it had fallen back to a default white box).
- **Auto sign-in toggle** (`shared/types.ts`, `constants.ts`, `Login.tsx`,
  `App.tsx`): new `ui.autoSignIn` (default on); boot auto-connect skipped when off.
- **WSS auto-fill toggle** (`SipProfile.autoWsUrl`, `Login.tsx`): derives
  `wss://<domain>:8089/ws`, disables manual entry while on, applies to
  test/save/connect; new profiles default to auto.
- **Editable WSS port** (`SipProfile.wsPort`, `Login.tsx`): port box beside the
  URL when auto-fill is on (digits only); blank = 8089.
- **⋮ clearance on Android** (`StatusBar.tsx`): native header gets top padding
  so the menu button sits below the system status bar and stays tappable
  (raised to 80px/32px after first pass sat too high);
  dropdown anchored to `top-full` so it follows any header height.
- **Outgoing invite failed on fresh installs** (`SystemPlugin.java`,
  `lib/system.ts`, `store/call.ts`, dial sites): `invite()` → getUserMedia
  rejects without mic permission (often messageless → bare "invite failed").
  New `checkMic`/`requestMic` plugin methods (Capacitor 8 annotation package:
  `annotation.Permission`); `ensureMic()` preflight in `makeCall`/`answer`;
  dial failures now `alert()` instead of dying silent (matches existing
  Contacts style); invite reason falls back to error name.
- **OverconstrainedError on some phones** (`SipEngine.ts`): full mic
  constraints (device + AEC/NS/AGC) rejected by the WebView. Trial handshake —
  probe full set once per device, fall back to plain `{audio:true}` on
  Overconstrained/NotFound, cache the outcome; Logs show which constraint
  failed.
- **Ear-sensor screen-off** (`SystemPlugin.java`, `lib/system.ts`,
  `CallView.tsx`, `store/call.ts`): `PROXIMITY_SCREEN_OFF_WAKE_LOCK` via new
  `proximityOn/Off` plugin methods (sensor support pre-checked). Acquired on
  earpiece calls, skipped on loudspeaker, released on every end path.
- **iPhone-style dialer** (`Dialpad.tsx`): big centered number display, round
  slate keys with letter subs, brand-blue circular call button with handset
  icon, ⌫ bottom-right beside it; paste/clear as subtle links under the
  number. Same sounds, shortcuts, and no-keyboard behavior.
- **Joining label** (`CallView.tsx`): status-driven — `connecting` shows
  "Connecting…", outgoing early states "Calling…", incoming ringing
  "Ringing…".
- **Dialer centering + full-width number** (`Dialpad.tsx`, `index.css`):
  keys + call row vertically centered in leftover space (reference look);
  number display spans full width with auto-shrinking type (>10/>14 digits);
  short-screen fallback shrinks keys via media query.
- **Contacts bulk delete** (`Contacts.tsx`): Select mode with checkboxes,
  select-all/clear, count, and confirm-guarded Delete; per-row ✕ kept for
  one-by-one. Toolbar wraps on narrow screens.
- **Dialpad restyle** (`Dialpad.tsx`): keys narrowed (`max-w-[19rem]`, smaller
  digits to match); backspace/clear moved to the right end of the number row
  beside a new ⧉ paste button (clipboard read, inserts at cursor — the
  mobile answer to right-click paste).
- **Exit app on mobile** (`Login.tsx`): native-only Exit button (Capacitor
  `exitApp`) under the login footer — after logout there was previously no
  way to close the app on phones.
- **Answer-delay instrumentation + mic warmup** (`SipEngine.ts`,
  `store/sip.ts`): answer path logs press time, `accept()` duration, and
  press→Established delta; trial pre-resolved at registration (`warmupMedia`)
  so dial/answer pays no setup cost. Awaiting device data to attribute the
  ~5 s join delay (candidates: ICE gather, DTLS, ACK).
- **Phone ringtones** (`SystemPlugin.java`, `lib/device.ts`, `Settings.tsx`,
  `IncomingCall.tsx`): list/play/stop via looping MediaPlayer on the ring
  stream; `AudioPrefs.ringtoneUri` picker in Audio settings (wins over synth);
  preview plays the right source; incoming uses it with synth fallback.
- **Phone contacts** (`SystemPlugin.java` manifest + `READ_CONTACTS`,
  `lib/device.ts`, `Contacts.tsx`): explicit Load (system permission dialog),
  searchable "On this phone" section with Call, Import-all deduped by digits.
- **⋮ menu untappable (stacking bug)** (`StatusBar.tsx`): header `z-30` — the
  `backdrop-blur` traps the dropdown in the header's stacking context, so page
  content painted over it. Incoming-call overlay (root `z-50`) still wins.
- **Connect crash (FGS type — confirmed on device)** (`AndroidManifest.xml`,
  `SystemPlugin.java`): first build where the service actually ran crashed on
  Connect. `phoneCall` FGS type is gated on modern Android outside
  Telecom-managed calls → switched to unrestricted `specialUse` (+ subtype
  property, `FOREGROUND_SERVICE_SPECIAL_USE`), and `onStartCommand` now
  degrades to `stopSelf()` instead of ever crashing the process.
- **Native plugin never registered** (`MainActivity.java`, BUGS.md #007):
  `registerPlugin()` ran AFTER `super.onCreate()`, which already consumes the
  builder to create the bridge — System (service, battery, audio routing) was
  silently absent, every call a no-op. Moved before `super`. Missing-plugin
  now logs loudly once instead of failing silent.
- **Real earpiece/speaker routing** (`SystemPlugin.java`, `lib/audioRoute.ts`,
  `IncomingCall.tsx`, `CallView.tsx`, `store/call.ts`): new `audioRoute`
  plugin method (`ring` = loud ringtone mode, `comm` = in-call with speaker
  flag, else normal). Incoming ring → loud; answered → earpiece by default;
  Speaker button finally wired (mobile only, resets per call); routing
  restored on every call end. Desktop unchanged (browser-managed).
- **Earpiece fix via setCommunicationDevice** (`SystemPlugin.java`):
  `setSpeakerphoneOn()` alone only steers the voice-call stream while WebView
  `<audio>` rides the media path — voice stayed on speaker. Now uses API 31+
  `setCommunicationDevice(earpiece/speaker)` with legacy fallback; applied
  routes logged to the Logs tab for verification.

## Calls & audio

- **Incoming ringtone could start silent** (`audio/AudioManager.ts`): oscillators
  were started on a still-`suspended` AudioContext (no user gesture on incoming
  calls), freezing them on a stopped timeline. Now resumes first, retries once running.
- **Local DTMF feedback** (`audio/AudioManager.ts`, `Dialpad.tsx`, `CallView.tsx`):
  dialpad presses and in-call keypad play ITU-T Q.23 dual-tone beeps (no new deps).
- **Outgoing ringback added, then removed per request** (`CallView.tsx`,
  `audio/AudioManager.ts`): a fake 440+480 Hz ringback was added, then deleted —
  only real PBX audio (early media / connected voice) and the incoming ringtone remain.
- **Early media now attaches** (`sip/SipEngine.ts`): the `track` listener was hooked
  before SIP.js lazily creates the SDH in `invite()`/`accept()`, so it never
  installed. Now also hooks via `session.delegate.onSessionDescriptionHandler`
  (confirmed + provisional SDHs), deduped with a `WeakSet`.
- **End Call instant on established calls** (`sip/SipEngine.ts`): `hangup()` awaited
  `session.bye()`, which pends for the ACK on just-answered incoming calls
  (dialog `AckWait`) — the button looked dead. Now ends the UI first, sends BYE
  in the background, with a 2.5 s race so a lost ACK can't hang shutdown either.
- **Unmute/volume reset before every `play()`** (`sip/SipEngine.ts`): stale muted
  or zero-volume element state no longer causes silence.
- **Synth sounds follow the chosen output** (`audio/AudioManager.ts`, `App.tsx`):
  new `setSink()` routes ringtone/DTMF via `AudioContext.setSinkId`; App applies
  ringtone-device (fallback: speaker-device) live on settings change.

## History

- **Missed/Failed filters fixed** (`components/History.tsx`): both checked
  `status === 'failed'`, showing identical lists while real missed calls
  (`ended` + 0 s) matched neither. Missed = incoming + ended + 0 s.
- **Sorting added**: Newest / Oldest / Longest / Name A–Z (sorted on a copy, store untouched).
- **Sort/filter hardening**: `historyTs()` (`shared/constants.ts`) coerces timestamps
  (number, date string, garbage → 0) — one bad `startedAt` returned NaN from the
  comparator and froze the whole list order. Direction compared lowercase.
- **Result count** (`70/76`) so filter response is visible; search also matches plain number.
- **Redial redirects** (`History.tsx`, `Contacts.tsx`): Redial/Call navigates to `/`
  first so the CallView appears immediately.
- **Clear button** (`History.tsx`, `store/call.ts`): confirm-then-wipe via new
  `clearHistory()` store action.
- **Configurable retention** (`shared/types.ts`, `shared/constants.ts`,
  `main/store.ts`, `store/call.ts`, `Settings.tsx` App tab): keep 1 / 7 / 30 days /
  forever (default 1). Age-pruned on load, on record, and every 60 s while running.
  Main store fills group defaults so older stored settings never crash the UI.
- **Tab order** (`StatusBar.tsx`): Dial, History, Contacts, Logs, Settings.

## Layout (no scrollbars)

- **Dialer** (`Dialpad.tsx`): `aspect-square` keys overflowed the window. Grid is now
  `flex-1 min-h-0` with `auto-rows-fr` so rows share available height; smaller type,
  tighter gaps, `overflow-hidden`. Inline Recent call log removed (lives in History tab).
- **StatusBar** (`StatusBar.tsx`, `index.css`): compact tabs + horizontally scrollable
  nav with hidden scrollbars (new `.no-scrollbar` utility).
- **Login** (`Login.tsx`): compacted header/form; profiles list capped with hidden
  internal scroll; invisible-scroll fallback so nothing clips.
- **Settings** (`Settings.tsx`): 7 stacked cards → sub-tabs (Account, Audio, Codecs,
  Network, App, Logs, Window), one panel visible, invisible-scroll fallback.
- **Window** (`main/window.ts`): default 420×720 → 440×800 (min 360×600).

## Misc

- **Codec drag-and-drop reorder** (`Settings.tsx`): native HTML5 DnD on codec chips,
  no new dependency.
- **Logout confirmation** (`StatusBar.tsx`, `Settings.tsx`): confirm dialog before
  disconnect ("Any active call will end").
- **Dialer right-click paste** (`Dialpad.tsx`): `onContextMenu` reads the clipboard
  and inserts at the cursor (Electron shows no native menu); Ctrl+V path untouched.

## Bandwidth + Calls page session (2026-09-25)

All verified with `typecheck`, `eslint`, `build:web`, node self-checks, and APK
rebuild (`npm run build:apk`, bundle verified inside the APK) after every batch.

### Opus enforcement + proof (`lib/sdp.ts`, `sip/SipEngine.ts`, `shared/constants.ts`)

- Settings → Codecs order was dead code (never read). New pure SDP munging:
  `applyCodecPrefs()` (reorder/strip audio `m=` to the list, DTMF always kept,
  untouched fallback when nothing matches — never emits an empty offer) +
  `tuneOpus()` (`maxaveragebitrate`, `usedtx=1`, `useinbandfec=1`,
  `sprop-stereo=0`, `maxplaybackrate`, `ptime:20`, merged not clobbered).
  15-check node self-test (`lib/sdp.test.mjs`).
- Wired as SIP.js `sessionDescriptionHandlerModifiers` into outgoing INVITE,
  incoming accept, and hold/resume re-INVITEs; sender capped via
  `RTCRtpSender.setParameters` on Established (belt-and-braces for stacks that
  ignore fmtp).
- Logs prove the call: `outbound audio RTP: codec=…`, `negotiated outbound
  codec: audio/opus`, `outbound audio: X kbps` every 3 s, `sender capped at …`.
- Fresh installs default to `['opus','telephone-event']`; stored prefs win on upgrade.
- Measured on device: Opus negotiated, 11–19 kbps @32 with DTX (silence ≈0.2 kbps)
  vs ~87 kbps G.711 wire — ~5–7× reduction.

### Opus quality selector 16/32/48 (`shared/types.ts`, `lib/sdp.ts`, `Settings.tsx`)

- `audio.opusKbps: 16|32|48` (default 32, group-merge migrates old installs free);
  `opusTuning(kbps)` map (16→16k/WB, 32→balanced, 48→fullband; FEC+DTX always on);
  sender cap follows the setting. `CODEC_LABELS` fixed (`Opus 48k` → `Opus` —
  the old label lied once `maxplaybackrate` is capped). Selector in Codecs tab
  with wire-bandwidth hints; stale "reorder deferred" helper text removed.

### Settings live-sync (`sip/SipEngine.ts`, `store/settings.ts`)

- Engine snapshotted settings at `initialize()` — every edit (codecs, opus,
  mic, timers) silently needed logout/login (caught via a `sender capped at
  32kbps` log after selecting 16). New `updateSettings()` + `patch()` push;
  applies on next call, never touches live sessions.

### Calls page redesign (`CallsPage.tsx`, `Dialpad.tsx`, `TabBar.tsx`, `App.tsx`)

- `/` is now Calls: history list + floating `KeypadSheet` (tap mini-bar/handle/
  keypad-icon to open/minimize, starts open) + bottom Calls|Contacts tabs.
  Tap-a-row fills the number (fixes mobile, where hover-Redial was unreachable).
  `/history` redirects `/`; `History.tsx` deleted; ⋮ menu keeps Logs/Settings.
- Mini bar slimmed to grab-handle only (was: duplicated number + call button).
- Caret-aware dial editing: keys/backspace/paste insert at the cursor.
- Paste resurrection: mobile long-press no longer intercepted (native menu fires
  a real paste event); ⧉-button denial falls back to an editable field +
  Logs reason instead of dying silent.
- Missed = any incoming with zero talk time (`ended` or `failed`), red row + arrow.
- (+) on unknown numbers only → name prompt → saved to contacts; rows resolve
  names live from contacts (saving/renaming renames the whole log at once).
- ⋮ menu portaled to `document.body` — `backdrop-blur` had trapped the backdrop
  to the header strip so outside taps never dismissed it.

### Outbound dial prefix (`SipProfile.dialPrefix`, `Login.tsx` → `Settings.tsx`)

- Per-profile prefix for bare-number dials (blank = disabled; SIP URIs bypass);
  read from live settings; applied in `makeCall` + `blindTransfer`. CallSession
  keeps the user-dialed URI so logs/history stay prefix-free; applied mapping
  logged (`dial prefix '9': sending 9123`). Field moved Login → Settings Account
  (active profile).
