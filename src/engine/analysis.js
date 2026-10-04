// Beat-grid analysis.
//
// Pipeline per track:
//   1. Onset envelopes on three bands (low = kick/bass, high = hats/snare, full)
//      at ~2.9 ms resolution.
//   2. Coarse tempo from the autocorrelation of the onset envelope.
//   3. Precise tempo from harmonic phase coherence over the whole track: the
//      period P maximising |Σ env(t)·e^{-2πi·h·t/P}| for h = 1, 2, 4. Over a
//      3-minute track this pins the period to a few hundredths of a BPM, which
//      is what keeps two decks locked for a 32-beat blend.
//   4. Beat phase from folding the KICK band onto that period (so the grid
//      sits on kicks, not on off-beat hats).
//   5. Local deviation tracking (16-beat windows) — tracks with a drummer or
//      drifting tempo get a per-beat offset map instead of a rigid grid.
//   6. Phrase structure: where 16-beat phrases start, where the beat is
//      present, where the music starts and ends.

const { biquadCoefficients, filterMono, lowpass4, highpass4, median, percentile, clamp } = require("./dsp");

const ANALYSIS_SR = 22050;
const ANALYSIS_VERSION = 3;
const HOP_SEC = 64 / 22050;
const WIN_SEC = 0.02;
const MIN_BPM = 66;
const MAX_BPM = 185;
const PHRASE_BEATS = 16;

function computeEnvelopes(samples, sampleRate) {
  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const win = Math.max(hop * 2, Math.round(sampleRate * WIN_SEC));
  const frameCount = Math.max(0, Math.floor((samples.length - win) / hop) + 1);

  const low = bandEnergy(lowpass4(samples, 150, sampleRate), hop, win, frameCount);
  const high = bandEnergy(highpass4(samples, 3000, sampleRate), hop, win, frameCount);
  const full = bandEnergy(samples, hop, win, frameCount);
  const body = bandEnergy(lowpass4(samples, 1500, sampleRate), hop, win, frameCount);

  const onsetLow = onsetFromEnergy(low);
  const onsetHigh = onsetFromEnergy(high);
  const meanLow = meanOf(onsetLow) || 1;
  const meanHigh = meanOf(onsetHigh) || 1;
  const combined = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    combined[i] = onsetLow[i] / meanLow + 0.7 * (onsetHigh[i] / meanHigh);
  }

  return {
    sampleRate,
    hop,
    hopSec: hop / sampleRate,
    // Frame n covers [n*hop, n*hop + win); its timestamp is the window centre.
    timeOffsetSec: win / 2 / sampleRate,
    frameCount,
    energy: { low, high, full },
    onset: { low: onsetLow, high: onsetHigh, body: onsetFromEnergy(body), combined },
  };
}

function bandEnergy(x, hop, win, frameCount) {
  const out = new Float32Array(frameCount);
  if (!frameCount) {
    return out;
  }
  let sum = 0;
  for (let n = 0; n < frameCount; n += 1) {
    const start = n * hop;
    if (n % 512 === 0) {
      // Periodic exact recompute keeps the running sum from drifting.
      sum = 0;
      for (let i = start; i < start + win; i += 1) {
        sum += x[i] * x[i];
      }
    } else {
      const prevStart = start - hop;
      for (let i = prevStart; i < start; i += 1) {
        sum -= x[i] * x[i];
      }
      for (let i = prevStart + win; i < start + win; i += 1) {
        sum += x[i] * x[i];
      }
    }
    out[n] = Math.max(0, sum / win);
  }
  return out;
}

function onsetFromEnergy(energy) {
  const out = new Float32Array(energy.length);
  const ref = percentile(sampleForStats(energy), 0.95) * 0.02 + 1e-12;
  let prev = Math.log1p(energy[0] / ref);
  for (let i = 1; i < energy.length; i += 1) {
    const cur = Math.log1p(energy[i] / ref);
    out[i] = cur > prev ? cur - prev : 0;
    prev = cur;
  }
  return out;
}

