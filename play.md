# play.md — Google Play release plan (GLMWebrtc / `io.glmwebrtc.app`)

Status: **not started**. Current artifact is a debug APK (`assembleDebug`,
debug-signed) — Play accepts **AAB, release-signed** only.

Toolchain (already compliant, verified 2026-09-23): AGP 8.13.0, Gradle 8.14.3,
`targetSdk 36`, `minSdk 24`. No native `.so` → 64-bit + 16 KB page-size rules
auto-pass. `minifyEnabled false` stays off (R8 risks breaking SIP.js for zero
gain on a 5.8 MB app).

Decisions already taken: no Play account yet ($25 signup needed), no keystore
yet (create fresh), `USE_FULL_SCREEN_INTENT` will be **removed** (declared but
unused — no full-screen notification code in `SystemPlugin.java` / `push.ts`;
re-add with Phase 3 FCM when truly used).

---

## Blockers (why the current APK can't ship)

| # | Blocker | Current state | Fix |
|---|---------|---------------|-----|
| 1 | Format | `assembleDebug` → APK, debug-signed | `bundleRelease` → **.aab**, release-signed |
| 2 | Signing | No `signingConfigs` in `android/app/build.gradle` | New keystore + env-wired config, never committed |
| 3 | Version | `versionCode 1` / `versionName "1.0"` hardcoded (`app/build.gradle:9-10`) | Bump per release; `versionCode` integer must always rise |
| 4 | `USE_FULL_SCREEN_INTENT` | Declared (`AndroidManifest.xml:55`), unused | Delete the line (re-add with Phase 3) |
| 5 | Battery exemption | Direct-request intent (`SystemPlugin.java:63`) | Keep — VoIP is eligible core function; document justification for review |
| 6 | FGS `specialUse` | Subtype property present (`AndroidManifest.xml:41-43`), good | File Play Console FGS declaration at release |
| 7 | Account | None | $25 signup; confirm `io.glmwebrtc.app` globally unique at creation |

---

## Wave A — build (one dev session)

### A1. Create the upload keystore (outside the repo)

```bash
mkdir -p ~/.keystores
keytool -genkeypair -alias glmwebrtc -keyalg RSA -keysize 2048 -validity 10000 \
  -keystore ~/.keystores/glmwebrtc-upload.jks
```

Back it up in **two** places (password manager + offline copy). Losing the
upload key means a new Play listing. Never commit the `.jks` or passwords —
`android/.gitignore` already covers build outputs; keep secrets in env only.

### A2. Wire release signing (`android/app/build.gradle`)

Add (values from env, no secrets in git):

```gradle
android {
    signingConfigs {
        release {
            storeFile file(System.getenv("GLM_KEYSTORE_PATH") ?: "")
            storePassword System.getenv("GLM_KEYSTORE_PASSWORD")
            keyAlias System.getenv("GLM_KEY_ALIAS") ?: "glmwebrtc"
            keyPassword System.getenv("GLM_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            ...
        }
    }
}
```

Bump in `defaultConfig`: `versionCode 2`, `versionName "1.1.0"`.

### A3. Drop the unused permission (`AndroidManifest.xml`)

Delete line 55 (`USE_FULL_SCREEN_INTENT`). Nothing references full-screen
intents — `push.ts` schedules plain channel notifications, `SystemPlugin`
posts an ongoing (not full-screen) service notification.

### A4. Verify

```bash
export GLM_KEYSTORE_PATH=~/.keystores/glmwebrtc-upload.jks
export GLM_KEYSTORE_PASSWORD='...' GLM_KEY_ALIAS=glmwebrtc GLM_KEY_PASSWORD='...'
npm run build:web && npx cap sync android
./android/gradlew -p android bundleRelease
jarsigner -verify android/app/build/outputs/bundle/release/app-release.aab
```

Install-test the release bundle locally before upload:

```bash
bundletool build-apks --bundle=app-release.aab --output=test.apks \
  --ks ~/.keystores/glmwebrtc-upload.jks --ks-key-alias=glmwebrtc
bundletool install-apks --apks=test.apks
```

On-device checklist: register → outgoing + incoming → screen-off during call →
battery-exemption prompt → minimize 10 min → incoming still arrives → Logs clean.

Also run: `npm run typecheck`, `npm run lint`, both self-checks.

---

## Wave B — Play Console (clicks, no code)

1. **Account**: $25 one-time signup → create app → confirm `io.glmwebrtc.app`
   is free. App name: GLMWebrtc.
2. **Assets**: 512 px icon (reuse G-mark source), feature graphic, ≥2 phone
   screenshots. Launcher icons already exist in all densities.
3. **Privacy policy**: host a URL (required). Content: mic used for calls,
   contacts read only on explicit Load, SIP credentials stay on-device except
   to the user's own PBX; no analytics, no ads, no third-party sharing.
4. **Data safety form**: microphone, contacts, phone numbers; "collected"
   (on-device + user PBX), not shared.
5. **Declarations**: foreground service (`specialUse` — VoIP keep-alive);
   `RECORD_AUDIO` / `READ_CONTACTS` / `POST_NOTIFICATIONS` with in-app
   rationale (already in-app: mic preflight in `store/call.ts`, explicit
   contacts Load in `Contacts.tsx`, register-time notification preflight).
6. **Questionnaires**: content rating, target audience, data-safety + news
   declarations as prompted.

Battery-exemption review note (keep handy if flagged): core function is
receiving VoIP calls in background; without exemption, Doze kills the SIP
transport and calls are missed. The app also degrades gracefully
(`recoverTransport()` on return) and discloses battery impact in Settings →
Background connection.

---

## Wave C — rollout

1. Upload AAB to the **internal testing** track → smoke test.
2. **Closed testing: ≥12 testers × 14 days** — mandatory for new accounts
   before production access. This is the long pole: start it ASAP, even with
   the current build, while polishing.
3. Promote to **production** after closed test completes with no blocking issues.

---

## Later (not this release)

- Phase 3 FCM (`google-services.json` + gateway): re-add
  `USE_FULL_SCREEN_INTENT` with a real full-screen incoming-call notification
  when killed-app ringing lands.
- `versionCode` bump discipline: +1 per AAB upload, no exceptions.
- If Play flags the direct battery-exemption intent, fallback is guiding to
  the system list (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`) instead of
  the direct request — one-method change in `SystemPlugin.java`.
