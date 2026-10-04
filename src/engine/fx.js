// Deck engine: a DJ mixer channel strip rendered sample-accurately.
//
//   stem -> [loop roll] -> 3-band EQ -> HPF -> LPF -> gain ─┬─> out
//                                         └─ echo send ──── echo ─┤
//                                         └─ reverb send ── reverb┘
//
// The EQ uses shelving/peaking biquads whose coefficients reduce to an exact
// identity at 0 dB, so an untouched deck is bit-transparent. Sends are taken
// before the channel fader so echo/reverb tails ring on after the dry signal
// has been cut, like on a real mixer.

const { biquadCoefficients, dbToGain, clamp } = require("./dsp");
const { MIX_SR } = require("./audio-io");

const LANE_DEFAULTS = {
  gain: 1,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  hpf: 18,
  hpfQ: Math.SQRT1_2,
  lpf: 22050,
  lpfQ: Math.SQRT1_2,
  echoSend: 0,
  reverbSend: 0,
};

const CURVES = {
  lin: (u) => u,
  exp: (u) => u,
  smooth: (u) => 0.5 - 0.5 * Math.cos(Math.PI * u),
  // Equal-power fade-in shape (sin) and fade-out shape (1 - cos).
  fastStart: (u) => Math.sin((Math.PI / 2) * u),
  slowStart: (u) => 1 - Math.cos((Math.PI / 2) * u),
};

class Lane {
  constructor(defaultValue) {
    this.defaultValue = defaultValue;
    this.keyframes = [];
    this.cursor = 0;
  }

  // Value is `value` at time t; before it, the previous value is held.
  hold(t, value) {
    this.keyframes.push({ t, v: value, curve: "step" });
    return this;
  }

  // Move from the previous keyframe's value to `value`, arriving at t.
  ramp(t, value, curve = "lin") {
    this.keyframes.push({ t, v: value, curve });
    return this;
  }

  finalize() {
    this.keyframes.sort((a, b) => a.t - b.t);
    this.cursor = 0;
    return this;
  }

  get isEmpty() {
    return this.keyframes.length === 0;
  }

  // Sequential lookup: times must be non-decreasing between calls.
  valueAt(t) {
    const kf = this.keyframes;
    if (!kf.length) {
      return this.defaultValue;
    }
    if (t <= kf[0].t) {
      return kf[0].v;
    }
    while (this.cursor + 1 < kf.length && kf[this.cursor + 1].t <= t) {
      this.cursor += 1;
    }
    const a = kf[this.cursor];
    if (this.cursor + 1 >= kf.length) {
      return a.v;
    }
    const b = kf[this.cursor + 1];
    if (b.curve === "step" || b.t <= a.t) {
      return a.v;
    }
    const u = (t - a.t) / (b.t - a.t);
    if (b.curve === "exp" && a.v > 0 && b.v > 0) {
      return a.v * Math.pow(b.v / a.v, u);
    }
    return a.v + (b.v - a.v) * (CURVES[b.curve] || CURVES.lin)(u);
  }

  lastTime() {
    return this.keyframes.length ? this.keyframes[this.keyframes.length - 1].t : -Infinity;
  }
}

function createLanes() {
  const lanes = {};
  for (const [name, value] of Object.entries(LANE_DEFAULTS)) {
    lanes[name] = new Lane(value);
  }
  return lanes;
}

// ── Filters ────────────────────────────────────────────────────────────────

class StereoBiquad {
  constructor() {
    this.c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    this.s = new Float64Array(8); // x1,x2,y1,y2 for L then R
  }

  set(coeffs) {
    this.c = coeffs;
  }

  // Bypassed identity filter: keep its history equal to the signal so that
  // re-entering processing is seamless.
  syncIdentity(l1, l2, r1, r2) {
    const s = this.s;
    s[0] = l1; s[1] = l2; s[2] = l1; s[3] = l2;
    s[4] = r1; s[5] = r2; s[6] = r1; s[7] = r2;
  }

  reset() {
    this.s.fill(0);
  }

  processL(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const s = this.s;
    const y = b0 * x + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
    s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
    return y;
  }

  processR(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const s = this.s;
    const y = b0 * x + b1 * s[4] + b2 * s[5] - a1 * s[6] - a2 * s[7];
    s[5] = s[4]; s[4] = x; s[7] = s[6]; s[6] = y;
    return y;
  }
}