function sampleForStats(values, maxCount = 20000) {
  if (values.length <= maxCount) {
    return Array.from(values);
  }
  const step = values.length / maxCount;
  const out = new Array(maxCount);
  for (let i = 0; i < maxCount; i += 1) {
    out[i] = values[Math.floor(i * step)];
  }
  return out;
}

function meanOf(values) {
  if (!values.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
  }
  return sum / values.length;
}

function frameTime(env, n) {
  return n * env.hopSec + env.timeOffsetSec;
}

function sampleEnvelope(values, env, timeSec) {
  const pos = (timeSec - env.timeOffsetSec) / env.hopSec;
  const i0 = Math.floor(pos);
  if (i0 < 0 || i0 + 1 >= values.length) {
    return 0;
  }
  const f = pos - i0;
  return values[i0] * (1 - f) + values[i0 + 1] * f;
}

// ── Tempo ──────────────────────────────────────────────────────────────────

function tempoPrior(bpm) {
  const octaves = Math.log2(bpm / 115) / 0.8;
  return Math.exp(-0.5 * octaves * octaves);
}

function estimateCoarsePeriod(onset, hopSec) {
  const maxFrames = Math.round(150 / hopSec);
  const start = Math.max(0, Math.floor((onset.length - maxFrames) / 2));
  const end = Math.min(onset.length, start + maxFrames);
  const n = end - start;
  const minLag = Math.max(2, Math.floor(60 / MAX_BPM / hopSec));
  const maxLag = Math.ceil(60 / MIN_BPM / hopSec);
  if (n < maxLag * 4) {
    return null;
  }

  const x = new Float64Array(n);
  const mean = meanOf(onset.subarray(start, end));
  for (let i = 0; i < n; i += 1) {
    x[i] = onset[start + i] - mean;
  }

  const acf = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 1) {
      sum += x[i] * x[i + lag];
    }
    acf[lag] = sum / (n - lag);
  }

  const peaks = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (!(acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) || acf[lag] <= 0) {
      continue;
    }
    const y0 = acf[lag - 1];
    const y2 = acf[lag + 1];
    const denom = y0 - 2 * acf[lag] + y2;
    const delta = Math.abs(denom) > 1e-12 ? clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5) : 0;
    const period = (lag + delta) * hopSec;
    peaks.push({ period, score: acf[lag] * tempoPrior(60 / period) });
  }
  peaks.sort((a, b) => b.score - a.score);
  return peaks.length ? peaks.slice(0, 6).map((p) => p.period) : null;
}

// ACF peaks can sit on rhythmic sub-patterns (e.g. a 1.5-beat kick gap in
// drum & bass). Re-score every ACF candidate and its metrical relatives by
// how well ALL onsets fit that grid (harmonic coherence) and keep the best.
function chooseTempoCandidate(values, hopSec, candidates) {
  const minPeriod = 60 / MAX_BPM;
  const maxPeriod = 60 / MIN_BPM;
  const pool = [];
  for (const base of candidates) {
    for (const ratio of [1, 2, 0.5, 1.5, 2 / 3]) {
      const p = base * ratio;
      if (p >= minPeriod && p <= maxPeriod && !pool.some((q) => Math.abs(q / p - 1) < 0.01)) {
        pool.push(p);
      }
    }
  }

  // Score on a decimated envelope for speed; precision comes later.
  const factor = 2;
  const decimated = new Float32Array(Math.floor(values.length / factor));
  for (let i = 0; i < decimated.length; i += 1) {
    decimated[i] = values[i * factor] + values[i * factor + 1];
  }
  const dHop = hopSec * factor;

  let best = null;
  for (const p of pool) {
    let localBest = 0;
    let localP = p;
    for (let s = -6; s <= 6; s += 1) {
      const candidate = p * (1 + s * 0.0015);
      const score = coherence(decimated, dHop, candidate);
      if (score > localBest) {
        localBest = score;
        localP = candidate;
      }
    }
    const weighted = localBest * Math.sqrt(tempoPrior(60 / localP));
    if (!best || weighted > best.score) {
      best = { period: localP, score: weighted };
    }
  }
  return best ? best.period : null;
}

const COHERENCE_HARMONICS = [[1, 1], [2, 0.5], [4, 0.25]];

