const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const dotenv = require("dotenv");

const ROOT_DIR = path.resolve(__dirname, "..");
const DJ_SCRIPT = path.join(ROOT_DIR, "src", "ai-dj.js");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Apps opened from Finder/Dock get a minimal PATH without Homebrew, so
// ffmpeg / ffprobe / ffplay / yt-dlp would not be found.
if (process.platform === "darwin") {
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
  const current = String(process.env.PATH || "").split(":").filter(Boolean);
  process.env.PATH = [...extraPaths.filter((p) => !current.includes(p)), ...current].join(":");
}

let mainWindow = null;
let activeDjProcess = null;
let ffplayProcess = null;
let playbackTicker = null;
let playbackPersistTimer = null;
const LOG_STREAMS = ["stdout", "stderr", "system"];
const LOG_BUFFER_FLUSH_AT = 180;
const logStreamBuffers = {
  stdout: "",
  stderr: "",
  system: "",
};
const PLAYBACK_STATE_VERSION = 1;
let playbackState = {
  filePath: "",
  positionSec: 0,
  startOffsetSec: 0,
  startedAtMs: 0,
  paused: true,
  ended: false,
};

const DESKTOP_SETTINGS_VERSION = 1;
const DESKTOP_SETTING_DEFINITIONS = [
  { key: "PLAYLIST_URL", type: "string", defaultValue: "" },
  { key: "GOOGLE_PLAYLIST_ID", type: "string", defaultValue: "" },
  { key: "GOOGLE_CLIENT_ID", type: "string", defaultValue: "" },
  { key: "GOOGLE_CLIENT_SECRET", type: "string", defaultValue: "" },
  { key: "GOOGLE_REFRESH_TOKEN", type: "string", defaultValue: "" },
  { key: "BLEND_MAX_TEMPO_SHIFT_PERCENT", type: "number", defaultValue: 6, min: 0, max: 12 },
  { key: "TEMPO_RAMP_BEATS", type: "int", defaultValue: 32, min: 4, max: 128 },
  { key: "PLAY_AUDIO", type: "bool", defaultValue: true },
  { key: "CLEAN_TEMP_AFTER_RUN", type: "bool", defaultValue: false },
  { key: "AUTO_RESET_ON_START", type: "bool", defaultValue: false },
];

function parseBooleanSetting(rawValue, fallbackValue) {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }

  if (typeof rawValue === "number") {
    return rawValue !== 0;
  }

  const text = String(rawValue ?? "").trim().toLowerCase();
  if (!text) {
    return fallbackValue;
  }

  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }

  return fallbackValue;
}

function normalizeSettingValue(definition, rawValue, fallbackValue) {
  if (definition.type === "bool") {
    return parseBooleanSetting(rawValue, Boolean(fallbackValue));
  }

  if (definition.type === "string") {
    if (rawValue === undefined || rawValue === null) {
      return String(fallbackValue ?? "").trim();
    }
    return String(rawValue).trim();
  }

  if (definition.type === "int") {
    const parsed = Number.parseInt(String(rawValue), 10);
    const fallback = Number.parseInt(String(fallbackValue), 10);
    const safe = Number.isFinite(parsed) ? parsed : Number.isFinite(fallback) ? fallback : Number(definition.defaultValue);
    const min = Number(definition.min ?? safe);
    const max = Number(definition.max ?? safe);
    return Math.round(Math.max(min, Math.min(max, safe)));
  }

  if (definition.type === "number") {
    const parsed = Number.parseFloat(String(rawValue));
    const fallback = Number.parseFloat(String(fallbackValue));
    const safe = Number.isFinite(parsed)
      ? parsed
      : Number.isFinite(fallback)
        ? fallback
        : Number(definition.defaultValue);
    const min = Number(definition.min ?? safe);
    const max = Number(definition.max ?? safe);
    return Number(Math.max(min, Math.min(max, safe)).toFixed(3));
  }

  return rawValue;
}

