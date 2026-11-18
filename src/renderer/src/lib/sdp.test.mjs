// ponytail: assert-based self-check for lib/sdp.ts. Run: node src/renderer/src/lib/sdp.test.mjs
import assert from 'node:assert';
import { applyCodecPrefs, tuneOpus, opusTuning, senderMaxBitrate } from './sdp.ts';

const EOL = '\r\n';
const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 9 0 8 101 102',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16',
  'a=rtpmap:102 telephone-event/48000',
  'a=fmtp:102 0-16',
  'a=ptime:20',
  'a=sendrecv',
].join(EOL);

let pass = 0;
const check = (name, got, want) => {
  assert.strictEqual(got, want, `${name}: got ${got} want ${want}`);
  pass++;
};

const mline = (sdp) => sdp.split(EOL).find((l) => l.startsWith('m=audio'));

// 1. Opus-only default strips G.722/G.711, keeps opus + DTMF.
const stripped = applyCodecPrefs(SDP, ['opus', 'telephone-event']);
check('opus-only m-line', mline(stripped), 'm=audio 9 UDP/TLS/RTP/SAVPF 111 101 102');
assert.ok(!stripped.includes('a=rtpmap:9 '), 'G722 rtpmap removed');
assert.ok(!stripped.includes('a=rtpmap:0 '), 'PCMU rtpmap removed');
assert.ok(!stripped.includes('a=rtpmap:8 '), 'PCMA rtpmap removed');
pass += 3;

// 2. Order is honored: PCMA first.
const reordered = applyCodecPrefs(SDP, ['PCMA', 'opus', 'PCMU', 'G722', 'telephone-event']);
check('pref order m-line', mline(reordered), 'm=audio 9 UDP/TLS/RTP/SAVPF 8 111 0 9 101 102');

// 3. DTMF kept even when absent from prefs.
const noDtmf = applyCodecPrefs(SDP, ['opus']);
assert.ok(noDtmf.includes('a=rtpmap:101 telephone-event/8000'), 'telephone-event kept');
pass++;

// 4. Section with none of the listed codecs is left untouched
// (never emit an empty m= line the PBX would 488).
const noOpusSdp = SDP.split(EOL)
  .filter((l) => !l.startsWith('a=rtpmap:111') && !l.startsWith('a=fmtp:111'))
  .map((l) => (l.startsWith('m=audio') ? 'm=audio 9 UDP/TLS/RTP/SAVPF 0 8' : l))
  .join(EOL);
check('no-opus fallback', applyCodecPrefs(noOpusSdp, ['opus']), noOpusSdp);

// 5. Opus tuning merges fmtp, keeps minptime, forces profile.
const tuned = tuneOpus(SDP);
const fmtp = tuned.split(EOL).find((l) => l.startsWith('a=fmtp:111'));
assert.ok(fmtp.includes('minptime=10'), 'existing minptime kept');
for (const kv of ['maxaveragebitrate=32000', 'useinbandfec=1', 'usedtx=1', 'sprop-stereo=0', 'maxplaybackrate=16000']) {
  assert.ok(fmtp.includes(kv), `fmtp has ${kv}`);
  pass++;
}
check('ptime forced', tuned.split(EOL).find((l) => l.startsWith('a=ptime:')), 'a=ptime:20');

// 6. Combined pipeline: prefs then tuning.
const full = tuneOpus(applyCodecPrefs(SDP, ['opus', 'telephone-event']));
check('pipeline m-line', mline(full), 'm=audio 9 UDP/TLS/RTP/SAVPF 111 101 102');
assert.ok(full.includes('maxaveragebitrate=32000'), 'pipeline tuned');
pass++;

// 7. Quality profiles map to the right encoder settings.
check('opus16 bitrate', opusTuning(16).maxaveragebitrate, 16000);
check('opus16 playback', opusTuning(16).maxplaybackrate, 16000);
check('opus32 bitrate', opusTuning(32).maxaveragebitrate, 32000);
check('opus48 bitrate', opusTuning(48).maxaveragebitrate, 48000);
check('opus48 playback', opusTuning(48).maxplaybackrate, 48000);
check('sender cap 16', senderMaxBitrate(16), 16000);
check('sender cap default', senderMaxBitrate(), 32000);

// 8. Tuning honors the selected profile end to end.
const tuned16 = tuneOpus(SDP, opusTuning(16));
assert.ok(tuned16.includes('maxaveragebitrate=16000'), '16k fmtp applied');
pass++;

console.log(`sdp: ${pass} checks passed`);
