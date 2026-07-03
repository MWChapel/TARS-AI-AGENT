// Electron strips PATH down to /usr/bin:/bin:/usr/sbin:/sbin.
// Homebrew lives in /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel).
// Fix this before any child_process calls (sox `rec`, `say`) happen.
if (process.platform === 'darwin') {
  const brewBin = process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin';
  if (!(process.env.PATH ?? '').includes(brewBin)) {
    process.env.PATH = `${brewBin}:/usr/local/bin:${process.env.PATH ?? ''}`;
  }
}

import { app, BrowserWindow, ipcMain, systemPreferences, globalShortcut } from 'electron';
import path from 'path';
import { AudioRecorder } from '../src/audio/recorder';
import { createSpeaker } from '../src/audio/createSpeaker';
import { getVoiceInfo } from '../src/audio/voiceInfo';
import { startTtsServerIfNeeded, stopTtsServer } from '../src/audio/ttsServerManager';
import { Transcriber } from '../src/stt/transcriber';
import { TARSClient } from '../src/llm/client';
import { config } from '../src/config';
import type { ProgressInfo } from '../src/stt/transcriber';

type AppState = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

let win: BrowserWindow | null = null;
let appState: AppState = 'idle';
let ttsEnabled = config.tts.enabled;

const recorder = new AudioRecorder();
const speaker = createSpeaker();
const transcriber = new Transcriber();
const tarsClient = new TARSClient();

tarsClient.onSearch = (query: string) => {
  sysMsg(`ACCESSING EXTERNAL DATA FEEDS: ${query}`);
};

tarsClient.onCallLog = (entry) => {
  send('call-log', entry);
};

speaker.onSpectrum = (bands) => {
  send('telemetry-spectrum', bands);
};

// ── IPC helpers ───────────────────────────────────────────────────────────────

function send(channel: string, data?: unknown): void {
  win?.webContents.send(channel, data);
}

function setState(s: AppState): void {
  appState = s;
  send('state-change', { state: s });
}

function sysMsg(text: string): void {
  send('system-message', { text });
}

// ── Whisper setup ─────────────────────────────────────────────────────────────

function initWhisper(): void {
  if (!config.whisper.enabled) {
    send('whisper-status', { status: 'disabled' });
    sysMsg('Voice input DISABLED (WHISPER_ENABLED=false). Press [ENTER] to type.');
    return;
  }

  sysMsg(`WHISPER: Loading ${config.whisper.model} — voice available when ready.`);

  transcriber.onProgress = (info: ProgressInfo) => {
    send('whisper-progress', info);
    if (info.status === 'ready') {
      sysMsg('WHISPER READY — press [SPACE] to transmit voice.');
    } else if (info.status === 'error') {
      sysMsg(`WHISPER ERROR: ${info.error?.message ?? 'unknown'}`);
    }
  };

  transcriber.loadModel();
}

// ── Voice pipeline ────────────────────────────────────────────────────────────

async function processInput(text: string): Promise<void> {
  send('user-message', { text });
  setState('thinking');

  try {
    const gen = tarsClient.chat(text);
    let full = '';
    let speakPromise: Promise<void> = Promise.resolve();

    // Fires as soon as the full response is known (before it's typed out),
    // so speech starts in parallel with the typing animation instead of after it.
    tarsClient.onResponseReady = (fullText) => {
      if (!fullText.trim()) return;
      setState('speaking');
      if (ttsEnabled) speakPromise = speaker.speak(fullText);
    };

    for await (const token of gen) {
      full += token;
      send('token', { text: token });
    }

    await speakPromise;

    send('response-complete', {
      stats: tarsClient.lastStats,
      turns: tarsClient.turnCount,
    });

    setState('idle');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    sysMsg(`ERROR: ${msg}`);
    setState('error');
    setTimeout(() => { if (appState === 'error') setState('idle'); }, 5000);
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.on('start-recording', () => {
  if (appState !== 'idle' || !transcriber.isReady) return;
  setState('recording');
  recorder.start();
});

ipcMain.on('stop-recording', () => {
  if (appState !== 'recording') return;
  setState('transcribing');

  void (async () => {
    try {
      const audioPath = await recorder.stop();
      let text: string;

      try {
        text = await transcriber.transcribe(audioPath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'AUDIO_TOO_SHORT') {
          sysMsg('Audio too short — nothing recorded.');
          setState('idle');
          return;
        }
        throw err;
      }

      if (!text) {
        sysMsg('No speech detected.');
        setState('idle');
        return;
      }

      await processInput(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sysMsg(`RECORDING ERROR: ${msg}`);
      setState('error');
      setTimeout(() => { if (appState === 'error') setState('idle'); }, 5000);
    }
  })();
});

ipcMain.on('send-message', (_event, text: string) => {
  if (!['idle', 'error'].includes(appState)) return;
  void processInput(text);
});

ipcMain.on('clear-history', () => {
  tarsClient.clearHistory();
  sysMsg('Mission log cleared. Conversation history reset.');
});

ipcMain.on('toggle-tts', () => {
  ttsEnabled = !ttsEnabled;
  sysMsg(`TTS ${ttsEnabled ? 'ENABLED' : 'DISABLED'}`);
  send('tts-state', { enabled: ttsEnabled });
});

ipcMain.on('stop-tts', () => {
  speaker.stop();
  if (appState === 'speaking') setState('idle');
});

ipcMain.on('quit', () => app.quit());

ipcMain.handle('get-config', async () => {
  const voice = await getVoiceInfo();
  return {
    humor: config.tars.humor,
    honesty: config.tars.honesty,
    lmStudioUrl: config.lmStudio.baseURL,
    chatModel: config.lmStudio.chatModel,
    whisperModel: config.whisper.model,
    whisperEnabled: config.whisper.enabled,
    ttsEnabled,
    ttsVoice: config.tts.voice,
    voiceEngine: voice.engine,
    voiceLabel: voice.voice,
  };
});

// ── Window creation ───────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  // Request microphone access — fire-and-forget so the dialog doesn't block
  // the window from opening. The IPC handler for start-recording checks
  // isReady, so recording won't start until permission is resolved anyway.
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').then((granted) => {
      if (!granted) sysMsg('WARNING: Microphone access denied — voice input unavailable.');
    }).catch(() => {});
  }

  win = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 800,
    minHeight: 540,
    backgroundColor: '#001200',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('closed', () => { win = null; });

  // Register did-finish-load BEFORE loadFile() — loadFile() resolves its
  // Promise by internally waiting for this same event, so registering after
  // the await means we always miss it.
  win.webContents.on('did-finish-load', () => {
    sysMsg('SYSTEM ONLINE. Link: ' + config.lmStudio.baseURL);
    sysMsg(
      `HUMOR ${config.tars.humor}%  HONESTY ${config.tars.honesty}%  COOPERATION 100%`
    );
    initWhisper();
  });

  win.loadFile(
    path.join(__dirname, '../../electron/renderer/index.html')
  ).catch(() => {});

  // DevTools toggle — always available via Cmd+Shift+I or F12
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    win?.webContents.toggleDevTools();
  });
  globalShortcut.register('F12', () => {
    win?.webContents.toggleDevTools();
  });
}

// Fire-and-forget -- kicked off as early as possible so the Python model load
// overlaps with the rest of Electron's startup instead of adding to it. The
// existing QwenSpeaker fallback (see createSpeaker.ts) already handles "not
// ready yet" by falling back to the say voice, so nothing needs to block on it.
void startTtsServerIfNeeded();

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  speaker.stop();
  stopTtsServer();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