class OnePole {
  constructor(freq, type) {
    this.a = Math.exp((-2 * Math.PI * freq) / MIX_SR);
    this.type = type;
    this.z = 0;
  }

  process(x) {
    this.z = x * (1 - this.a) + this.z * this.a;
    return this.type === "lp" ? this.z : x - this.z;
  }
}

// ── Echo (beat-synced ping-pong delay) ─────────────────────────────────────

class PingPongEcho {
  constructor(delaySec, feedback) {
    this.size = Math.max(1, Math.round(delaySec * MIX_SR));
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.idx = 0;
    this.feedback = feedback;
    this.inHpL = new OnePole(280, "hp");
    this.inHpR = new OnePole(280, "hp");
    this.fbLpL = new OnePole(5500, "lp");
    this.fbLpR = new OnePole(5500, "lp");
  }

  process(inL, inR, out, o) {
    const dL = this.left[this.idx];
    const dR = this.right[this.idx];
    this.left[this.idx] = this.inHpL.process(inL) + this.feedback * this.fbLpL.process(dR);
    this.right[this.idx] = this.inHpR.process(inR) + this.feedback * this.fbLpR.process(dL);
    this.idx = this.idx + 1 === this.size ? 0 : this.idx + 1;
    out[o] += dL * 0.8;
    out[o + 1] += dR * 0.8;
  }
}

// ── Reverb (Freeverb topology, tuned for 48 kHz) ───────────────────────────

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

class Freeverb {
  constructor({ roomSize = 0.86, damping = 0.3, width = 1 } = {}) {
    const scale = MIX_SR / 44100;
    const make = (len) => ({ buf: new Float32Array(Math.round(len * scale)), idx: 0, store: 0 });
    this.combsL = COMB_TUNING.map((n) => make(n));
    this.combsR = COMB_TUNING.map((n) => make(n + STEREO_SPREAD));
    this.allL = ALLPASS_TUNING.map((n) => make(n));
    this.allR = ALLPASS_TUNING.map((n) => make(n + STEREO_SPREAD));
    this.feedback = roomSize * 0.28 + 0.7;
    this.damp = damping * 0.4;
    this.wet1 = width / 2 + 0.5;
    this.wet2 = (1 - width) / 2;
    this.inHp = new OnePole(300, "hp");
  }

  static comb(c, input, feedback, damp) {
    const output = c.buf[c.idx];
    c.store = output * (1 - damp) + c.store * damp;
    c.buf[c.idx] = input + c.store * feedback;
    c.idx = c.idx + 1 === c.buf.length ? 0 : c.idx + 1;
    return output;
  }

  static allpass(a, input) {
    const bufout = a.buf[a.idx];
    a.buf[a.idx] = input + bufout * 0.5;
    a.idx = a.idx + 1 === a.buf.length ? 0 : a.idx + 1;
    return bufout - input;
  }

  process(inL, inR, out, o) {
    const input = this.inHp.process((inL + inR) * 0.5) * 0.03;
    let l = 0;
    let r = 0;
    for (let i = 0; i < 8; i += 1) {
      l += Freeverb.comb(this.combsL[i], input, this.feedback, this.damp);
      r += Freeverb.comb(this.combsR[i], input, this.feedback, this.damp);
    }
    for (let i = 0; i < 4; i += 1) {
      l = Freeverb.allpass(this.allL[i], l);
      r = Freeverb.allpass(this.allR[i], r);
    }
    out[o] += l * this.wet1 + r * this.wet2;
    out[o + 1] += r * this.wet1 + l * this.wet2;
  }
}

// ── Loop roll ──────────────────────────────────────────────────────────────

