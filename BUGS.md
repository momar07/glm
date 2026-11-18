# BUGS.md — Bug Ledger

A record of bugs found and fixed in this codebase. Each entry includes the
symptom, root cause, fix, and prevention notes — so the same class of bug
doesn't recur.

| #   | Title                                        | Severity | Status   |
|-----|----------------------------------------------|----------|----------|
| 001 | Detached audio element — no remote audio     | Critical | Fixed    |
| 002 | CANCEL instead of BYE — channel stays alive  | Critical | Fixed    |
| 003 | No audio after resume from hold              | Critical | Fixed    |
| 004 | Blind transfer — REFER accepted but no transfer | Major | Fixed    |
| 005 | Incoming-first call silently dropped — no overlay/ring | Critical | Fixed |
| 006 | Failed connect strands state — Reconnecting splash with no exit | Major | Fixed |
| 007 | registerPlugin after super.onCreate — native plugin silently absent | Critical | Fixed |
| 008 | Double-talk garble on Yeastar IAX trunk calls (app exonerated) | Major | Open — PBX-side |

---

## #001 — Detached audio element: no remote audio during calls

**Date**: 2026-07-13
**Severity**: Critical (app's primary function broken)
**Status**: Fixed
**Files changed**: `src/renderer/src/App.tsx`, `src/renderer/src/sip/SipEngine.ts`

### Symptom

> "There is no voice comes from the app during the app."

SIP registration succeeds. Calls are established. Asterisk executes the
announcement. RTP packets are transmitted and received through ICE. DTLS and
SRTP are working. Channel statistics show bidirectional RTP with zero packet
loss. But **no audio is audible** from the softphone.

The PBX was verified correct. The problem was inside the Electron/SIP.js
client.

### Root cause

`App.tsx` rendered the `<audio>` element inside **two separate conditional
branches** — one for the offline/Login state, one for the online state:

```tsx
if (!online) {
  return (
    <div>
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      <Login ... />
    </div>
  );
}
return (
  <div>
    <audio ref={audioRef} autoPlay playsInline className="hidden" />
    <StatusBar />
    ...
  </div>
);
```

The audio element was registered with the SIP engine via a `useEffect` with
empty dependencies:

```tsx
const audioRef = useRef<HTMLAudioElement>(null);
useEffect(() => {
  if (audioRef.current) sipEngine.setRemoteAudio(audioRef.current);
}, []);
```

This effect runs **once** on mount. At mount time, the user is offline, so
React renders the Login branch — `audioRef.current` points to the Login
branch's `<audio>` element. `sipEngine.remoteAudio` now holds that element.

When the user logs in, `presence` changes to `online`. React unmounts the
Login branch (including its `<audio>` element) and mounts the online branch
(with a **new** `<audio>` element). But the `useEffect([], [])` never
re-fires, so `sipEngine.remoteAudio` still points to the old, **detached**
element — a node that is no longer in the DOM.

When a call connects, `attachRemoteAudio()` runs:

```typescript
this.remoteAudio.srcObject = remote;
void this.remoteAudio.play().catch(() => {});
```

`srcObject` is set on the detached element. `play()` is called on the
detached element. Neither produces sound because the element is not in the
document. The `play().catch(() => {})` silently swallows any error.

Meanwhile, the real `<audio>` element in the DOM (the online branch's one)
has `srcObject = null` and never receives the MediaStream.

### Why it was hard to find

- No errors were thrown — `play().catch(() => {})` swallowed everything.
- SIP.js's internal `ontrack` handler worked correctly (it added tracks to
  its `remoteMediaStream`).
- ICE/DTLS/SRTP all succeeded — media was arriving at the peer connection.
- The `getStats()` inbound-rtp report showed `packetsReceived` increasing.
- Everything looked correct from the network layer up — the break was at the
  very last step: DOM element → speaker.

### Fix

**`App.tsx`**: replaced `useRef` + `useEffect([])` with a **callback ref**
that re-registers the audio element every time it mounts:

```tsx
const setAudioRef = useCallback((el: HTMLAudioElement | null): void => {
  if (el) {
    el.volume = 1;
    el.muted = false;
    sipEngine.setRemoteAudio(el);
    logger.info('audio', `audio element bound (inDOM=${el.isConnected} ...)`);
  }
}, []);

// Both branches:
<audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
```

A callback ref fires on every mount/unmount of the element. When React
unmounts the Login branch and mounts the online branch, the callback fires
again with the new element — `sipEngine.remoteAudio` always points to the
element currently in the DOM.

Also removed `className="hidden"` (unnecessary for `<audio>` without
`controls` — the element is invisible by default) and added `id="remoteAudio"`
for diagnostics.

**`SipEngine.ts`**: added full media pipeline diagnostics (see the Audio
diagnostics section in README.md) so this class of bug can be debugged from
the Logs tab in the future. The diagnostics log:
- `ontrack` events (kind, readyState, enabled, streams.length)
- Audio element state before/after attach (srcObject, inDOM, muted, volume)
- `play()` success or the exact DOMException name + message
- All `<audio>` elements in the DOM (catches duplicates)
- `pc.getReceivers()` (verifies audio receiver with live track)
- `pc.getStats()` inbound-rtp (packetsReceived, bytesReceived, jitter, audioLevel)
- 3-second polling of packetsReceived delta

### Prevention

- **Never** use `useRef` + `useEffect([])` to register a DOM element that's
  rendered inside conditional branches. Use a callback ref — it fires on
  every mount.
- **Never** swallow `play()` errors silently. Log them. The DOMException name
  (`NotAllowedError`, `AbortError`, etc.) is the key to diagnosing autoplay
  policy issues.
- The `diagnoseAudioPipeline()` method can be called from the DevTools
  console during a call for a full pipeline dump.

---

## #002 — CANCEL instead of BYE: channel stays alive on Asterisk

**Date**: 2026-07-13
**Severity**: Critical (calls don't tear down on the PBX)
**Status**: Fixed
**Files changed**: `src/renderer/src/sip/SipEngine.ts`

### Symptom

> "I dialed a virtual extension which routes to a queue. When I press End
> Call, the call is ended on the softphone but still running the channel on
> Asterisk."

The softphone UI shows the call as ended. But `asterisk -rx "core show
channels"` shows the channel still up. Queue announcements keep playing. The
channel only dies when Asterisk's RTP timeout or session timer fires (which
can take 30+ seconds).

### Root cause

`terminateInternal()` dispatched on **method existence** instead of **session
state**:

```typescript
private async terminateInternal(session: AnySession): Promise<void> {
  try {
    if (!session) return;
    const state = session.state;
    if (state === 'Terminated' || state === 'Terminating') return;
    if (typeof session.cancel === 'function') await session.cancel();  // ← BUG
    else if (typeof session.bye === 'function') await session.bye();
  } catch {
    /* ignore */  // ← swallows the error, BYE never sent
  }
}
```

An `Inviter` (outbound call session) has **both** `cancel()` and `bye()`.
The code checked `typeof session.cancel === 'function'` first — this is
`true` for an `Inviter`, so `session.cancel()` is called.

But SIP.js's `Inviter.cancel()` validates the session state
(`node_modules/sip.js/lib/api/inviter.js:195`):

```javascript
cancel(options = {}) {
  if (this.state !== SessionState.Initial && this.state !== SessionState.Establishing) {
    const error = new Error(`Invalid session state ${this.state}`);
    return Promise.reject(error);
  }
  // ... sends CANCEL ...
}
```

For an **established** call, `this.state === SessionState.Established`, so
`cancel()` **rejects with `"Invalid session state Established"`**.

The empty `catch {}` block **swallowed the error**. The `else if` for `bye()`
was already skipped (the `if` was taken, even though it threw). So **BYE was
never sent**.

Back in `hangup()`:

```typescript
async hangup(callId: string): Promise<void> {
  const call = this.sessions.get(callId);
  if (!call) return;
  await this.terminateInternal(call.internal);  // ← throws internally, swallowed
  this.endCall(call, 'hangup');                  // ← runs anyway, UI shows "ended"
}
```

`endCall()` is called unconditionally after `terminateInternal`, so the UI
shows the call as ended — but **no SIP BYE went on the wire**. Asterisk never
received a BYE, so it keeps the channel alive.

### Why it only affected established calls

- **Pre-answer hangup** (state = `Establishing`): `cancel()` succeeds, sends
  SIP CANCEL. Asterisk sees the CANCEL, tears down the early dialog. Works
  correctly.
- **Post-answer hangup** (state = `Established`): `cancel()` rejects, BYE is
  never sent. Asterisk keeps the channel alive. **Broken.**
- **Incoming call reject** (state = `Initial`, `Invitation`): `Invitation`
  doesn't have `cancel()`, so the `else if` falls through to... nothing,
  because `Invitation` has `reject()` not `bye()` in the pre-answer state.
  But `reject()` is called directly from `SipEngine.reject()`, not through
  `terminateInternal()`, so this path wasn't affected in practice.

### Fix

Dispatch on **session state**, not method existence:

```typescript
private async terminateInternal(session: AnySession): Promise<void> {
  if (!session) return;
  const state = session.state;
  if (state === 'Terminated' || state === 'Terminating') return;

  try {
    // Dispatch on session STATE, not method existence. An Inviter has both
    // cancel() and bye(); calling cancel() on an Established Inviter throws
    // "Invalid session state Established" and the empty catch swallows it,
    // so BYE is never sent and the remote channel stays alive.
    //   Established     → bye()     (sends SIP BYE — tears down confirmed dialog)
    //   Initial/Establishing + Inviter    → cancel()  (sends SIP CANCEL)
    //   Initial/Establishing + Invitation → reject()  (sends 486/487)
    if (state === 'Established') {
      if (typeof session.bye === 'function') await session.bye();
    } else if (typeof session.cancel === 'function') {
      await session.cancel();
    } else if (typeof session.reject === 'function') {
      await session.reject({ statusCode: 487, reasonPhrase: 'Request Terminated' });
    }
  } catch (e: any) {
    this.log('warn', `terminate failed (state=${state}): ${e?.message}`);
  }
}
```

Three changes:

1. **State-based dispatch**: `Established` → `bye()`; not-established →
   `cancel()` (Inviter) or `reject()` (Invitation). This is the correct SIP
   protocol mapping: BYE tears down a confirmed dialog; CANCEL tears down an
   early dialog; reject refuses an incoming INVITE.

2. **Error logging**: the `catch` block now logs the error instead of
   silently swallowing it. If `bye()` fails (e.g., network down), the Logs
   tab will show `terminate failed (state=Established): <message>` — making
   the failure visible and debuggable.

3. **Invitation reject**: added `reject()` as a fallback for incoming calls
   that haven't been answered yet (used by `shutdown()` when terminating all
   sessions, which may include a ringing incoming call).

