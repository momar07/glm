# GLMWebrtc — Windows & Android feasibility

## Windows 10 / 11 — YES (64-bit) — SHIPPED 2026-09-22

- Supported: Electron 33 requires Win10+. NSIS x64 per-machine installer.
- Build: `npm run dist:win` → `dist/GLMWebrtc-0.1.0-x64-setup.exe` (unsigned).
- Icon: `build/icon.ico` (+ `icon.png`) generated from the in-app G mark.
- Not signed: SmartScreen shows "Unknown publisher" — still installs.
  Signing later needs zero code changes (`CSC_LINK` in electron-builder.yml).
- Not covered: 32-bit Windows, Win 7/8.1.

### Tester checklist (Win 10 + 11)

1. Run installer as admin (per-machine) → expect SmartScreen warning → install anyway.
2. Launch, register to the PBX.
3. Place a call + answer a call — two-way audio both directions.
4. Allow the Windows Firewall UDP prompt (voice media needs it).
5. Grant mic in Settings → Privacy → Microphone.
6. Incoming call while minimized → toast appears, clicking focuses the app.
7. History persists across restart; retention setting (App tab) respected.
8. Settings → export logs works; Contacts CSV import/export dialogs work.
9. Settings → launch-at-startup toggle takes effect after reboot.
10. Launching a second copy focuses the first (single instance).

## Android — APK ready for sideload (2026-09-22)

- Artifact: `dist/GLMWebrtc-1.0-debug.apk` (debug-signed — install works,
  Play release needs a release key later). Rebuild: `npm run build:apk`.
- Scope: register, outgoing/incoming while open, history, settings. Closed-phone
  ringing needs Phase 3 (below).
- On-device checklist: install → allow mic + notifications → register → call
  both directions → minimize/screen-off during active call → exempt the app
  from battery optimization (Xiaomi/Samsung/Huawei kill background sockets).

### Phase 3 — closed-phone ringing (not built yet)

1. Create a Firebase project, drop `google-services.json` into `android/app/`.
2. Host a push gateway: Asterisk dialplan hits it on incoming INVITE, it sends
   FCM data `{type:'incoming', from, callId}` to the device token (shown in Logs).
3. App already handles the rest: loud call notification + tap-to-focus
   (`lib/push.ts`, `onPushMessage` bus ready for auto re-register + ring).