// Replace the roll region with repeated slices of its first beat. Slices
// crossfade into each other (3 ms) and the region crossfades back into the
// original audio at its end, so the stutter is click-free. The first slice
// is the source itself, so the entry is seamless.
function applyRoll(stem, startTime, roll) {
  const fade = Math.round(0.003 * MIX_SR);
  const frames = stem.length / 2;
  const srcStart = Math.round((roll.sourceStart - startTime) * MIX_SR);
  const lengths = roll.slices.map((sl) => Math.round(sl.length * MIX_SR));
  const maxLen = Math.max(...lengths) + fade;
  const regionStart = Math.round((roll.slices[0].time - startTime) * MIX_SR);
  const last = roll.slices[roll.slices.length - 1];
  const regionEnd = Math.round((last.time + last.length - startTime) * MIX_SR);
  if (srcStart < 0 || srcStart + maxLen > frames || regionStart < 0 || regionEnd + fade > frames) {
    return;
  }
  const source = stem.slice(srcStart * 2, (srcStart + maxLen) * 2);
  const original = stem.slice(regionStart * 2, (regionEnd + fade) * 2);
  const region = new Float32Array((regionEnd + fade - regionStart) * 2);

  roll.slices.forEach((slice, index) => {
    const at = Math.round((slice.time - startTime) * MIX_SR) - regionStart;
    const len = lengths[index];
    for (let n = 0; n < len + fade && at + n < region.length / 2; n += 1) {
      const fadeIn = index === 0 ? 1 : Math.min(1, n / fade);
      const fadeOut = n < len ? 1 : 1 - (n - len) / fade;
      const w = fadeIn * fadeOut;
      region[(at + n) * 2] += source[n * 2] * w;
      region[(at + n) * 2 + 1] += source[n * 2 + 1] * w;
    }
  });
  // Original audio fades back in under the last slice's tail.
  const back = regionEnd - regionStart;
  for (let n = 0; n < fade; n += 1) {
    const w = n / fade;
    region[(back + n) * 2] += original[(back + n) * 2] * w;
    region[(back + n) * 2 + 1] += original[(back + n) * 2 + 1] * w;
  }
  stem.set(region, regionStart * 2);
}

// ── Deck processing ────────────────────────────────────────────────────────

const BLOCK = 32;
const EQ_SETTLE_FRAMES = Math.round(0.15 * MIX_SR);
const EQ_FREQ = { low: 200, mid: 1000, high: 3800 };

/**
 * @param {Float32Array} stem   interleaved stereo, frame 0 at stem time `startTime`
 * @param {object} lanes        from createLanes(), filled by transitions
 * @param {object} fx           { echo: {delaySec, feedback}|null, reverb: bool, roll|null }
 * @returns {Float32Array} processed deck (same length)
 */
