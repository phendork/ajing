const statusEl = document.getElementById("statusLine");
const currentTrackEl = document.getElementById("currentTrack");
const nextTrackEl = document.getElementById("nextTrack");
const mixSummaryEl = document.getElementById("mixSummary");
const mixPositionSlider = document.getElementById("mixPositionSlider");
const mixPositionValueEl = document.getElementById("mixPositionValue");
const trackPositionSlider = document.getElementById("trackPositionSlider");
const trackPositionValueEl = document.getElementById("trackPositionValue");
const fxMasterSlider = document.getElementById("fxMasterSlider");
const fxMasterValueEl = document.getElementById("fxMasterValue");
const fxBassSlider = document.getElementById("fxBassSlider");
const fxBassValueEl = document.getElementById("fxBassValue");
const fxMidSlider = document.getElementById("fxMidSlider");
const fxMidValueEl = document.getElementById("fxMidValue");
const fxTrebleSlider = document.getElementById("fxTrebleSlider");
const fxTrebleValueEl = document.getElementById("fxTrebleValue");
const fxDriveSlider = document.getElementById("fxDriveSlider");
const fxDriveValueEl = document.getElementById("fxDriveValue");
const fxEchoSlider = document.getElementById("fxEchoSlider");
const fxEchoValueEl = document.getElementById("fxEchoValue");
const logEl = document.getElementById("logOutput");
const flameCanvas = document.getElementById("flamegraphCanvas");
const flameCtx = flameCanvas ? flameCanvas.getContext("2d") : null;

const prepareBtn = document.getElementById("prepareBtn");
const pauseBtn = document.getElementById("pauseBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const exportBtn = document.getElementById("exportBtn");
const resetBtn = document.getElementById("resetBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const resetSettingsBtn = document.getElementById("resetSettingsBtn");
const settingsStatusEl = document.getElementById("settingsStatus");
const resetAllFxBtn = document.getElementById("resetAllFxBtn");

const settingsFields = {
  PLAYLIST_URL: document.getElementById("cfgPlaylistUrl"),
  GOOGLE_PLAYLIST_ID: document.getElementById("cfgGooglePlaylistId"),
  GOOGLE_CLIENT_ID: document.getElementById("cfgGoogleClientId"),
  GOOGLE_CLIENT_SECRET: document.getElementById("cfgGoogleClientSecret"),
  GOOGLE_REFRESH_TOKEN: document.getElementById("cfgGoogleRefreshToken"),
  BLEND_MAX_TEMPO_SHIFT_PERCENT: document.getElementById("cfgBlendMaxTempoShiftPercent"),
  TEMPO_RAMP_BEATS: document.getElementById("cfgTempoRampBeats"),
  PLAY_AUDIO: document.getElementById("cfgPlayAudio"),
  CLEAN_TEMP_AFTER_RUN: document.getElementById("cfgCleanTempAfterRun"),
  AUTO_RESET_ON_START: document.getElementById("cfgAutoResetOnStart"),
};
const settingsFieldEntries = Object.entries(settingsFields);

let session = null;
let preparing = false;
let currentIndex = -1;
const maxLogLines = 2000;
const LOG_FOLLOW_THRESHOLD_PX = 24;
const logLineBuffer = [];
const logLines = [];
let logFlushRaf = 0;
let logAutoFollow = true;
let playback = {
  positionSec: 0,
  paused: true,
  ended: false,
};
let flameRaf = 0;
const mixAudio = new Audio();
mixAudio.preload = "auto";
mixAudio.volume = 1;
let playbackSaveTimer = null;
let currentAudioFile = "";
let audioContext = null;
let analyserNode = null;
let mediaSourceNode = null;
let fxNodes = null;
let frequencyData = null;
let flameLevels = [];
let isScrubbingMix = false;
let isScrubbingTrack = false;
let settingsState = null;
let settingsDirty = false;

const FX_DEFAULTS = {
  master: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  drive: 0,
  echo: 0,
};

const fxValues = {
  ...FX_DEFAULTS,
};

const fxControlDefs = [
  { key: "master", slider: fxMasterSlider, valueEl: fxMasterValueEl, defaultValue: FX_DEFAULTS.master },
  { key: "bass", slider: fxBassSlider, valueEl: fxBassValueEl, defaultValue: FX_DEFAULTS.bass },
  { key: "mid", slider: fxMidSlider, valueEl: fxMidValueEl, defaultValue: FX_DEFAULTS.mid },
  { key: "treble", slider: fxTrebleSlider, valueEl: fxTrebleValueEl, defaultValue: FX_DEFAULTS.treble },
  { key: "drive", slider: fxDriveSlider, valueEl: fxDriveValueEl, defaultValue: FX_DEFAULTS.drive },
  { key: "echo", slider: fxEchoSlider, valueEl: fxEchoValueEl, defaultValue: FX_DEFAULTS.echo },
];

function setStatus(message) {
  statusEl.textContent = message;
}

function isLogNearBottom() {
  if (!logEl) {
    return true;
  }

  return logEl.scrollHeight - (logEl.scrollTop + logEl.clientHeight) <= LOG_FOLLOW_THRESHOLD_PX;
}

function flushLogBuffer() {
  logFlushRaf = 0;

  if (!logEl || logLineBuffer.length === 0) {
    return;
  }

  const shouldFollow = logAutoFollow || isLogNearBottom();
  for (const bufferedLine of logLineBuffer) {
    logLines.push(bufferedLine);
  }
  logLineBuffer.length = 0;

  if (logLines.length > maxLogLines) {
    logLines.splice(0, logLines.length - maxLogLines);
  }

  logEl.textContent = logLines.join("\n");
  if (shouldFollow) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function scheduleLogFlush() {
  if (logFlushRaf) {
    return;
  }

  logFlushRaf = window.requestAnimationFrame(flushLogBuffer);
}

function appendLog(line, stream = "stdout") {
  const prefix = stream === "stderr" ? "[ERR]" : stream === "system" ? "[SYS]" : "[OUT]";
  const timestamp = new Date().toLocaleTimeString();
  const text = String(line || "");
  const pieces = text
    .split(/\r?\n/)
    .map((item) => item.trimEnd())
    .filter((item) => item.length > 0);

  if (pieces.length === 0) {
    return;
  }

  for (const piece of pieces) {
    logLineBuffer.push(`${timestamp} ${prefix} ${piece}`);
  }

  scheduleLogFlush();
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) {
    return "--:--";
  }
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatFxValue(key, value) {
  const numeric = Number(value || 0);
  const sign = numeric > 0 ? "+" : "";

  if (key === "drive" || key === "echo") {
    return `${sign}${numeric.toFixed(2)}%`;
  }

  return `${sign}${numeric.toFixed(2)} dB`;
}

function buildDistortionCurve(amount) {
  const safe = Math.max(0, Number(amount || 0));
  if (safe <= 0.0001) {
    return null;
  }

  const samples = 2048;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;

  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + safe) * x * 20 * deg) / (Math.PI + safe * Math.abs(x));
  }

  return curve;
}