// Harmonic phase coherence of the envelope at period P over frames [from, to).
function coherence(values, hopSec, period, from = 0, to = values.length) {
  let total = 0;
  let norm = 0;
  for (let i = from; i < to; i += 1) {
    norm += values[i];
  }
  if (norm <= 0) {
    return 0;
  }
  for (const [h, weight] of COHERENCE_HARMONICS) {
    const theta = (-2 * Math.PI * h * hopSec) / period;
    const cr = Math.cos(theta);
    const ci = Math.sin(theta);
    let zr = Math.cos(theta * from);
    let zi = Math.sin(theta * from);
    let accR = 0;
    let accI = 0;
    for (let i = from; i < to; i += 1) {
      const v = values[i];
      accR += v * zr;
      accI += v * zi;
      const nr = zr * cr - zi * ci;
      zi = zr * ci + zi * cr;
      zr = nr;
      if ((i & 4095) === 4095) {
        zr = Math.cos(theta * (i + 1));
        zi = Math.sin(theta * (i + 1));
      }
    }
    total += weight * Math.sqrt(accR * accR + accI * accI);
  }
  return total / norm;
}

function refinePeriod(values, hopSec, approxPeriod, searchFrac, from, to) {
  const steps = 80;
  let bestP = approxPeriod;
  let bestScore = -Infinity;
  const lo = approxPeriod * (1 - searchFrac);
  const hi = approxPeriod * (1 + searchFrac);
  const stepSize = (hi - lo) / steps;
  for (let s = 0; s <= steps; s += 1) {
    const p = lo + s * stepSize;
    const score = coherence(values, hopSec, p, from, to);
    if (score > bestScore) {
      bestScore = score;
      bestP = p;
    }
  }

  // Golden-section search inside the winning cell.
  let a = bestP - stepSize;
  let b = bestP + stepSize;
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = coherence(values, hopSec, c, from, to);
  let fd = coherence(values, hopSec, d, from, to);
  for (let iter = 0; iter < 28; iter += 1) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = coherence(values, hopSec, c, from, to);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = coherence(values, hopSec, d, from, to);
    }
  }
  const period = (a + b) / 2;
  return { period, score: coherence(values, hopSec, period, from, to) };
}

// Fold the envelope onto the period; return the beat phase in [0, P).
function foldPhase(values, env, period, from = 0, to = values.length) {
  const binWidth = env.hopSec / 2;
  const bins = Math.max(48, Math.round(period / binWidth));
  const hist = new Float64Array(bins);
  for (let i = from; i < to; i += 1) {
    const t = frameTime(env, i);
    const pos = (((t % period) + period) % period) / period * bins;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    hist[i0 % bins] += values[i] * (1 - f);
    hist[(i0 + 1) % bins] += values[i] * f;
  }
  const smooth = circularSmooth(circularSmooth(hist));
  const peak = parabolicPeak(smooth, true);
  const mean = meanOf(smooth);
  return {
    phase: ((peak.index / bins) * period + period) % period,
    sharpness: mean > 0 ? (peak.value - mean) / mean : 0,
    // Strongest fold value within ±width of a phase (seconds).
    valueNear(phaseSec, widthSec) {
      const center = Math.round((phaseSec / period) * bins);
      const reach = Math.max(1, Math.round((widthSec / period) * bins));
      let best = 0;
      for (let d = -reach; d <= reach; d += 1) {
        best = Math.max(best, smooth[(((center + d) % bins) + bins) % bins]);
      }
      return best;
    },
    // Strongest peak at least `minDistSec` away from the main peak.
    secondary(minDistSec) {
      let best = { phase: 0, value: 0 };
      for (let i = 0; i < bins; i += 1) {
        const phaseSec = (i / bins) * period;
        const mainPhase = (peak.index / bins) * period;
        const dist = Math.abs(((phaseSec - mainPhase + period * 1.5) % period) - period / 2);
        if (dist >= minDistSec && smooth[i] > best.value) {
          best = { phase: phaseSec, value: smooth[i] };
        }
      }
      return best;
    },
    peakValue: peak.value,
  };
}

