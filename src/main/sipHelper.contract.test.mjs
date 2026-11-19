// ponytail: end-to-end check of the helper protocol client in the main process.
// Run: node src/main/sipHelper.contract.test.mjs
// A fake helper (node, no Windows needed) proves: the id matching, the event
// forwarding, the error answers, the garbage lines, and the re-registration on
// a fresh process after a crash.
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SipHelper } from './sipHelper.ts';

const FAKE = String.raw`
import { createInterface } from 'node:readline';

process.stdout.write('not json at all\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const id = msg.id;
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  switch (msg.cmd) {
    case 'ping':
      send({ id, ok: true });
      break;
    case 'register':
      send({ id, ok: true });
      send({ event: 'registration', extension: msg.extension, ok: true, status: 200 });
      break;
    case 'call':
      // the state of the call can race the answer, the client must not care
      send({ event: 'callState', callId: 7, state: 'CONFIRMED', text: 'ok' });
      send({ id, ok: true, callId: 7 });
      break;
    case 'boom':
      send({ id, error: 'nope' });
      break;
    case 'quit':
      process.exit(0);
      break;
    default:
      send({ id, ok: true });
  }
});
`;

const dir = mkdtempSync(join(tmpdir(), 'sip-helper-'));
const fake = join(dir, 'fake-helper.mjs');
writeFileSync(fake, FAKE);

const events = [];
let registrations = 0;
const helper = new SipHelper(
  (event) => {
    events.push(event);
    if (event.event === 'registration' && event.ok) registrations += 1;
  },
  { path: process.execPath, args: [fake] },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting');
    await sleep(20);
  }
}

assert.equal(await helper.available(), true);

const ping = await helper.send({ cmd: 'ping' });
assert.equal(ping.ok, true);

const call = await helper.send({ cmd: 'call', target: '1001' });
assert.equal(call.callId, 7);
await waitFor(() =>
  events.some((e) => e.event === 'callState' && e.callId === 7 && e.state === 'CONFIRMED'),
);

await assert.rejects(
  () => helper.send({ cmd: 'boom' }),
  /nope/,
);

await helper.send({
  cmd: 'register',
  server: '192.168.2.22',
  port: 5060,
  extension: '1002',
  password: 'secret',
  transport: 'udp',
});
await waitFor(() => registrations === 1);

// the crash: pending answers are rejected, the account is registered again
await helper.send({ cmd: 'quit' }).catch(() => {});
await waitFor(() => events.some((e) => e.event === 'helper' && e.alive === false));
await waitFor(() => registrations === 2, 6000);

helper.dispose();
console.log('sipHelper contract: OK (answers, events, crash restart)');
