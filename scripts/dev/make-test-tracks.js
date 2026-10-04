// Generates synthetic dance tracks with exactly known beat positions so the
// engine's tempo/phase accuracy and transition alignment can be measured in
// milliseconds. Usage: node scripts/dev/make-test-tracks.js <outDir>
//
// Each track is written as .opus (like YouTube audio) plus a .truth.json with
// the true beat times, BPM and phrase layout.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SR = 44100;

const TRACKS = [
  { id: "t01-118", bpm: 118.0, lead: 0.12, root: 55.0, kick: "four" },
  { id: "t02-122", bpm: 122.3, lead: 0.0, root: 61.7, kick: "four" },
  { id: "t03-124-quiet", bpm: 124.0, lead: 0.53, root: 49.0, kick: "four", gainDb: -7 },
  { id: "t04-126-live", bpm: 126.0, lead: 0.2, root: 58.3, kick: "four", drift: 0.004 },
  { id: "t05-128", bpm: 128.0, lead: 0.05, root: 51.9, kick: "four" },
  { id: "t06-131", bpm: 131.5, lead: 0.3, root: 65.4, kick: "four" },
  { id: "t07-140", bpm: 140.0, lead: 0.0, root: 46.2, kick: "four" },
  { id: "t08-174-dnb", bpm: 174.0, lead: 0.25, root: 43.7, kick: "dnb" },
  { id: "t09-95-hiphop", bpm: 95.0, lead: 0.4, root: 55.0, kick: "hiphop" },
  { id: "t10-100", bpm: 100.0, lead: 0.1, root: 49.0, kick: "four" },
];

// Bars per section and which instruments play.
const SECTIONS = [
  { bars: 8, kick: true, hat: true },
  { bars: 8, kick: true, hat: true, bass: true },
  { bars: 16, kick: true, hat: true, bass: true, clap: true, pad: true },
  { bars: 8, hat: true, pad: true },
  { bars: 16, kick: true, hat: true, bass: true, clap: true, pad: true },
  { bars: 8, kick: true, hat: true },
];

const KICK_PATTERNS = {
  four: [0, 1, 2, 3],
  dnb: [0, 2.5],
  hiphop: [0, 1.5, 2],
};
const CLAP_PATTERNS = {
  four: [1, 3],
  dnb: [1, 3],
  hiphop: [1, 3],
};

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 * 2 - 1;
  };
}

function buildBeats(spec, totalBeats) {
  const beats = [];
  let t = spec.lead;
  for (let i = 0; i <= totalBeats; i += 1) {
    beats.push(t);
    const bpm = spec.bpm * (1 + (spec.drift || 0) * Math.sin((2 * Math.PI * t) / 40));
    t += 60 / bpm;
  }
  return beats;
}

function timeAt(beats, position) {
  const i = Math.floor(position);
  const f = position - i;
  return beats[i] + f * (beats[i + 1] - beats[i]);
}