function applyFxValuesToNodes() {
  if (!audioContext || !fxNodes) {
    return;
  }

  const now = audioContext.currentTime;

  const masterDb = clamp(Number(fxValues.master || 0), -48, 48);
  const bass = clamp(Number(fxValues.bass || 0), -48, 48);
  const mid = clamp(Number(fxValues.mid || 0), -48, 48);
  const treble = clamp(Number(fxValues.treble || 0), -48, 48);
  const driveSigned = clamp(Number(fxValues.drive || 0), -400, 400);
  const echoSigned = clamp(Number(fxValues.echo || 0), -400, 400);

  const masterLinear = clamp(Math.pow(10, masterDb / 40), 0.02, 8);

  fxNodes.masterGain.gain.setTargetAtTime(masterLinear, now, 0.03);
  fxNodes.bassFilter.gain.setTargetAtTime(bass, now, 0.03);
  fxNodes.midFilter.gain.setTargetAtTime(mid, now, 0.03);
  fxNodes.trebleFilter.gain.setTargetAtTime(treble, now, 0.03);

  const driveAmount = Math.abs(driveSigned) / 400;
  if (driveAmount <= 0.0001) {
    fxNodes.drivePreGain.gain.setTargetAtTime(1, now, 0.03);
    fxNodes.drivePostGain.gain.setTargetAtTime(1, now, 0.03);
    fxNodes.driveShaper.curve = null;
  } else if (driveSigned >= 0) {
    fxNodes.drivePreGain.gain.setTargetAtTime(1 + driveAmount * 5.4, now, 0.03);
    fxNodes.drivePostGain.gain.setTargetAtTime(1 / (1 + driveAmount * 2.5), now, 0.03);
    fxNodes.driveShaper.curve = buildDistortionCurve(30 + driveAmount * 620);
  } else {
    fxNodes.drivePreGain.gain.setTargetAtTime(1 + driveAmount * 1.6, now, 0.03);
    fxNodes.drivePostGain.gain.setTargetAtTime(1 / (1 + driveAmount * 0.9), now, 0.03);
    fxNodes.driveShaper.curve = buildDistortionCurve(12 + driveAmount * 220);
  }

  const echoAmount = Math.abs(echoSigned) / 400;
  const echoFeedback = echoAmount <= 0.0001 ? 0 : clamp(0.06 + echoAmount * 0.74, 0, 0.82);
  const echoDelaySec = echoSigned >= 0 ? 0.14 + echoAmount * 0.55 : 0.05 + echoAmount * 0.24;
  const echoWetLevel = (echoSigned >= 0 ? 1 : -1) * echoAmount * 0.72;
  const echoDryLevel = clamp(1 - echoAmount * 0.36, 0.4, 1);

  fxNodes.echoDelay.delayTime.setTargetAtTime(echoDelaySec, now, 0.03);
  fxNodes.echoFeedbackGain.gain.setTargetAtTime(echoFeedback, now, 0.03);
  fxNodes.echoWetGain.gain.setTargetAtTime(echoWetLevel, now, 0.03);
  fxNodes.echoDryGain.gain.setTargetAtTime(echoDryLevel, now, 0.03);
}

function setFxValue(key, nextValue) {
  const control = fxControlDefs.find((item) => item.key === key);
  if (!control || !control.slider) {
    return;
  }

  const min = Number(control.slider.min || 0);
  const max = Number(control.slider.max || 100);
  const safeValue = clamp(Number(nextValue), min, max);

  control.slider.value = String(safeValue);
  fxValues[key] = safeValue;
  if (control.valueEl) {
    control.valueEl.textContent = formatFxValue(key, safeValue);
  }

  applyFxValuesToNodes();
}

function resetFxValue(key) {
  const control = fxControlDefs.find((item) => item.key === key);
  if (!control) {
    return;
  }

  setFxValue(key, control.defaultValue);
}

function resetAllFxValues() {
  for (const control of fxControlDefs) {
    resetFxValue(control.key);
  }
}

