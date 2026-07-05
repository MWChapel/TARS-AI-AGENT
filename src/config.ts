import dotenv from 'dotenv';
dotenv.config();

export const config = {
  lmStudio: {
    baseURL: process.env.LM_STUDIO_URL ?? 'http://localhost:1234/v1',
    apiKey: process.env.LM_STUDIO_API_KEY ?? 'lm-studio',
    chatModel: process.env.CHAT_MODEL ?? 'local-model',
  },
  whisper: {
    // Xenova/whisper-tiny.en  (~77 MB, fastest)
    // Xenova/whisper-base.en  (~145 MB, better accuracy)
    // Xenova/whisper-small.en (~465 MB, even better)
    model: process.env.WHISPER_MODEL ?? 'Xenova/whisper-tiny.en',
    enabled: process.env.WHISPER_ENABLED !== 'false',
  },
  tts: {
    voice: process.env.TTS_VOICE ?? 'Fred',
    enabled: process.env.TTS_ENABLED !== 'false',
  },
  qwenTts: {
    // Separate local Python server (tts-server/), not LM Studio -- see tts-server/README.md.
    enabled:   process.env.QWEN_TTS_ENABLED === 'true',
    url:       process.env.QWEN_TTS_URL ?? 'http://127.0.0.1:8008',
    timeoutMs: parseInt(process.env.QWEN_TTS_TIMEOUT_MS ?? '30000', 10),
  },
  tars: {
    humor: parseInt(process.env.TARS_HUMOR ?? '75', 10),
    honesty: parseInt(process.env.TARS_HONESTY ?? '90', 10),
  },
  search: {
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || null,
    enabled: process.env.SEARCH_ENABLED !== 'false',
  },
  person: {
    // PERSON=Michael or PERSON=Michael,Lynda,Olivia -- a single name is always
    // used; multiple names means one is picked at random per session. Unset
    // (default) means no personalization at all.
    names: (process.env.PERSON ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },
  idlePrompt: {
    enabled: process.env.IDLE_PROMPT_ENABLED !== 'false',
  },
} as const;
