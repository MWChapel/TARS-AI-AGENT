import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

// Manages the separate Python tts-server/ process for Qwen3-TTS -- started
// automatically (when QWEN_TTS_ENABLED=true) so `npm start`/`npm run dev`
// bring the whole voice stack up together, and stopped on app quit. If a
// server is already listening at QWEN_TTS_URL (started manually, or left
// over from a previous run), reuses it instead of spawning a duplicate --
// loading the model twice would double the memory footprint for nothing.

let child: ChildProcess | null = null;

async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function findVenvPython(serverDir: string): string | null {
  for (const bin of ['bin/python3', 'bin/python']) {
    const p = path.join(serverDir, 'venv', bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// npm scripts always run with cwd set to the directory containing
// package.json, and `electron .` inherits that -- so this resolves to the
// project root regardless of build output layout.
function serverDir(): string {
  return path.join(process.cwd(), 'tts-server');
}

export async function startTtsServerIfNeeded(): Promise<void> {
  if (!config.qwenTts.enabled) return;

  // Guard first, before the network check -- if this is called twice (e.g.
  // re-triggered before the first call finishes), a second spawn would
  // overwrite `child` and orphan the first process, which stopTtsServer()
  // could then never reach again.
  if (child) {
    console.log('[tars-tts-manager] already managing a Qwen TTS server process, skipping');
    return;
  }

  const base = config.qwenTts.url.replace(/\/$/, '');
  if (await isReachable(base)) {
    console.log('[tars-tts-manager] Qwen TTS server already running -- reusing it');
    return;
  }

  // Re-check after the await above in case another call raced us while we
  // were waiting on the network request.
  if (child) return;

  const dir = serverDir();
  const python = findVenvPython(dir);
  if (!python || !fs.existsSync(path.join(dir, 'server.py'))) {
    console.warn(
      '[tars-tts-manager] tts-server/venv not found -- skipping auto-start ' +
      '(TARS will fall back to the say voice). See tts-server/README.md to set it up.'
    );
    return;
  }

  console.log('[tars-tts-manager] starting Qwen TTS server...');
  child = spawn(python, ['server.py'], { cwd: dir, stdio: 'inherit' });

  child.on('exit', (code) => {
    console.log(`[tars-tts-manager] Qwen TTS server process exited (code ${code})`);
    child = null;
  });
  child.on('error', (err) => {
    console.warn(`[tars-tts-manager] failed to start Qwen TTS server: ${err.message}`);
    child = null;
  });
}

// Only kills a server this manager itself spawned -- a manually-started or
// pre-existing server (the "reusing it" case above) is left running, since
// this app didn't start it and shouldn't assume ownership of its lifecycle.
export function stopTtsServer(): void {
  if (child) {
    child.kill();
    child = null;
  }
}
