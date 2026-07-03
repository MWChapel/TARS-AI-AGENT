import { execFile, ChildProcess } from 'child_process';
import { config } from '../config';

export interface SpeakerLike {
  speak(text: string): Promise<void>;
  stop(): void;
  readonly isSpeaking: boolean;
  // Optional: fired with 10 band levels (0-100) as real audio is generated,
  // for a cosmetic spectrum-analyzer display. Only QwenSpeaker can populate
  // this (it has the raw PCM) -- the `say` fallback simply never calls it.
  onSpectrum?: (bands: number[]) => void;
}

// Shared text cleanup so TTS backends don't read out markdown/URLs verbatim.
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_#`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Speaker implements SpeakerLike {
  private process: ChildProcess | null = null;

  speak(text: string): Promise<void> {
    if (!config.tts.enabled || !text.trim()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const clean = cleanForSpeech(text);

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