// Kicks + snares (drum body) mark beats; hats mark subdivisions. If the drum
// body only lands on every other grid point, the grid is a subdivision and the
// real beat is twice as long (e.g. hip-hop read as 190 instead of 95).
function correctTempoOctave(env, period) {
  const doubled = period * 2;
  if (doubled > 60 / MIN_BPM) {
    return period;
  }
  const fold = foldPhase(env.onset.body, env, doubled);
  const onBeat = fold.valueNear(fold.phase, period / 8);
  const offBeat = fold.valueNear((fold.phase + period) % doubled, period / 8);
  return onBeat > 0 && offBeat / onBeat < 0.5 ? doubled : period;
}

// Kick-band phase; if two kick positions half a beat apart are equally strong
// (broken beats like drum & bass), the snare/drum body decides which is "on".
function choosePhase(env, period) {
  const lowFold = foldPhase(env.onset.low, env, period);
  const combinedFold = foldPhase(env.onset.combined, env, period);
  if (lowFold.sharpness < 0.6) {
    return { phase: combinedFold.phase, sharpness: combinedFold.sharpness, values: env.onset.combined };
  }
  let phase = lowFold.phase;
  const rival = lowFold.secondary(period / 4);
  if (rival.value >= lowFold.peakValue * 0.75) {
    const bodyFold = foldPhase(env.onset.body, env, period);
    if (bodyFold.valueNear(rival.phase, period / 10) > bodyFold.valueNear(phase, period / 10) * 1.15) {
      phase = rival.phase;
    }
  }
  return { phase, sharpness: lowFold.sharpness, values: env.onset.low };
}

function circularSmooth(hist) {
  const n = hist.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = 0.25 * hist[(i - 1 + n) % n] + 0.5 * hist[i] + 0.25 * hist[(i + 1) % n];
  }
  return out;
}

function parabolicPeak(values, circular) {
  const n = values.length;
  let best = 0;
  for (let i = 1; i < n; i += 1) {
    if (values[i] > values[best]) {
      best = i;
    }
  }
  const prev = circular ? values[(best - 1 + n) % n] : values[Math.max(0, best - 1)];
  const next = circular ? values[(best + 1) % n] : values[Math.min(n - 1, best + 1)];
  const denom = prev - 2 * values[best] + next;
  const delta = Math.abs(denom) > 1e-12 ? clamp(0.5 * (prev - next) / denom, -0.5, 0.5) : 0;
  return { index: best + delta, value: values[best] - 0.25 * (prev - next) * delta };
}

// Beat-relative fold: where, relative to each predicted beat, does the onset
// envelope peak? Works on any beat map (constant or warped tempo).
function measureBeatDeviation(values, env, beatTimes, maxDevSec) {
  const binWidth = env.hopSec / 2;
  const half = Math.max(2, Math.ceil(maxDevSec / binWidth));
  const bins = half * 2 + 1;
  const hist = new Float64Array(bins);
  let used = 0;
  for (const beat of beatTimes) {
    if (beat - maxDevSec < env.timeOffsetSec || beat + maxDevSec > frameTime(env, values.length - 2)) {
      continue;
    }
    used += 1;
    for (let b = 0; b < bins; b += 1) {
      hist[b] += sampleEnvelope(values, env, beat + (b - half) * binWidth);
    }
  }
  if (used < 3) {
    return null;
  }
  const smooth = new Float64Array(bins);
  for (let i = 0; i < bins; i += 1) {
    smooth[i] = 0.25 * hist[Math.max(0, i - 1)] + 0.5 * hist[i] + 0.25 * hist[Math.min(bins - 1, i + 1)];
  }
  const peak = parabolicPeak(smooth, false);
  const mean = meanOf(smooth);
  return {
    deviationSec: (peak.index - half) * binWidth,
    sharpness: mean > 0 ? (peak.value - mean) / mean : 0,
    peakPerBeat: peak.value / used,
    beatsUsed: used,
  };
}

// ── Full-track analysis ────────────────────────────────────────────────────

