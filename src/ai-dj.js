require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const ora = require("ora");
const { analyzeTrackFile, isAnalysisCurrent, renderSet } = require("./engine/engine");
const { measureLoudness } = require("./engine/audio-io");
const { TRANSITION_TYPES } = require("./engine/transitions");

const args = new Set(process.argv.slice(2));

const CONFIG = {
  playlistUrl: process.env.PLAYLIST_URL || "",
  playlistFetchMode: (process.env.PLAYLIST_FETCH_MODE || "auto").trim().toLowerCase(),
  ytdlpBin: process.env.YTDLP_BIN || "yt-dlp",
  ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
  ffprobeBin: process.env.FFPROBE_BIN || "ffprobe",
  ffplayBin: process.env.FFPLAY_BIN || "ffplay",
  cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || "",
  cookiesFile: process.env.YTDLP_COOKIES_FILE || "",
  useCookiesForDownload: parseBoolean(process.env.YTDLP_USE_COOKIES_FOR_DOWNLOAD, false),
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
  googlePlaylistId: process.env.GOOGLE_PLAYLIST_ID || "",
  cacheDir: resolveFromRoot(process.env.CACHE_DIR || ".cache"),
  stateFile: resolveFromRoot(process.env.STATE_FILE || ".cache/dj-state.json"),
  outputFile: resolveFromRoot(process.env.OUTPUT_FILE || ".cache/output/ai-dj-mix.wav"),
  sessionFile: resolveFromRoot(process.env.DJ_SESSION_FILE || ".cache/output/ai-dj-session.json"),
  // Max speed change of a deck during a blend (each deck moves half the gap).
  // Pairs further apart than 2x this are joined with a phrase-locked cut style.
  blendMaxTempoShiftPercent: parseNumber(process.env.BLEND_MAX_TEMPO_SHIFT_PERCENT, 6),
  tempoRampBeats: parseInteger(process.env.TEMPO_RAMP_BEATS, 32),
  setShape: (process.env.SET_SHAPE || "auto").trim().toLowerCase(),
  transitionStyles: parseList(process.env.TRANSITION_STYLES),
  targetLufs: parseNumber(process.env.TARGET_LUFS, -14),
  setSeed: process.env.SET_SEED ? parseInteger(process.env.SET_SEED, NaN) : NaN,
  playAudio: parseBoolean(process.env.PLAY_AUDIO, true),
  markPlayedWhenNotPlaying: parseBoolean(process.env.MARK_PLAYED_WHEN_NOT_PLAYING, true),
  cleanTempAfterRun: parseBoolean(process.env.CLEAN_TEMP_AFTER_RUN, false),
  autoResetOnStart: parseBoolean(process.env.AUTO_RESET_ON_START, false),
  disableSpinners: parseBoolean(process.env.DISABLE_SPINNERS, false),
};

const DEPRECATED_ENV = [
  "BPM_SAMPLE_SECONDS",
  "TEMPO_MATCH_POOL_SIZE",
  "MAX_TEMPO_SHIFT_PERCENT",
  "MIN_TRANSITION_SECONDS",
  "MAX_TRANSITION_SECONDS",
];