### SIP protocol background

| Call state          | SIP method to tear down | Why                                          |
|---------------------|-------------------------|----------------------------------------------|
| Early (not answered)| CANCEL                  | Cancels the outstanding INVITE transaction   |
| Confirmed (answered)| BYE                     | Tears down the confirmed dialog              |
| Incoming (not accepted) | reject (4xx/6xx)    | Rejects the INVITE before a dialog is created|

CANCEL is only valid while the INVITE transaction is still pending (no final
response sent/received). Once the call is answered (200 OK received and ACK
sent), the dialog is confirmed and only BYE can tear it down. This is RFC
3261 §15.

### Prevention

- **Never** dispatch SIP teardown on method existence. `Inviter` has both
  `cancel()` and `bye()` — the choice between them is a *protocol* decision,
  not an API-availability decision. Always check session state.
- **Never** swallow errors in `catch {}` without at least logging them. An
  empty catch block is a bug factory — it hides failures that should be
  visible. The one-line `this.log('warn', ...)` added here would have made
  this bug immediately diagnosable.
- The SIP.js `SessionState` enum is the source of truth for what teardown
  method is valid: `Initial`/`Establishing` → CANCEL/reject; `Established`
  → BYE; `Terminating`/`Terminated` → already dead, no-op.

---

## #003 — No audio after resume from hold

