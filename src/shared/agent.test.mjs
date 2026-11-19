// ponytail: assert-based self-check for shared/agent.ts. Run: node src/shared/agent.test.mjs
import assert from 'node:assert';
import {
  parseWsUrl,
  deriveWsUrl,
  pongJson,
  statusChangeJson,
  statusChanged,
  anchorOffset,
  urlEncode,
  workspaceUrl,
  dashboardUrl,
  callerDigits,
  sameCaller,
  crmPopIsFresh,
  parseLoginResponse,
  parseAgentEvent,
} from './agent.ts';

const now = 1_700_000_000_000;

const checks = [
  // --- deriveWsUrl / parseWsUrl ---
  ['ws from http', deriveWsUrl('http://192.168.2.22:8080'), 'ws://192.168.2.22:8080/ws'],
  ['ws from https default port', deriveWsUrl('https://pbx.example'), 'wss://pbx.example/ws'],
  ['ws from http default port', deriveWsUrl('http://pbx.example/'), 'ws://pbx.example/ws'],
  ['ws from https explicit 443', deriveWsUrl('https://pbx.example:443/api'), 'wss://pbx.example/ws'],
  ['ws from api with path still uses ws path', deriveWsUrl('http://h:7000/prefix', '/ws'), 'ws://h:7000/ws'],
  ['ws garbage', deriveWsUrl('pbx.example'), ''],
  ['ws bad port', deriveWsUrl('http://h:abc'), ''],
  ['parse ws userinfo', JSON.stringify(parseWsUrl('wss://u:p@h:9000/x')), '{"host":"h","port":9000,"path":"/x","secure":true}'],
  ['parse ws no scheme', parseWsUrl('h:1/x'), null],

  // --- wire payloads ---
  ['pong json', pongJson(), '{"event":"pong"}'],
  [
    'status change json',
    statusChangeJson('1000', 'pause', 'Break'),
    '{"event":"status_change","extension":"1000","status":"pause","reason":"Break"}',
  ],
  [
    'offline json',
    statusChangeJson('1000', 'offline', ''),
    '{"event":"status_change","extension":"1000","status":"offline","reason":""}',
  ],

  // --- statusChanged: the echo must not restart the timer ---
  ['echo same', statusChanged({ hasStatus: true, hasReason: true, status: 'pause', reason: 'Break' }, 'pause', 'Break'), false],
  ['no fields', statusChanged({ hasStatus: false, hasReason: false, status: '', reason: '' }, 'pause', 'Break'), false],
  ['status changed', statusChanged({ hasStatus: true, hasReason: false, status: 'available', reason: '' }, 'pause', 'Break'), true],
  ['reason present empty counts', statusChanged({ hasStatus: false, hasReason: true, status: '', reason: '' }, 'pause', 'Break'), true],
  ['reason changed', statusChanged({ hasStatus: true, hasReason: true, status: 'pause', reason: 'Lunch' }, 'pause', 'Break'), true],

  // --- anchorOffset ---
  ['anchor first', anchorOffset(null, 5000), 5000],
  ['anchor jitter ignored', anchorOffset(5000, 5900), 5000],
  ['anchor drift re-anchors', anchorOffset(5000, 6100), 6100],

  // --- url encoding / record urls ---
  ['url encode', urlEncode('a b*~'), 'a%20b%2A~'],
  ['url encode plus', urlEncode('+20100'), '%2B20100'],
  ['workspace empty base', workspaceUrl('', '1', '2'), ''],
  ['workspace url', workspaceUrl('https://crm/x', '1333', 'abc.1'), 'https://crm/x?phone=1333&uid=abc.1'],
  ['workspace existing query', workspaceUrl('https://crm/x?a=1', '1333', ''), 'https://crm/x?a=1&phone=1333'],
  ['workspace encodes', workspaceUrl('https://crm/x', '+20 100', ''), 'https://crm/x?phone=%2B20%20100'],
  [
    'dashboard url',
    dashboardUrl('http://h:8080/', 'tok', '1333', '9.1'),
    'http://h:8080/?token=tok&phone=1333&uid=9.1#crm-customers',
  ],
  ['dashboard no phone/uid', dashboardUrl('http://h:8080', 't', '', ''), 'http://h:8080/?token=t#crm-customers'],

  // --- caller matching ---
  ['digits last ten', callerDigits('+20 100 123 4567'), '1001234567'],
  ['digits short', callerDigits('*100#'), '100'],
  ['same caller formatted', sameCaller('+20 100 123 4567', '01001234567'), true],
  ['same caller email never', sameCaller('agent@x', 'agent@x'), false],
  ['same caller empty', sameCaller('', '123'), false],
  ['same caller different', sameCaller('111222333', '444555666'), false],

  // --- pop freshness (ms) ---
  ['fresh now', crmPopIsFresh(now, now), true],
  ['fresh exactly 30s', crmPopIsFresh(now - 30_000, now), true],
  ['stale 30s+1ms', crmPopIsFresh(now - 30_001, now), false],
  ['future record', crmPopIsFresh(now + 1, now), false],
  ['zero at', crmPopIsFresh(0, now), false],
  ['zero now', crmPopIsFresh(now, 0), false],
];