function buildDefaultDesktopSettings() {
  const settings = {};
  for (const definition of DESKTOP_SETTING_DEFINITIONS) {
    settings[definition.key] = definition.defaultValue;
  }
  return settings;
}

function normalizeDesktopSettingsFromInput(inputValues = {}, fallbackValues = {}) {
  const settings = {};
  for (const definition of DESKTOP_SETTING_DEFINITIONS) {
    const fallbackValue = Object.prototype.hasOwnProperty.call(fallbackValues, definition.key)
      ? fallbackValues[definition.key]
      : definition.defaultValue;

    const hasInputValue = Object.prototype.hasOwnProperty.call(inputValues, definition.key);
    const rawValue = hasInputValue ? inputValues[definition.key] : fallbackValue;
    settings[definition.key] = normalizeSettingValue(definition, rawValue, fallbackValue);
  }

  return settings;
}

function buildDesktopSettingsFromEnvValues(envValues) {
  const defaults = buildDefaultDesktopSettings();
  return normalizeDesktopSettingsFromInput(envValues || {}, defaults);
}

function getDesktopSettingsFilePath() {
  return resolveRuntimePaths().desktopSettingsFile;
}

function loadDesktopSettingsSync() {
  const dotenvData = loadDotenvFromCandidates();
  const envSettings = buildDesktopSettingsFromEnvValues(dotenvData.values);
  const settingsFilePath = getDesktopSettingsFilePath();

  let persistedValues = {};
  if (fs.existsSync(settingsFilePath)) {
    try {
      const raw = fs.readFileSync(settingsFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        persistedValues = parsed.values && typeof parsed.values === "object" ? parsed.values : parsed;
      }
    } catch {
      persistedValues = {};
    }
  }

  const mergedSettings = normalizeDesktopSettingsFromInput(persistedValues, envSettings);
  return {
    settings: mergedSettings,
    loadedEnvFiles: dotenvData.loadedFrom,
    envCandidates: dotenvData.candidates,
    envValues: dotenvData.values,
    settingsFilePath,
  };
}

function persistDesktopSettingsSync(settings) {
  const filePath = getDesktopSettingsFilePath();
  const payload = {
    version: DESKTOP_SETTINGS_VERSION,
    updatedAt: new Date().toISOString(),
    values: settings,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function resetDesktopSettingsSync() {
  const filePath = getDesktopSettingsFilePath();
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }

  return loadDesktopSettingsSync();
}

function buildSettingsEnvOverrides(settings) {
  const overrides = {};
  for (const definition of DESKTOP_SETTING_DEFINITIONS) {
    const value = settings[definition.key];
    if (definition.type === "bool") {
      overrides[definition.key] = value ? "true" : "false";
      continue;
    }

    overrides[definition.key] = String(value ?? "");
  }

  return overrides;
}

function resolvePortableExecutableDir() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (portableDir) {
    return path.resolve(portableDir);
  }

  const portableFile = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (portableFile) {
    return path.dirname(path.resolve(portableFile));
  }

  return null;
}

function resolveExecutableBaseDir() {
  return resolvePortableExecutableDir() || path.dirname(process.execPath);
}