async function main() {
  validateConfig();
  const playlistFetchMode = resolvePlaylistFetchMode();

  const shouldReset = args.has("--reset") || CONFIG.autoResetOnStart;
  const statusOnly = args.has("--status");

  await ensureDir(path.dirname(CONFIG.stateFile));
  await ensureDir(CONFIG.cacheDir);
  await ensureDir(path.dirname(CONFIG.outputFile));
  await ensureDir(path.dirname(CONFIG.sessionFile));

  const audioDir = path.join(CONFIG.cacheDir, "audio");
  const workDir = path.join(CONFIG.cacheDir, "work");
  await ensureDir(audioDir);

  await verifyDependencies();

  const fetchSpinner = startSpinner(`Fetching playlist (${playlistFetchMode})...`);
  let playlist;
  try {
    playlist = await fetchPlaylist(playlistFetchMode);
    if (!playlist.entries.length) {
      fetchSpinner.fail("Playlist fetch completed but no tracks were found.");
      throw new Error("Playlist has no tracks.");
    }
    fetchSpinner.succeed(`Playlist fetched: ${playlist.title} (${playlist.entries.length} tracks)`);
  } catch (err) {
    if (fetchSpinner.isSpinning) {
      fetchSpinner.fail(`Failed to fetch playlist (${playlistFetchMode}).`);
    }
    throw err;
  }

  let state = await loadState();
  state = mergeStateWithPlaylist(state, playlist, shouldReset);
  await saveState(state);

  printGlobalStatus(state);

  if (statusOnly) {
    return;
  }

  let unplayed = state.tracks.filter((t) => !t.played && !t.unavailable);
  if (!unplayed.length) {
    const unavailableUnplayed = state.tracks.filter((t) => !t.played && t.unavailable).length;
    if (unavailableUnplayed > 0) {
      console.log("No playable unplayed songs remain.");
      console.log("Some tracks are marked unavailable. Run with --reset to retry all tracks.");
      return;
    }

    console.log("All songs are already marked as played.");
    console.log("Run with --reset to make all tracks unplayed and restart.");
    return;
  }

  console.log("\nPreparing tracks (download, beat grid, loudness)...");
  const preparedTracks = [];
  const tracksToPrepareCount = unplayed.length;
  for (let trackIndex = 0; trackIndex < unplayed.length; trackIndex += 1) {
    const track = unplayed[trackIndex];
    const prefix = `[${trackIndex + 1}/${tracksToPrepareCount}]`;
    const trackSpinner = startSpinner(`${prefix} ${track.title} -> checking audio source`);

    try {
      await ensureTrackDownloaded(track, audioDir, (statusText) => {
        trackSpinner.text = `${prefix} ${track.title} -> ${statusText}`;
      });

      if (!isAnalysisCurrent(track.analysis)) {
        trackSpinner.text = `${prefix} ${track.title} -> analysing beat grid`;
        track.analysis = await analyzeTrackFile(CONFIG.ffmpegBin, track.filePath);
      }
      if (!track.loudness || !Number.isFinite(track.loudness.integrated)) {
        trackSpinner.text = `${prefix} ${track.title} -> measuring loudness`;
        track.loudness = await measureLoudness(CONFIG.ffmpegBin, track.filePath);
      }
      track.durationSec = track.analysis.durationSec;
      track.bpm = track.analysis.bpm;
      // Fields of the previous engine; the analysis object replaces them.
      delete track.beatsSec;
      delete track.firstBeatSec;
      delete track.bpmMethod;

      track.unavailable = false;
      track.unavailableReason = null;
      track.lastErrorAt = null;
      preparedTracks.push(track);

      const beatLabel = track.analysis.hasBeat
        ? `${track.analysis.bpm.toFixed(2)} BPM${track.analysis.steady ? "" : ", live tempo"}`
        : "no steady beat";
      trackSpinner.succeed(`${prefix} ${track.title} ready (${Math.round(track.durationSec)}s, ${beatLabel})`);
      await saveState(state);
    } catch (err) {
      const message = String((err && err.message) || err || "");
      if (isTrackUnavailableError(message)) {
        markTrackAsUnavailable(state, track.id, message);
        trackSpinner.warn(`${prefix} skipping unavailable track: ${track.title}`);
        await saveState(state);
        continue;
      }

      trackSpinner.fail(`${prefix} failed: ${track.title}`);
      throw err;
    }
  }
  await saveState(state);

  if (!preparedTracks.length) {
    console.log("No playable tracks available after filtering unavailable videos.");
    console.log("Use --reset to retry all tracks later or remove unavailable items from the playlist.");
    printGlobalStatus(state);
    return;
  }

  console.log("\nPlanning the set and rendering the mix...");
  console.log(`Tempo: every song plays at its native BPM; blends meet halfway (max ±${CONFIG.blendMaxTempoShiftPercent}% per deck).`);
  let renderSpinner = null;
  const result = await renderSet({
    tracks: preparedTracks,
    outputFile: CONFIG.outputFile,
    config: {
      ffmpegBin: CONFIG.ffmpegBin,
      seed: CONFIG.setSeed,
      maxShiftPercent: CONFIG.blendMaxTempoShiftPercent,
      rampBeats: CONFIG.tempoRampBeats,
      setShape: CONFIG.setShape,
      targetLufs: CONFIG.targetLufs,
      allowedTransitions: CONFIG.transitionStyles,
    },
    onEvent: (event) => {
      if (event.type === "plan") {
        console.log(`Set order (seed ${event.seed}):`);
        event.order.forEach((track, i) => {
          const t = event.transitions[i];
          const bpm = track.analysis.hasBeat ? `${track.analysis.bpm.toFixed(2)} BPM` : "no beat";
          console.log(`  ${String(i + 1).padStart(2)}. ${track.title} (${bpm})`);
          if (t) {
            console.log(`        └─ ${describeTransition(t)}`);
          }
        });
        console.log("");
      } else if (event.type === "track-start") {
        renderSpinner = startSpinner(`[${event.index + 1}/${preparedTracks.length}] rendering ${event.track.title}`);
      } else if (event.type === "track-done" && renderSpinner) {
        const { entry } = event;
        const join = entry.transitionIn;
        let note = "";
        if (join) {
          note = ` | in: ${join.name}`;
          if (join.alignment && Number.isFinite(join.alignment.driftMs)) {
            note += ` (beat-lock drift ${Math.abs(join.alignment.driftMs).toFixed(2)} ms)`;
          }
        }
        renderSpinner.succeed(`[${event.index + 1}/${preparedTracks.length}] ${entry.track.title} @ ${formatClock(entry.startSec)}${note}`);
      }
    },
  });

  const sessionSummary = buildSessionSummary(result);
  await writeSessionFile(sessionSummary);
  console.log(`\nFinal mix ready: ${CONFIG.outputFile} (${formatClock(result.totalDurationSec)})`);
  console.log(`Session info ready: ${CONFIG.sessionFile}`);

  if (CONFIG.playAudio) {
    console.log("\nStarting playback...");
    scheduleSongStatusPrints(result.timeline, state);
    await runCommandInherit(CONFIG.ffplayBin, ["-nodisp", "-autoexit", "-loglevel", "warning", CONFIG.outputFile]);
  } else {
    console.log("PLAY_AUDIO=false, skipping playback.");
    if (CONFIG.markPlayedWhenNotPlaying) {
      for (const entry of result.timeline) {
        markTrackAsPlayed(state, entry.track.id);
      }
      await saveState(state);
      printGlobalStatus(state);
    } else {
      console.log("MARK_PLAYED_WHEN_NOT_PLAYING=false, leaving played status unchanged.");
    }
  }

  if (CONFIG.cleanTempAfterRun) {
    // The engine renders in memory; only stems of older versions live here.
    await safeRm(workDir);
  }

  console.log("\nPlaylist ended. AI DJ stopped.");
}