**Date**: 2026-07-13
**Severity**: Critical (hold/resume is a core feature)
**Status**: Fixed (three iterations — timing and hook point were red herrings;
the real cause was the `holdModifier` desyncing WebRTC transceiver state)
**Files changed**: `src/renderer/src/sip/SipEngine.ts`

### Symptom

> "When I come back from hold, the call has no sound or voice return."

Hold works correctly — the remote party is put on hold, the softphone goes
silent. But after pressing Resume, the softphone stays silent. The remote
party can hear the softphone user (the uplink is fine), but the softphone
user hears nothing from the PBX. The call appears connected in the UI, but
audio never returns. The only fix is to hang up and re-dial.

### Root cause (confirmed by diagnostics logs)

The root cause was the **`holdModifier`** desyncing the WebRTC
`RTCRtpTransceiver`'s internal direction state from the SDP text.

SIP.js's `holdModifier` (`node_modules/sip.js/lib/platform/web/modifiers/modifiers.js:147`)
operates on SDP **text** *after* `createOffer()` has already run:

```javascript
export function holdModifier(description) {
    let sdp = description.sdp;
    sdp = sdp.replace(/a=sendrecv\r\n/g, "a=sendonly\r\n");  // text replacement
    return Promise.resolve({ sdp, type });
}
```