function renderTrack(spec, index) {
  const totalBars = SECTIONS.reduce((sum, s) => sum + s.bars, 0);
  const totalBeats = totalBars * 4;
  const beats = buildBeats(spec, totalBeats + 1);
  const length = Math.ceil((beats[totalBeats] + 3) * SR);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const rand = makeRng(1234 + index * 77);

  const add = (t0, fn, durSec, panL = 1, panR = 1) => {
    const start = Math.round(t0 * SR);
    const n = Math.round(durSec * SR);
    for (let i = 0; i < n && start + i < length; i += 1) {
      const v = fn(i / SR, i);
      left[start + i] += v * panL;
      right[start + i] += v * panR;
    }
  };

  const kick = (t0) => {
    let phase = 0;
    add(t0, (tt) => {
      const f = 48 + 120 * Math.exp(-tt * 32);
      phase += (2 * Math.PI * f) / SR;
      const click = tt < 0.002 ? rand() * 0.4 : 0;
      return (Math.sin(phase) * Math.exp(-tt * 7) + click) * 0.9;
    }, 0.38);
  };
  const clap = (t0) => {
    let prev = 0;
    add(t0, (tt) => {
      const n = rand();
      const v = n - prev;
      prev = n;
      return v * Math.exp(-tt * 22) * 0.25;
    }, 0.25);
  };
  const hat = (t0) => {
    let prev = 0;
    add(t0, (tt) => {
      const n = rand();
      const v = n - prev;
      prev = n;
      return v * Math.exp(-tt * 70) * 0.12;
    }, 0.07, 0.8, 1);
  };
  const bass = (t0, dur, freq) => {
    let phase = 0;
    let lp = 0;
    add(t0, (tt) => {
      phase = (phase + freq / SR) % 1;
      const saw = 2 * phase - 1;
      lp += 0.08 * (saw - lp);
      const env = Math.min(1, tt / 0.005) * Math.min(1, Math.max(0, (dur - tt) / 0.02));
      return lp * env * 0.45;
    }, dur);
  };
  const pad = (t0, dur, freq) => {
    add(t0, (tt) => {
      const env = Math.min(1, tt / 0.4) * Math.min(1, Math.max(0, (dur - tt) / 0.4));
      return (Math.sin(2 * Math.PI * freq * 4 * tt) + 0.6 * Math.sin(2 * Math.PI * freq * 5.04 * tt)
        + 0.5 * Math.sin(2 * Math.PI * freq * 6 * tt)) * env * 0.05;
    }, dur, 1, 0.85);
  };

  let bar = 0;
  for (const section of SECTIONS) {
    for (let b = 0; b < section.bars; b += 1, bar += 1) {
      const barBeat = bar * 4;
      if (section.kick) {
        for (const pos of KICK_PATTERNS[spec.kick]) kick(timeAt(beats, barBeat + pos));
      }
      if (section.clap) {
        for (const pos of CLAP_PATTERNS[spec.kick]) clap(timeAt(beats, barBeat + pos));
      }
      if (section.hat) {
        for (let q = 0; q < 4; q += 1) hat(timeAt(beats, barBeat + q + 0.5));
      }
      if (section.bass) {
        const notes = [1, 1, 1.189, 0.891];
        for (let q = 0; q < 4; q += 1) {
          const t0 = timeAt(beats, barBeat + q + 0.5);
          bass(t0, (beats[barBeat + q + 1] - beats[barBeat + q]) * 0.4, spec.root * notes[Math.floor(bar / 2) % 4]);
        }
      }
      if (section.pad && b % 2 === 0) {
        pad(beats[barBeat], beats[barBeat + 8] - beats[barBeat], spec.root * (bar % 4 === 0 ? 1 : 1.122));
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const gain = (0.89 / peak) * Math.pow(10, (spec.gainDb || 0) / 20);
  const pcm = Buffer.alloc(length * 4);
  for (let i = 0; i < length; i += 1) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] * gain)) * 32767), i * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] * gain)) * 32767), i * 4 + 2);
  }

  return {
    pcm,
    truth: {
      id: spec.id,
      bpm: spec.bpm,
      drift: spec.drift || 0,
      kickPattern: spec.kick,
      firstBeatSec: spec.lead,
      beats: beats.slice(0, totalBeats),
      phraseOffset: 0,
      durationSec: length / SR,
    },
  };
}

function main() {
  const outDir = path.resolve(process.argv[2] || ".cache/test-tracks");
  fs.mkdirSync(outDir, { recursive: true });
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";

  TRACKS.forEach((spec, index) => {
    const { pcm, truth } = renderTrack(spec, index);
    const target = path.join(outDir, `${spec.id}.opus`);
    const result = spawnSync(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(SR), "-ac", "2", "-i", "-",
      "-c:a", "libopus", "-b:a", "160k", target,
    ], { input: pcm });
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed for ${spec.id}: ${result.stderr}`);
    }
    fs.writeFileSync(path.join(outDir, `${spec.id}.truth.json`), JSON.stringify(truth));
    console.log(`wrote ${target} (${truth.durationSec.toFixed(1)}s, ${spec.bpm} BPM)`);
  });
}

main();