function validateConfig() {
  const deprecated = DEPRECATED_ENV.filter((key) => process.env[key] != null && process.env[key] !== "");
  if (deprecated.length) {
    console.warn(`Ignoring settings from the previous mix engine: ${deprecated.join(", ")}. See .env.example.`);
  }
  if (CONFIG.transitionStyles) {
    const unknown = CONFIG.transitionStyles.filter((style) => !TRANSITION_TYPES.includes(style));
    if (unknown.length) {
      throw new Error(`Unknown TRANSITION_STYLES: ${unknown.join(", ")}. Available: ${TRANSITION_TYPES.join(", ")}`);
    }
  }
  if (!["auto", "rise", "arc"].includes(CONFIG.setShape)) {
    throw new Error("SET_SHAPE must be one of: auto, rise, arc");
  }

  if (!CONFIG.playlistUrl && !CONFIG.googlePlaylistId) {
    throw new Error("Set PLAYLIST_URL or GOOGLE_PLAYLIST_ID in .env");
  }

  const mode = resolvePlaylistFetchMode();
  if (mode === "youtube-api" && !hasGoogleOAuthConfig()) {
    throw new Error(
      "PLAYLIST_FETCH_MODE=youtube-api requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN"
    );
  }

  if (mode === "yt-dlp" && !CONFIG.playlistUrl) {
    throw new Error("PLAYLIST_URL is required when PLAYLIST_FETCH_MODE=yt-dlp");
  }
}