function analyzeSamples(samples, sampleRate) {
  const durationSec = samples.length / sampleRate;
  const env = computeEnvelopes(samples, sampleRate);
  const fallback = buildFallbackAnalysis(env, durationSec);
  if (env.frameCount < 2000) {
    return fallback;
  }

  const candidates = estimateCoarsePeriod(env.onset.combined, env.hopSec);
  const coarse = candidates ? chooseTempoCandidate(env.onset.combined, env.hopSec, candidates) : null;
  if (!coarse) {
    return fallback;
  }
  let period = refinePeriod(env.onset.combined, env.hopSec, coarse, 0.006, 0, env.frameCount).period;
  const octavePeriod = correctTempoOctave(env, period);
  if (octavePeriod !== period) {
    period = refinePeriod(env.onset.combined, env.hopSec, octavePeriod, 0.002, 0, env.frameCount).period;
  }

  const phaseChoice = choosePhase(env, period);
  const phaseValues = phaseChoice.values;
  const strength = phaseChoice.sharpness;
  let phase = phaseChoice.phase;

  // Linear drift correction: a residual period error shows up as a phase
  // deviation that grows linearly along the track.
  for (let pass = 0; pass < 2; pass += 1) {
    const windows = measureWindowDeviations(phaseValues, env, gridTimes(phase, period, durationSec), period, 16, 8);
    if (windows.length < 4) {
      break;
    }
    const fit = weightedLine(windows);
    period += fit.slope;
    phase += fit.intercept;
  }
  phase = normalizePhase(phase, period);

  // Local deviations (8-beat windows): a drifting/live tempo gets a per-beat
  // offset map instead of a rigid grid.
  let beatTimes = gridTimes(phase, period, durationSec);
  let offsets = null;
  let steady = true;
  for (let pass = 0; pass < 2; pass += 1) {
    const windows = measureWindowDeviations(phaseValues, env, beatTimes, period, 8, 4);
    if (windows.length < 4) {
      break;
    }
    const spread = percentile(windows.map((w) => Math.abs(w.dev)), 0.9);
    if (pass === 0 && spread < 0.004) {
      break;
    }
    steady = false;
    const delta = interpolateOffsets(windows.map((w) => ({ k: w.k, res: w.dev })), beatTimes.length, period);
    offsets = offsets ? offsets.map((o, k) => o + delta[k]) : delta;
    beatTimes = beatTimes.map((t, k) => t + delta[k]);
  }

  // Sample-accurate attack alignment: put each beat on the 50% point of the
  // averaged kick attack. Envelope-based detection carries a content-dependent
  // bias of several ms; this removes it so two different kicks line up.
  const lowSignal = zeroPhaseLowpass(samples, 150, sampleRate);
  const attack = measureAttackOffset(lowSignal, sampleRate, selectKickBeats(env, beatTimes, period), period);
  if (attack && attack.contrast >= 2) {
    phase += attack.offsetSec;
    beatTimes = beatTimes.map((t) => t + attack.offsetSec);
    if (phase >= period - 0.03 || phase < -0.03) {
      const normalized = normalizePhase(phase, period);
      const shift = Math.round((phase - normalized) / period);
      phase = normalized;
      if (offsets && shift > 0) {
        offsets = offsets.concat(new Array(shift).fill(offsets[offsets.length - 1] || 0)).slice(shift);
      } else if (offsets && shift < 0) {
        offsets = new Array(-shift).fill(offsets[0] || 0).concat(offsets);
      }
    }
  }

  const beatCount = Math.max(1, Math.floor((durationSec - phase) / period) + 1);
  if (offsets) {
    const last = offsets.length ? offsets[offsets.length - 1] : 0;
    offsets = Array.from({ length: beatCount }, (_, k) => (k < offsets.length ? offsets[k] : last));
  }
  beatTimes = new Array(beatCount);
  for (let k = 0; k < beatCount; k += 1) {
    beatTimes[k] = phase + k * period + (offsets ? offsets[k] : 0);
  }

  const structure = analyzeStructure(env, beatTimes, period);
  const confidence = coherence(env.onset.combined, env.hopSec, period, 0, env.frameCount);

  return {
    version: ANALYSIS_VERSION,
    durationSec,
    bpm: 60 / period,
    period,
    phase,
    beatCount,
    beatOffsets: offsets ? offsets.map((o) => Number(o.toFixed(5))) : null,
    steady,
    confidence: Number(confidence.toFixed(4)),
    beatStrength: Number(strength.toFixed(3)),
    hasBeat: confidence >= 0.12 && strength >= 0.6,
    ...structure,
  };
}