function syncFxFromUi() {
  for (const control of fxControlDefs) {
    if (!control.slider) {
      continue;
    }

    const raw = Number(control.slider.value);
    const fallback = Number(control.defaultValue);
    const value = Number.isFinite(raw) ? raw : fallback;
    fxValues[control.key] = value;
    if (control.valueEl) {
      control.valueEl.textContent = formatFxValue(control.key, value);
    }
  }

  applyFxValuesToNodes();
}

function setSettingsStatus(message, tone = "info") {
  if (!settingsStatusEl) {
    return;
  }

  settingsStatusEl.textContent = message;
  settingsStatusEl.dataset.tone = tone;
}

function coerceNumberFromInput(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function applySettingsToForm(settings) {
  settingsState = { ...settings };

  for (const [key, input] of settingsFieldEntries) {
    if (!input) {
      continue;
    }

    const value = settings[key];
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
      continue;
    }

    input.value = value === undefined || value === null ? "" : String(value);
  }

  updatePlaylistIdHint();
  settingsDirty = false;
}

function extractPlaylistIdFromUrl(url) {
  try {
    return new URL(String(url || "").trim()).searchParams.get("list") || "";
  } catch {
    return "";
  }
}

// When the ID field is empty, show the ID that will be taken from the URL.
function updatePlaylistIdHint() {
  const idFromUrl = extractPlaylistIdFromUrl(settingsFields.PLAYLIST_URL.value);
  settingsFields.GOOGLE_PLAYLIST_ID.placeholder = idFromUrl ? `${idFromUrl} (from URL)` : "PLxxxxxxxxxxxxxxxx";
}

function collectSettingsFromForm() {
  const payload = {
    PLAYLIST_URL: String(settingsFields.PLAYLIST_URL.value || "").trim(),
    GOOGLE_PLAYLIST_ID: String(settingsFields.GOOGLE_PLAYLIST_ID.value || "").trim(),
    GOOGLE_CLIENT_ID: String(settingsFields.GOOGLE_CLIENT_ID.value || "").trim(),
    GOOGLE_CLIENT_SECRET: String(settingsFields.GOOGLE_CLIENT_SECRET.value || "").trim(),
    GOOGLE_REFRESH_TOKEN: String(settingsFields.GOOGLE_REFRESH_TOKEN.value || "").trim(),
    BLEND_MAX_TEMPO_SHIFT_PERCENT: Number(coerceNumberFromInput(settingsFields.BLEND_MAX_TEMPO_SHIFT_PERCENT.value, 6).toFixed(3)),
    TEMPO_RAMP_BEATS: Math.round(coerceNumberFromInput(settingsFields.TEMPO_RAMP_BEATS.value, 32)),
    PLAY_AUDIO: Boolean(settingsFields.PLAY_AUDIO.checked),
    CLEAN_TEMP_AFTER_RUN: Boolean(settingsFields.CLEAN_TEMP_AFTER_RUN.checked),
    AUTO_RESET_ON_START: Boolean(settingsFields.AUTO_RESET_ON_START.checked),
  };

  return payload;
}

function handleSettingsFieldChange() {
  updatePlaylistIdHint();
  settingsDirty = true;
  setSettingsStatus("Unsaved changes. Save to apply settings for the next mix preparation.", "warn");
  refreshButtons();
}

async function loadSettingsFromBackend() {
  const result = await window.desktopDJ.getSettings();
  applySettingsToForm(result.settings || {});

  if (result.loadedEnvFiles && result.loadedEnvFiles.length) {
    setSettingsStatus("Settings loaded from .env and saved desktop profile.", "ok");
  } else {
    setSettingsStatus("No .env found. Using saved/default desktop settings.", "info");
  }

  refreshButtons();
}

async function saveSettingsFromForm() {
  const payload = collectSettingsFromForm();
  const result = await window.desktopDJ.saveSettings({ settings: payload });
  applySettingsToForm(result.settings || payload);
  setSettingsStatus("Settings saved. Next preparation run will use these values.", "ok");
  appendLog("Settings saved from desktop panel.", "system");
  refreshButtons();
}

async function resetSettingsToEnv() {
  const result = await window.desktopDJ.resetSettings();
  applySettingsToForm(result.settings || {});
  setSettingsStatus("Settings reset to .env/default values.", "ok");
  appendLog("Settings reset to .env/default values.", "system");
  refreshButtons();
}

function getSessionAudioUrl(targetSession) {
  if (!targetSession) {
    return "";
  }

  if (targetSession.audioUrl) {
    return String(targetSession.audioUrl);
  }

  if (!targetSession.outputFile) {
    return "";
  }

  const normalized = String(targetSession.outputFile).replace(/\\/g, "/");
  return encodeURI(`file:///${normalized}`);
}

function getMixDurationSec() {
  const decodedDurationSec = Number(mixAudio.duration || 0);
  if (Number.isFinite(decodedDurationSec) && decodedDurationSec > 1) {
    return decodedDurationSec;
  }

  return Number(session && session.totalDurationSec ? session.totalDurationSec : 0);
}

function clampPositionSec(positionSec) {
  const raw = Math.max(0, Number(positionSec || 0));
  const total = getMixDurationSec();
  if (!Number.isFinite(total) || total <= 1) {
    return raw;
  }

  return Math.min(raw, Math.max(0, total - 0.25));
}

function buildExportFileName() {
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `ai-dj-mix-${stamp}.wav`;
}

