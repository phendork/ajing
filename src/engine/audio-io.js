const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");

// Every stem, deck and the final mix run at this rate. Positions inside the
// engine are expressed in seconds but always resolve to exact sample indices.
const MIX_SR = 48000;
const MIX_CHANNELS = 2;

function runProcess(command, argsList, options = {}) {
  const { input = null, cwd = undefined } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argsList, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false,
      cwd,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${argsList.join(" ")} failed with code ${code}\n${stderr}`));
    });

    if (input) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

function bufferToFloat32(buffer) {
  // Copy into an aligned buffer: Buffer slices from a pool may be unaligned.
  const out = new Float32Array(Math.floor(buffer.length / 4));
  Buffer.from(out.buffer).set(buffer.subarray(0, out.length * 4));
  return out;
}

// Decode any source to mono float samples at `sampleRate`. Used for analysis.
async function decodeMono(ffmpegBin, filePath, sampleRate) {
  const { stdout } = await runProcess(ffmpegBin, [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "+discardcorrupt", "-err_detect", "ignore_err",
    "-i", filePath,
    "-vn", "-ac", "1", "-ar", String(sampleRate),
    "-f", "f32le", "-",
  ]);
  return bufferToFloat32(stdout);
}

// Decode any source to interleaved stereo float samples at the mix rate.
async function decodeStereo(ffmpegBin, filePath) {
  const { stdout } = await runProcess(ffmpegBin, [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "+discardcorrupt", "-err_detect", "ignore_err",
    "-i", filePath,
    "-vn", "-af", `aresample=${MIX_SR}`, "-ac", String(MIX_CHANNELS), "-ar", String(MIX_SR),
    "-f", "f32le", "-",
  ]);
  return bufferToFloat32(stdout);
}

// Integrated loudness (EBU R128, LUFS) and true peak (dBTP) of a source.
async function measureLoudness(ffmpegBin, filePath) {
  const { stderr } = await runProcess(ffmpegBin, [
    "-hide_banner", "-nostats",
    "-fflags", "+discardcorrupt", "-err_detect", "ignore_err",
    "-i", filePath,
    "-vn", "-af", "ebur128=framelog=quiet:peak=true",
    "-f", "null", "-",
  ]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = summary.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const truePeak = summary.match(/True peak:\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  return {
    integrated: integrated ? Number(integrated[1]) : null,
    truePeak: truePeak ? Number(truePeak[1]) : null,
  };
}

// Interleaved stereo float32 raw files are the engine's working format:
// no headers, sample-exact offsets, no requantization between stages.
async function readStereoRaw(filePath) {
  const buffer = await fsp.readFile(filePath);
  return bufferToFloat32(buffer);
}

async function writeStereoRaw(filePath, samples) {
  await fsp.writeFile(filePath, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
}

async function removeFile(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      throw err;
    }
  }
}

function fileExists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

module.exports = {
  MIX_SR,
  MIX_CHANNELS,
  runProcess,
  bufferToFloat32,
  decodeMono,
  decodeStereo,
  measureLoudness,
  readStereoRaw,
  writeStereoRaw,
  removeFile,
  fileExists,
};
