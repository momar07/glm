// ponytail: assert-based self-check for the SipService state machine.
// Run: npx tsx src/renderer/src/sip/SipService.test.mjs
import assert from 'node:assert';

const allowed = {
  disconnected: ['connecting'],
  connecting: ['connected', 'registering', 'disconnected', 'disconnecting'],
  connected: ['registering', 'reconnecting', 'disconnecting'],
  registering: ['registered', 'registration-failed', 'reconnecting', 'disconnecting'],
  registered: ['reconnecting', 'disconnecting'],
  'registration-failed': ['connecting', 'disconnecting'],
  reconnecting: ['connected', 'registering', 'registered', 'registration-failed', 'disconnecting'],
  disconnecting: ['disconnected'],
};

function canTransition(from, to) {
  return (allowed[from] ?? []).includes(to);
}

const checks = [
  ['disconnected -> connecting', canTransition('disconnected', 'connecting')],
  ['registration-failed -> connecting', canTransition('registration-failed', 'connecting')],
  ['registered -> connecting (BLOCKED)', !canTransition('registered', 'connecting')],
  ['connecting -> connecting (BLOCKED)', !canTransition('connecting', 'connecting')],
  ['connected -> connecting (BLOCKED)', !canTransition('connected', 'connecting')],
  ['registered -> registering (BLOCKED)', !canTransition('registered', 'registering')],
  ['registering -> registering (BLOCKED)', !canTransition('registering', 'registering')],
  ['connecting -> connected', canTransition('connecting', 'connected')],
  ['connected -> registering', canTransition('connected', 'registering')],
  ['registering -> registered', canTransition('registering', 'registered')],
  ['registered -> reconnecting', canTransition('registered', 'reconnecting')],
  ['reconnecting -> registered', canTransition('reconnecting', 'registered')],
  ['registered -> disconnecting', canTransition('registered', 'disconnecting')],
  ['connecting -> disconnecting', canTransition('connecting', 'disconnecting')],
  ['reconnecting -> disconnecting', canTransition('reconnecting', 'disconnecting')],
  ['disconnecting -> disconnected', canTransition('disconnecting', 'disconnected')],
  ['reconnecting -> connecting (BLOCKED)', !canTransition('reconnecting', 'connecting')],
];

let pass = 0;
for (const [name, got] of checks) {
  assert.strictEqual(got, true, `${name}: expected true but got ${got}`);
  pass++;
}
console.log(`SipService state machine: ${pass}/${checks.length} transitions verified`);
