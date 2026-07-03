import { config } from '../config';

export interface VoiceInfo {
  engine: string;   // e.g. "SAY" or "QWEN3-TTS"
  voice: string;    // e.g. "FRED" or "12HZ-1.7B-BASE-8BIT"
}

// TARS_TTS_MODEL is read by the separate Python process (tts-server/), not
// visible to Node -- the only way to know what's actually loaded is to ask
// the running server, so this hits its /health endpoint rather than guessing.
function shortModelLabel(modelId: string): string {
  const last = modelId.split('/').pop() ?? modelId;
  return last.replace(/^Qwen3-TTS-/i, '').toUpperCase();
}

export async function getVoiceInfo(): Promise<VoiceInfo> {
  if (!config.qwenTts.enabled) {
    return { engine: 'SAY', voice: config.tts.voice.toUpperCase() };
  }

  try {
    const base = config.qwenTts.url.replace(/\/$/, '');
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { model?: string };
    return {
      engine: 'QWEN3-TTS',
      voice: body.model ? shortModelLabel(body.model) : 'UNKNOWN',
    };
  } catch {
    return { engine: 'QWEN3-TTS', voice: 'UNREACHABLE (falls back to SAY)' };
  }
}