async function ensureVisualizerNodes() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return false;
  }

  if (!audioContext) {
    audioContext = new AudioCtx();
  }

  if (!mediaSourceNode) {
    mediaSourceNode = audioContext.createMediaElementSource(mixAudio);

    const bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = "lowshelf";
    bassFilter.frequency.value = 140;

    const midFilter = audioContext.createBiquadFilter();
    midFilter.type = "peaking";
    midFilter.frequency.value = 1200;
    midFilter.Q.value = 0.8;

    const trebleFilter = audioContext.createBiquadFilter();
    trebleFilter.type = "highshelf";
    trebleFilter.frequency.value = 6800;

    const drivePreGain = audioContext.createGain();
    const driveShaper = audioContext.createWaveShaper();
    driveShaper.oversample = "4x";
    const drivePostGain = audioContext.createGain();
    const echoDelay = audioContext.createDelay(1.5);
    const echoFeedbackGain = audioContext.createGain();
    const echoWetGain = audioContext.createGain();
    const echoDryGain = audioContext.createGain();
    const masterGain = audioContext.createGain();

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.82;

    mediaSourceNode.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(trebleFilter);
    trebleFilter.connect(drivePreGain);
    drivePreGain.connect(driveShaper);
    driveShaper.connect(drivePostGain);
    drivePostGain.connect(echoDryGain);
    drivePostGain.connect(echoDelay);

    echoDelay.connect(echoWetGain);
    echoDelay.connect(echoFeedbackGain);
    echoFeedbackGain.connect(echoDelay);

    echoDryGain.connect(masterGain);
    echoWetGain.connect(masterGain);
    masterGain.connect(analyserNode);
    analyserNode.connect(audioContext.destination);

    fxNodes = {
      bassFilter,
      midFilter,
      trebleFilter,
      drivePreGain,
      driveShaper,
      drivePostGain,
      echoDelay,
      echoFeedbackGain,
      echoWetGain,
      echoDryGain,
      masterGain,
    };

    frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
    syncFxFromUi();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return true;
}

function setRangeValue(sliderEl, value, max) {
  if (!sliderEl) {
    return;
  }

  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeValue = Math.min(Math.max(0, Number(value || 0)), safeMax);
  sliderEl.max = safeMax.toFixed(3);
  sliderEl.value = safeValue.toFixed(3);
}

function updatePositionSliders() {
  const mixDurationSec = getMixDurationSec();
  const mixPosSec = Math.max(0, Number(playback.positionSec || 0));
  const hasSessionMix = Boolean(session && session.outputFile && mixDurationSec > 0);

  if (!hasSessionMix) {
    setRangeValue(mixPositionSlider, 0, 1);
    setRangeValue(trackPositionSlider, 0, 1);
    mixPositionValueEl.textContent = "--:-- / --:--";
    trackPositionValueEl.textContent = "--:-- / --:--";
    return;
  }

  if (!isScrubbingMix) {
    setRangeValue(mixPositionSlider, mixPosSec, mixDurationSec);
  }

  const mixShown = isScrubbingMix ? Number(mixPositionSlider.value || 0) : mixPosSec;
  mixPositionValueEl.textContent = `${formatDuration(mixShown)} / ${formatDuration(mixDurationSec)}`;

  const hasCurrentTrack =
    Number.isInteger(currentIndex) && session && currentIndex >= 0 && currentIndex < session.tracks.length;
  if (!hasCurrentTrack) {
    setRangeValue(trackPositionSlider, 0, 1);
    trackPositionValueEl.textContent = "--:-- / --:--";
    return;
  }

  const currentTrack = session.tracks[currentIndex];
  const trackDurationSec = Math.max(0, Number(currentTrack.durationSec || 0));
  const trackStartSec = Math.max(0, Number(currentTrack.startSec || 0));
  const trackPosSec = clamp(mixPosSec - trackStartSec, 0, trackDurationSec);

  if (!isScrubbingTrack) {
    setRangeValue(trackPositionSlider, trackPosSec, trackDurationSec);
  }

  const trackShown = isScrubbingTrack ? Number(trackPositionSlider.value || 0) : trackPosSec;
  trackPositionValueEl.textContent = `${formatDuration(trackShown)} / ${formatDuration(trackDurationSec)}`;
}

async function seekToMixPosition(targetSec) {
  if (!session || !session.outputFile) {
    return;
  }

  const safeSec = clampPositionSec(targetSec);
  ensureAudioSource(session);
  mixAudio.currentTime = safeSec;

  if (!playback.paused) {
    await ensureVisualizerNodes();
    await mixAudio.play();
  }

  syncPlaybackFromAudio({ persist: true });
}

function queuePlaybackStatePersist() {
  if (playbackSaveTimer) {
    return;
  }

  playbackSaveTimer = setTimeout(async () => {
    playbackSaveTimer = null;
    try {
      await window.desktopDJ.playbackSaveState({
        filePath: playback.filePath || (session && session.outputFile) || "",
        positionSec: Number(playback.positionSec || 0),
        paused: Boolean(playback.paused),
        ended: Boolean(playback.ended),
      });
    } catch {
      // Ignore save-state failures in timer path.
    }
  }, 1000);
}

async function persistPlaybackStateNow() {
  if (playbackSaveTimer) {
    clearTimeout(playbackSaveTimer);
    playbackSaveTimer = null;
  }

  await window.desktopDJ.playbackSaveState({
    filePath: playback.filePath || (session && session.outputFile) || "",
    positionSec: Number(playback.positionSec || 0),
    paused: Boolean(playback.paused),
    ended: Boolean(playback.ended),
  });
}