The SIP.js SDH pipeline is (`session-description-handler.js:207-214`):

```
getLocalMediaStream → updateDirection → createDataChannel
  → createLocalOfferOrAnswer → applyModifiers      ← holdModifier runs here
  → setLocalSessionDescription                     ← sets the modified SDP
```

`createLocalOfferOrAnswer` calls `pc.createOffer()`, which reads the
transceiver's `direction` property (e.g. `sendrecv`) and produces SDP with
`a=sendrecv`. Then `applyModifiers` runs `holdModifier`, which rewrites the
SDP text to `a=sendonly`. Then `setLocalSessionDescription` calls
`pc.setLocalDescription({ sdp: modified })`.

Here's the desync: `setLocalDescription` with `a=sendonly` **silently
mutates** `transceiver.direction` to `sendonly` to match the SDP. But the
transceiver's internal state machine has been bypassed — `setDirection()`
was never called, so the transceiver's bookkeeping is inconsistent. On the
*next* offer (resume), `createOffer()` reads `transceiver.direction` — which
may still be `sendonly` internally despite the SDH's `updateDirection()`
trying to reset it to `sendrecv`. The offer goes out with the wrong
direction, the PBX answers accordingly, and the receiver never resumes.

### Evidence from diagnostics logs

**Before the fix** (using `holdModifier`):

```
attachRemoteAudio: stream track[0]: readyState=live enabled=true muted=true
receiver[0]:        readyState=live enabled=true muted=true
getStats(): no inbound audio RTP report yet
(no stats lines follow — RTP never resumes)
```

The track's `muted=true` is set by the **browser** when it's not receiving
RTP. `getStats()` shows zero inbound-rtp reports — no packets arriving at
all. The PBX is not sending media because the transceiver direction was
wrong in the resume offer.

**After the fix** (using `hold: true/false` option):

```
transceiver[0] before hold:       direction=sendrecv currentDirection=sendrecv
transceiver[0] after hold answer: direction=sendonly currentDirection=sendonly
transceiver[0] before resume:     direction=sendonly currentDirection=sendonly
transceiver[0] after resume:      direction=sendrecv currentDirection=sendrecv  ← correct!
stream track[0]:                  readyState=live enabled=true muted=false      ← unmuted!
inbound audio RTP:                packetsReceived=1 bytesReceived=160           ← RTP flowing!
ICE:                              connectionState=connected throughout          ← stable
```

The transceiver direction correctly cycles `sendrecv → sendonly → sendrecv`,
the track unmutes, and RTP flows immediately after resume.

### The fix

Replaced the `holdModifier` with SIP.js's built-in `hold` SDH option, which
uses `transceiver.setDirection()` *before* `createOffer()` — the proper
WebRTC way to manage direction.

**`hold()` — use `sessionDescriptionHandlerOptions: { hold: true }`:**

```typescript
async hold(callId: string): Promise<void> {
  const s = call.internal as AnySession;
  await s.invite({
    sessionDescriptionHandlerOptions: { hold: true },
    requestDelegate: {
      onAccept: () => this.logTransceiverDirections(s, 'after hold answer'),
      onReject: (resp) => this.log('warn', `hold re-INVITE rejected: ${resp?.message?.statusCode}`),
    },
  });
  call.held = true;
  call.status = 'held';
  this.em.emit('callUpdate', { ...call });
}
```

The `hold: true` option makes `updateDirection()` (session-description-handler.js:688)
call `transceiver.setDirection("sendonly")` **before** `createOffer()`. So
`createOffer()` naturally produces `a=sendonly` — no text modification needed,
no desync. The transceiver's internal state is consistent with the SDP.

**`resume()` — use `sessionDescriptionHandlerOptions: { hold: false }`
and `requestDelegate.onAccept` as the hook point:**

```typescript
async resume(callId: string): Promise<void> {
  const s = call.internal as AnySession;
  await s.invite({
    sessionDescriptionHandlerOptions: { hold: false },
    requestDelegate: {
      onAccept: () => {
        // Fires AFTER setAnswer → setRemoteDescription completes.
        this.logTransceiverDirections(s, 'after resume answer');
        this.attachRemoteAudio(s);
      },
      onReject: (resp) => this.log('warn', `resume re-INVITE rejected: ${resp?.message?.statusCode}`),
    },
  });
  call.held = false;
  call.status = 'in-call';
  this.em.emit('callUpdate', { ...call });
}
```