function resolvePlaylistFetchMode() {
  const mode = CONFIG.playlistFetchMode;
  if (!["auto", "yt-dlp", "youtube-api"].includes(mode)) {
    throw new Error("PLAYLIST_FETCH_MODE must be one of: auto, yt-dlp, youtube-api");
  }

  if (mode === "auto") {
    return hasGoogleOAuthConfig() ? "youtube-api" : "yt-dlp";
  }

  return mode;
}

function hasGoogleOAuthConfig() {
  return Boolean(CONFIG.googleClientId && CONFIG.googleClientSecret && CONFIG.googleRefreshToken);
}

function resolveFromRoot(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(process.cwd(), inputPath);
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value) {
  if (!value || !String(value).trim()) {
    return null;
  }
  return String(value).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildCookiesArgs(enabled = true) {
  if (!enabled) {
    return [];
  }

  if (CONFIG.cookiesFile) {
    return ["--cookies", CONFIG.cookiesFile];
  }
  if (CONFIG.cookiesFromBrowser) {
    return ["--cookies-from-browser", CONFIG.cookiesFromBrowser];
  }
  return [];
}

function hasCookieSourceConfigured() {
  return Boolean(CONFIG.cookiesFile || CONFIG.cookiesFromBrowser);
}

async function verifyDependencies() {
  const checks = [
    [CONFIG.ytdlpBin, ["--version"]],
    [CONFIG.ffmpegBin, ["-version"]],
    [CONFIG.ffprobeBin, ["-version"]],
    [CONFIG.ffplayBin, ["-version"]],
  ];

  for (const [bin, versionArgs] of checks) {
    try {
      await runCommandCapture(bin, versionArgs, { captureBinary: false });
    } catch (err) {
      throw new Error(`Required binary not found or not executable: ${bin}`);
    }
  }
}

async function fetchPlaylist(mode) {
  if (mode === "youtube-api") {
    return fetchPlaylistViaYoutubeApi();
  }
  return fetchPlaylistViaYtdlp();
}

async function fetchPlaylistViaYtdlp() {
  const argsList = [
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    ...buildCookiesArgs(true),
    CONFIG.playlistUrl,
  ];
  const raw = await runCommandCapture(CONFIG.ytdlpBin, argsList, { captureBinary: false });

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new Error("Failed to parse playlist JSON from yt-dlp.");
  }

  const entries = Array.isArray(parsed.entries)
    ? parsed.entries
        .filter((x) => x && x.id)
        .map((x) => ({
          id: String(x.id),
          title: String(x.title || `Track ${x.id}`),
          url: `https://www.youtube.com/watch?v=${x.id}`,
        }))
    : [];

  return {
    id: String(parsed.id || extractPlaylistId(CONFIG.playlistUrl) || "unknown"),
    title: String(parsed.title || "YouTube Playlist"),
    entries,
  };
}

async function fetchPlaylistViaYoutubeApi() {
  let google;
  try {
    ({ google } = require("googleapis"));
  } catch (err) {
    throw new Error("googleapis package is required for youtube-api mode. Run: npm install googleapis");
  }

  if (!hasGoogleOAuthConfig()) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN are required for youtube-api mode"
    );
  }

  const playlistId = CONFIG.googlePlaylistId || extractPlaylistId(CONFIG.playlistUrl);
  if (!playlistId) {
    throw new Error("Could not determine playlist ID. Set GOOGLE_PLAYLIST_ID or a valid PLAYLIST_URL.");
  }

  const oauth2Client = new google.auth.OAuth2(CONFIG.googleClientId, CONFIG.googleClientSecret);
  oauth2Client.setCredentials({ refresh_token: CONFIG.googleRefreshToken });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  try {
    let playlistTitle = "YouTube Playlist";
    const details = await youtube.playlists.list({
      part: ["snippet"],
      id: [playlistId],
      maxResults: 1,
    });

    const maybeTitle = details && details.data && details.data.items && details.data.items[0]
      ? details.data.items[0].snippet && details.data.items[0].snippet.title
      : "";
    if (maybeTitle) {
      playlistTitle = String(maybeTitle);
    }

    const entries = [];
    let pageToken = undefined;

    do {
      const page = await youtube.playlistItems.list({
        part: ["snippet", "status"],
        playlistId,
        maxResults: 50,
        pageToken,
      });

      const items = Array.isArray(page && page.data && page.data.items) ? page.data.items : [];
      for (const item of items) {
        const videoId = item && item.snippet && item.snippet.resourceId ? item.snippet.resourceId.videoId : "";
        if (!videoId) {
          continue;
        }

        const title = item && item.snippet && item.snippet.title ? String(item.snippet.title) : `Track ${videoId}`;
        entries.push({
          id: String(videoId),
          title: title === "Private video" ? `Track ${videoId}` : title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }

      pageToken = page && page.data ? page.data.nextPageToken : "";
    } while (pageToken);

    return {
      id: String(playlistId),
      title: playlistTitle,
      entries,
    };
  } catch (err) {
    const apiError =
      (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
      (err && err.message) ||
      String(err);
    throw new Error(`YouTube API playlist fetch failed: ${apiError}`);
  }
}

function extractPlaylistId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("list") || "";
  } catch {
    return "";
  }
}