function ensurePortableWorkingDirectory() {
  const preferredDir = resolveExecutableBaseDir();
  if (!preferredDir) {
    return;
  }

  try {
    process.chdir(preferredDir);
  } catch {
    // Keep existing cwd if not changeable.
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 900,
    minHeight: 640,
    autoHideMenuBar: true,
    title: "AJING - AI DJ Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function normalizeLogStream(stream) {
  if (stream === "stderr") {
    return "stderr";
  }
  if (stream === "system") {
    return "system";
  }
  return "stdout";
}

function emitLogLine(stream, rawLine) {
  const line = String(rawLine || "").trimEnd();
  if (!line) {
    return;
  }

  broadcast("dj:log", {
    stream,
    line,
    at: new Date().toISOString(),
  });
}

function flushLogBuffer(stream) {
  const streamKey = normalizeLogStream(stream);
  const pending = String(logStreamBuffers[streamKey] || "").trimEnd();
  if (!pending) {
    return;
  }

  logStreamBuffers[streamKey] = "";
  emitLogLine(streamKey, pending);
}

function pushLog(stream, rawText) {
  const streamKey = normalizeLogStream(stream);
  const text = String(rawText || "");
  if (!text) {
    return;
  }

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const merged = `${logStreamBuffers[streamKey]}${normalized}`;
  const lines = merged.split("\n");
  logStreamBuffers[streamKey] = lines.pop() || "";

  for (const line of lines) {
    emitLogLine(streamKey, line);
  }

  if (logStreamBuffers[streamKey].length >= LOG_BUFFER_FLUSH_AT) {
    flushLogBuffer(streamKey);
  }
}

function resolveFfplayBin() {
  const dotenvData = loadDotenvFromCandidates();
  const fromEnvFile = String(dotenvData.values.FFPLAY_BIN || "").trim();
  const fromProcess = String(process.env.FFPLAY_BIN || "").trim();

  const ffmpegFromEnvFile = String(dotenvData.values.FFMPEG_BIN || "").trim();
  const ffmpegFromProcess = String(process.env.FFMPEG_BIN || "").trim();
  const ffmpegValue = ffmpegFromEnvFile || ffmpegFromProcess;

  const exeBase = resolveExecutableBaseDir();
  const wingetLink = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffplay.exe")
    : "";
  const chocoRealBin = "C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffplay.exe";
  const chocoBin = "C:\\ProgramData\\chocolatey\\bin\\ffplay.exe";

  const candidates = [
    // Prefer explicit binary paths first; bare command names are tried last.
    wingetLink,
    chocoRealBin,
    chocoBin,
    path.join(exeBase, "ffplay.exe"),
    ffmpegValue ? ffmpegValue.replace(/ffmpeg(?:\.exe)?$/i, "ffplay.exe") : "",
    fromEnvFile,
    fromProcess,
    "ffplay",
  ];

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) {
      continue;
    }

    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}

function buildFfplayEnv() {
  const env = { ...process.env };
  const configuredAudioDriver = String(env.SDL_AUDIODRIVER || "").trim().toLowerCase();

  // Some environments inherit SDL_AUDIODRIVER=dummy, which makes ffplay silent.
  if (process.platform === "win32" && (!configuredAudioDriver || configuredAudioDriver === "dummy")) {
    env.SDL_AUDIODRIVER = "wasapi";
  }

  return env;
}

function getPlaybackPositionSec() {
  if (playbackState.paused) {
    return Number(playbackState.positionSec || 0);
  }

  const elapsed = Math.max(0, (Date.now() - Number(playbackState.startedAtMs || Date.now())) / 1000);
  return Number(playbackState.startOffsetSec || 0) + elapsed;
}

function buildPlaybackPayload() {
  return {
    filePath: playbackState.filePath,
    positionSec: Number(getPlaybackPositionSec().toFixed(3)),
    paused: Boolean(playbackState.paused),
    ended: Boolean(playbackState.ended),
  };
}

function emitPlaybackState() {
  broadcast("dj:playback", {
    ...buildPlaybackPayload(),
    at: new Date().toISOString(),
  });
  queuePersistPlaybackState();
}

function stopPlaybackTicker() {
  if (!playbackTicker) {
    return;
  }
  clearInterval(playbackTicker);
  playbackTicker = null;
}

function getPlaybackStateFilePath() {
  return resolveRuntimePaths().playbackStateFile;
}

function buildPersistedPlaybackState() {
  return {
    version: PLAYBACK_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    filePath: String(playbackState.filePath || ""),
    positionSec: Number(getPlaybackPositionSec().toFixed(3)),
    paused: Boolean(playbackState.paused),
    ended: Boolean(playbackState.ended),
  };
}

