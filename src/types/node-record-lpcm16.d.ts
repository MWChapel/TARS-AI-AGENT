declare module 'node-record-lpcm16' {
  import { Readable } from 'stream';

  interface RecordOptions {
    sampleRateHertz?: number;
    threshold?: number;
    silence?: string;
    verbose?: boolean;
    recordProgram?: string;
    channels?: number;
    audioType?: string;
  }

  interface Recording {
    stream(): Readable;
    stop(): void;
  }

  export function record(options?: RecordOptions): Recording;
}