async function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) {
    return {
      version: 1,
      playlistId: "",
      playlistTitle: "",
      updatedAt: new Date().toISOString(),
      tracks: [],
    };
  }

  const raw = await fsp.readFile(CONFIG.stateFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tracks)) {
      parsed.tracks = [];
    }
    return parsed;
  } catch {
    return {
      version: 1,
      playlistId: "",
      playlistTitle: "",
      updatedAt: new Date().toISOString(),
      tracks: [],
    };
  }
}

function mergeStateWithPlaylist(state, playlist, shouldReset) {
  const existingById = new Map(state.tracks.map((t) => [t.id, t]));
  const mergedTracks = playlist.entries.map((entry) => {
    const existing = existingById.get(entry.id);
    if (!existing) {
      return {
        id: entry.id,
        title: entry.title,
        url: entry.url,
        played: false,
        bpm: null,
        durationSec: null,
        filePath: "",
        unavailable: false,
        unavailableReason: null,
        lastErrorAt: null,
        lastPlayedAt: null,
      };
    }

    return {
      ...existing,
      title: entry.title,
      url: entry.url,
      played: shouldReset ? false : Boolean(existing.played),
      unavailable: shouldReset ? false : Boolean(existing.unavailable),
      unavailableReason: shouldReset ? null : existing.unavailableReason || null,
      lastErrorAt: shouldReset ? null : existing.lastErrorAt || null,
      lastPlayedAt: shouldReset ? null : existing.lastPlayedAt || null,
    };
  });

  return {
    ...state,
    playlistId: playlist.id,
    playlistTitle: playlist.title,
    updatedAt: new Date().toISOString(),
    tracks: mergedTracks,
  };
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await fsp.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function writeSessionFile(session) {
  await ensureDir(path.dirname(CONFIG.sessionFile));
  await fsp.writeFile(CONFIG.sessionFile, JSON.stringify(session, null, 2), "utf8");
}

function buildSessionSummary(result) {
  const tracks = result.timeline.map((entry) => {
    const analysis = entry.track.analysis;
    const join = entry.transitionIn;
    return {
      index: entry.index,
      id: entry.track.id,
      title: entry.track.title,
      url: entry.track.url,
      startSec: Number(entry.startSec.toFixed(3)),
      durationSec: Number(entry.durationSec.toFixed(3)),
      endSec: Number((entry.startSec + entry.durationSec).toFixed(3)),
      originalBpm: Number(analysis.bpm.toFixed(3)),
      // Tracks play at native tempo outside blends.
      adjustedBpm: Number(analysis.bpm.toFixed(3)),
      tempoFactor: 1,
      firstBeatSec: Number(Math.max(0, analysis.phase).toFixed(3)),
      gainDb: Number(entry.gainDb.toFixed(2)),
      transitionIn: join
        ? {
          type: join.type,
          name: join.name,
          beats: join.beats || null,
          sharedBpm: join.sharedBpm ? Number(join.sharedBpm.toFixed(3)) : null,
          beatLockDriftMs: join.alignment && Number.isFinite(join.alignment.driftMs)
            ? Number(join.alignment.driftMs.toFixed(3))
            : null,
        }
        : null,
    };
  });

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    outputFile: CONFIG.outputFile,
    seed: result.seed,
    totalDurationSec: Number((result.totalDurationSec || 0).toFixed(3)),
    trackCount: tracks.length,
    tracks,
  };
}

