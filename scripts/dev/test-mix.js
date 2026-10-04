// Renders a full DJ set from the synthetic test tracks and verifies, against
// the generator's ground truth, how precisely the kicks of the two decks line
// up inside every blend. Usage:
//   node scripts/dev/make-test-tracks.js .cache/test-tracks
//   node scripts/dev/test-mix.js .cache/test-tracks [seed]

const fs = require("fs");
const path = require("path");
const { analyzeTrackFile, renderSet } = require("../../src/engine/engine");
const { measureLoudness } = require("../../src/engine/audio-io");

async function main() {
  const dir = path.resolve(process.argv[2] || ".cache/test-tracks");
  const seed = process.argv[3] ? Number(process.argv[3]) : 7;
  const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".opus")).sort();

  const tracks = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const truth = JSON.parse(fs.readFileSync(filePath.replace(/\.opus$/, ".truth.json"), "utf8"));
    const analysis = await analyzeTrackFile(ffmpegBin, filePath);
    const loudness = await measureLoudness(ffmpegBin, filePath);
    tracks.push({ id: truth.id, title: truth.id, filePath, analysis, loudness, truth });
    console.log(`${truth.id.padEnd(15)} ${analysis.bpm.toFixed(3)} BPM  ${loudness.integrated} LUFS`);
  }

  const outputFile = path.join(dir, "test-mix.wav");
  const t0 = Date.now();
  const result = await renderSet({
    tracks,
    outputFile,
    config: {
      ffmpegBin,
      seed,
      maxShiftPercent: 6,
      rampBeats: 32,
      setShape: "auto",
      targetLufs: -14,
      allowedTransitions: process.env.TRANSITION_STYLES ? process.env.TRANSITION_STYLES.split(",") : null,
    },
  });
  console.log(`\nRendered ${result.totalDurationSec.toFixed(1)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outputFile} (peak ${result.peak.toFixed(3)})\n`);

  fs.writeFileSync(path.join(dir, "test-mix.timeline.json"), JSON.stringify(result.timeline.map((e) => ({
    id: e.track.id,
    startSec: e.startSec,
    durationSec: e.durationSec,
    transitionIn: e.transitionIn,
  })), null, 2));

  for (let i = 0; i < result.transitions.length; i += 1) {
    const t = result.transitions[i];
    const a = result.order[i];
    const b = result.order[i + 1];
    let truthReport = "";
    if (t.overlap) {
      // True kick positions of both decks in mix time, within the blend.
      const aKicks = a.truth.beats.map(result.toMixTime[i]);
      const bKicks = b.truth.beats.map(result.toMixTime[i + 1]);
      const startMix = result.timeline[i + 1].startSec;
      const endMix = startMix + t.lengthBeats * (60 / t.sharedBpm);
      const errs = [];
      for (const ta of aKicks) {
        if (ta < startMix || ta > endMix) continue;
        let best = Infinity;
        for (const tb of bKicks) if (Math.abs(tb - ta) < Math.abs(best)) best = tb - ta;
        if (Math.abs(best) < 0.1) errs.push(Math.abs(best) * 1000);
      }
      truthReport = errs.length
        ? `TRUE beat error: mean ${(errs.reduce((s, v) => s + v, 0) / errs.length).toFixed(3)} ms, max ${Math.max(...errs).toFixed(3)} ms over ${errs.length} beats`
        : "no overlapping true beats";
    }
    const measured = result.alignment[i]
      && result.alignment[i].driftMs != null
      ? ` | engine-measured drift ${result.alignment[i].driftMs.toFixed(2)} ms`
      : "";
    console.log(`${String(i + 1).padStart(2)}. ${a.id} -> ${b.id}: ${t.name}${t.overlap ? ` ${t.lengthBeats} beats @ ${t.sharedBpm.toFixed(2)} BPM (A x${t.factorA.toFixed(4)}, B x${t.factorB.toFixed(4)})` : ` (gap ${t.gapPercent.toFixed(1)}%)`}`);
    if (truthReport || measured) console.log(`    ${truthReport}${measured}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