function syncPlaybackFromAudio({ persist = true } = {}) {
  playback = {
    ...playback,
    filePath: (session && session.outputFile) || playback.filePath || "",
    positionSec: Number.isFinite(mixAudio.currentTime) ? mixAudio.currentTime : Number(playback.positionSec || 0),
    paused: Boolean(mixAudio.paused),
    ended: Boolean(mixAudio.ended),
  };

  if (playback.ended) {
    setStatus("Playback finished.");
  }

  updateTrackPanels();
  if (persist) {
    queuePlaybackStatePersist();
  }
}

function ensureAudioSource(targetSession) {
  const outputFile = String(targetSession && targetSession.outputFile ? targetSession.outputFile : "").trim();
  if (!outputFile) {
    throw new Error("Prepared mix path is missing.");
  }

  if (currentAudioFile === outputFile) {
    return;
  }

  const sourceUrl = getSessionAudioUrl(targetSession);
  if (!sourceUrl) {
    throw new Error("Prepared mix URL is missing.");
  }

  mixAudio.src = sourceUrl;
  mixAudio.load();
  currentAudioFile = outputFile;
}

async function startRendererPlayback(targetSession, startSec) {
  ensureAudioSource(targetSession);
  await ensureVisualizerNodes();

  const safeStartSec = clampPositionSec(startSec);
  try {
    if (Math.abs(Number(mixAudio.currentTime || 0) - safeStartSec) > 0.2 || mixAudio.ended) {
      mixAudio.currentTime = safeStartSec;
    }
  } catch {
    // If seek is not immediately available, play from current position.
  }

  await mixAudio.play();

  playback = {
    ...playback,
    filePath: String(targetSession.outputFile),
    positionSec: safeStartSec,
    paused: false,
    ended: false,
  };

  updateTrackPanels();
  await persistPlaybackStateNow();
  return playback;
}

function getCurrentTrackBpm() {
  if (!session || !Array.isArray(session.tracks) || !session.tracks.length) {
    return 120;
  }

  const idx = getCurrentTrackIndex();
  if (idx < 0 || idx >= session.tracks.length) {
    return 120;
  }

  const bpm = Number(session.tracks[idx].adjustedBpm || session.tracks[idx].originalBpm || 120);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
}

function resizeFlamegraphCanvas() {
  if (!flameCanvas || !flameCtx) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = flameCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));

  if (flameCanvas.width !== width || flameCanvas.height !== height) {
    flameCanvas.width = width;
    flameCanvas.height = height;
  }

  flameCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawFlamegraph(nowMs) {
  if (!flameCanvas || !flameCtx) {
    return;
  }

  resizeFlamegraphCanvas();

  const w = Math.max(1, flameCanvas.clientWidth);
  const h = Math.max(1, flameCanvas.clientHeight);
  const active = Boolean(session && !preparing && !playback.paused && !playback.ended);
  const bpm = getCurrentTrackBpm();
  const beat = (Number(playback.positionSec || 0) * bpm * Math.PI * 2) / 60;

  flameCtx.clearRect(0, 0, w, h);

  const bg = flameCtx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#0f1a26");
  bg.addColorStop(1, "#06080c");
  flameCtx.fillStyle = bg;
  flameCtx.fillRect(0, 0, w, h);

  const bars = 56;
  const gap = 2;
  const barW = Math.max(1, (w - (bars - 1) * gap) / bars);
  const timeWave = nowMs * 0.0042;

  if (flameLevels.length !== bars) {
    flameLevels = new Array(bars).fill(0);
  }

  let bassLevel = 0;
  let usedSpectrum = false;

  if (active && analyserNode && frequencyData) {
    try {
      analyserNode.getByteFrequencyData(frequencyData);
      const usableBins = Math.max(8, Math.floor(frequencyData.length * 0.9));
      const bassBins = Math.max(4, Math.floor(usableBins * 0.12));

      let bassSum = 0;
      for (let i = 0; i < bassBins; i += 1) {
        bassSum += frequencyData[i] || 0;
      }
      bassLevel = bassSum / (bassBins * 255);

      for (let i = 0; i < bars; i += 1) {
        const start = Math.floor(Math.pow(i / bars, 1.7) * usableBins);
        const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * usableBins));

        let sum = 0;
        let count = 0;
        for (let b = start; b < end && b < usableBins; b += 1) {
          sum += frequencyData[b] || 0;
          count += 1;
        }

        const raw = count > 0 ? sum / (count * 255) : 0;
        const target = 0.04 + Math.pow(raw, 0.75) * 0.96;
        flameLevels[i] = flameLevels[i] * 0.55 + target * 0.45;
      }

      usedSpectrum = true;
    } catch {
      usedSpectrum = false;
    }
  }

  for (let i = 0; i < bars; i += 1) {
    const x = i * (barW + gap);

    if (!usedSpectrum) {
      const pulse = (Math.sin(beat + i * 0.33) + 1) * 0.5;
      const wave = (Math.sin(timeWave + i * 0.71) + 1) * 0.5;
      const ripple = (Math.sin(timeWave * 1.8 + i * 0.15) + 1) * 0.5;
      const fallback = 0.1 + pulse * 0.45 + wave * 0.35 + ripple * 0.2;
      flameLevels[i] = flameLevels[i] * 0.7 + fallback * 0.3;
      bassLevel = Math.max(bassLevel, pulse * 0.65);
    }

    let ratio = flameLevels[i] || 0.04;
    if (!active) {
      ratio *= 0.22;
    }

    const barH = Math.max(2, h * Math.min(1, ratio));
    const y = h - barH;

    const grad = flameCtx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, active ? "#fff1bd" : "#6a737d");
    grad.addColorStop(0.35, active ? "#ff9f5a" : "#55606c");
    grad.addColorStop(0.72, active ? "#ff5d45" : "#39424b");
    grad.addColorStop(1, active ? "#3b0f11" : "#182028");
    flameCtx.fillStyle = grad;
    flameCtx.fillRect(x, y, barW, barH);
  }

  if (active) {
    flameCtx.strokeStyle = `rgba(255, 255, 255, ${0.08 + bassLevel * 0.12})`;
    flameCtx.lineWidth = 1;
    flameCtx.beginPath();
    flameCtx.moveTo(0, h * (0.3 - bassLevel * 0.08));
    flameCtx.lineTo(w, h * (0.3 - bassLevel * 0.08));
    flameCtx.stroke();
  }
}