const login = parseLoginResponse(
  {
    sip_extension: '1000',
    sip_password: 'sip-secret',
    sip_server_ip: '192.168.2.22',
    assigned_queues: ['800', '801'],
    pause_reasons: ['Break'],
    token: 'tok',
    timestamp: 1731380000,
  },
  'http://192.168.2.22:8080',
);

checks.push(
  ['login extension', login?.extension, '1000'],
  ['login port default', login?.port, 5060],
  ['login domain defaults to server', login?.domain, '192.168.2.22'],
  ['login ws derived', login?.wsUrl, 'ws://192.168.2.22:8080/ws'],
  ['login queues', JSON.stringify(login?.queues), '["800","801"]'],
  ['login missing token', parseLoginResponse({ sip_extension: '1' }, 'http://h'), null],
  ['login missing extension', parseLoginResponse({ token: 't' }, 'http://h'), null],
  [
    'login ws_url override',
    parseLoginResponse({ sip_extension: '1', token: 't', ws_url: 'wss://x/ws' }, 'http://h')?.wsUrl,
    'wss://x/ws',
  ],
  [
    'login domain override',
    parseLoginResponse({ sip_extension: '1', token: 't', sip_domain: 'issabel.local' }, 'http://h')?.domain,
    'issabel.local',
  ],
  [
    'login port override',
    parseLoginResponse({ sip_extension: '1', token: 't', sip_server_port: 5070 }, 'http://h')?.port,
    5070,
  ],
);

const state = parseAgentEvent(
  '{"event":"state_update","extension":"1000","status":"pause","reason":"Break","assigned_queues":["800"],"timestamp":1731380000}',
);
checks.push(
  ['event ping', parseAgentEvent('{"event":"ping"}')?.kind, 'ping'],
  ['event state kind', state?.kind, 'state'],
  ['event state status', state?.kind === 'state' ? state.update.status : null, 'pause'],
  ['event state queues', state?.kind === 'state' ? JSON.stringify(state.update.queues) : null, '["800"]'],
  ['event garbage', parseAgentEvent('not json'), null],
  ['event array', parseAgentEvent('[]'), null],
  ['event unknown', parseAgentEvent('{"event":"ticket"}')?.kind, 'unknown'],
);

const pop = parseAgentEvent(
  JSON.stringify({
    event: 'crm_screen_pop',
    extension: '1005',
    agent_ext: '1005',
    caller_number: '1333',
    cdr_uniqueid: '1794882400.1',
    is_new: false,
    customer: {
      id: 4,
      full_name: 'Test Customer',
      tag: 'VIP',
      company: 'Test Company',
      primary_phone: '1333',
      secondary_phone: '',
      category_code: 'Normal',
    },
    last_interaction: { disposition_code: 'RESOLVED', notes: 'ok', created_at: '2026-01-01' },
  }),
);
const newPop = parseAgentEvent(
  '{"event":"crm_screen_pop","caller_id":"777","uniqueid":"1.2","is_new":true,"customer":null}',
);

checks.push(
  ['pop kind', pop?.kind, 'pop'],
  ['pop caller', pop?.kind === 'pop' ? pop.pop.callerId : null, '1333'],
  ['pop uid', pop?.kind === 'pop' ? pop.pop.uid : null, '1794882400.1'],
  ['pop customer name', pop?.kind === 'pop' ? pop.pop.customer?.name : null, 'Test Customer'],
  ['pop tag', pop?.kind === 'pop' ? pop.pop.customer?.tag : null, 'VIP'],
  ['pop last disposition', pop?.kind === 'pop' ? pop.pop.lastInteraction?.disposition : null, 'RESOLVED'],
  ['pop is_new flag', newPop?.kind === 'pop' ? newPop.pop.isNew : null, true],
  ['pop new has no customer', newPop?.kind === 'pop' ? newPop.pop.customer : 'x', null],
  ['pop caller fallback', newPop?.kind === 'pop' ? newPop.pop.callerId : null, '777'],
);

let pass = 0;
for (const [name, got, want] of checks) {
  assert.deepStrictEqual(got, want, `${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  pass++;
}
console.log(`agent selfcheck: ${pass}/${checks.length} passed`);
