// Set renderer: analysis results in, finished mix + timeline out.
//
//   order tracks on the tempo circle -> plan transitions (style, tempo, phrase
//   anchors) -> per-track beat warp -> align anchors sample-exactly ->
//   for each track: decode, varispeed render, deck FX, stream into the bus.

const { MIX_SR, decodeStereo, decodeMono } = require("./audio-io");
const { ANALYSIS_SR, ANALYSIS_VERSION, analyzeSamples, measureAttackOffset, zeroPhaseLowpass } = require("./analysis");
const { buildWarp, renderVarispeed } = require("./warp");
const { makeRng, buildSetOrder, planTransitions, buildBeatDurations } = require("./set-planner");
const { TRANSITIONS } = require("./transitions");
const { createLanes, processDeck } = require("./fx");
const { MixWriter } = require("./mixer");
const { clamp } = require("./dsp");

// Incoming decks start this long before their anchor so the kick attack that
// sits on the anchor is never clipped.
const PREROLL_SEC = 0.03;

async function analyzeTrackFile(ffmpegBin, filePath) {
  const samples = await decodeMono(ffmpegBin, filePath, ANALYSIS_SR);
  return analyzeSamples(samples, ANALYSIS_SR);
}

function isAnalysisCurrent(analysis) {
  return Boolean(analysis && analysis.version === ANALYSIS_VERSION && analysis.beatCount > 0);
}

function loudnessGainDb(loudness, targetLufs) {
  if (!loudness || !Number.isFinite(loudness.integrated)) {
    return 0;
  }
  let gain = clamp(targetLufs - loudness.integrated, -12, 12);
  // Allow at most ~3 dB of limiting on the loudest peaks.
  if (Number.isFinite(loudness.truePeak)) {
    gain = Math.min(gain, -1 - loudness.truePeak + 3);
  }
  return gain;
}

/**
 * @param {object} params
 * @param {Array<{id,title,filePath,analysis,loudness}>} params.tracks
 * @param {object} params.config
 * @param {string} params.outputFile
 * @param {(event: object) => void} [params.onEvent]
 */
