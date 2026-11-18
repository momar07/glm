// ponytail: assert-based self-check for pure helpers. Run: node src/shared/selfcheck.test.mjs
import assert from 'node:assert';
import { normalizeSipUri, safePhone, formatDuration } from './constants.ts';

const checks = [
  ['normalizeSipUri sip:', normalizeSipUri('sip:1001@pbx', 'pbx.x'), 'sip:1001@pbx'],
  ['normalizeSipUri user@domain', normalizeSipUri('1001@pbx.x', 'pbx.x'), 'sip:1001@pbx.x'],
  ['normalizeSipUri dialstring', normalizeSipUri('+1 (234) 567-8900', 'pbx.x'), 'sip:+12345678900@pbx.x'],
  ['safePhone strips', safePhone('+1 (234) 56-78'), '+12345678'],
  ['formatDuration mm:ss', formatDuration(65), '01:05'],
  ['formatDuration h:mm:ss', formatDuration(3661), '1:01:01'],
  ['formatDuration zero', formatDuration(0), '00:00'],
];

let pass = 0;
for (const [name, got, want] of checks) {
  assert.strictEqual(got, want, `${name}: got ${got} want ${want}`);
  pass++;
}
console.log(`selfcheck: ${pass}/${checks.length} passed`);
