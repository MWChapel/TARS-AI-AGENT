import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { config } from '../config';

export type { ProgressInfo } from './types';

export class Transcriber {
  private worker: ChildProcess | null = null;
  private _loading = false;
  private _ready   = false;
  private pendingResolve: ((text: string) => void) | null = null;
  private pendingReject:  ((err: Error)   => void) | null = null;
  private stdoutBuf = '';

  onProgress?: (info: import('./types').ProgressInfo) => void;

  /** Spawn a system Node.js process for whisper — avoids Electron ABI/ESM issues. */
  loadModel(): void {
    if (this._loading || this._ready || !config.whisper.enabled) return;
    this._loading = true;

    // Compiled builds (Electron, via `npm run build`) have a sibling .js file.
    // `npm run cli` runs src/*.ts directly via tsx with no build step, so fall
    // back to running the .ts source through tsx in that case.
    const compiledScript = path.join(__dirname, 'whisper-worker.js');
    const sourceScript   = path.join(__dirname, 'whisper-worker.ts');

    let command: string;
    let args: string[];

    if (fs.existsSync(compiledScript)) {
      command = this.findNodeBinary();
      args = [compiledScript];
    } else {
      command = this.findTsxBinary();
      args = [sourceScript];
    }

    this.worker = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.worker.on('error', (err) => {
      this._loading = false;
      this.onProgress?.({ status: 'error', error: err });
    });

    // stdout — newline-delimited JSON responses from worker
    this.worker.stdout?.setEncoding('utf8');
    this.worker.stdout?.on('data', (chunk: string) => {
      this.stdoutBuf += chunk;
      const lines = this.stdoutBuf.split('\n');
      this.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.handleMessage(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // malformed JSON from worker — ignore
        }
      }
    });

    // stderr — suppress ONNX verbose warnings (already filtered in worker too)
    this.worker.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (!text.includes('[W:onnxruntime:') && !text.includes('Removing initializer')) {
        process.stderr.write(chunk);
      }
    });

    this.worker.on('exit', (code) => {
      if (this._loading) {
        this._loading = false;
        this.onProgress?.({
          status: 'error',
          error: new Error(`Whisper worker exited unexpectedly (code ${code})`),
        });
      }
    });

    this.workerSend({
      type:     'init',
      cacheDir: path.join(os.homedir(), '.cache', 'tars-agent'),
      model:    config.whisper.model,
    });
  }

  async transcribe(audioFilePath: string): Promise<string> {
    if (!config.whisper.enabled) throw new Error('STT_DISABLED');
    if (!this._ready || !this.worker) throw new Error('Whisper model not loaded');

    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject  = reject;
      this.workerSend({ type: 'transcribe', audioPath: audioFilePath });
    });
  }

  get isReady():   boolean { return this._ready; }
  get isLoading(): boolean { return this._loading; }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'ready') {
      this._loading = false;
      this._ready   = true;
      this.onProgress?.({ status: 'ready' });

    } else if (msg.type === 'progress') {
      this.onProgress?.({
        status:   'downloading',
        name:     msg.name as string | undefined,
        progress: msg.progress as number | undefined,
      });

    } else if (msg.type === 'result') {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject  = null;
      resolve?.(msg.text as string);

    } else if (msg.type === 'error') {
      const err = new Error(msg.message as string);
      if (this.pendingReject) {
        this.pendingReject(err);
        this.pendingResolve = null;
        this.pendingReject  = null;
      } else {
        this._loading = false;
        this.onProgress?.({ status: 'error', error: err });
      }
    }
  }

  private workerSend(msg: Record<string, unknown>): void {
    this.worker?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private findNodeBinary(): string {
    // npm sets npm_node_execpath to the Node.js binary it's using.
    const npmNode = process.env.npm_node_execpath;
    if (npmNode && fs.existsSync(npmNode)) return npmNode;

    for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      if (fs.existsSync(p)) return p;
    }

    return 'node';
  }

  private findTsxBinary(): string {
    // Resolve the locally installed tsx CLI so the worker can run the
    // TypeScript source directly without a separate build step.
    const localTsx = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
    if (fs.existsSync(localTsx)) return localTsx;

    return 'tsx';
  }
}
