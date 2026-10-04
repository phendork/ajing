// Streaming mix bus. Decks are summed at sample-exact positions into a
// float buffer; everything before the start of the newest deck is final and
// is streamed to ffmpeg, which applies a look-ahead limiter (latency
// compensated, so the timeline does not shift) and writes the WAV.

const { spawn } = require("child_process");
const { MIX_SR, MIX_CHANNELS } = require("./audio-io");

class MixWriter {
  constructor(ffmpegBin, outputPath) {
    this.flushedFrames = 0;
    this.buffer = new Float32Array(MIX_SR * MIX_CHANNELS * 60);
    this.bufferFrames = 0;
    this.peak = 0;
    this.stderr = "";

    this.child = spawn(ffmpegBin, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "f32le", "-ar", String(MIX_SR), "-ac", String(MIX_CHANNELS), "-i", "-",
      // -1 dBFS ceiling; level=false keeps gain static, latency=1 keeps
      // the limiter's look-ahead from delaying the timeline.
      "-af", "alimiter=limit=0.891:attack=4:release=60:level=false:latency=1,aresample=osf=s16:dither_method=triangular",
      "-c:a", "pcm_s16le", "-rf64", "auto",
      outputPath,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.closed = new Promise((resolve, reject) => {
      this.child.on("error", reject);
      this.child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg mix encoder failed with code ${code}\n${this.stderr}`));
      });
    });
    this.child.stdin.on("error", () => {});
  }

  ensureCapacity(frames) {
    if (frames * MIX_CHANNELS <= this.buffer.length) {
      return;
    }
    const next = new Float32Array(Math.max(frames * MIX_CHANNELS, this.buffer.length * 2));
    next.set(this.buffer.subarray(0, this.bufferFrames * MIX_CHANNELS));
    this.buffer = next;
  }

  // Sum a deck into the bus. `startFrame` is the absolute mix position.
  addDeck(samples, startFrame) {
    if (startFrame < this.flushedFrames) {
      throw new Error(`Deck starts at frame ${startFrame}, before already flushed audio (${this.flushedFrames}).`);
    }
    const rel = startFrame - this.flushedFrames;
    const frames = samples.length / MIX_CHANNELS;
    this.ensureCapacity(rel + frames);
    if (rel + frames > this.bufferFrames) {
      this.buffer.fill(0, this.bufferFrames * MIX_CHANNELS, (rel + frames) * MIX_CHANNELS);
      this.bufferFrames = rel + frames;
    }
    const offset = rel * MIX_CHANNELS;
    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[offset + i] += samples[i];
    }
  }

  async write(chunk) {
    for (let i = 0; i < chunk.length; i += 1) {
      const v = Math.abs(chunk[i]);
      if (v > this.peak) this.peak = v;
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // Copy: the bus buffer is reused after this call returns.
    if (!this.child.stdin.write(Buffer.from(bytes))) {
      await new Promise((resolve) => this.child.stdin.once("drain", resolve));
    }
  }

  // Stream out everything before absolute frame `frame`.
  async flushTo(frame) {
    const count = Math.min(this.bufferFrames, frame - this.flushedFrames);
    if (count <= 0) {
      if (frame > this.flushedFrames) {
        // Gap without audio: emit silence.
        await this.write(new Float32Array((frame - this.flushedFrames) * MIX_CHANNELS));
        this.flushedFrames = frame;
      }
      return;
    }
    await this.write(this.buffer.subarray(0, count * MIX_CHANNELS));
    this.buffer.copyWithin(0, count * MIX_CHANNELS, this.bufferFrames * MIX_CHANNELS);
    this.bufferFrames -= count;
    this.flushedFrames += count;
    if (frame > this.flushedFrames) {
      await this.flushTo(frame);
    }
  }

  async finish() {
    await this.flushTo(this.flushedFrames + this.bufferFrames);
    this.child.stdin.end();
    await this.closed;
    return { frames: this.flushedFrames, peak: this.peak };
  }
}

module.exports = { MixWriter };