// First beat may sit a hair before t=0 (audio that starts right on the one).
function normalizePhase(phase, period) {
  let p = ((phase % period) + period) % period;
  if (p >= period - 0.03) {
    p -= period;
  }
  return p;
}

function gridTimes(phase, period, durationSec) {
  const count = Math.max(1, Math.floor((durationSec - phase) / period) + 1);
  const times = new Array(count);
  for (let k = 0; k < count; k += 1) {
    times[k] = phase + k * period;
  }
  return times;
}

function measureWindowDeviations(values, env, beatTimes, period, windowBeats, hopBeats) {
  const windows = [];
  const half = windowBeats / 2;
  // Windows without a real pulse (breakdowns) would only contribute noise.
  const global = measureBeatDeviation(values, env, beatTimes, period * 0.2);
  const minPeak = global ? global.peakPerBeat * 0.5 : 0;
  for (let center = half; center <= beatTimes.length - half; center += hopBeats) {
    const dev = measureBeatDeviation(values, env, beatTimes.slice(center - half, center + half), period * 0.2);
    if (dev && dev.sharpness >= 1.5 && dev.peakPerBeat >= minPeak) {
      windows.push({ k: center - 0.5, dev: dev.deviationSec, weight: dev.sharpness });
    }
  }
  return windows;
}

// Beats that actually carry a kick (calibrating the attack on snare-only
// beats of a hip-hop pattern would bias it).
function selectKickBeats(env, beatTimes, period) {
  const strengths = beatTimes.map((t) => {
    const from = Math.max(0, Math.floor((t - period / 8 - env.timeOffsetSec) / env.hopSec));
    const to = Math.min(env.frameCount - 1, Math.ceil((t + period / 8 - env.timeOffsetSec) / env.hopSec));
    let peak = 0;
    for (let i = from; i <= to; i += 1) {
      peak = Math.max(peak, env.onset.low[i]);
    }
    return peak;
  });
  const threshold = percentile(strengths, 0.9) * 0.5;
  const selected = beatTimes.filter((_, k) => strengths[k] >= threshold);
  return selected.length >= 8 ? selected : beatTimes;
}

// Average the kick-band energy around every beat (sample resolution) and find
// where the averaged attack crosses 50% between the pre-beat floor and peak.
function measureAttackOffset(lowSignal, sampleRate, beatTimes, period) {
  const half = Math.round((period / 4) * sampleRate);
  const profile = new Float64Array(half * 2 + 1);
  let used = 0;
  for (const beat of beatTimes) {
    const center = Math.round(beat * sampleRate);
    if (center - half < 0 || center + half >= lowSignal.length) {
      continue;
    }
    used += 1;
    for (let j = -half; j <= half; j += 1) {
      const v = lowSignal[center + j];
      profile[j + half] += v * v;
    }
  }
  if (used < 8) {
    return null;
  }

  // Centred 8 ms moving average: cancels the bass-cycle ripple of the squared
  // signal without moving the 50% point of a rising edge.
  const smoothHalf = Math.max(1, Math.round(0.004 * sampleRate));
  const prefix = new Float64Array(profile.length + 1);
  for (let i = 0; i < profile.length; i += 1) {
    prefix[i + 1] = prefix[i] + profile[i];
  }
  const smooth = new Float64Array(profile.length);
  for (let i = 0; i < profile.length; i += 1) {
    const a = Math.max(0, i - smoothHalf);
    const b = Math.min(profile.length, i + smoothHalf + 1);
    smooth[i] = (prefix[b] - prefix[a]) / (b - a);
  }

  const searchHalf = Math.round((period / 8) * sampleRate);
  let peakIdx = half;
  for (let i = half - searchHalf; i <= half + searchHalf; i += 1) {
    if (smooth[i] > smooth[peakIdx]) {
      peakIdx = i;
    }
  }
  let floor = Infinity;
  for (let i = 0; i <= peakIdx; i += 1) {
    floor = Math.min(floor, smooth[i]);
  }
  const peak = smooth[peakIdx];
  if (!(peak > 0) || !Number.isFinite(floor)) {
    return null;
  }
  const threshold = floor + 0.5 * (peak - floor);
  let cross = peakIdx;
  while (cross > 0 && smooth[cross - 1] >= threshold) {
    cross -= 1;
  }
  let position = cross;
  if (cross > 0) {
    const below = smooth[cross - 1];
    const above = smooth[cross];
    position = cross - 1 + (above > below ? (threshold - below) / (above - below) : 1);
  }
  return {
    offsetSec: (position - half) / sampleRate,
    contrast: peak / Math.max(1e-12, floor),
  };
}

