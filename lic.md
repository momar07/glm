# lic.md — App approval gate ("nobody uses the app before I accept")

Goal: whole-app use blocked until the owner taps accept remotely.
Constraint: the PBX is **not** ours — enforcement lives in the app + a small
service we control.

> Honest ceiling: the app is client-only, so this stops casual/unauthorized
> use (shared APK, ex-employees, strangers), not a determined reverse
> engineer. Locking down *who calls* also needs per-user SIP credentials on
> the PBX side (PBX owner's job, outside this app).

## Recommended: Firebase approval gate

Shares the Firebase prerequisite with Phase 3 push (`google-services.json`).

### Flow

1. First launch → app creates a device ID (`crypto.randomUUID`, in
   `localStorage`), writes `{deviceId, label, model, ts, status:'pending'}`
   to Firestore.
2. App renders a **"Waiting for approval"** screen instead of Login —
   live-subscribed to the request doc, unlocks the moment the owner approves
   (polling fallback if listeners fail in background).
3. Owner approves from an **Admin tab** (PIN-gated, only on the owner's
   device): pending list → Approve / Deny / Revoke.
4. `connect()` is hard-blocked until approved — no Login, no auto-sign-in.
5. Approval cached locally + **revalidated every start and every 24h** while
   online; server status always wins. Revoke → back to waiting screen.

### App changes (file-by-file)

| File | Change |
|------|--------|
| `lib/deviceId.ts` (new) | Stable device ID + human label |
| `lib/approval.ts` (new) | Firestore request / subscribe / revalidate; `ensureApproved()` guard |
| `App.tsx` | Gate: unapproved → waiting screen (keep `<audio>` wiring untouched); skip auto-connect |
| `store/sip.ts` (`connect()`) | Refuse when not approved (defense in depth, not just UI hiding) |
| `components/ApprovalAdmin.tsx` (new) + `StatusBar.tsx` | Approve / Deny / Revoke list, PIN-gated |
| `android/app/google-services.json` + Capacitor setup | Firebase project (also unblocks push) |

### Rules (Firestore)

- Devices read/write **only their own** request doc.
- Only the admin UID can set `approved`.
- Never trust the local cache alone — revalidate against server.

## Alternative: activation codes (zero infra)

Owner generates a per-device code from the device ID (HMAC, secret kept by
owner); app verifies offline with the embedded secret. No server, works
offline — but the secret ships in the APK (extractable) and there is no
revoke. "Honest people honest" only.

## Suggested path

Firebase gate: medium work, real remote accept/revoke, and lays the Firebase
track Phase 3 push needs anyway. Activation codes only if zero backend is a
hard requirement.
