// ponytail: end-to-end check of the middleware contract against the mock.
// Run: node src/main/agent.contract.test.mjs
// The mock is the dependency-free server of the MicroSIP project; it needs
// nothing but node. What this proves: the login shape, the ws auth header,
// the ping/pong keepalive, the status echo, the CRM pop, the offline event.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';
import {
  deriveWsUrl,
  parseAgentEvent,
  parseLoginResponse,
  pongJson,
  statusChangeJson,
  statusChanged,
  sameCaller,
  crmPopIsFresh,
} from '../shared/agent.ts';

const MOCK =
  '/home/momar/apps/call-center-project/MicroSIP-3.22.16-src/tests/mock_middleware.js';
const PORT = 18080;
const API = `http://127.0.0.1:${PORT}`;

assert.ok(existsSync(MOCK), `mock middleware not found: ${MOCK}`);

const child = spawn(process.execPath, [MOCK, '--port', String(PORT), '--ping', '1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += String(d)));
child.stderr.on('data', (d) => (log += String(d)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await post('/api/login', { username: 'nobody', password: 'x' });
      if (r.status === 401) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error('the mock middleware did not start');
}

function open(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(deriveWsUrl(API), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const timer = setTimeout(() => reject(new Error('socket timeout')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('unexpected-response', (_r, res) => {
      clearTimeout(timer);
      reject(new Error(`refused: HTTP ${res.statusCode}`));
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Collects parsed events; pongs immediately, exactly like the client.
function listener(ws) {
  const queue = [];
  let waiter = null;
  ws.on('message', (data) => {
    const ev = parseAgentEvent(String(data));
    if (!ev) return;
    if (ev.kind === 'ping') {
      ws.send(pongJson());
      return;
    }
    queue.push(ev);
    waiter?.();
  });
  return {
    next(kind, ms = 4000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          const i = queue.findIndex((e) => e.kind === kind);
          if (i >= 0) {
            waiter = null;
            resolve(queue.splice(i, 1)[0]);
            return;
          }
          if (Date.now() - started > ms) {
            waiter = null;
            reject(new Error(`no ${kind} event in ${ms}ms`));
            return;
          }
          waiter = check;
          setTimeout(check, 50);
        };
        check();
      });
    },
  };
}

let pass = 0;
const step = (name) => {
  pass++;
  console.log(`  ok ${pass} — ${name}`);
};

try {
  await waitReady();
  step('mock middleware listens');

  const bad = await post('/api/login', { username: 'agent1', password: 'nope' });
  assert.strictEqual(bad.status, 401, 'a wrong password is refused');
  assert.strictEqual(bad.body.error, 'Invalid credentials');
  step('401 on a wrong password');

  const good = await post('/api/login', { username: 'agent1', password: 'secret' });
  assert.strictEqual(good.status, 200);
  const login = parseLoginResponse(good.body, API);
  assert.ok(login, 'the answer parses');
  assert.strictEqual(login.extension, '1000');
  assert.strictEqual(login.port, 5060);
  assert.strictEqual(login.domain, '127.0.0.1');
  assert.strictEqual(login.wsUrl, `ws://127.0.0.1:${PORT}/ws`);
  assert.deepStrictEqual(login.queues, ['800', '801']);
  assert.deepStrictEqual(login.pauseReasons, ['Break', 'Pray']);
  step('login answer parsed and ws url derived');

  await assert.rejects(open('wrong-token'), /refused/);
  step('socket refused without a valid bearer token');

  const ws = await open(login.token);
  const rx = listener(ws);
  step('socket open with the authorization header');

  // Two ping intervals with immediate pongs: the mock logs a QueueRemove on a miss.
  await sleep(2600);
  assert.ok(!log.includes('QueueRemove'), 'the keepalive answered every ping');
  step('ping/pong keepalive');

  ws.send(statusChangeJson(login.extension, 'pause', 'Break'));
  const echo = await rx.next('state');
  assert.strictEqual(echo.update.status, 'pause');
  assert.strictEqual(echo.update.reason, 'Break');
  assert.deepStrictEqual(echo.update.queues, ['800', '801']);
  assert.strictEqual(statusChanged(echo.update, 'available', ''), true, 'a real change is detected');
  assert.strictEqual(statusChanged(echo.update, 'pause', 'Break'), false, 'the echo is not a change');
  step('status_change echoed, echo detected as unchanged');

  await post('/simulate/crm_pop', { caller_id: '1333' });
  const pop = await rx.next('pop');
  assert.strictEqual(pop.pop.callerId, '1333');
  assert.strictEqual(pop.pop.uid, '1794882400.1');
  assert.strictEqual(pop.pop.customer?.name, 'Test Customer');
  assert.strictEqual(pop.pop.customer?.tag, 'VIP');
  assert.strictEqual(pop.pop.lastInteraction?.disposition, 'RESOLVED');
  // The app matches the user part of the sip uri, never the whole uri.
  const userPart = 'sip:1333@192.168.2.22'.replace(/^sip:/, '').split('@')[0];
  assert.ok(sameCaller(pop.pop.callerId, userPart), 'the incoming number matches the pop');
  assert.ok(crmPopIsFresh(Date.now(), Date.now()), 'the pop is fresh');
  step('crm_screen_pop parsed and matched to the caller');

  await post('/simulate/state', { status: 'available', reason: '' });
  const remote = await rx.next('state');
  assert.strictEqual(remote.update.status, 'available');
  assert.strictEqual(statusChanged(remote.update, 'pause', 'Break'), true, 'a remote change is detected');
  step('remote admin state change');

  ws.send(statusChangeJson(login.extension, 'offline', ''));
  await sleep(300);
  assert.ok(log.includes('QueueRemove'), 'logout leaves the queue immediately');
  step('offline event removes the agent from the queues');

  ws.terminate();
  console.log(`agent contract: ${pass} checks passed`);
} catch (e) {
  console.error('agent contract: FAILED');
  console.error(e);
  console.error('--- mock log ---\n' + log);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
