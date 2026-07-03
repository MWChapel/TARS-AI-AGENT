/**
 * Pre-downloads the Whisper model to ~/.cache/tars-agent/ before the app
 * launches. Re-running is safe — already-cached files are skipped instantly.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const MODEL   = process.env.WHISPER_MODEL   ?? 'Xenova/whisper-tiny.en';
const CACHE   = path.join(os.homedir(), '.cache', 'tars-agent');
const ENABLED = process.env.WHISPER_ENABLED !== 'false';

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = process.stdout.columns ?? 90;

function rule(ch = '─'): void { console.log('  ' + ch.repeat(W - 4)); }

function progressBar(pct: number, width = 24): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function shortName(fullPath: string): string {
  // fullPath may be like "Xenova/whisper-tiny.en/onnx/encoder.onnx"
  const parts = fullPath.split('/');
  return parts.slice(-2).join('/');   // "onnx/encoder.onnx" or "tokenizer.json"
}

// ── Check cache ───────────────────────────────────────────────────────────────

function isCached(): boolean {
  // @xenova/transformers v2 stores files flat:
  // <cacheDir>/<org>/<model>/onnx/encoder_model.onnx
  const [org, model] = MODEL.split('/');
  const onnxDir = path.join(CACHE, org, model, 'onnx');
  return fs.existsSync(onnxDir) && fs.readdirSync(onnxDir).length > 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   T · A · R · S  —  Pre-flight Checklist    ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log();

  if (!ENABLED) {
    console.log('  ◆ WHISPER_ENABLED=false — voice input disabled, skipping.');
    console.log();
    return;
  }

  console.log(`  MODEL : ${MODEL}`);
  console.log(`  CACHE : ${CACHE}`);
  console.log();

  if (isCached()) {
    console.log('  ✓ Whisper model already cached — no download needed.');
    console.log();
    console.log('  Launching TARS...');
    console.log();
    return;
  }

  // ── Download ────────────────────────────────────────────────────────────────

  rule();
  console.log('  Downloading model files (one-time setup)...');
  console.log();

  // ESM-only package — use new Function to bypass TypeScript's CJS transform
  const esmImport = new Function('m', 'return import(m)') as
    (m: string) => Promise<typeof import('@xenova/transformers')>;
  const { pipeline, env } = await esmImport('@xenova/transformers');

  env.cacheDir = CACHE;
  env.allowLocalModels = false;

  // Suppress ONNX Runtime's verbose graph-optimization warnings (harmless noise
  // about removing unused initializers). They come from native C++ stderr and
  // can't be filtered at the JS level any other way.
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: typeof process.stderr.write }).write = () => true;

  const seen = new Set<string>();
  let activeLine = '';

  await pipeline('automatic-speech-recognition', MODEL, {
    progress_callback: (raw: unknown) => {
      const ev = raw as Record<string, unknown>;
      const status   = ev.status   as string;
      const name     = ev.name     as string | undefined;
      const progress = ev.progress as number | undefined ?? 0;

      if (status === 'downloading' && name) {
        const label = shortName(name);

        if (label !== activeLine) {
          // Finish previous line
          if (activeLine) process.stdout.write('\n');
          activeLine = label;
        }

        const lbl  = `  ↓ ${label}`.padEnd(52);
        const pct  = `${Math.round(progress)}%`.padStart(4);
        const bar  = progressBar(progress);
        process.stdout.write(`\r${lbl} ${pct}  ${bar}`);

      } else if ((status === 'done' || status === 'loaded') && name) {
        const label = shortName(name);
        if (!seen.has(label)) {
          seen.add(label);
          if (activeLine) { process.stdout.write('\n'); activeLine = ''; }
          const lbl = `  ✓ ${label}`.padEnd(52);
          console.log(`${lbl}  100%  ${'█'.repeat(24)}`);
        }
      }
    },
  });

  // Restore stderr
  (process.stderr as { write: typeof process.stderr.write }).write = realStderrWrite;

  // Flush any dangling progress line
  if (activeLine) process.stdout.write('\n');

  rule();
  console.log();
  console.log('  ✓ All files ready. Launching TARS...');
  console.log();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n  ✗ Whisper prefetch failed: ${msg}\n\n`);
  process.exit(1);
});
