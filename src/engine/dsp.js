// Small DSP toolkit shared by analysis and the deck FX engine.
// Biquads follow the RBJ Audio EQ Cookbook. A shelf/peak at 0 dB yields
// b == a, i.e. an exact identity filter — this is what lets a DJ EQ sit in
// the signal path without colouring the sound until it is actually moved.

function biquadCoefficients(type, freq, sampleRate, q = Math.SQRT1_2, gainDb = 0) {
  const nyquistSafe = Math.min(freq, sampleRate * 0.49);
  const w0 = (2 * Math.PI * Math.max(1, nyquistSafe)) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * Math.max(0.05, q));
  const A = Math.pow(10, gainDb / 40);
  const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;

  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  switch (type) {
    case "lowpass":
      b0 = (1 - cosw) / 2;
      b1 = 1 - cosw;
      b2 = (1 - cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cosw) / 2;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    case "peaking":
      b0 = 1 + alpha * A;
      b1 = -2 * cosw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw;
      a2 = 1 - alpha / A;
      break;
    case "lowshelf":
      b0 = A * ((A + 1) - (A - 1) * cosw + sqrtA2alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
      b2 = A * ((A + 1) - (A - 1) * cosw - sqrtA2alpha);
      a0 = (A + 1) + (A - 1) * cosw + sqrtA2alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cosw);
      a2 = (A + 1) + (A - 1) * cosw - sqrtA2alpha;
      break;
    case "highshelf":
      b0 = A * ((A + 1) + (A - 1) * cosw + sqrtA2alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      b2 = A * ((A + 1) + (A - 1) * cosw - sqrtA2alpha);
      a0 = (A + 1) - (A - 1) * cosw + sqrtA2alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cosw);
      a2 = (A + 1) - (A - 1) * cosw - sqrtA2alpha;
      break;
    default:
      throw new Error(`Unknown biquad type: ${type}`);
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

// Offline mono filter (Direct Form I). Returns a new Float32Array.
function filterMono(samples, coeffs) {
  const out = new Float32Array(samples.length);
  const { b0, b1, b2, a1, a2 } = coeffs;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

// 4th-order Linkwitz-Riley style band limiting (two cascaded Butterworths).
function lowpass4(samples, freq, sampleRate) {
  const c = biquadCoefficients("lowpass", freq, sampleRate);
  return filterMono(filterMono(samples, c), c);
}

function highpass4(samples, freq, sampleRate) {
  const c = biquadCoefficients("highpass", freq, sampleRate);
  return filterMono(filterMono(samples, c), c);
}

function median(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) {
    return 0;
  }
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function percentile(values, p) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) {
    return 0;
  }
  const idx = Math.min(valid.length - 1, Math.max(0, Math.round((valid.length - 1) * p)));
  return valid[idx];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

module.exports = {
  biquadCoefficients,
  filterMono,
  lowpass4,
  highpass4,
  median,
  percentile,
  clamp,
  dbToGain,
};