function zeroPhaseLowpass(samples, freq, sampleRate) {
  const coeffs = biquadCoefficients("lowpass", freq, sampleRate);
  const forward = filterMono(samples, coeffs);
  forward.reverse();
  const backward = filterMono(forward, coeffs);
  backward.reverse();
  return backward;
}

function weightedLine(points) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sw += p.weight;
    sx += p.weight * p.k;
    sy += p.weight * p.dev;
    sxx += p.weight * p.k * p.k;
    sxy += p.weight * p.k * p.dev;
  }
  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) {
    return { slope: 0, intercept: sy / Math.max(1e-12, sw) };
  }
  const slope = (sw * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / sw };
}

function interpolateOffsets(residuals, count, period) {
  // Median-of-3 smoothing, then linear interpolation across beats.
  const smoothed = residuals.map((r, i) => {
    const neighbours = residuals.slice(Math.max(0, i - 1), i + 2).map((x) => x.res);
    return { k: r.k, res: median(neighbours) };
  });
  const offsets = new Array(count);
  const limit = period * 0.25;
  let j = 0;
  for (let k = 0; k < count; k += 1) {
    while (j + 1 < smoothed.length && smoothed[j + 1].k <= k) {
      j += 1;
    }
    const a = smoothed[j];
    const b = smoothed[Math.min(smoothed.length - 1, j + 1)];
    let value;
    if (k <= smoothed[0].k) {
      value = smoothed[0].res;
    } else if (k >= smoothed[smoothed.length - 1].k) {
      value = smoothed[smoothed.length - 1].res;
    } else {
      const f = b.k === a.k ? 0 : (k - a.k) / (b.k - a.k);
      value = a.res + (b.res - a.res) * f;
    }
    offsets[k] = clamp(value, -limit, limit);
  }
  return offsets;
}