async function persistPlaybackState() {
  const payload = buildPersistedPlaybackState();
  const filePath = getPlaybackStateFilePath();

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function persistPlaybackStateSync() {
  const payload = buildPersistedPlaybackState();
  const filePath = getPlaybackStateFilePath();

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function queuePersistPlaybackState() {
  if (playbackPersistTimer) {
    return;
  }

  playbackPersistTimer = setTimeout(async () => {
    playbackPersistTimer = null;
    try {
      await persistPlaybackState();
    } catch {
      // Ignore persistence errors in background tick path.
    }
  }, 200);
}

function stopPlaybackPersistTimer() {
  if (!playbackPersistTimer) {
    return;
  }

  clearTimeout(playbackPersistTimer);
  playbackPersistTimer = null;
}

async function hydratePlaybackStateFromDisk() {
  const filePath = getPlaybackStateFilePath();
  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);

    playbackState.filePath = String(parsed.filePath || "");
    playbackState.positionSec = Math.max(0, Number(parsed.positionSec || 0));
    playbackState.startOffsetSec = playbackState.positionSec;
    playbackState.startedAtMs = Date.now();
    playbackState.paused = Boolean(parsed.paused);
    playbackState.ended = Boolean(parsed.ended);
  } catch {
    // Keep default in-memory state if parsing/loading fails.
  }
}

function startPlaybackTicker() {
  stopPlaybackTicker();
  playbackTicker = setInterval(() => {
    emitPlaybackState();
  }, 500);
}

function stopFfplayProcess() {
  if (!ffplayProcess) {
    return;
  }

  try {
    ffplayProcess.__intentionalStop = true;
    ffplayProcess.kill();
  } catch {
    // no-op
  }
}

function pauseFfplayPlayback() {
  if (!ffplayProcess) {
    playbackState.paused = true;
    emitPlaybackState();
    return buildPlaybackPayload();
  }

  playbackState.positionSec = getPlaybackPositionSec();
  playbackState.startOffsetSec = playbackState.positionSec;
  playbackState.paused = true;
  playbackState.ended = false;

  stopPlaybackTicker();
  stopFfplayProcess();
  emitPlaybackState();
  return buildPlaybackPayload();
}

