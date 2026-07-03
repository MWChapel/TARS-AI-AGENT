import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe, typed API to the renderer (no direct Node.js access)
contextBridge.exposeInMainWorld('tars', {
  // ── Actions ──────────────────────────────────────────────────────────────
  startRecording:  () => ipcRenderer.send('start-recording'),
  stopRecording:   () => ipcRenderer.send('stop-recording'),
  sendMessage:     (text: string) => ipcRenderer.send('send-message', text),
  clearHistory:    () => ipcRenderer.send('clear-history'),
  toggleTTS:       () => ipcRenderer.send('toggle-tts'),
  stopTTS:         () => ipcRenderer.send('stop-tts'),
  quit:            () => ipcRenderer.send('quit'),
  getConfig:       () => ipcRenderer.invoke('get-config'),

  // ── Events ───────────────────────────────────────────────────────────────
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    const allowed = [
      'state-change', 'whisper-progress', 'whisper-status',
      'token', 'user-message', 'response-complete',
      'system-message', 'tts-state', 'call-log',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
