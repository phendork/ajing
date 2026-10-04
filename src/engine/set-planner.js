// Set planning: running order, per-transition tempo + style + phrase anchors.
//
// Ordering works on the "tempo circle": log2(BPM) mod 1, so 87 and 174 BPM
// (drum & bass in half time / full time) or 70 and 140 sit together. Tracks
// are sorted around the circle starting after its largest empty gap, lightly
// shuffled, so neighbours are always close in tempo while the order still
// changes on every run.
//
// Tempo: no global session BPM. Each track plays at its NATIVE tempo in its
// body. At a blend both decks meet at the geometric mean of their tempos, so
// each one moves only half the gap (e.g. 124 -> 128 means 124 plays at 126
// and 128 plays at 126 during the blend), then glides back to native.

const { PHRASE_BEATS, beatTimesOf } = require("./analysis");
const { TRANSITIONS, pickTransitionType } = require("./transitions");

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function circlePosition(bpm) {
  const x = Math.log2(bpm);
  return x - Math.floor(x);
}

/**
 * @param {Array<{analysis}>} tracks
 * @param {{ rng: () => number, shape: "auto"|"rise"|"arc", maxShiftPercent }} options
 */
function buildSetOrder(tracks, options) {
  const { rng } = options;
  if (tracks.length <= 2) {
    return tracks.slice();
  }

  const beatless = tracks.filter((t) => !t.analysis.hasBeat);
  const items = tracks
    .filter((t) => t.analysis.hasBeat)
    .map((t) => ({ track: t, x: circlePosition(t.analysis.bpm) }))
    .sort((a, b) => a.x - b.x);

  let ordered = [];
  if (items.length) {
    // Cut the circle at its largest gap, then unwrap into a line.
    let cut = 0;
    let largest = -1;
    for (let i = 0; i < items.length; i += 1) {
      const next = i + 1 < items.length ? items[i + 1].x : items[0].x + 1;
      if (next - items[i].x > largest) {
        largest = next - items[i].x;
        cut = (i + 1) % items.length;
      }
    }
    const line = items.slice(cut).concat(items.slice(0, cut).map((it) => ({ ...it, x: it.x + 1 })));

    // Jitter ±0.6% tempo so near-equal tempos shuffle between runs.
    const jitter = Math.log2(1.006);
    const jittered = line
      .map((it) => ({ ...it, key: it.x + (rng() * 2 - 1) * jitter }))
      .sort((a, b) => a.key - b.key);

    const steps = [];
    for (let i = 1; i < jittered.length; i += 1) {
      steps.push(jittered[i].x - jittered[i - 1].x);
    }
    steps.sort((a, b) => a - b);
    const typicalStep = steps.length ? steps[Math.floor(steps.length / 2)] : 0;

    let shape = options.shape || "auto";
    if (shape === "auto") {
      // An arc (build up, peak, come down) doubles neighbour gaps; only use it
      // when the playlist is dense enough for that to stay well beatmatchable.
      shape = typicalStep * 2 <= Math.log2(1 + (options.maxShiftPercent || 6) / 200) ? "arc" : "rise";
    }

    if (shape === "arc") {
      const up = jittered.filter((_, i) => i % 2 === 0);
      const down = jittered.filter((_, i) => i % 2 === 1).reverse();
      ordered = up.concat(down).map((it) => it.track);
    } else {
      ordered = jittered.map((it) => it.track);
    }
  }

  // Beatless tracks (ambient, ballads) get blended in at random positions.
  for (const t of beatless) {
    const at = Math.floor(rng() * (ordered.length + 1));
    ordered.splice(at, 0, t);
  }
  return ordered;
}

// ── Pair tempo relation ────────────────────────────────────────────────────

/**
 * Find the octave relation j so that B's tempo (in A-beat units, bpmB * 2^j)
 * is as close as possible to A's, and the shared blend tempo.
 */
