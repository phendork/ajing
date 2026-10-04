// Transition catalogue — what a DJ does with the mixer, written as automation.
//
// Every style describes, in BEATS relative to the transition anchor (the
// phrase downbeat where the incoming track enters), how each deck's channel
// strip moves: volume, 3-band EQ (kill depth -40 dB), resonant high/low-pass
// filters, a beat-synced echo send and a reverb send. The deck engine (fx.js)
// renders these lanes sample-accurately.
//
// Overlap styles (beatmatched, both decks audible on one locked grid):
//   bass_swap        8-bar blend, the basslines swap in one beat on the phrase
//   filter_handoff   complementary LPF/HPF sweep — the new track takes over
//                    the spectrum from the top down
//   quick_swap       2-bar drop swap: incoming hats/mids, then hard swap on 1
// Cut styles (phrase-locked, work across any tempo gap):
//   echo_out         last beat thrown into a dotted-eighth echo, new track
//                    drops on the one
//   loop_roll        beat repeat 1/2 -> 1/4 -> 1/8 with rising HPF into the drop
//   reverb_wash      outgoing washes into a big reverb while the next drops
//   smooth_fade      long EQ'd crossfade for tracks without a steady beat

const KILL = -40;

const TRANSITIONS = {
  bass_swap: {
    name: "Bass Swap Blend",
    overlap: true,
    minBeats: 16,
    chooseLength: () => 32,
    automate({ L, a, b }) {
      const half = L / 2;
      a.eqLow.hold(a.at(half - 0.5), 0).ramp(a.at(half), KILL);
      a.eqMid.hold(a.at(half), 0).ramp(a.at(L * 0.75), -10).ramp(a.at(L - 1), -30);
      a.eqHigh.hold(a.at(L / 4), 0).ramp(a.at(half), -6).ramp(a.at(L - 1), KILL);
      a.gain.hold(a.at(L * 0.75), 1).ramp(a.at(L), 0, "slowStart");

      b.gain.hold(b.at(0), 0).ramp(b.at(L / 4), 1, "fastStart");
      b.eqLow.hold(b.at(half - 0.5), KILL).ramp(b.at(half), 0);
      b.eqMid.hold(b.at(L / 4), -10).ramp(b.at(half), 0);
      b.eqHigh.hold(b.at(0), -8).ramp(b.at(L / 4), 0);
    },
  },

  filter_handoff: {
    name: "Filter Handoff",
    overlap: true,
    minBeats: 16,
    chooseLength: (rng) => (rng() < 0.5 ? 16 : 32),
    automate({ L, a, b }) {
      a.lpf.hold(a.at(0), 22050).ramp(a.at(L * 0.25), 7000, "exp").ramp(a.at(L - 1), 110, "exp");
      a.lpfQ.hold(a.at(0), 1.1);
      a.eqLow.hold(a.at(L - 1), 0).ramp(a.at(L - 0.5), KILL);
      a.gain.hold(a.at(L - 1), 1).ramp(a.at(L), 0, "slowStart");

      b.gain.hold(b.at(0), 0).ramp(b.at(2), 1, "fastStart");
      b.hpf.hold(b.at(0), 6000).ramp(b.at(L - 1), 110, "exp").ramp(b.at(L), 18, "exp");
      b.hpfQ.hold(b.at(0), 1.1);
      b.eqLow.hold(b.at(L - 1), -12).ramp(b.at(L - 0.5), 0);
    },
  },

  quick_swap: {
    name: "Quick Drop Swap",
    overlap: true,
    minBeats: 8,
    chooseLength: () => 8,
    automate({ L, a, b }) {
      b.gain.hold(b.at(0), 0).ramp(b.at(2), 1, "fastStart");
      b.eqLow.hold(b.at(L - 0.5), KILL).ramp(b.at(L), 0);
      b.eqMid.hold(b.at(L / 2), -6).ramp(b.at(L), 0);

      a.eqHigh.hold(a.at(2), 0).ramp(a.at(L - 1), -12);
      a.eqLow.hold(a.at(L - 0.5), 0).ramp(a.at(L), KILL);
      a.gain.hold(a.at(L - 0.25), 1).ramp(a.at(L), 0, "slowStart");
    },
  },

  echo_out: {
    name: "Echo Out Drop",
    overlap: false,
    outroBeats: 4,
    echo: { delayBeats: 0.75, feedback: 0.5 },
    tailBeats: 8,
    automate({ a, b }) {
      a.hpf.hold(a.at(-2), 18).ramp(a.at(0), 260, "exp");
      a.echoSend.hold(a.at(-1.05), 0).ramp(a.at(-1), 1).hold(a.at(-0.03), 1).ramp(a.at(0), 0);
      a.gain.hold(a.at(-0.03), 1).ramp(a.at(0), 0);
      dropIn(b);
    },
  },

  loop_roll: {
    name: "Loop Roll Drop",
    overlap: false,
    outroBeats: 4,
    echo: { delayBeats: 0.5, feedback: 0.4 },
    tailBeats: 4,
    // Repeat the downbeat 4 beats before the cut: 4 x 1/2, 4 x 1/4, 8 x 1/8.
    roll: { sourceBeat: -4, pattern: [[0.5, 4], [0.25, 4], [0.125, 8]] },
    automate({ a, b }) {
      a.hpf.hold(a.at(-4), 18).ramp(a.at(0), 1200, "exp");
      a.hpfQ.hold(a.at(-4), 1.4);
      a.eqLow.hold(a.at(-1), 0).ramp(a.at(-0.05), -20);
      a.echoSend.hold(a.at(-0.55), 0).ramp(a.at(-0.5), 0.8).hold(a.at(-0.03), 0.8).ramp(a.at(0), 0);
      a.gain.hold(a.at(-0.03), 1).ramp(a.at(0), 0);
      dropIn(b);
    },
  },

  reverb_wash: {
    name: "Reverb Wash",
    overlap: false,
    outroBeats: 4,
    tailSeconds: 4.5,
    automate({ a, b }) {
      a.reverbSend.hold(a.at(-4), 0).ramp(a.at(-0.5), 1, "slowStart").hold(a.at(-0.03), 1).ramp(a.at(0), 0);
      a.hpf.hold(a.at(-4), 18).ramp(a.at(0), 500, "exp");
      a.hpfQ.hold(a.at(-4), 1.1);
      a.gain.hold(a.at(-0.6), 1).ramp(a.at(0), 0, "slowStart");
      dropIn(b);
    },
  },

  smooth_fade: {
    name: "Smooth Crossfade",
    overlap: false,
    outroBeats: 0,
    fadeSeconds: 10,
    automate({ a, b, fadeSeconds }) {
      a.gain.hold(a.time(0), 1).ramp(a.time(fadeSeconds), 0, "slowStart");
      a.eqLow.hold(a.time(0), 0).ramp(a.time(fadeSeconds * 0.5), -24);
      b.gain.hold(b.time(0), 0).ramp(b.time(fadeSeconds), 1, "fastStart");
      b.eqLow.hold(b.time(0), -24).ramp(b.time(fadeSeconds * 0.6), 0);
    },
  },
};