The `hold: false` option makes `updateDirection()` reset the transceiver
direction to `sendrecv` before `createOffer()`. The offer contains
`a=sendrecv`, the PBX answers with `a=sendrecv`, and the receiver resumes.

`requestDelegate.onAccept` fires after `setAnswer` → `setRemoteDescription`
completes (SIP.js `session.js:374-378`) — this is the earliest point where
the remote description is applied and the track is ready. `attachRemoteAudio`
sets `srcObject` and calls `play()` at the right moment.

**`attachRemoteAudio` — explicitly re-enable receiver tracks:**

```typescript
pc.getReceivers().forEach((r: RTCRtpReceiver) => {
  if (r.track && r.track.kind === 'audio') {
    if (!r.track.enabled) {
      this.log('info', `attachRemoteAudio: re-enabling disabled audio receiver track`);
      r.track.enabled = true;
    }
  }
});
```

Safety net: if anything disabled the track during hold, re-enable it.

**`hookPeerConnection` — added transceiver direction + ICE state logging:**

```typescript
pc.addEventListener('iceconnectionstatechange', () => {
  this.log('info', `ICE state changed: ${pc.iceConnectionState} (signaling=${pc.signalingState})`);
});
pc.addEventListener('connectionstatechange', () => {
  this.log('info', `PC connection state: ${pc.connectionState}`);
});
```

Plus `logTransceiverDirections()` which logs `direction`,
`currentDirection`, `mid`, ICE connection state, gathering state, and
signaling state at each hold/resume checkpoint. This is what confirmed the
root cause — the transceiver direction was stuck at `sendonly` after resume.

### Why the first two fix attempts didn't work

**Attempt 1**: called `attachRemoteAudio(s)` after `await s.invite()`.
Didn't work because `s.invite()` resolves when the INVITE is **sent**, not
when the 200 OK arrives — so `attachRemoteAudio` ran before the answer was
applied. But even fixing the timing (attempt 2) didn't help, because the
real problem was the SDP direction, not the attach timing.

**Attempt 2**: moved `attachRemoteAudio` into `requestDelegate.onAccept`
(fires after `setAnswer` completes). The hook point was now correct, and
the logs showed `onAccept` firing — but the track was still `muted=true`
and no RTP was flowing. This proved the problem was **upstream of the audio
element**: the PBX wasn't sending media because the resume offer's direction
was wrong (the `holdModifier` had desynced the transceiver).

**Attempt 3** (the actual fix): replaced `holdModifier` with the `hold`
SDH option. This fixed the transceiver direction, RTP resumed immediately,
and the track unmuted.

### Prevention

- **Never use `holdModifier` for hold/resume.** It modifies SDP text after
  `createOffer()`, which desyncs the WebRTC transceiver's internal direction
  state. Use `sessionDescriptionHandlerOptions: { hold: true/false }` instead
  — it calls `transceiver.setDirection()` *before* `createOffer()`, keeping
  the transceiver state consistent with the SDP.
- **`Session.invite()` resolves on send, not on answer.** Never call
  `attachRemoteAudio` (or any media-dependent logic) after `await s.invite()`.
  Use `requestDelegate.onAccept` — it fires after `setAnswer` completes.
- **Re-INVITEs don't change `SessionState`.** The state stays `Established`
  throughout. `bindSession`'s state listener never fires on hold/resume.
  Any media re-attachment must be triggered from the re-INVITE's `onAccept`
  callback.
- **Log transceiver directions during renegotiation.** The
  `logTransceiverDirections()` helper was what pinpointed the root cause —
  it showed `direction=sendonly currentDirection=sendonly` after resume when
  it should have been `sendrecv`. Always log `direction` and
  `currentDirection` when debugging hold/resume.
- **Re-enable receiver tracks on resume.** If anything disabled the track
  (`enabled=false`), it produces silence even when RTP flows. SIP.js's
  `SessionManager` does this via `enableReceiverTracks`; if you're not
  using `SessionManager`, do it explicitly in `attachRemoteAudio`.

---

## #004 — Blind transfer: REFER accepted but transfer doesn't happen

**Date**: 2026-07-13
**Severity**: Major (transfer is a core PBX feature)
**Status**: Fixed
**Files changed**: `src/renderer/src/sip/SipEngine.ts`

### Symptom

> "The transfer button won't transfer and gives me in the log REFER accepted."

The user enters a transfer target and presses Transfer. The log shows
"REFER accepted". But the call doesn't actually transfer — the original
call stays alive, the target doesn't get dialed (or gets dialed but the
transfer doesn't complete), and the softphone stays in the call.

### Root cause