async function renderSet({ tracks, config, outputFile, onEvent = () => {} }) {
  const seed = Number.isFinite(config.seed) ? config.seed : (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  const rng = makeRng(seed);
  const maxShiftPercent = config.maxShiftPercent;

  const order = buildSetOrder(tracks, { rng, shape: config.setShape, maxShiftPercent });
  const transitions = planTransitions(order, {
    rng,
    maxShiftPercent,
    allowedTypes: config.allowedTransitions,
  });
  onEvent({ type: "plan", order, transitions, seed });

  // Beat-accurate warp of every track.
  const warps = order.map((track, i) => {
    const { beats, durations } = buildBeatDurations(
      track.analysis,
      i > 0 ? transitions[i - 1] : null,
      i < transitions.length ? transitions[i] : null,
      config.rampBeats,
    );
    return { beats, warp: buildWarp(beats, durations, track.analysis.durationSec) };
  });

  // Anchor times (stem output seconds) and per-transition beat clocks.
  const joins = transitions.map((t) => {
    const a = warps[t.index].warp;
    const b = warps[t.index + 1].warp;
    const outBeats = a.outBeatTimes;
    const inBeats = b.outBeatTimes;
    const tA = outBeats[t.outBeat];
    const tB = inBeats[t.inBeat];
    const spec = TRANSITIONS[t.type];
    // Output beat length at the anchor: the locked blend pulse for overlap
    // styles, each deck's own (native) beat for cut styles.
    const beatA = spec.overlap
      ? order[t.index].analysis.period / t.factorA
      : localBeat(outBeats, t.outBeat, -1);
    const beatB = spec.overlap ? beatA : localBeat(inBeats, t.inBeat, 1);
    return { t, spec, tA, tB, beatA, beatB };
  });

  // Deck ranges in each track's own (stem) time, and where stem time 0 sits in the mix.
  const decks = order.map((track, i) => {
    const warp = warps[i].warp;
    const join = i > 0 ? joins[i - 1] : null;
    const start = join ? Math.max(0, join.tB - PREROLL_SEC) : 0;
    let end = warp.outputDuration;
    if (i < joins.length) {
      end = Math.min(end + 8, joins[i].tA + deckTailSeconds(joins[i]));
    }
    return { track, start, end };
  });
  const origins = new Array(order.length).fill(0);
  for (let i = 1; i < order.length; i += 1) {
    origins[i] = origins[i - 1] + joins[i - 1].tA - joins[i - 1].tB;
  }
  const originFrames = origins.map((o) => Math.round(o * MIX_SR));

  const writer = new MixWriter(config.ffmpegBin, outputFile);
  const timeline = [];
  const alignment = new Array(joins.length).fill(null);
  let pendingOutroAttacks = null;

  try {
    for (let i = 0; i < order.length; i += 1) {
      const track = order[i];
      const deck = decks[i];
      onEvent({ type: "track-start", index: i, track });

      const source = await decodeStereo(config.ffmpegBin, track.filePath);
      const startFrame = Math.floor(deck.start * MIX_SR);
      const endFrame = Math.max(startFrame + 1, Math.ceil(deck.end * MIX_SR));
      const gainDb = loudnessGainDb(track.loudness, config.targetLufs);
      const stem = renderVarispeed(source, warps[i].warp.segments, startFrame, endFrame, Math.pow(10, gainDb / 20));

      // Measure where kicks really land around both blends (for the report).
      const inJoin = i > 0 ? joins[i - 1] : null;
      const outJoin = i < joins.length ? joins[i] : null;
      if (inJoin && inJoin.spec.overlap && pendingOutroAttacks) {
        const incoming = measureKicks(stem, startFrame, track.analysis, warps[i].warp.outBeatTimes,
          inJoin.t.inBeat, inJoin.t.inBeat + inJoin.t.lengthBeatsB, origins[i]);
        alignment[i - 1] = compareKicks(pendingOutroAttacks, incoming);
      }
      pendingOutroAttacks = outJoin && outJoin.spec.overlap
        ? measureKicks(stem, startFrame, track.analysis, warps[i].warp.outBeatTimes,
          outJoin.t.outBeat, outJoin.t.outBeat + outJoin.t.lengthBeats, origins[i])
        : null;

      const { lanes, fx } = buildDeckAutomation(inJoin, outJoin, warps[i].warp);
      const processed = processDeck(stem, startFrame / MIX_SR, lanes, fx);

      const mixStart = originFrames[i] + startFrame;
      await writer.flushTo(mixStart);
      writer.addDeck(processed, mixStart);

      const entry = {
        index: i,
        track,
        startSec: mixStart / MIX_SR,
        durationSec: (endFrame - startFrame) / MIX_SR,
        gainDb,
        nativeBpm: track.analysis.bpm,
        transitionIn: inJoin ? describeJoin(inJoin, alignment[i - 1]) : null,
      };
      timeline.push(entry);
      onEvent({ type: "track-done", index: i, entry });
    }
    const result = await writer.finish();
    return {
      seed,
      order,
      transitions,
      timeline,
      alignment,
      totalDurationSec: result.frames / MIX_SR,
      peak: result.peak,
      // Exact mapping source time -> mix time per track (for verification).
      toMixTime: order.map((_, i) => (sourceSec) => originFrames[i] / MIX_SR + warps[i].warp.sourceToOutput(sourceSec)),
    };
  } catch (err) {
    try {
      writer.child.kill();
    } catch {
      // ignore
    }
    throw err;
  }
}

function localBeat(outBeats, k, direction) {
  const a = Math.max(0, Math.min(outBeats.length - 2, direction < 0 ? k - 1 : k));
  return outBeats[a + 1] - outBeats[a];
}

function deckTailSeconds(join) {
  const { spec, t, beatA } = join;
  if (spec.overlap) {
    return t.lengthBeats * beatA + 0.05;
  }
  if (spec.fadeSeconds) {
    return spec.fadeSeconds + 0.05;
  }
  if (spec.tailSeconds) {
    return spec.tailSeconds;
  }
  return (spec.tailBeats || 4) * beatA;
}

function buildDeckAutomation(inJoin, outJoin, warp) {
  const lanes = createLanes();
  const fx = { echo: null, reverb: false, roll: null };

  const role = (anchor, beat) => {
    const view = {};
    for (const [name, lane] of Object.entries(lanes)) {
      view[name] = lane;
    }
    view.at = (b) => anchor + b * beat;
    view.time = (s) => anchor + s;
    return view;
  };
  // A deck that is not in a transition role still needs a target for the
  // other side's automation calls; give it throwaway lanes.
  const scratch = (anchor, beat) => {
    const throwaway = createLanes();
    const view = { ...throwaway };
    view.at = (b) => anchor + b * beat;
    view.time = (s) => anchor + s;
    return view;
  };

  if (inJoin) {
    const { spec, t, tB, beatB } = inJoin;
    spec.automate({
      L: t.lengthBeats,
      a: scratch(0, beatB),
      b: role(tB, beatB),
      fadeSeconds: spec.fadeSeconds,
    });
  }
  if (outJoin) {
    const { spec, t, tA, beatA } = outJoin;
    spec.automate({
      L: t.lengthBeats,
      a: role(tA, beatA),
      b: scratch(0, beatA),
      fadeSeconds: spec.fadeSeconds,
    });
    if (spec.echo) {
      fx.echo = { delaySec: spec.echo.delayBeats * beatA, feedback: spec.echo.feedback };
    }
    if (spec.tailSeconds) {
      fx.reverb = true;
    }
    if (spec.roll) {
      const slices = [];
      let cursor = tA + spec.roll.sourceBeat * beatA;
      for (const [lengthBeats, repeats] of spec.roll.pattern) {
        for (let r = 0; r < repeats; r += 1) {
          slices.push({ time: cursor, length: lengthBeats * beatA });
          cursor += lengthBeats * beatA;
        }
      }
      fx.roll = { sourceStart: tA + spec.roll.sourceBeat * beatA, slices };
    }
  }
  return { lanes, fx };
}

// Kick attack offsets (averaged over many beats) relative to the planned
// grid, for the first and second half of a blend. Mix-time differences
// between the two decks give the true alignment error and any drift.
function measureKicks(stem, startFrame, analysis, outBeatTimes, from, to, origin) {
  const period = analysis.period;
  const first = Math.max(0, from);
  const last = Math.min(outBeatTimes.length - 1, to);
  if (last - first < 4) {
    return null;
  }
  const regionStart = Math.max(startFrame, Math.floor((outBeatTimes[first] - period) * MIX_SR));
  const regionEnd = Math.min(startFrame + stem.length / 2, Math.ceil((outBeatTimes[last] + period) * MIX_SR));
  if (regionEnd - regionStart < MIX_SR) {
    return null;
  }
  const mono = new Float32Array(regionEnd - regionStart);
  for (let n = 0; n < mono.length; n += 1) {
    const o = (regionStart - startFrame + n) * 2;
    mono[n] = 0.5 * (stem[o] + stem[o + 1]);
  }
  const low = zeroPhaseLowpass(mono, 150, MIX_SR);
  const regionSec = regionStart / MIX_SR;
  const half = Math.floor((first + last) / 2);
  const measureRange = (a, b) => {
    const beats = [];
    for (let k = a; k < b; k += 1) {
      if (analysis.kickMask[k] === "1") beats.push(outBeatTimes[k] - regionSec);
    }
    const m = beats.length >= 4 ? measureAttackOffset(low, MIX_SR, beats, period) : null;
    return m && m.contrast >= 2 ? m.offsetSec : null;
  };
  return {
    // Mix time of the planned anchor and measured offsets of real kicks.
    anchor: origin + outBeatTimes[first],
    early: measureRange(first, half),
    late: measureRange(half, last),
  };
}

function compareKicks(outgoing, incoming) {
  if (!outgoing || !incoming) {
    return null;
  }
  const pairs = [["early", outgoing.early, incoming.early], ["late", outgoing.late, incoming.late]]
    .filter(([, a, b]) => a != null && b != null)
    .map(([part, a, b]) => ({ part, errorMs: (incoming.anchor + b - (outgoing.anchor + a)) * 1000 }));
  if (!pairs.length) {
    return null;
  }
  // The absolute offset carries a small shape bias (varispeed changes kick
  // pitch); the drift between the halves of the blend does not, and is what
  // proves the two decks are locked.
  return {
    driftMs: pairs.length === 2 ? pairs[1].errorMs - pairs[0].errorMs : null,
  };
}

function describeJoin(join, alignmentStats) {
  const { t, spec } = join;
  return {
    type: t.type,
    name: spec.name,
    overlap: spec.overlap,
    beats: t.lengthBeats,
    sharedBpm: t.sharedBpm,
    gapPercent: t.gapPercent,
    alignment: alignmentStats,
  };
}

module.exports = {
  analyzeTrackFile,
  isAnalysisCurrent,
  renderSet,
};