function flamegraphLoop(nowMs) {
  drawFlamegraph(nowMs || performance.now());
  flameRaf = window.requestAnimationFrame(flamegraphLoop);
}

function getCurrentTrackIndex() {
  if (!session || !Array.isArray(session.tracks) || !session.tracks.length) {
    return -1;
  }

  const t = Number(playback.positionSec || 0);
  let idx = 0;
  for (let i = 0; i < session.tracks.length; i += 1) {
    if (t + 0.001 >= session.tracks[i].startSec) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}

function updateTrackPanels() {
  if (!session || !session.tracks || !session.tracks.length) {
    currentTrackEl.textContent = "No active track";
    nextTrackEl.textContent = "No next track";
    mixSummaryEl.textContent = "Prepare a mix to start playback.";
    currentIndex = -1;
    updatePositionSliders();
    refreshButtons();
    return;
  }

  currentIndex = getCurrentTrackIndex();
  const current = session.tracks[currentIndex];
  const next = currentIndex + 1 < session.tracks.length ? session.tracks[currentIndex + 1] : null;

  currentTrackEl.textContent = `${current.title} | id=${current.id} | ${formatDuration(current.durationSec)}`;
  nextTrackEl.textContent = next
    ? `${next.title} | id=${next.id} | ${formatDuration(next.durationSec)}`
    : "End of playlist";

  const durationSec = Number(session.totalDurationSec || 0);
  const stateLabel = playback.ended ? "Ended" : playback.paused ? "Paused" : "Playing";
  mixSummaryEl.textContent = `Track ${currentIndex + 1}/${session.tracks.length} | Position ${formatDuration(
    playback.positionSec
  )} / ${formatDuration(durationSec)} | ${stateLabel}`;

  updatePositionSliders();
  refreshButtons();
}

async function jumpToTrack(index) {
  if (!session || !session.tracks || !session.tracks.length) {
    return;
  }

  const safeIndex = Math.max(0, Math.min(index, session.tracks.length - 1));
  const startSec = clampPositionSec(Number(session.tracks[safeIndex].startSec || 0));
  ensureAudioSource(session);
  mixAudio.currentTime = startSec;

  if (!playback.paused) {
    await mixAudio.play();
  }

  syncPlaybackFromAudio({ persist: true });
}

function refreshButtons() {
  const hasSession = Boolean(session && session.tracks && session.tracks.length);
  const hasPlaybackSource = Boolean((session && session.outputFile) || playback.filePath);
  const canControlPlayback = hasSession && hasPlaybackSource;
  const canExportMix = Boolean(session && session.outputFile);
  const hasCurrentTrack = Boolean(hasSession && currentIndex >= 0 && currentIndex < session.tracks.length);
  const hasSettingsLoaded = Boolean(settingsState);
  const isBusy = preparing;

  prepareBtn.disabled = isBusy;
  resetBtn.disabled = isBusy;
  pauseBtn.disabled = isBusy || !canControlPlayback;
  prevBtn.disabled = isBusy || !canControlPlayback || currentIndex <= 0;
  nextBtn.disabled = isBusy || !canControlPlayback || currentIndex >= (session ? session.tracks.length - 1 : 0);
  exportBtn.disabled = isBusy || !canExportMix;
  mixPositionSlider.disabled = isBusy || !canControlPlayback;
  trackPositionSlider.disabled = isBusy || !canControlPlayback || !hasCurrentTrack;
  saveSettingsBtn.disabled = isBusy || !hasSettingsLoaded || !settingsDirty;
  resetSettingsBtn.disabled = isBusy || !hasSettingsLoaded;

  for (const [, input] of settingsFieldEntries) {
    if (!input) {
      continue;
    }
    input.disabled = isBusy;
  }

  pauseBtn.textContent = playback.paused ? "Play" : "Pause";
}

async function prepareAndPlay(options = {}) {
  if (preparing) {
    return;
  }

  preparing = true;
  refreshButtons();
  setSettingsStatus("Mix preparation is running. Settings are locked until it finishes.", "info");

  const isReset = Boolean(options.reset);
  const hasCachedSession = Boolean(session && session.outputFile);

  if (isReset) {
    setStatus("Resetting and preparing mix...");
    appendLog("Reset requested from desktop controls. Generating a new transitioned mix...", "system");
  } else if (hasCachedSession) {
    setStatus("Using cached prepared mix...");
    appendLog("Using cached prepared mix (no regeneration).", "system");
  } else {
    setStatus("No cached mix found. Preparing mix...");
    appendLog("Preparing first mix from desktop app.", "system");
  }

  try {
    let result = session;
    if (isReset || !hasCachedSession) {
      result = await window.desktopDJ.prepare({ reset: isReset });
      session = result;

      appendLog(
        `Prepared mix file (${Math.round((Number(result.outputFileSizeBytes || 0) / (1024 * 1024)) * 100) / 100} MB).`,
        "system"
      );
    }

    const startSec = isReset ? 0 : Number(playback.ended ? 0 : playback.positionSec || 0);

    const playbackState = await startRendererPlayback(result, startSec);

    playback = {
      ...playback,
      ...playbackState,
    };

    setStatus(isReset ? "Playback started from rebuilt mix." : "Playback started from cached mix.");
    appendLog(
      isReset
        ? "Playback started with newly generated mix via desktop audio engine."
        : `Playback started from cached mix via desktop audio engine at ${formatDuration(startSec)}.`,
      "system"
    );
    updateTrackPanels();
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
    appendLog(err.message, "stderr");
  } finally {
    preparing = false;
    if (settingsDirty) {
      setSettingsStatus("Preparation finished. You can edit settings now and save changes.", "warn");
    } else {
      setSettingsStatus("Preparation finished. Settings are now editable.", "ok");
    }
    refreshButtons();
  }
}

for (const [, input] of settingsFieldEntries) {
  if (!input) {
    continue;
  }

  const eventName = input.type === "checkbox" ? "change" : "input";
  input.addEventListener(eventName, handleSettingsFieldChange);
}

saveSettingsBtn.addEventListener("click", async () => {
  if (preparing || !settingsDirty) {
    return;
  }

  try {
    await saveSettingsFromForm();
  } catch (err) {
    setSettingsStatus(`Failed to save settings: ${err.message}`, "error");
    appendLog(`Settings save failed: ${err.message}`, "stderr");
  }
});

resetSettingsBtn.addEventListener("click", async () => {
  if (preparing) {
    return;
  }

  try {
    await resetSettingsToEnv();
  } catch (err) {
    setSettingsStatus(`Failed to reset settings: ${err.message}`, "error");
    appendLog(`Settings reset failed: ${err.message}`, "stderr");
  }
});

for (const control of fxControlDefs) {
  if (!control.slider) {
    continue;
  }

  control.slider.addEventListener("input", () => {
    setFxValue(control.key, Number(control.slider.value));
  });

  control.slider.addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetFxValue(control.key);
    appendLog(`FX reset: ${control.key}`, "system");
  });
}