`blindTransfer()` sent the REFER and logged the 202 Accepted, but did
**nothing after that**:

```typescript
async blindTransfer(callId: string, target: string): Promise<void> {
  await s.refer(targetURI, {
    requestDelegate: { onAccept: () => this.log('info', 'REFER accepted') },
  });
}
```

Two things were missing:

**1. No `onNotify` callback — transfer status was invisible.**

After a REFER is accepted (202), the PBX sends NOTIFY messages with the
transfer progress. The NOTIFY body is a sipfrag like
`SIP/2.0 200 OK` (transfer succeeded) or `SIP/2.0 486 Busy Here` (failed).
The `Subscription-State` header is `active` while pending and `terminated`
when done.

Without `onNotify`, SIP.js auto-accepts the NOTIFYs (`request.accept()` at
`session.js:878`) but the app never sees them. The transfer could be
succeeding, failing, or timing out — the log only shows "REFER accepted"
and nothing else. The user has no way to know what happened.

**2. No hangup after transfer success — original call stays alive.**

After a successful blind transfer (NOTIFY with `200 OK` +
`Subscription-State: terminated`), the referer's call should end. The PBX
usually sends a BYE, but some PBX configurations (especially with queues)
expect the referer to hang up. Without an explicit `hangup()` call, the
original call stays alive — the softphone shows "in-call" while the PBX
has already transferred the media to the target.

### The SIP REFER transfer flow (RFC 3515)

```
Softphone                    PBX                       Target
   │── REFER (Refer-To: target)──→│                         │
   │←── 202 Accepted ─────────────│                         │
   │←── NOTIFY (100 Trying) ──────│── INVITE (target) ────→│
   │←── NOTIFY (180 Ringing) ─────│←── 180 Ringing ────────│
   │←── NOTIFY (200 OK) ──────────│←── 200 OK ─────────────│
   │── BYE ─────────────────────→│                         │
   │   (or PBX sends BYE)         │                         │
```

The `onNotify` callback fires for each NOTIFY. When the body contains
`200 OK` and `Subscription-State` is `terminated`, the transfer succeeded
and the referer should hang up.

### Fix

Added `onNotify` callback that logs transfer progress and hangs up on
success:

```typescript
async blindTransfer(callId: string, target: string): Promise<void> {
  const s = call.internal as AnySession;
  const targetURI = this.sipjs.UserAgent.makeURI(uri);
  this.log('info', `Blind transfer: ${call.remote} → ${uri}`);
  await s.refer(targetURI, {
    requestDelegate: {
      onAccept: () => this.log('info', 'REFER accepted (202) — PBX will attempt transfer'),
      onReject: (resp) => this.log('warn', `REFER rejected: ${resp?.message?.statusCode}`),
    },
    onNotify: (notification) => {
      const msg = notification?.request;
      const subState = msg?.getHeader?.('Subscription-State') || 'unknown';
      const body = msg?.body || '';
      this.log('info', `TRANSFER NOTIFY: state=${subState} body=${body.trim()}`);
      void notification.accept().catch(() => {});
      if (subState === 'terminated') {
        if (body.includes('200 OK')) {
          this.log('info', 'Transfer succeeded — sending BYE to original call');
          void this.hangup(callId);
        } else {
          this.log('warn', `Transfer failed: ${body.trim()}`);
        }
      }
    },
  });
}
```

Three changes:

1. **`onNotify` callback**: logs every NOTIFY's `Subscription-State` and
   sipfrag body. The user can now see `TRANSFER NOTIFY: state=active
   body=SIP/2.0 100 Trying`, then `state=terminated body=SIP/2.0 200 OK`
   (or a failure code). The transfer status is fully visible.

2. **Hangup on success**: when `Subscription-State: terminated` and the
   body contains `200 OK`, calls `this.hangup(callId)` to send a BYE and
   tear down the original call. This is the standard referer behavior
   after a successful blind transfer.

3. **Log on failure**: when `Subscription-State: terminated` and the body
   does NOT contain `200 OK`, logs the failure reason (e.g.,
   `SIP/2.0 486 Busy Here`). The original call stays alive — the user can
   retry or continue the call.

4. **Explicit notification.accept()**: accepts each NOTIFY so the PBX
   knows we received it. SIP.js does this automatically when `onNotify`
   is not set, but when it IS set, we must do it ourselves.

### Prevention

- **Always handle `onNotify` when sending a REFER.** Without it, the
  transfer status is invisible — you see "REFER accepted" and nothing
  else. The `onNotify` callback is the only way to know if the transfer
  succeeded, failed, or is still in progress.