async function startFfplayPlayback(filePath, startSec) {
  const resolvedPath = path.resolve(filePath);
  const stat = await fsp.stat(resolvedPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Playback file missing or empty: ${resolvedPath}`);
  }

  stopPlaybackTicker();
  stopFfplayProcess();

  const ffplayCandidates = resolveFfplayBin();
  if (!ffplayCandidates.length) {
    throw new Error("No ffplay candidate binary found. Set FFPLAY_BIN in .env.");
  }

  const seek = Math.max(0, Number(startSec || 0));
  const args = [
    "-nodisp",
    "-autoexit",
    "-vn",
    "-loglevel",
    "error",
    "-volume",
    "100",
    "-ss",
    seek.toFixed(3),
    resolvedPath,
  ];
  const ffplayEnv = buildFfplayEnv();

  let lastError = null;
  for (const ffplayBin of ffplayCandidates) {
    if (path.isAbsolute(ffplayBin) && !fs.existsSync(ffplayBin)) {
      pushLog("stderr", `[ffplay] skipping missing candidate: ${ffplayBin}`);
      continue;
    }

    pushLog("stdout", `[ffplay] trying candidate: ${ffplayBin}`);

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        let stderrTail = [];

        const child = spawn(ffplayBin, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: ffplayEnv,
          shell: false,
          windowsHide: false,
        });

        ffplayProcess = child;

        const startupTimer = setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          pushLog(
            "stdout",
            `[ffplay] started using ${ffplayBin} (SDL_AUDIODRIVER=${String(ffplayEnv.SDL_AUDIODRIVER || "default")})`
          );
          resolve();
        }, 1200);

        child.stdout.on("data", (chunk) => {
          pushLog("stdout", `[ffplay] ${chunk.toString("utf8")}`);
        });

        child.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          pushLog("stderr", `[ffplay] ${text}`);

          const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          stderrTail.push(...lines);
          if (stderrTail.length > 8) {
            stderrTail = stderrTail.slice(stderrTail.length - 8);
          }
        });

        child.on("error", (err) => {
          clearTimeout(startupTimer);
          if (ffplayProcess === child) {
            ffplayProcess = null;
          }
          if (settled) {
            return;
          }
          settled = true;
          reject(new Error(`Failed to start ffplay (${ffplayBin}): ${err.message}`));
        });

        child.on("close", (code, signal) => {
          clearTimeout(startupTimer);
          if (ffplayProcess === child) {
            ffplayProcess = null;
          }

          const intentional = Boolean(child.__intentionalStop);
          if (!settled) {
            settled = true;
            if (intentional) {
              reject(new Error("ffplay was stopped before startup completed."));
              return;
            }

            const tail = stderrTail.length ? ` | ${stderrTail.join(" | ")}` : "";
            reject(new Error(`ffplay exited before playback start (code=${code}, signal=${signal || "none"})${tail}`));
            return;
          }

          if (intentional) {
            return;
          }

          playbackState.positionSec = getPlaybackPositionSec();
          playbackState.startOffsetSec = playbackState.positionSec;
          playbackState.paused = true;
          playbackState.ended = true;
          stopPlaybackTicker();
          emitPlaybackState();
        });
      });

      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      pushLog("stderr", `[ffplay] candidate failed: ${ffplayBin} -> ${err.message}`);
      stopFfplayProcess();
      ffplayProcess = null;
    }
  }

  if (lastError) {
    throw new Error(
      `Unable to start playback with ffplay. Tried: ${ffplayCandidates.join(", ")}. Last error: ${lastError.message}`
    );
  }

  playbackState.filePath = resolvedPath;
  playbackState.positionSec = seek;
  playbackState.startOffsetSec = seek;
  playbackState.startedAtMs = Date.now();
  playbackState.paused = false;
  playbackState.ended = false;

  startPlaybackTicker();
  emitPlaybackState();
  return buildPlaybackPayload();
}

async function resumeFfplayPlayback() {
  if (!playbackState.filePath) {
    throw new Error("No prepared playback file. Prepare the mix first.");
  }

  return startFfplayPlayback(playbackState.filePath, playbackState.positionSec || 0);
}

async function seekFfplayPlayback(startSec) {
  if (!playbackState.filePath) {
    throw new Error("No prepared playback file. Prepare the mix first.");
  }

  return startFfplayPlayback(playbackState.filePath, Math.max(0, Number(startSec || 0)));
}

async function toggleFfplayPause() {
  if (!playbackState.filePath) {
    throw new Error("No prepared playback file. Prepare the mix first.");
  }

  if (playbackState.paused) {
    return resumeFfplayPlayback();
  }

  return pauseFfplayPlayback();
}

function resolveEnvCandidatePaths() {
  const exeDir = path.dirname(process.execPath);
  const portableDir = resolvePortableExecutableDir();
  const candidates = [
    process.env.DJ_ENV_PATH ? path.resolve(process.env.DJ_ENV_PATH) : null,
    path.join(ROOT_DIR, ".env"),
    portableDir ? path.join(portableDir, ".env") : null,
    portableDir ? path.resolve(portableDir, "..", ".env") : null,
    portableDir ? path.resolve(portableDir, "..", "..", ".env") : null,
    path.join(exeDir, ".env"),
    path.resolve(exeDir, "..", ".env"),
    path.resolve(exeDir, "..", "..", ".env"),
    // macOS: exeDir is <App>.app/Contents/MacOS — look next to the .app too.
    process.platform === "darwin" ? path.resolve(exeDir, "..", "..", "..", ".env") : null,
    app.isPackaged ? path.join(app.getPath("userData"), ".env") : null,
    path.join(process.cwd(), ".env"),
  ];

  const seen = new Set();
  const unique = [];

  for (const item of candidates) {
    if (!item) {
      continue;
    }

    const normalized = path.resolve(item);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function loadDotenvFromCandidates() {
  const candidates = resolveEnvCandidatePaths();

  const merged = {};
  const loadedFrom = [];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    try {
      const raw = fs.readFileSync(envPath, "utf8");
      Object.assign(merged, dotenv.parse(raw));
      loadedFrom.push(envPath);
    } catch {
      // Ignore malformed files in candidates other than primary runtime source.
    }
  }

  return {
    values: merged,
    loadedFrom,
    candidates,
  };
}

function resolveRuntimePaths() {
  if (!app.isPackaged) {
    const cacheDir = path.join(ROOT_DIR, ".cache");
    return {
      cwd: ROOT_DIR,
      cacheDir,
      stateFile: path.join(cacheDir, "dj-state.json"),
      outputFile: path.join(cacheDir, "output", "ai-dj-mix.wav"),
      sessionFile: path.join(cacheDir, "output", "ai-dj-session.json"),
      playbackStateFile: path.join(cacheDir, "output", "desktop-playback-state.json"),
      desktopSettingsFile: path.join(cacheDir, "desktop-settings.json"),
    };
  }

  const baseDir = path.join(app.getPath("userData"), "runtime");
  const cacheDir = path.join(baseDir, ".cache");
  return {
    cwd: resolveExecutableBaseDir(),
    cacheDir,
    stateFile: path.join(cacheDir, "dj-state.json"),
    outputFile: path.join(cacheDir, "output", "ai-dj-mix.wav"),
    sessionFile: path.join(cacheDir, "output", "ai-dj-session.json"),
    playbackStateFile: path.join(cacheDir, "output", "desktop-playback-state.json"),
    desktopSettingsFile: path.join(cacheDir, "desktop-settings.json"),
  };
}

function buildChildEnv() {
  const runtime = resolveRuntimePaths();
  const settingsData = loadDesktopSettingsSync();
  const settingOverrides = buildSettingsEnvOverrides(settingsData.settings);

  const env = {
    ...process.env,
    ...settingsData.envValues,
    ...settingOverrides,
    ELECTRON_RUN_AS_NODE: "1",
    PLAY_AUDIO: "false",
    MARK_PLAYED_WHEN_NOT_PLAYING: "false",
    DISABLE_SPINNERS: "true",
    CACHE_DIR: runtime.cacheDir,
    STATE_FILE: runtime.stateFile,
    OUTPUT_FILE: runtime.outputFile,
    DJ_SESSION_FILE: runtime.sessionFile,
  };

  return {
    env,
    runtime,
    loadedEnvFiles: settingsData.loadedEnvFiles,
    envCandidates: settingsData.envCandidates,
  };
}

async function readSessionFile() {
  const runtime = resolveRuntimePaths();
  const raw = await fsp.readFile(runtime.sessionFile, "utf8");
  const session = JSON.parse(raw);

  const outputStat = await fsp.stat(session.outputFile);
  if (!outputStat.isFile() || outputStat.size <= 0) {
    throw new Error(`Output mix file is missing or empty: ${session.outputFile}`);
  }

  return {
    ...session,
    audioUrl: pathToFileURL(session.outputFile).href,
    outputFileSizeBytes: outputStat.size,
  };
}

function runDjPreparation({ reset }) {
  if (activeDjProcess) {
    throw new Error("A DJ preparation process is already running.");
  }

  const childConfig = buildChildEnv();

  try {
    fs.rmSync(path.dirname(childConfig.runtime.outputFile), { recursive: true, force: true });
  } catch {
    // Best-effort cache cleanup only.
  }

  const hasPlaylistSource =
    String(childConfig.env.PLAYLIST_URL || "").trim().length > 0 ||
    String(childConfig.env.GOOGLE_PLAYLIST_ID || "").trim().length > 0;

  if (!hasPlaylistSource) {
    const loadedLine = childConfig.loadedEnvFiles.length
      ? `Loaded .env file(s): ${childConfig.loadedEnvFiles.join(", ")}`
      : "No .env file was found in the searched locations.";
    const candidates = childConfig.envCandidates.map((p) => `- ${p}`).join("\n");

    throw new Error(
      `Missing PLAYLIST_URL or GOOGLE_PLAYLIST_ID in .env.\n${loadedLine}\nSearched locations:\n${candidates}`
    );
  }

  const args = [DJ_SCRIPT];
  if (reset) {
    args.push("--reset");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: childConfig.runtime.cwd,
      env: childConfig.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    activeDjProcess = child;
    broadcast("dj:status", {
      state: "running",
      message: reset ? "Resetting state and preparing mix..." : "Preparing mix...",
      at: new Date().toISOString(),
    });

    child.stdout.on("data", (chunk) => pushLog("stdout", chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => pushLog("stderr", chunk.toString("utf8")));

    child.on("error", (err) => {
      for (const stream of LOG_STREAMS) {
        flushLogBuffer(stream);
      }
      activeDjProcess = null;
      reject(err);
    });

    child.on("close", async (code) => {
      for (const stream of LOG_STREAMS) {
        flushLogBuffer(stream);
      }
      activeDjProcess = null;

      if (code !== 0) {
        const message = `DJ preparation failed with exit code ${code}.`;
        broadcast("dj:status", {
          state: "error",
          message,
          at: new Date().toISOString(),
        });
        reject(new Error(message));
        return;
      }

      try {
        const session = await readSessionFile();
        playbackState.filePath = session.outputFile;
        playbackState.positionSec = 0;
        playbackState.startOffsetSec = 0;
        playbackState.startedAtMs = 0;
        playbackState.paused = true;
        playbackState.ended = false;
        emitPlaybackState();
        await persistPlaybackState();

        broadcast("dj:status", {
          state: "ready",
          message: "Mix is ready. Starting playback controls.",
          at: new Date().toISOString(),
        });
        resolve(session);
      } catch (err) {
        reject(new Error(`DJ run succeeded but session file could not be read: ${err.message}`));
      }
    });
  });
}

ipcMain.handle("dj:get-settings", async () => {
  const data = loadDesktopSettingsSync();
  return {
    settings: data.settings,
    loadedEnvFiles: data.loadedEnvFiles,
    settingsFilePath: data.settingsFilePath,
  };
});

ipcMain.handle("dj:save-settings", async (_event, options = {}) => {
  if (activeDjProcess) {
    throw new Error("Cannot change settings while mix preparation is in progress.");
  }

  const current = loadDesktopSettingsSync();
  const incoming = options && typeof options.settings === "object" ? options.settings : {};
  const nextSettings = normalizeDesktopSettingsFromInput(incoming, current.settings);

  persistDesktopSettingsSync(nextSettings);

  return {
    settings: nextSettings,
    settingsFilePath: current.settingsFilePath,
  };
});

ipcMain.handle("dj:reset-settings", async () => {
  if (activeDjProcess) {
    throw new Error("Cannot reset settings while mix preparation is in progress.");
  }

  const data = resetDesktopSettingsSync();
  return {
    settings: data.settings,
    loadedEnvFiles: data.loadedEnvFiles,
    settingsFilePath: data.settingsFilePath,
  };
});

ipcMain.handle("dj:prepare", async (_event, options = {}) => {
  const reset = Boolean(options && options.reset);
  return runDjPreparation({ reset });
});

ipcMain.handle("dj:get-latest-session", async () => {
  try {
    return await readSessionFile();
  } catch {
    return null;
  }
});

ipcMain.handle("dj:stop-preparation", async () => {
  if (!activeDjProcess) {
    return { stopped: false };
  }

  try {
    activeDjProcess.kill();
    activeDjProcess = null;
    return { stopped: true };
  } catch {
    return { stopped: false };
  }
});

ipcMain.handle("dj:playback-start", async (_event, options = {}) => {
  const filePath = String(options.filePath || playbackState.filePath || "").trim();
  const startSec = Number(options.startSec || 0);
  if (!filePath) {
    throw new Error("No playback file path provided.");
  }

  return startFfplayPlayback(filePath, startSec);
});

ipcMain.handle("dj:playback-toggle-pause", async () => {
  return toggleFfplayPause();
});

ipcMain.handle("dj:playback-seek", async (_event, options = {}) => {
  return seekFfplayPlayback(Number(options.startSec || 0));
});

ipcMain.handle("dj:playback-stop", async () => {
  stopPlaybackTicker();
  stopFfplayProcess();
  playbackState.paused = true;
  playbackState.positionSec = getPlaybackPositionSec();
  playbackState.startOffsetSec = playbackState.positionSec;
  emitPlaybackState();
  return buildPlaybackPayload();
});

ipcMain.handle("dj:playback-get-state", async () => {
  return buildPlaybackPayload();
});

ipcMain.handle("dj:playback-save-state", async (_event, options = {}) => {
  const filePath = String(options.filePath || playbackState.filePath || "").trim();
  const positionSec = Math.max(0, Number(options.positionSec || 0));
  const paused = Boolean(options.paused);
  const ended = Boolean(options.ended);

  playbackState.filePath = filePath;
  playbackState.positionSec = positionSec;
  playbackState.startOffsetSec = positionSec;
  playbackState.startedAtMs = Date.now();
  playbackState.paused = paused;
  playbackState.ended = ended;

  emitPlaybackState();
  await persistPlaybackState();
  return buildPlaybackPayload();
});

ipcMain.handle("dj:export-mix", async (_event, options = {}) => {
  const sourcePath = String(options.filePath || "").trim();
  if (!sourcePath) {
    throw new Error("No generated mix file path was provided.");
  }

  const resolvedSource = path.resolve(sourcePath);
  let sourceStat;
  try {
    sourceStat = await fsp.stat(resolvedSource);
  } catch {
    throw new Error(`Mix file not found: ${resolvedSource}`);
  }

  if (!sourceStat.isFile() || sourceStat.size <= 0) {
    throw new Error(`Mix file is missing or empty: ${resolvedSource}`);
  }

  const defaultFileName = String(options.defaultName || path.basename(resolvedSource) || "ai-dj-mix.wav")
    .replace(/[<>:\"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  const safeFileName = defaultFileName.toLowerCase().endsWith(".wav")
    ? defaultFileName
    : `${defaultFileName || "ai-dj-mix"}.wav`;

  let defaultDir = "";
  try {
    defaultDir = app.getPath("music");
  } catch {
    defaultDir = "";
  }

  if (!defaultDir || !fs.existsSync(defaultDir)) {
    defaultDir = resolveExecutableBaseDir();
  }

  const saveResult = await dialog.showSaveDialog({
    title: "Export Generated Mix",
    defaultPath: path.join(defaultDir, safeFileName),
    filters: [
      { name: "WAV Audio", extensions: ["wav"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true, exported: false };
  }

  let resolvedTarget = path.resolve(saveResult.filePath);
  if (!resolvedTarget.toLowerCase().endsWith(".wav")) {
    resolvedTarget = `${resolvedTarget}.wav`;
  }

  if (resolvedTarget.toLowerCase() === resolvedSource.toLowerCase()) {
    return {
      canceled: false,
      exported: true,
      reused: true,
      filePath: resolvedSource,
      sizeBytes: sourceStat.size,
    };
  }

  await fsp.mkdir(path.dirname(resolvedTarget), { recursive: true });
  await fsp.copyFile(resolvedSource, resolvedTarget);
  const targetStat = await fsp.stat(resolvedTarget);

  return {
    canceled: false,
    exported: true,
    filePath: resolvedTarget,
    sizeBytes: targetStat.size,
  };
});

app.whenReady().then(() => {
  ensurePortableWorkingDirectory();

  return hydratePlaybackStateFromDisk().then(() => {
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (activeDjProcess) {
    try {
      activeDjProcess.kill();
    } catch {
      // no-op
    }
  }

  playbackState.positionSec = getPlaybackPositionSec();
  playbackState.startOffsetSec = playbackState.positionSec;
  playbackState.startedAtMs = 0;
  stopPlaybackPersistTimer();
  try {
    persistPlaybackStateSync();
  } catch {
    // no-op
  }

  stopPlaybackTicker();
  stopFfplayProcess();
});