function pairTempo(bpmA, bpmB) {
  const j = Math.round(Math.log2(bpmA / bpmB));
  const bInA = bpmB * Math.pow(2, j);
  const shared = Math.sqrt(bpmA * bInA);
  return {
    j,
    sharedBpm: shared,
    // Speed factor each deck needs at the blend (1.02 = +2%).
    factorA: shared / bpmA,
    factorB: shared / bInA,
    gapPercent: Math.abs(bInA / bpmA - 1) * 100,
  };
}

// ── Phrase anchors ─────────────────────────────────────────────────────────

function isPhraseStart(analysis, k) {
  return (((k - analysis.phraseOffset) % PHRASE_BEATS) + PHRASE_BEATS) % PHRASE_BEATS === 0;
}

function kickAt(analysis, k) {
  return analysis.kickMask && analysis.kickMask[k] === "1";
}

function kickDensity(analysis, from, to) {
  let hits = 0;
  let total = 0;
  for (let k = Math.max(0, from); k < Math.min(analysis.beatCount, to); k += 1) {
    total += 1;
    if (kickAt(analysis, k)) hits += 1;
  }
  return total ? hits / total : 0;
}

// Where the incoming track enters: first phrase start where music is playing.
// For drop-style cuts it must also have a beat.
function chooseInAnchor(analysis, needsKick) {
  const limit = Math.floor(analysis.beatCount * 0.35);
  const start = needsKick && analysis.firstKickBeat != null ? analysis.firstKickBeat : analysis.firstActiveBeat;
  for (let k = Math.max(0, start - 2); k < limit; k += 1) {
    if (!isPhraseStart(analysis, k)) continue;
    if (!needsKick || kickDensity(analysis, k, k + 8) >= 0.5) {
      return k;
    }
  }
  return Math.max(0, start);
}

// Where the outgoing track starts mixing out (overlap) or cuts (drop styles):
// the latest phrase start that still leaves `lengthBeats` of music.
function chooseOutAnchor(analysis, lengthBeats, minBeat) {
  const endBeat = Math.min(analysis.beatCount - 1, analysis.lastActiveBeat + 1);
  for (let k = endBeat - lengthBeats; k >= minBeat; k -= 1) {
    if (isPhraseStart(analysis, k)) {
      return k;
    }
  }
  return null;
}

/**
 * Plan every transition of the set.
 * @returns {Array} transition descriptors, transitions[i] joins order[i] -> order[i+1]
 */
function planTransitions(order, options) {
  const { rng, maxShiftPercent, allowedTypes } = options;
  const transitions = [];
  let previousType = null;
  // inAnchor of each track as decided by the transition into it.
  const inAnchors = new Array(order.length).fill(null);

  for (let i = 0; i < order.length - 1; i += 1) {
    const a = order[i].analysis;
    const b = order[i + 1].analysis;
    const bothBeats = a.hasBeat && b.hasBeat;
    const tempo = pairTempo(a.bpm, b.bpm);
    const beatmatchable = bothBeats && tempo.gapPercent <= maxShiftPercent * 2;

    // A track must play a decent part of itself before mixing out.
    const minOut = Math.max(
      (inAnchors[i] || 0) + PHRASE_BEATS * 2,
      Math.floor(a.beatCount * 0.45),
    );

    let type = pickTransitionType({ rng, beatmatchable, bothBeats, previousType, allowedTypes });
    let spec = TRANSITIONS[type];
    let lengthBeats = spec.overlap ? spec.chooseLength(rng) : 0;

    let outBeat = null;
    if (spec.overlap) {
      // Shrink the blend if the outro is too short; fall back to a cut style.
      for (const length of [lengthBeats, 16, 8]) {
        if (length > lengthBeats) continue;
        outBeat = chooseOutAnchor(a, length, minOut);
        if (outBeat != null) {
          lengthBeats = length;
          break;
        }
      }
      if (outBeat == null || (lengthBeats < spec.minBeats)) {
        type = bothBeats ? "echo_out" : "smooth_fade";
        spec = TRANSITIONS[type];
        lengthBeats = 0;
        outBeat = null;
      }
    }
    if (!spec.overlap) {
      outBeat = chooseOutAnchor(a, spec.outroBeats || 0, minOut);
      if (outBeat == null) {
        outBeat = Math.max(minOut, Math.min(a.beatCount - 1, a.lastActiveBeat - (spec.outroBeats || 0)));
      }
    }

    const inBeat = chooseInAnchor(b, !spec.overlap && b.hasBeat);
    inAnchors[i + 1] = inBeat;

    // B beats covered by the blend (B runs 2^-j beats per A beat).
    const lengthBeatsB = spec.overlap ? Math.round(lengthBeats / Math.pow(2, tempo.j)) : 0;

    transitions.push({
      index: i,
      type,
      name: spec.name,
      overlap: spec.overlap,
      lengthBeats,
      lengthBeatsB,
      j: tempo.j,
      sharedBpm: spec.overlap ? tempo.sharedBpm : null,
      factorA: spec.overlap ? tempo.factorA : 1,
      factorB: spec.overlap ? tempo.factorB : 1,
      gapPercent: tempo.gapPercent,
      outBeat,
      inBeat,
    });
    previousType = type;
  }
  return transitions;
}