function processDeck(stem, startTime, lanes, fx = {}) {
  for (const lane of Object.values(lanes)) {
    lane.finalize();
  }
  if (fx.roll) {
    applyRoll(stem, startTime, fx.roll);
  }

  const frames = stem.length / 2;
  const out = new Float32Array(stem.length);
  const eqLow = new StereoBiquad();
  const eqMid = new StereoBiquad();
  const eqHigh = new StereoBiquad();
  const hpf = new StereoBiquad();
  const lpf = new StereoBiquad();
  const echo = fx.echo ? new PingPongEcho(fx.echo.delaySec, fx.echo.feedback) : null;
  const reverb = fx.reverb ? new Freeverb() : null;
  const coeffCache = new Map();
  const coeffs = (type, freq, q, gain) => {
    const key = `${type}|${freq.toFixed(1)}|${q.toFixed(3)}|${gain.toFixed(2)}`;
    let c = coeffCache.get(key);
    if (!c) {
      c = biquadCoefficients(type, freq, MIX_SR, q, gain);
      if (coeffCache.size > 20000) coeffCache.clear();
      coeffCache.set(key, c);
    }
    return c;
  };

  let eqFlatFrames = 0;
  let eqWasBypassed = true;
  let echoActive = false;
  let reverbActive = false;
  let hpfActive = false;
  let lpfActive = false;
  let l1 = 0;
  let l2 = 0;
  let r1 = 0;
  let r2 = 0;
  let gainPrev = lanes.gain.valueAt(startTime);
  let echoPrev = lanes.echoSend.valueAt(startTime);
  let revPrev = lanes.reverbSend.valueAt(startTime);

  for (let blockStart = 0; blockStart < frames; blockStart += BLOCK) {
    const n = Math.min(BLOCK, frames - blockStart);
    const tMid = startTime + (blockStart + n / 2) / MIX_SR;
    const tEnd = startTime + (blockStart + n) / MIX_SR;

    const gLow = Math.max(-60, lanes.eqLow.valueAt(tMid));
    const gMid = Math.max(-60, lanes.eqMid.valueAt(tMid));
    const gHigh = Math.max(-60, lanes.eqHigh.valueAt(tMid));
    const hpfFreq = lanes.hpf.valueAt(tMid);
    const hpfQ = lanes.hpfQ.valueAt(tMid);
    const lpfFreq = lanes.lpf.valueAt(tMid);
    const lpfQ = lanes.lpfQ.valueAt(tMid);
    const gainNext = lanes.gain.valueAt(tEnd);
    const echoNext = lanes.echoSend.valueAt(tEnd);
    const revNext = lanes.reverbSend.valueAt(tEnd);

    // After an EQ move, keep filtering at 0 dB for a while so the filter's
    // residual state decays before switching back to the exact bypass path.
    const eqFlat = Math.abs(gLow) < 0.01 && Math.abs(gMid) < 0.01 && Math.abs(gHigh) < 0.01;
    eqFlatFrames = eqFlat ? eqFlatFrames + n : 0;
    const eqBypass = eqFlat && (eqWasBypassed || eqFlatFrames >= EQ_SETTLE_FRAMES);
    eqWasBypassed = eqBypass;
    if (!eqBypass) {
      eqLow.set(coeffs("lowshelf", EQ_FREQ.low, 0.7, gLow));
      eqMid.set(coeffs("peaking", EQ_FREQ.mid, 0.7, gMid));
      eqHigh.set(coeffs("highshelf", EQ_FREQ.high, 0.7, gHigh));
    }

    // Filters fade in/out of the path at inaudible cut-offs (18-26 Hz HPF,
    // 20.5-22 kHz LPF), so switching them never clicks.
    const hpfWet = clamp((hpfFreq - 18) / 8, 0, 1);
    const lpfWet = clamp((22050 - lpfFreq) / 1500, 0, 1);
    if (hpfWet > 0) {
      if (!hpfActive) hpf.reset();
      hpf.set(coeffs("highpass", Math.max(18, hpfFreq), Math.max(0.5, hpfQ), 0));
    }
    if (lpfWet > 0) {
      if (!lpfActive) lpf.reset();
      lpf.set(coeffs("lowpass", Math.min(21500, lpfFreq), Math.max(0.5, lpfQ), 0));
    }
    hpfActive = hpfWet > 0;
    lpfActive = lpfWet > 0;
    if (echo && (echoPrev > 0 || echoNext > 0)) echoActive = true;
    if (reverb && (revPrev > 0 || revNext > 0)) reverbActive = true;

    for (let i = 0; i < n; i += 1) {
      const frame = blockStart + i;
      const o = frame * 2;
      const u = (i + 0.5) / n;
      let l = stem[o];
      let r = stem[o + 1];

      if (eqBypass) {
        l2 = l1; l1 = l;
        r2 = r1; r1 = r;
      } else {
        l2 = l1; l1 = l;
        r2 = r1; r1 = r;
        l = eqHigh.processL(eqMid.processL(eqLow.processL(l)));
        r = eqHigh.processR(eqMid.processR(eqLow.processR(r)));
      }
      if (hpfActive) {
        const fl = hpf.processL(l);
        const fr = hpf.processR(r);
        l += (fl - l) * hpfWet;
        r += (fr - r) * hpfWet;
      }
      if (lpfActive) {
        const fl = lpf.processL(l);
        const fr = lpf.processR(r);
        l += (fl - l) * lpfWet;
        r += (fr - r) * lpfWet;
      }

      const gain = gainPrev + (gainNext - gainPrev) * u;
      out[o] = l * gain;
      out[o + 1] = r * gain;

      if (echoActive) {
        const send = echoPrev + (echoNext - echoPrev) * u;
        echo.process(l * send, r * send, out, o);
      }
      if (reverbActive) {
        const send = revPrev + (revNext - revPrev) * u;
        reverb.process(l * send, r * send, out, o);
      }
    }

    if (eqBypass) {
      eqLow.syncIdentity(l1, l2, r1, r2);
      eqMid.syncIdentity(l1, l2, r1, r2);
      eqHigh.syncIdentity(l1, l2, r1, r2);
    }
    gainPrev = gainNext;
    echoPrev = echoNext;
    revPrev = revNext;
  }

  // Never end a deck on a non-zero sample.
  const tailFade = Math.min(frames, Math.round(0.02 * MIX_SR));
  for (let i = 0; i < tailFade; i += 1) {
    const w = i / tailFade;
    const o = (frames - 1 - i) * 2;
    out[o] *= w;
    out[o + 1] *= w;
  }
  return out;
}

module.exports = {
  LANE_DEFAULTS,
  Lane,
  createLanes,
  processDeck,
};
