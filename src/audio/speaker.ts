import { execFile, ChildProcess } from 'child_process';
import { config } from '../config';

export class Speaker {
  private process: ChildProcess | null = null;

  speak(text: string): Promise<void> {
    if (!config.tts.enabled || !text.trim()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const clean = text
        .replace(/[*_#`~]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\n+/g, '. ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!clean) { resolve(); return; }

      // Use execFile (not exec) — no shell interpolation, safer with arbitrary text.
      this.process = execFile('/usr/bin/say', ['-v', config.tts.voice, clean], (err) => {
        this.process = null;
        if (!err || err.killed || (err as NodeJS.ErrnoException & { signal?: string }).signal) {
          // null  → completed normally
          // killed / signal set → stopped intentionally via stop()
          resolve();
        } else {
          reject(err);
        }
      });
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  get isSpeaking(): boolean { return this.process !== null; }
}