/**
 * Desired output duration of every beat interval of track i, given the
 * transitions into and out of it. Native tempo in the body, constant shared
 * tempo inside blends, log-linear glides of up to `rampBeats` in between.
 */
function buildBeatDurations(analysis, inTransition, outTransition, rampBeats) {
  const beats = beatTimesOf(analysis);
  const count = beats.length;
  const native = new Array(Math.max(0, count - 1));
  for (let k = 0; k < count - 1; k += 1) {
    native[k] = beats[k + 1] - beats[k];
  }
  const period = analysis.period;

  // Blend regions with their constant output beat duration.
  let inRegion = null;
  if (inTransition && inTransition.overlap) {
    inRegion = {
      from: inTransition.inBeat,
      to: inTransition.inBeat + inTransition.lengthBeatsB,
      duration: period / inTransition.factorB,
      factor: inTransition.factorB,
    };
  }
  let outRegion = null;
  if (outTransition && outTransition.overlap) {
    outRegion = {
      from: outTransition.outBeat,
      to: outTransition.outBeat + outTransition.lengthBeats,
      duration: period / outTransition.factorA,
      factor: outTransition.factorA,
    };
  }

  const inFactor = inRegion ? inRegion.factor : 1;
  const outFactor = outRegion ? outRegion.factor : 1;
  const bodyStart = inRegion ? inRegion.to : 0;
  const bodyEnd = outRegion ? outRegion.from : count - 1;
  const bodyLength = Math.max(0, bodyEnd - bodyStart);
  const ramp = Math.min(rampBeats, Math.floor(bodyLength / 2));

  const durations = new Array(native.length);
  for (let k = 0; k < native.length; k += 1) {
    if (inRegion && k >= inRegion.from && k < inRegion.to) {
      durations[k] = inRegion.duration;
      continue;
    }
    if (outRegion && k >= outRegion.from && k < outRegion.to) {
      durations[k] = outRegion.duration;
      continue;
    }

    let factor;
    if (k < bodyStart) {
      factor = inFactor;
    } else if (k >= bodyEnd) {
      factor = outFactor;
    } else if (ramp <= 0) {
      // Body too short for a hold: glide straight from in- to out-tempo.
      const u = bodyLength > 0 ? (k - bodyStart + 0.5) / bodyLength : 1;
      factor = Math.pow(inFactor, 1 - u) * Math.pow(outFactor, u);
    } else if (k < bodyStart + ramp) {
      const u = (k - bodyStart + 0.5) / ramp;
      factor = Math.pow(inFactor, 1 - u);
    } else if (k >= bodyEnd - ramp) {
      const u = (k - (bodyEnd - ramp) + 0.5) / ramp;
      factor = Math.pow(outFactor, u);
    } else {
      factor = 1;
    }
    durations[k] = native[k] / factor;
  }
  return { beats, durations };
}

module.exports = {
  makeRng,
  buildSetOrder,
  pairTempo,
  planTransitions,
  buildBeatDurations,
};