function describeTransition(t) {
  if (t.overlap) {
    const pct = (f) => `${f >= 1 ? "+" : "-"}${Math.abs((f - 1) * 100).toFixed(1)}%`;
    return `${t.name}, ${t.lengthBeats} beats @ ${t.sharedBpm.toFixed(2)} BPM (out ${pct(t.factorA)}, in ${pct(t.factorB)})`;
  }
  return `${t.name}, phrase-locked cut${t.gapPercent > 0.05 ? ` (tempo gap ${t.gapPercent.toFixed(1)}%)` : ""}`;
}

function formatClock(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s2 = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s2}` : `${m}:${s2}`;
}

function saveStateSync(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function printGlobalStatus(state) {
  const played = state.tracks.filter((t) => t.played).length;
  const unavailable = state.tracks.filter((t) => t.unavailable).length;
  const total = state.tracks.length;
  const unplayed = Math.max(0, total - played - unavailable);

  console.log("\n====== DJ STATE ======");
  console.log(`Playlist: ${state.playlistTitle} (${state.playlistId})`);
  console.log(`Total tracks: ${total}`);
  console.log(`Played: ${played}`);
  console.log(`Unavailable: ${unavailable}`);
  console.log(`Unplayed: ${unplayed}`);
}

async function ensureTrackDownloaded(track, audioDir, onStatus = () => {}) {
  if (track.filePath && fs.existsSync(track.filePath)) {
    onStatus("using cached audio file");
    return;
  }

  const cachedPath = await findCachedTrackFile(audioDir, track.id);
  if (cachedPath && fs.existsSync(cachedPath)) {
    track.filePath = cachedPath;
    onStatus("using cached audio file (matched by track ID)");
    return;
  }

  const outputTemplate = path.join(audioDir, "%(id)s.%(ext)s");
  const download = async (withCookies) => {
    onStatus(withCookies ? "downloading audio (cookies enabled)" : "downloading audio");
    const argsList = [
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      "--no-overwrites",
      "--continue",
      "-o",
      outputTemplate,
      "--print",
      "after_move:filepath",
      ...buildCookiesArgs(withCookies),
      track.url,
    ];
    return runCommandCapture(CONFIG.ytdlpBin, argsList, { captureBinary: false });
  };

  let raw;
  try {
    raw = await download(CONFIG.useCookiesForDownload);
  } catch (err) {
    if (!CONFIG.useCookiesForDownload && hasCookieSourceConfigured()) {
      console.warn(`Download failed without cookies for ${track.title}. Retrying with configured cookies...`);
      onStatus("retrying download with cookies");
      raw = await download(true);
    } else {
      throw err;
    }
  }

  const lines = raw
    .toString("utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  let downloadedPath = lines.length ? lines[lines.length - 1] : "";
  if (!downloadedPath || !fs.existsSync(downloadedPath)) {
    downloadedPath = await findCachedTrackFile(audioDir, track.id);
  }

  if (!downloadedPath) {
    throw new Error(`Could not find downloaded file for track ${track.id}`);
  }

  track.filePath = downloadedPath;
  onStatus("audio file ready");
}

async function findCachedTrackFile(audioDir, id) {
  const entries = await fsp.readdir(audioDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.startsWith(`${id}.`)) {
      return path.join(audioDir, entry.name);
    }
  }
  return "";
}

function scheduleSongStatusPrints(timeline, state) {
  timeline.forEach((entry, i) => {
    const delayMs = Math.max(0, Math.round(entry.startSec * 1000));

    setTimeout(() => {
      markTrackAsPlayed(state, entry.track.id);
      saveStateSync(state);

      const played = state.tracks.filter((t) => t.played).length;
      const unavailable = state.tracks.filter((t) => t.unavailable).length;
      const total = state.tracks.length;
      const unplayed = Math.max(0, total - played - unavailable);

      console.log("\n========================================");
      console.log(`Now playing ${i + 1}/${timeline.length}: ${entry.track.title}`);
      console.log(`Track ID: ${entry.track.id}`);
      console.log(`Tempo: ${entry.nativeBpm.toFixed(2)} BPM (native)`);
      console.log(`Transition in: ${entry.transitionIn ? entry.transitionIn.name : "Start of set"}`);
      console.log(`Next: ${i < timeline.length - 1 ? timeline[i + 1].track.title : "End of playlist"}`);
      console.log(`Status -> Played: ${played}/${total} | Unavailable: ${unavailable} | Unplayed: ${unplayed}`);
      console.log("========================================");
    }, delayMs);
  });
}

function markTrackAsPlayed(state, trackId) {
  const idx = state.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) {
    return;
  }

  state.tracks[idx].played = true;
  state.tracks[idx].unavailable = false;
  state.tracks[idx].unavailableReason = null;
  state.tracks[idx].lastErrorAt = null;
  state.tracks[idx].lastPlayedAt = new Date().toISOString();
}

function markTrackAsUnavailable(state, trackId, reason) {
  const idx = state.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) {
    return;
  }

  const message = String(reason || "Unavailable").slice(0, 1200);
  state.tracks[idx].unavailable = true;
  state.tracks[idx].unavailableReason = message;
  state.tracks[idx].lastErrorAt = new Date().toISOString();
}

function isTrackUnavailableError(message) {
  const normalized = String(message || "").toLowerCase();
  if (!normalized.includes("[youtube]")) {
    return false;
  }

  const markers = [
    "video unavailable",
    "this video is not available",
    "private video",
    "this video is private",
    "has been removed",
    "not available in your country",
    "uploader has not made this video available",
  ];

  return markers.some((marker) => normalized.includes(marker));
}

async function runCommandCapture(command, argsList, options = {}) {
  const { captureBinary = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, argsList, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code === 0) {
        const out = Buffer.concat(stdoutChunks);
        resolve(captureBinary ? out : Buffer.from(out.toString("utf8"), "utf8"));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      reject(new Error(`${command} ${argsList.join(" ")} failed with code ${code}\n${stderr}`));
    });
  });
}

async function runCommandInherit(command, argsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argsList, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${argsList.join(" ")} failed with code ${code}`));
    });
  });
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function safeRm(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  await fsp.rm(targetPath, { recursive: true, force: true });
}

