// Whisper worker — spawned as a child process by Transcriber.
// Communicates via JSON newline messages on stdin/stdout (no IPC channel),
// which avoids Electron's patched child_process.fork() behavior with custom execPath.

import fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ASRPipeline = (input: unknown, opts?: Record<string, unknown>) => Promise<{ text: string }>;
let pipe: ASRPipeline | null = null;

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Read newline-delimited JSON commands from stdin
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuf += chunk;
  const lines = stdinBuf.split('\n');
  stdinBuf = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      void handleCommand(JSON.parse(trimmed));
    } catch (e) {
      send({ type: 'error', message: `bad JSON: ${e}` });
    }
  }
});

async function handleCommand(msg: Record<string, unknown>): Promise<void> {
  if (msg.type === 'init') {
    // Suppress ONNX Runtime verbose graph-optimization warnings
    const realWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (s: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof s === 'string' && s.includes('[W:onnxruntime:')) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realWrite as any)(s, ...rest);
    };

    try {
      // @xenova/transformers is ESM-only — new Function bypasses TS CJS transform
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
      const { pipeline, env } = await esmImport('@xenova/transformers');

      env.cacheDir = msg.cacheDir as string;
      env.allowLocalModels = false;

      pipe = (await pipeline('automatic-speech-recognition', msg.model as string, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        progress_callback: (info: any) => {
          if (info.status === 'downloading') {
            send({ type: 'progress', status: 'downloading', name: info.name, progress: info.progress });
          }
        },
      })) as ASRPipeline;

      send({ type: 'ready' });
    } catch (err: unknown) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = realWrite;
    }
    return;
  }

  if (msg.type === 'transcribe') {
    if (!pipe) {
      send({ type: 'error', message: 'Model not loaded' });
      return;
    }
    try {
      const audioPath = msg.audioPath as string;
      const stat = fs.statSync(audioPath);
      // At 48kHz 16-bit mono: 0.3 s = ~28 800 bytes. Reject anything shorter
      // so Whisper doesn't attempt transcription on a near-empty file.
      if (stat.size < 28800) {
        send({ type: 'error', message: 'AUDIO_TOO_SHORT' });
        return;
      }
      const { samples } = decodeWav(fs.readFileSync(audioPath));
      // Do NOT pass language+task together for .en (English-only) models:
      // forced_decoder_ids for both tokens combined causes the whisper-tiny.en
      // decoder to emit an empty sequence. For .en models the task is implicit.
      const result = await pipe(samples);
      send({ type: 'result', text: result.text.trim() });
    } catch (err: unknown) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ── Minimal WAV decoder (8 / 16 / 32-bit PCM, mono & stereo) ─────────────────

function decodeWav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('Invalid WAV file');
  }

  const numChannels   = buffer.readUInt16LE(22);
  const sampleRate    = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);

  let offset = 12;
  while (offset < buffer.length - 8) {
    const tag = buffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (tag === 'data') break;
    offset += chunkSize;
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor((buffer.length - offset) / (bytesPerSample * numChannels));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const pos = offset + i * numChannels * bytesPerSample;
    if (bitsPerSample === 16) {
      samples[i] = buffer.readInt16LE(pos) / 32768;
    } else if (bitsPerSample === 32) {
      samples[i] = buffer.readFloatLE(pos);
    } else if (bitsPerSample === 8) {
      samples[i] = (buffer.readUInt8(pos) - 128) / 128;
    }
  }

  return { samples, sampleRate };
}
