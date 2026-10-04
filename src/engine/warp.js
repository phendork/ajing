// Beat-accurate time warping (varispeed).
//
// Each beat interval of a track gets its own playback rate, so the exact
// output duration of every beat is dictated by the set plan: tracks keep
// their native speed in the body, glide over a few bars, and lock to a shared
// pulse during a blend — even when the source tempo drifts (live drummers),
// because the per-beat map flattens it.
//
// Rendering is varispeed (like a turntable / CDJ without key lock): a
// band-limited windowed-sinc resampler reads the source at the warped
// position. Unlike ffmpeg's atempo (WSOLA), which smears transients by up to
// ±20 ms, this keeps every kick exactly where the math puts it.

const { MIX_SR } = require("./audio-io");

/**
 * @param {number[]} beatTimes   source time of each detected beat (seconds)
 * @param {number[]} beatOutDur  desired OUTPUT duration of beat interval k
 * @param {number}  sourceDuration
 */
function buildWarp(beatTimes, beatOutDur, sourceDuration) {
  const count = beatTimes.length;
  const segments = [];
  const tempoOf = (k) => clampTempo((beatTimes[k + 1] - beatTimes[k]) / beatOutDur[k]);

  // Audio before the first beat plays at the first interval's rate.
  const firstTempo = count > 1 ? tempoOf(0) : 1;
  const firstBeatOut = beatTimes[0] / firstTempo;
  segments.push({ src: 0, out: 0, tempo: firstTempo });

  const outBeatTimes = new Array(count);
  outBeatTimes[0] = firstBeatOut;
  for (let k = 0; k < count - 1; k += 1) {
    const tempo = tempoOf(k);
    const src = Math.max(0, beatTimes[k]);
    const out = outBeatTimes[k] + (src - beatTimes[k]) / tempo;
    const last = segments[segments.length - 1];
    if (src <= last.src) {
      last.tempo = tempo;
    } else if (Math.abs(tempo - last.tempo) > 1e-9) {
      segments.push({ src, out, tempo });
    }
    outBeatTimes[k + 1] = outBeatTimes[k] + (beatTimes[k + 1] - beatTimes[k]) / tempo;
  }

  return {
    segments,
    outBeatTimes,
    sourceToOutput: (t) => sourceToOutputWith(segments, t),
    outputToSource: (t) => outputToSourceWith(segments, t),
    outputDuration: sourceToOutputWith(segments, sourceDuration),
  };
}

function clampTempo(tempo) {
  if (!Number.isFinite(tempo) || tempo <= 0) {
    return 1;
  }
  return Math.max(0.5, Math.min(2, tempo));
}

function findSegment(segments, key, value) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid][key] <= value) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return segments[lo];
}

function sourceToOutputWith(segments, t) {
  const seg = findSegment(segments, "src", t);
  return seg.out + (t - seg.src) / seg.tempo;
}

function outputToSourceWith(segments, t) {
  const seg = findSegment(segments, "out", t);
  return seg.src + (t - seg.out) * seg.tempo;
}

// ── Band-limited resampler ─────────────────────────────────────────────────

const SINC_HALF = 16;
const SINC_TAPS = SINC_HALF * 2;
const SINC_PHASES = 4096;
// Cutoff at 0.86 × Nyquist (20.6 kHz): alias-free up to a +7% speed-up.
const SINC_CUTOFF = 0.86;
let sincTable = null;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k += 1) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
}

function getSincTable() {
  if (sincTable) {
    return sincTable;
  }
  const beta = 9;
  const norm = besselI0(beta);
  sincTable = new Float32Array((SINC_PHASES + 1) * SINC_TAPS);
  for (let p = 0; p <= SINC_PHASES; p += 1) {
    const frac = p / SINC_PHASES;
    let sum = 0;
    for (let tap = 0; tap < SINC_TAPS; tap += 1) {
      // Tap `tap` reads source sample floor(pos) - SINC_HALF + 1 + tap.
      const x = tap - SINC_HALF + 1 - frac;
      const arg = Math.PI * SINC_CUTOFF * x;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(arg) / arg;
      const w = Math.abs(x) >= SINC_HALF ? 0 : besselI0(beta * Math.sqrt(1 - (x / SINC_HALF) ** 2)) / norm;
      const value = SINC_CUTOFF * sinc * w;
      sincTable[p * SINC_TAPS + tap] = value;
      sum += value;
    }
    // Normalise each phase to unity DC gain.
    for (let tap = 0; tap < SINC_TAPS; tap += 1) {
      sincTable[p * SINC_TAPS + tap] /= sum;
    }
  }
  return sincTable;
}

/**
 * Render output samples [outStart, outEnd) of a warped track.
 * @param {Float32Array} source interleaved stereo @ MIX_SR
 * @returns {Float32Array} interleaved stereo
 */
function renderVarispeed(source, segments, outStart, outEnd, gain = 1) {
  const table = getSincTable();
  const frames = Math.max(0, outEnd - outStart);
  const out = new Float32Array(frames * 2);
  const sourceFrames = source.length / 2;

  let segIndex = 0;
  const firstTime = outStart / MIX_SR;
  while (segIndex + 1 < segments.length && segments[segIndex + 1].out <= firstTime) {
    segIndex += 1;
  }

  for (let n = 0; n < frames; n += 1) {
    const tOut = (outStart + n) / MIX_SR;
    while (segIndex + 1 < segments.length && segments[segIndex + 1].out <= tOut) {
      segIndex += 1;
    }
    const seg = segments[segIndex];
    const pos = (seg.src + (tOut - seg.out) * seg.tempo) * MIX_SR;
    const base = Math.floor(pos);
    const phase = Math.round((pos - base) * SINC_PHASES);
    const row = phase * SINC_TAPS;
    const first = base - SINC_HALF + 1;

    let left = 0;
    let right = 0;
    if (first >= 0 && first + SINC_TAPS <= sourceFrames) {
      let idx = first * 2;
      for (let tap = 0; tap < SINC_TAPS; tap += 1, idx += 2) {
        const c = table[row + tap];
        left += source[idx] * c;
        right += source[idx + 1] * c;
      }
    } else {
      for (let tap = 0; tap < SINC_TAPS; tap += 1) {
        const s = first + tap;
        if (s < 0 || s >= sourceFrames) continue;
        const c = table[row + tap];
        left += source[s * 2] * c;
        right += source[s * 2 + 1] * c;
      }
    }
    out[n * 2] = left * gain;
    out[n * 2 + 1] = right * gain;
  }
  return out;
}

module.exports = {
  buildWarp,
  renderVarispeed,
};