if (resetAllFxBtn) {
  resetAllFxBtn.addEventListener("click", () => {
    resetAllFxValues();
    appendLog("FX reset: all controls", "system");
  });
}

syncFxFromUi();

if (logEl) {
  logEl.addEventListener("scroll", () => {
    logAutoFollow = isLogNearBottom();
  });
}

prepareBtn.addEventListener("click", () => prepareAndPlay({ reset: false }));
resetBtn.addEventListener("click", () => prepareAndPlay({ reset: true }));

mixPositionSlider.addEventListener("input", () => {
  isScrubbingMix = true;
  const durationSec = getMixDurationSec();
  const valueSec = Number(mixPositionSlider.value || 0);
  mixPositionValueEl.textContent = `${formatDuration(valueSec)} / ${formatDuration(durationSec)}`;
});

mixPositionSlider.addEventListener("change", async () => {
  const seekSec = Number(mixPositionSlider.value || 0);
  try {
    await seekToMixPosition(seekSec);
  } catch (err) {
    appendLog(`Mix seek failed: ${err.message}`, "stderr");
  } finally {
    isScrubbingMix = false;
    updateTrackPanels();
  }
});

trackPositionSlider.addEventListener("input", () => {
  isScrubbingTrack = true;
  const hasCurrentTrack = Boolean(session && currentIndex >= 0 && currentIndex < session.tracks.length);
  if (!hasCurrentTrack) {
    trackPositionValueEl.textContent = "--:-- / --:--";
    return;
  }

  const currentTrack = session.tracks[currentIndex];
  const valueSec = Number(trackPositionSlider.value || 0);
  trackPositionValueEl.textContent = `${formatDuration(valueSec)} / ${formatDuration(
    Number(currentTrack.durationSec || 0)
  )}`;
});

trackPositionSlider.addEventListener("change", async () => {
  const hasCurrentTrack = Boolean(session && currentIndex >= 0 && currentIndex < session.tracks.length);
  if (!hasCurrentTrack) {
    isScrubbingTrack = false;
    updateTrackPanels();
    return;
  }

  const currentTrack = session.tracks[currentIndex];
  const trackOffsetSec = Number(trackPositionSlider.value || 0);
  const mixSeekSec = Number(currentTrack.startSec || 0) + trackOffsetSec;

  try {
    await seekToMixPosition(mixSeekSec);
  } catch (err) {
    appendLog(`Track seek failed: ${err.message}`, "stderr");
  } finally {
    isScrubbingTrack = false;
    updateTrackPanels();
  }
});

exportBtn.addEventListener("click", async () => {
  if (preparing || !session || !session.outputFile) {
    return;
  }

  try {
    setStatus("Choose where to export the generated mix...");
    const result = await window.desktopDJ.exportMix({
      filePath: session.outputFile,
      defaultName: buildExportFileName(),
    });

    if (!result || result.canceled) {
      setStatus("Export canceled.");
      appendLog("Mix export canceled.", "system");
      return;
    }

    const sizeMb = Math.round((Number(result.sizeBytes || 0) / (1024 * 1024)) * 100) / 100;
    setStatus("Mix exported successfully.");
    appendLog(`Mix exported: ${result.filePath} (${sizeMb} MB)`, "system");
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
    appendLog(`Export failed: ${err.message}`, "stderr");
  } finally {
    refreshButtons();
  }
});

