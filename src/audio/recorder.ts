import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SOX_BIN = (() => {
  for (const p of ['/opt/homebrew/bin/rec', '/usr/local/bin/rec', 'rec']) {
    try { if (p === 'rec' || fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'rec';
})();

export class AudioRecorder {
  private sox: ChildProcess | null = null;
  readonly outputPath: string;

  constructor() {
    this.outputPath = path.join(os.tmpdir(), 'tars_input.wav');
  }

  start(): void {
    if (this.sox) this.forceStop();

    // Write to a real file so sox can seek back and fix the WAV length header.
    // Native CoreAudio rate (48 kHz) is captured as-is; the whisper worker
    // decodes the Float32Array and @xenova/transformers uses the mel feature
    // extractor at 16 kHz (the model's native rate) after implicit resampling
    // via the samples being treated as 16 kHz audio — but to avoid that wrong
    // assumption we actually need to resample. We use sox's `rate` effect here
    // and write to a FILE (not stdout), so sox can finalize the WAV on SIGTERM.
    this.sox = spawn(SOX_BIN, [
      '-q',
      '-c', '1',
      '-e', 'signed-integer',
      '-b', '16',
      '-t', 'wav',
      this.outputPath,   // write to file — sox seeks back to fix WAV header
      'rate', '16000',   // resample to 16 kHz before writing
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    this.sox.stderr?.on('data', (d: Buffer) => {
      const line = d.toString();
      if (!line.includes("can't set sample rate") && !line.includes('Length in output')) {
        process.stderr.write(d);
      }
    });

    this.sox.on('error', (err) => {
      process.stderr.write(`[recorder] sox error: ${err.message}\n`);
    });
  }

  stop(): Promise<string> {
    return new Promise((resolve) => {
      const sox = this.sox;
      this.sox = null;

      if (!sox) {
        resolve(this.outputPath);
        return;
      }

      // SIGTERM asks sox to stop gracefully: it finalises the WAV header in
      // the file (possible because we're writing to a real file, not stdout).
      sox.on('exit', () => setTimeout(() => resolve(this.outputPath), 100));

      try { sox.kill('SIGTERM'); } catch { /* already dead */ }

      // Safety net: resolve after 2 s if sox hangs
      setTimeout(() => resolve(this.outputPath), 2000);
    });
  }

  private forceStop(): void {
    try { this.sox?.kill('SIGKILL'); } catch { /* ignore */ }
    this.sox = null;
  }

  get isRecording(): boolean { return this.sox !== null; }
}