- **Hang up the original call after a successful transfer.** When the
  NOTIFY says `200 OK` + `terminated`, the referer's job is done — send a
  BYE. Some PBXs send the BYE themselves, but don't rely on it.
- **Log the sipfrag body from NOTIFY.** It contains the actual SIP
  response code from the transfer target. `SIP/2.0 200 OK` = success,
  `SIP/2.0 486 Busy Here` = target busy, `SIP/2.0 408 Request Timeout` =
  target didn't answer. This is critical for debugging transfer failures.
- **Accept each NOTIFY.** When you provide `onNotify`, SIP.js does NOT
  auto-accept — you must call `notification.accept()` or the PBX will
  retry the NOTIFY.

---

## #005 — Incoming-first call silently dropped: Asterisk rings, app stays silent

**Date**: 2026-09-22
**Severity**: Critical (incoming calls completely missed on fresh launch)
**Status**: Fixed
**Files changed**: `src/renderer/src/store/call.ts`

### Symptom

> "No incoming call comes or ringing although it ringing on the Asterisk CLI."

The PBX rings the caller. The app shows nothing — no overlay, no ringtone, no
notification. The engine log even shows `Session created (incoming, …)` while
the UI stays dead. Intermittent: after placing one outgoing call, incoming
calls start working.

### Root cause

The call store subscribed to the SIP engine inside `makeCall()`:

```typescript
async makeCall(target) {
  bind(set, get);   // ← engine listeners attached HERE, and only here
  ...
}
```

`bind()` registers the `incoming` / `outgoing` / `callUpdate` / `callEnded`
listeners that drive the overlay, ringtone, redial, and history. If the first
call event after launch was an **incoming** call, zero listeners existed: the
engine held the session, Asterisk kept ringing, and nothing in the UI ever
fired. One outgoing call flipped `bound = true` and masked the bug afterwards —
hence "works after I dial out once".

### Fix

Bind once in the store initializer instead of inside an action:

```typescript
export const useCall = create<CallState>((set, get) => {
  bind(set, get);   // listeners live from startup; `bound` flag keeps it once
  return { ... };
});
```

### Prevention

- **Never gate event subscriptions behind an unrelated user action.**
  Subscriptions belong in module/store setup, not in `makeCall`/`answer`/etc.
- An `if (bound) return` flag hides *where* binding happens — grep all callers
  of a guarded init before trusting it.

---

## #006 — Failed connect strands state: Reconnecting splash with no exit

**Date**: 2026-09-22
**Severity**: Major (fresh installs can brick into a dead screen)
**Status**: Fixed
**Files changed**: `src/renderer/src/sip/SipEngine.ts`, `src/renderer/src/App.tsx`

### Symptom

> Fresh install, press Connect, stuck on "Reconnecting… — Restoring your
> session" forever, with no way back to fix settings.

### Root cause

`doInitialize()` transitioned to `connecting` first, then ran fallible steps
(module import, URI parse, UA start). Only the `ua.start()` failure reset the
state — any other throw (bad URI, hung socket, dead server) left the machine
in `connecting` with no live attempt. The splash (added for mid-recovery)
keys off exactly that state, so it parked forever with no Cancel path, and
the Login form stayed disabled behind `connecting: true`.

### Fix

- `initialize()` catches any `doInitialize` failure and forces idle
  (`disconnecting → disconnected`) via the transition table — the machine can
  never strand mid-connect.
- Splash gained a Cancel button → new `cancelConnect()` (bumps the generation
  to invalidate the in-flight attempt, drops the half-built UA, forces idle)
  plus a store `connecting: false` reset so the Login form unsticks.

### Prevention

- Every state machine needs a failure edge out of *each* transient state, not
  just the one you tested. If a screen keys off a transient state, it must
  also offer an exit from it.

---

## #007 — registerPlugin after super.onCreate: native plugin silently absent

**Date**: 2026-09-22
**Severity**: Critical (foreground service, battery check, audio routing all dead)
**Status**: Fixed
**Files changed**: `android/.../MainActivity.java`, `lib/system.ts`, `lib/audioRoute.ts`

### Symptom

> Calls stay on loudspeaker, Speaker button does nothing. (Also: no persistent
> service notification, no battery prompt — same root cause.)

### Root cause

