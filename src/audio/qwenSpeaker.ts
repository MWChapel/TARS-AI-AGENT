import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { config } from '../config';
import { Speaker, cleanForSpeech, SpeakerLike } from './speaker';

const SAMPLE_RATE = 24000;

const SOX_BIN = (() => {
  for (const p of ['/opt/homebrew/bin/sox', '/usr/local/bin/sox', 'sox']) {
    try { if (p === 'sox' || fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'sox';
})();

// Band edges (Hz) for the 10-bar cosmetic spectrum analyzer, log-spaced across
// the range where speech energy actually lives -- well under the 12kHz Nyquist
// limit for 24kHz audio. Keep the *count* in sync with TELEMETRY_LABELS in
// electron/renderer/app.js (labels are derived from these same edges there).
const BAND_EDGES = [60, 150, 300, 500, 800, 1300, 2000, 3200, 5000, 8000, 11500];
// Single-point Goertzel picks up almost nothing from real speech -- formants
// are broadband, not pure tones, so most of a band's energy falls between
// bins. Sampling several points across each band and combining them (below)
// approximates a real bandpass filter's energy reading instead.
const TAPS_PER_BAND = 6;

// Reads a little-endian PCM16 chunk as samples without assuming the chunk's
// byte offset is 2-byte aligned (Node's pooled Buffers don't guarantee that).
function toInt16Samples(chunk: Uint8Array): Int16Array {
  const len = chunk.length - (chunk.length % 2);
  const view = new DataView(chunk.buffer, chunk.byteOffset, len);
  const out = new Int16Array(len / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// Goertzel algorithm: energy at one target frequency in a block of samples --
// cheaper than a full FFT and doesn't care that network chunks are irregular
// sizes. Good enough for a cosmetic VU-style display, not spectral analysis.
function goertzelAmplitude(samples: Int16Array, sampleRate: number, freq: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const k = Math.round((n * freq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * Math.cos(omega);
  const imag = q2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag) / n;
}

// RMS across several Goertzel taps spread through [lo, hi) -- an approximate
// bandpass energy reading for that range.
function bandAmplitude(samples: Int16Array, sampleRate: number, lo: number, hi: number): number {
  let sumSq = 0;
  for (let t = 0; t < TAPS_PER_BAND; t++) {
    const freq = lo + ((hi - lo) * (t + 0.5)) / TAPS_PER_BAND;
    const amp = goertzelAmplitude(samples, sampleRate, freq);
    sumSq += amp * amp;
  }
  return Math.sqrt(sumSq / TAPS_PER_BAND);
}

// Converts a raw PCM16 chunk into 10 bar heights (0-100), one per band in
// BAND_EDGES -- fed to onSpectrum as audio streams out of the TTS server, so
// the header graph reacts to the actual voice output.
function computeSpectrum(chunk: Uint8Array, sampleRate: number): number[] {
  const samples = toInt16Samples(chunk);
  const bands: number[] = [];
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    const amplitude = bandAmplitude(samples, sampleRate, BAND_EDGES[i], BAND_EDGES[i + 1]);
    const db = 20 * Math.log10(Math.max(amplitude, 1e-6) / 32768);
    // -90dB..-30dB mapped to 0-100% -- calibrated against measured band energy
    // from real synthesized speech (quiet gaps between words/sentences fall
    // below -100dB and correctly read as ~0).
    bands.push(Math.max(0, Math.min(100, ((db + 90) / 60) * 100)));
  }
  return bands;
}

// Talks to the local Qwen3-TTS (MLX) Python server (tts-server/) over HTTP,
// streaming raw PCM16 audio as it's generated straight into a `sox` process's
// stdin for real-time playback -- audio starts in well under a second instead
// of waiting for the whole response to synthesize. Falls back to the macOS
// `say` backend if the server can't be reached at all (connection failure or
// no audio within the configured timeout).
export class QwenSpeaker implements SpeakerLike {
  private process: ChildProcess | null = null;
  private fallback = new Speaker();
  private usingFallback = false;
  private abortController: AbortController | null = null;
  private spectrumTimers = new Set<NodeJS.Timeout>();

  onSpectrum?: (bands: number[]) => void;

  private clearSpectrumTimers(): void {
    for (const t of this.spectrumTimers) clearTimeout(t);
    this.spectrumTimers.clear();
  }

  async speak(text: string): Promise<void> {
    if (!config.tts.enabled || !text.trim()) return;

    const clean = cleanForSpeech(text);
    if (!clean) return;

    try {
      await this.streamAndPlay(clean);
    } catch (err) {
      process.stderr.write(
        `[qwen-tts] unreachable, falling back to system voice: ${err instanceof Error ? err.message : String(err)}\n`
      );
      this.usingFallback = true;
      try {
        await this.fallback.speak(text);
      } finally {
        this.usingFallback = false;
      }
    }
  }

  private async streamAndPlay(text: string): Promise<void> {
    const base = config.qwenTts.url.replace(/\/$/, '');
    this.abortController = new AbortController();

    // Only time out waiting for the *first* byte -- once streaming has
    // started, a long response legitimately takes a while and shouldn't be
    // treated as a failure.
    const firstByteTimer = setTimeout(() => this.abortController?.abort(), config.qwenTts.timeoutMs);

    const res = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: this.abortController.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Qwen TTS server HTTP ${res.status}`);

    const sox = spawn(
      SOX_BIN,
      ['-q', '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed', '-b', '16', '-c', '1', '-', '-d'],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );
    this.process = sox;

    // If sox dies mid-stream, abort the fetch immediately instead of continuing
    // to read (and discard) the rest of the response -- otherwise we'd keep the
    // server generating audio nobody can hear, only discovering the failure
    // (and falling back to `say`) after the whole response finishes.
    let soxError: Error | null = null;
    const playDone = new Promise<void>((resolve, reject) => {
      sox.on('error', (err) => {
        soxError = err;
        this.abortController?.abort();
        this.clearSpectrumTimers();
        reject(err);
      });
      sox.on('exit', (code, signal) => {
        this.process = null;
        if (code === 0 || signal) {
          resolve();
        } else {
          soxError = new Error(`sox exited with code ${code}`);
          this.abortController?.abort();
          this.clearSpectrumTimers();
          reject(soxError);
        }
      });
    });
    playDone.catch(() => { /* surfaced via the throw below; this just avoids an unhandled-rejection warning if it settles first */ });

    // The 8-bit model generates faster than real-time (~3x), so chunks arrive
    // over the network well ahead of when they're actually audible -- sox just
    // queues them up. Firing onSpectrum the instant a chunk arrives made the
    // cosmetic analyzer visibly run ~3x faster than the voice. Instead, pace
    // each chunk's callback to the wall-clock moment sox will actually be
    // playing that audio, based on cumulative sample count.
    let playbackStartMs: number | null = null;
    let cumulativeSamples = 0;

    try {
      let gotFirstByte = false;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!gotFirstByte) {
          gotFirstByte = true;
          clearTimeout(firstByteTimer);
        }
        if (!sox.stdin.destroyed) sox.stdin.write(chunk);

        // Cosmetic only -- never let a bug here interrupt actual audio playback.
        if (this.onSpectrum) {
          try {
            const bands = computeSpectrum(chunk, SAMPLE_RATE);
            if (playbackStartMs === null) playbackStartMs = Date.now();
            const chunkStartMs = (cumulativeSamples / SAMPLE_RATE) * 1000;
            cumulativeSamples += Math.floor(chunk.length / 2);
            const delay = playbackStartMs + chunkStartMs - Date.now();
            if (delay > 0) {
              const timer = setTimeout(() => {
                this.spectrumTimers.delete(timer);
                this.onSpectrum?.(bands);
              }, delay);
              this.spectrumTimers.add(timer);
            } else {
              this.onSpectrum(bands);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      // If sox exited, the abort above is what's really being reported here --
      // surface the more useful sox failure instead of a generic abort error.
      throw soxError ?? err;
    } finally {
      clearTimeout(firstByteTimer);
      if (!sox.stdin.destroyed) sox.stdin.end();
    }

    await playDone;
  }

  stop(): void {
    this.abortController?.abort();
    this.clearSpectrumTimers();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.fallback.stop();
  }

  get isSpeaking(): boolean {
    return this.process !== null || this.usingFallback;
  }
}