// Incoming track slams in on the downbeat (a 10 ms fade-in avoids a click).
function dropIn(b) {
  b.gain.hold(b.time(-0.025), 0).ramp(b.time(-0.015), 1);
}

const WEIGHTS_BEATMATCHED = {
  bass_swap: 34,
  filter_handoff: 24,
  quick_swap: 12,
  echo_out: 10,
  loop_roll: 10,
  reverb_wash: 10,
};
const WEIGHTS_UNMATCHED = {
  echo_out: 40,
  loop_roll: 25,
  reverb_wash: 35,
};
const WEIGHTS_BEATLESS = {
  smooth_fade: 70,
  reverb_wash: 30,
};

function pickTransitionType({ rng, beatmatchable, bothBeats, previousType, allowedTypes }) {
  const table = beatmatchable ? WEIGHTS_BEATMATCHED : (bothBeats ? WEIGHTS_UNMATCHED : WEIGHTS_BEATLESS);
  let entries = Object.entries(table);
  if (allowedTypes && allowedTypes.length) {
    const filtered = entries.filter(([type]) => allowedTypes.includes(type));
    if (filtered.length) {
      entries = filtered;
    }
  }
  // Avoid the same style twice in a row when there is a choice.
  if (entries.length > 1) {
    entries = entries.filter(([type]) => type !== previousType);
  }
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [type, weight] of entries) {
    roll -= weight;
    if (roll <= 0) {
      return type;
    }
  }
  return entries[entries.length - 1][0];
}

module.exports = {
  TRANSITIONS,
  TRANSITION_TYPES: Object.keys(TRANSITIONS),
  pickTransitionType,
};
