// Bandwidth control: pure SDP munging for the audio offer/answer.
// No DOM or WebRTC imports — node-runnable (see sdp.test.mjs).
//
// Wired in SipEngine.sdpModifiers() as SIP.js sessionDescriptionHandlerModifiers,
// so Settings → Codecs order is enforced on every offer/answer/re-INVITE.
// ponytail: string surgery only; SDP grammar edge cases the PBX rejects are
// caught by the safe fallbacks (leave section untouched) below.

export interface OpusTuning {
  maxaveragebitrate: number;
  useinbandfec: 0 | 1;
  usedtx: 0 | 1;
  maxplaybackrate: number;
  ptime: number;
}

// Profiles: 16 low (~30kbps wire active, ~20 avg), 32 balanced (~48/~30),
// 48 fullband (~70 active). FEC + DTX stay on in all three.
export function opusTuning(kbps: 16 | 32 | 48 = 32): OpusTuning {
  return {
    maxaveragebitrate: kbps * 1000,
    useinbandfec: 1,
    usedtx: 1,
    maxplaybackrate: kbps >= 48 ? 48000 : 16000,
    ptime: 20,
  };
}

// Belt-and-braces sender cap (RTCRtpSender.setParameters) for stacks that
// ignore the fmtp bitrate hint.
export function senderMaxBitrate(kbps: 16 | 32 | 48 = 32): number {
  return kbps * 1000;
}

// Static payload types have no a=rtpmap line — map them by number.
const STATIC_PTS: Record<string, string> = { '0': 'pcmu', '8': 'pcma' };

function eolOf(sdp: string): string {
  return sdp.includes('\r\n') ? '\r\n' : '\n';
}

// Walk media sections, applying fn to each m=audio block.
function mapAudioSections(sdp: string, fn: (section: string[], eol: string) => string[]): string {
  const eol = eolOf(sdp);
  const out: string[] = [];
  let buf: string[] = [];
  let isAudio = false;
  const flush = (): void => {
    if (buf.length > 0) out.push(...(isAudio ? fn(buf, eol) : buf));
    buf = [];
    isAudio = false;
  };
  for (const line of sdp.split(/\r\n|\n/)) {
    if (line.startsWith('m=')) {
      flush();
      isAudio = line.startsWith('m=audio ');
    }
    if (isAudio) buf.push(line);
    else out.push(line);
  }
  flush();
  return out.join(eol);
}

function encodingOf(section: string[], pt: string): string | null {
  for (const line of section) {
    const m = /^a=rtpmap:(\d+)\s+([^\s/]+)/i.exec(line);
    if (m && m[1] === pt) return m[2].toLowerCase();
  }
  return STATIC_PTS[pt] ?? null;
}

// Reorder + strip the audio m= line to match Settings → Codecs.
// telephone-event (DTMF) is always kept — dropping it breaks dial tones.
// Sections with none of the listed codecs are left untouched (safe fallback:
// never emit an empty m= line the PBX would 488).
export function applyCodecPrefs(sdp: string, prefs: string[]): string {
  const order = prefs.map((p) => p.toLowerCase());
  return mapAudioSections(sdp, (section) => {
    const parts = section[0].split(' ');
    const fmts = parts.slice(3);
    const rank = (pt: string): number => {
      const enc = encodingOf(section, pt);
      if (enc === null) return -1;
      if (enc === 'telephone-event') return Number.MAX_SAFE_INTEGER;
      return order.indexOf(enc);
    };
    const kept = fmts.filter((pt) => rank(pt) !== -1);
    if (kept.length === 0) return section;
    kept.sort((a, b) => rank(a) - rank(b));
    const dropped = new Set(fmts.filter((pt) => !kept.includes(pt)));
    const cleaned = section.filter((line) => {
      const m = /^a=(rtpmap|fmtp|rtcp-fb):(\d+)(?=[\s;]|$)/.exec(line);
      return !(m && dropped.has(m[2]));
    });
    cleaned[0] = [...parts.slice(0, 3), ...kept].join(' ');
    return cleaned;
  });
}

// Force the Opus fmtp line to the balanced low-bandwidth profile, merging
// with (not clobbering) existing params like minptime. Sections without
// Opus are left untouched.
export function tuneOpus(sdp: string, t: OpusTuning = opusTuning(32)): string {
  return mapAudioSections(sdp, (section) => {
    let opusPt: string | null = null;
    let rtpmapIdx = -1;
    section.forEach((line, i) => {
      const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
      if (m) {
        opusPt = m[1];
        rtpmapIdx = i;
      }
    });
    if (opusPt === null) return section;
    const pt: string = opusPt;
    const want: Record<string, string> = {
      maxaveragebitrate: String(t.maxaveragebitrate),
      useinbandfec: String(t.useinbandfec),
      usedtx: String(t.usedtx),
      'sprop-stereo': '0',
      stereo: '0',
      cbr: '0',
      maxplaybackrate: String(t.maxplaybackrate),
    };
    const out = [...section];
    const fmtpIdx = out.findIndex((line) => new RegExp(`^a=fmtp:${pt}(?=[\\s;]|$)`).test(line));
    if (fmtpIdx === -1) {
      out.splice(rtpmapIdx + 1, 0, `a=fmtp:${pt} ${fmtpLine(want)}`);
    } else {
      const params = out[fmtpIdx].slice(`a=fmtp:${pt} `.length).split(';').map((s) => s.trim()).filter(Boolean);
      const seen = new Set<string>();
      const merged = params.map((p) => {
        const k = p.split('=')[0].trim();
        seen.add(k);
        return k in want ? `${k}=${want[k]}` : p;
      });
      for (const k of Object.keys(want)) {
        if (!seen.has(k)) merged.push(`${k}=${want[k]}`);
      }
      out[fmtpIdx] = `a=fmtp:${pt} ${merged.join(';')}`;
    }
    const ptimeIdx = out.findIndex((line) => /^a=ptime:/.test(line));
    if (ptimeIdx === -1) {
      const anchor = out.findIndex((line) => new RegExp(`^a=fmtp:${pt}(?=[\\s;]|$)`).test(line));
      out.splice(anchor + 1, 0, `a=ptime:${t.ptime}`);
    } else {
      out[ptimeIdx] = `a=ptime:${t.ptime}`;
    }
    return out;
  });
}

function fmtpLine(params: Record<string, string>): string {
  return Object.keys(params)
    .map((k) => `${k}=${params[k]}`)
    .join(';');
}