function startSpinner(text) {
  const shouldUseSpinner = !CONFIG.disableSpinners && Boolean(process.stdout && process.stdout.isTTY);
  if (!shouldUseSpinner) {
    return createNoopSpinner(text);
  }

  return ora({
    text,
    spinner: "dots",
  }).start();
}

function createNoopSpinner(initialText) {
  let currentText = initialText;
  let lastOutput = "";

  const log = (prefix, message) => {
    const line = `${prefix} ${message}`;
    if (line !== lastOutput) {
      console.log(line);
      lastOutput = line;
    }
  };

  log("...", currentText);

  return {
    isSpinning: false,
    get text() {
      return currentText;
    },
    set text(value) {
      currentText = value;
      log("...", value);
    },
    succeed(message) {
      log("OK", message || currentText);
      return this;
    },
    fail(message) {
      log("FAIL", message || currentText);
      return this;
    },
    warn(message) {
      log("WARN", message || currentText);
      return this;
    },
  };
}

main().catch((err) => {
  const message = String((err && err.message) || err || "Unknown error");

  console.error("\nAI DJ failed:");
  console.error(message);

  if (message.includes("Could not copy Chrome cookie database")) {
    console.error("\nTroubleshooting:");
    console.error("1) Close Chrome completely, including background processes.");
    console.error("2) Run: taskkill /F /IM chrome.exe");
    console.error("3) Start a new terminal and run: npm run dj");
    console.error("4) If it still fails, export cookies.txt and set YTDLP_COOKIES_FILE in .env, then clear YTDLP_COOKIES_FROM_BROWSER.");
  }

  process.exit(1);
});