`MainActivity.onCreate()` called `registerPlugin(SystemPlugin.class)` **after**
`super.onCreate()`. But `BridgeActivity.onCreate` consumes `bridgeBuilder` to
create the bridge (`load()` → `create()`), so a builder addition afterwards
lands nowhere — verified in `node_modules/@capacitor/android/.../BridgeActivity.java`
(`registerPlugin` → `bridgeBuilder.addPlugin`, bridge already built). Every
`Capacitor.Plugins.System` call resolved to `undefined`, and both JS bridges
treated that as "not native, no-op" without a word.

### Fix

- Register **before** `super.onCreate()`, when the builder is still unconsumed.
- Both JS bridges now log an error once when native yet plugin-less, so this
  class of silent failure is visible in the Logs tab.

### Prevention

- Order-dependent native init with silent failure is a trap: always verify a
  new plugin appears in `Capacitor.Plugins` (log it at boot) instead of
  assuming registration worked.

---

*When a new bug is found and fixed, add an entry here following the same
format: symptom, root cause, fix, prevention. Number sequentially.*

---

## #008 — Double-talk garble on Yeastar IAX trunk calls (app exonerated)

**Date**: 2026-09-25
**Severity**: Major (trunk calls hard to hold a conversation over)
**Status**: Open — PBX-side (no app change needed unless trunk tests clear it)
**Files changed**: none yet (diagnosis only)

### Symptom

> "During the call, when the client talks I hear him very well. But if I talk
> at the same time, the client's voice garbles and isn't clear."

One-way voice is perfect in both directions. The moment both sides talk
simultaneously (double-talk), the remote voice garbles/muffles until one side
stops.

### Controlled experiments (what rules what out)

| # | Test | Result | Rules out |
|---|------|--------|-----------|
| A | Earpiece, noise suppression OFF | Same garble | Noise suppression |
| B | Earpiece, echo cancellation OFF too | Same garble | Local AEC (WebView) |
| C | Opus 16 / 32 / 48 | Same on all three | Codec + bitrate entirely |
| D | Internal (extension-to-extension) calls | Clean | App, phone, SIP leg, Opus |
| E | Calls via Yeastar IAX trunk | Garble on double-talk | — (isolates the trunk path) |

A+B exonerate the whole client audio chain (mic processing, device DSP path,
Opus). D proves the app + PBX SIP leg are clean. Only E fails — the fault is
downstream of the PBX, in the IAX trunk path. (Far-side experience still
untested.)

### Ranked suspects (most likely first)

**1. Transcoding on the trunk path.** App↔PBX leg negotiates Opus; the IAX
trunk leg is almost certainly alaw/ulaw (or g729). The PBX therefore transcodes
every trunk call — and transcoders are exactly where double-talk turns to mush
while single-talk sounds fine. Internal calls stay single-codec (native bridge,
no transcode), which is why they are clean.

**2. IAX trunk multiplexing + jitter buffer.** `trunk=yes` multiplexes frames
across calls; under jitter, overlap/double-talk is the first casualty.

**3. Yeastar-side echo canceller / VAD.** Same double-talk suppression story,
sitting on the gateway: its EC or silence-suppression/VAD clips incoming voice
when both sides talk.

**4. Trunk network path.** Loss/jitter between the boxes (not the phone link).

### Tomorrow's checklist (in this order)

1. **Logs compare**: `inbound audio RTP` lines — `packetsLost=`/`jitter=` on a
   clean internal call vs a garbling trunk call. Loss only on trunk → suspect 4.
2. **Transcode check** (during a garbling call): `core show channels` — Read vs
   Write formats on both legs. Differ (Opus ↔ alaw/g729) → suspect 1 confirmed.
   Fix: align `allow=` so trunk calls bridge natively (e.g. alaw end-to-end on
   the trunk route) — one-line PBX change, no app change.
3. **Trunk config**: `iax.conf` peer section — `allow=`, `trunk=`, `jitterbuffer`,
   `forcejitterbuffer`, `maxjitterbuffer`. Test call with `trunk=no`.
4. **Yeastar trunk page**: echo cancellation and silence suppression/VAD —
   toggle off as a test.
5. **Far-side check**: does the remote party also hear garble on double-talk,
   or only the app side? (Tells transcoder vs one-directional suppression.)

### Prevention

- Diagnose voice quality with controlled experiments before touching code: one
  variable per test, keep an internal-call control group, read `packetsLost`
  before changing anything. This issue survived two setting toggles and three
  bitrates because the fault was never in the app — the experiment table proved
  it in an afternoon.
- "Fine one-way, broken on double-talk" points at transcoders, trunk
  multiplexing, or echo cancellers — never at bitrate. Don't chase kbps for a
  double-talk symptom.