pauseBtn.addEventListener("click", async () => {
  if (preparing || !session) {
    return;
  }

  try {
    ensureAudioSource(session);
    if (mixAudio.paused || mixAudio.ended) {
      await ensureVisualizerNodes();
      if (mixAudio.ended) {
        mixAudio.currentTime = clampPositionSec(playback.positionSec || 0);
      }
      await mixAudio.play();
    } else {
      mixAudio.pause();
    }

    syncPlaybackFromAudio({ persist: true });
  } catch (err) {
    appendLog(`Pause/play failed: ${err.message}`, "stderr");
  }
});

prevBtn.addEventListener("click", () => {
  if (preparing || currentIndex <= 0) {
    return;
  }
  jumpToTrack(currentIndex - 1).catch((err) => {
    appendLog(`Prev track failed: ${err.message}`, "stderr");
  });
});

nextBtn.addEventListener("click", () => {
  if (preparing || !session || currentIndex >= session.tracks.length - 1) {
    return;
  }
  jumpToTrack(currentIndex + 1).catch((err) => {
    appendLog(`Next track failed: ${err.message}`, "stderr");
  });
});

window.desktopDJ.onLog((payload) => {
  appendLog(payload.line, payload.stream);
});

window.desktopDJ.onStatus((payload) => {
  if (payload && payload.message) {
    setStatus(payload.message);
  }
});

mixAudio.addEventListener("playing", () => {
  ensureVisualizerNodes().catch(() => {
    // no-op
  });
  syncPlaybackFromAudio({ persist: true });
});
mixAudio.addEventListener("pause", () => syncPlaybackFromAudio({ persist: true }));
mixAudio.addEventListener("timeupdate", () => syncPlaybackFromAudio({ persist: true }));
mixAudio.addEventListener("ended", () => syncPlaybackFromAudio({ persist: true }));
mixAudio.addEventListener("error", () => {
  const mediaError = mixAudio.error;
  if (!mediaError) {
    appendLog("Audio playback error occurred.", "stderr");
    return;
  }

  appendLog(`Audio playback error (code=${mediaError.code}).`, "stderr");
});

window.desktopDJ.onPlaybackState((payload) => {
  if (!payload) {
    return;
  }

  // Renderer audio is the source of truth while it is active.
  if (!mixAudio.paused || (!playback.paused && !playback.ended)) {
    return;
  }

  playback = {
    ...playback,
    ...payload,
  };

  if (payload.ended) {
    setStatus("Playback finished.");
  }

  updateTrackPanels();
});

(async () => {
  if (flameCanvas && flameCtx) {
    resizeFlamegraphCanvas();
    window.addEventListener("resize", () => {
      resizeFlamegraphCanvas();
    });
    flameRaf = window.requestAnimationFrame(flamegraphLoop);
  }

  setStatus("Desktop app ready. Loading settings and cached session...");

  try {
    await loadSettingsFromBackend();
  } catch (err) {
    setSettingsStatus(`Could not load settings: ${err.message}`, "error");
    appendLog(`Settings load failed: ${err.message}`, "stderr");
  }

  const latestSession = await window.desktopDJ.getLatestSession();
  const latestPlayback = await window.desktopDJ.playbackGetState();

  if (latestSession && latestSession.outputFile) {
    session = latestSession;
    appendLog("Loaded latest prepared mix from cache.", "system");

    try {
      ensureAudioSource(session);
    } catch (err) {
      appendLog(`Audio source load warning: ${err.message}`, "stderr");
    }
  }

  if (latestPlayback) {
    playback = {
      ...playback,
      ...latestPlayback,
    };
  }

  if (session && session.outputFile) {
    if (!playback.filePath || playback.filePath !== session.outputFile) {
      playback.filePath = session.outputFile;
      playback.positionSec = 0;
      playback.paused = true;
      playback.ended = false;
    }

    try {
      ensureAudioSource(session);
      mixAudio.currentTime = clampPositionSec(playback.positionSec || 0);
    } catch {
      // Delay seek until playback is explicitly started.
    }

    updateTrackPanels();

    if (!playback.paused && !playback.ended) {
      appendLog(`Resuming playback from ${formatDuration(playback.positionSec)}.`, "system");
      await prepareAndPlay({ reset: false });
    } else if (playback.ended) {
      setStatus("Cached mix loaded. Playback ended previously. Press Play to start from beginning.");
    } else {
      setStatus(`Cached mix loaded. Press Play to continue from ${formatDuration(playback.positionSec)}.`);
    }
  } else {
    await prepareAndPlay({ reset: false });
  }
})();

window.addEventListener("beforeunload", () => {
  if (flameRaf) {
    window.cancelAnimationFrame(flameRaf);
    flameRaf = 0;
  }

  if (logFlushRaf) {
    window.cancelAnimationFrame(logFlushRaf);
    logFlushRaf = 0;
  }

  if (logLineBuffer.length > 0) {
    flushLogBuffer();
  }

  try {
    mixAudio.pause();
  } catch {
    // no-op
  }

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {
      // no-op
    });
  }

  playback = {
    ...playback,
    positionSec: Number.isFinite(mixAudio.currentTime) ? mixAudio.currentTime : Number(playback.positionSec || 0),
    paused: true,
    ended: Boolean(mixAudio.ended),
  };

  persistPlaybackStateNow().catch(() => {
    // no-op
  });
});