function analyzeStructure(env, beatTimes, period) {
  const count = beatTimes.length;
  const kick = new Array(count).fill(0);
  const lowE = new Array(count).fill(0);
  const fullE = new Array(count).fill(0);

  for (let k = 0; k < count; k += 1) {
    const t = beatTimes[k];
    const from = Math.max(0, Math.floor((t - period / 8 - env.timeOffsetSec) / env.hopSec));
    const to = Math.min(env.frameCount - 1, Math.ceil((t + period / 8 - env.timeOffsetSec) / env.hopSec));
    let peak = 0;
    for (let i = from; i <= to; i += 1) {
      peak = Math.max(peak, env.onset.low[i]);
    }
    kick[k] = peak;

    const eFrom = Math.max(0, Math.floor((t - env.timeOffsetSec) / env.hopSec));
    const eTo = Math.min(env.frameCount, Math.floor((t + period - env.timeOffsetSec) / env.hopSec));
    let lowSum = 0;
    let fullSum = 0;
    for (let i = eFrom; i < eTo; i += 1) {
      lowSum += env.energy.low[i];
      fullSum += env.energy.full[i];
    }
    const n = Math.max(1, eTo - eFrom);
    lowE[k] = lowSum / n;
    fullE[k] = fullSum / n;
  }

  const kickRef = percentile(kick, 0.9) || 1;
  const fullRef = median(fullE.filter((v) => v > 0)) || 1;
  const kickMask = kick.map((v) => (v / kickRef >= 0.35 ? 1 : 0));
  const activeMask = fullE.map((v) => (v / fullRef >= 0.12 ? 1 : 0));

  // Phrase grid: elements enter and leave on 8/16-beat boundaries, so look
  // for the offset where per-beat energy changes concentrate.
  const novelty = new Array(count).fill(0);
  for (let k = 8; k < count - 8; k += 1) {
    let lowBefore = 0;
    let lowAfter = 0;
    let fullBefore = 0;
    let fullAfter = 0;
    let kickBefore = 0;
    let kickAfter = 0;
    for (let j = 1; j <= 8; j += 1) {
      lowBefore += lowE[k - j];
      fullBefore += fullE[k - j];
      kickBefore += kickMask[k - j];
      lowAfter += lowE[k + j - 1];
      fullAfter += fullE[k + j - 1];
      kickAfter += kickMask[k + j - 1];
    }
    novelty[k] = Math.abs(Math.log((lowAfter + 1e-9) / (lowBefore + 1e-9)))
      + Math.abs(Math.log((fullAfter + 1e-9) / (fullBefore + 1e-9)))
      + Math.abs(kickAfter - kickBefore) / 8;
  }

  const firstKickBeat = kickMask.indexOf(1);
  let phraseOffset = firstKickBeat >= 0 ? firstKickBeat % PHRASE_BEATS : 0;
  let bestScore = -Infinity;
  for (let m = 0; m < PHRASE_BEATS; m += 1) {
    let score = 0;
    for (let k = 0; k < count; k += 1) {
      const r = ((k - m) % PHRASE_BEATS + PHRASE_BEATS) % PHRASE_BEATS;
      if (r === 0) score += novelty[k];
      if (r % 8 === 0) score += 0.5 * novelty[k];
      if (r % 4 === 0) score += 0.25 * novelty[k];
    }
    if (firstKickBeat >= 0 && (firstKickBeat - m) % 4 === 0) {
      score *= 1.05;
    }
    if (score > bestScore) {
      bestScore = score;
      phraseOffset = m;
    }
  }

  const firstActiveBeat = Math.max(0, activeMask.indexOf(1));
  const lastActive = activeMask.lastIndexOf(1);
  const lastKick = kickMask.lastIndexOf(1);

  return {
    phraseOffset,
    firstActiveBeat,
    lastActiveBeat: lastActive >= 0 ? lastActive : count - 1,
    firstKickBeat: firstKickBeat >= 0 ? firstKickBeat : null,
    lastKickBeat: lastKick >= 0 ? lastKick : null,
    kickMask: kickMask.join(""),
    activeMask: activeMask.join(""),
  };
}

function buildFallbackAnalysis(env, durationSec) {
  const period = 0.5;
  const beatCount = Math.max(1, Math.floor(durationSec / period));
  return {
    version: ANALYSIS_VERSION,
    durationSec,
    bpm: 120,
    period,
    phase: 0,
    beatCount,
    beatOffsets: null,
    steady: true,
    confidence: 0,
    beatStrength: 0,
    hasBeat: false,
    phraseOffset: 0,
    firstActiveBeat: 0,
    lastActiveBeat: beatCount - 1,
    firstKickBeat: null,
    lastKickBeat: null,
    kickMask: "0".repeat(beatCount),
    activeMask: "1".repeat(beatCount),
  };
}

// Absolute source time (seconds) of every beat in an analysis result.
function beatTimesOf(analysis) {
  const times = new Array(analysis.beatCount);
  for (let k = 0; k < analysis.beatCount; k += 1) {
    times[k] = analysis.phase + k * analysis.period + (analysis.beatOffsets ? analysis.beatOffsets[k] : 0);
  }
  return times;
}

module.exports = {
  ANALYSIS_SR,
  ANALYSIS_VERSION,
  PHRASE_BEATS,
  computeEnvelopes,
  analyzeSamples,
  measureAttackOffset,
  zeroPhaseLowpass,
  measureBeatDeviation,
  beatTimesOf,
  coherence,
  refinePeriod,
  foldPhase,
};
