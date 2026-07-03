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
  tars: {
    humor: parseInt(process.env.TARS_HUMOR ?? '75', 10),
    honesty: parseInt(process.env.TARS_HONESTY ?? '90', 10),
  },
  search: {
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || null,
    enabled: process.env.SEARCH_ENABLED !== 'false',
  },
  hermes: {
    acpUrl:    process.env.HERMES_ACP_URL    ?? 'http://localhost:8000',
    acpToken:  process.env.HERMES_ACP_TOKEN  ?? '',
    agentName: process.env.HERMES_AGENT_NAME ?? 'hermes',
    enabled:   process.env.HERMES_ENABLED    !== 'false',
    timeoutMs: parseInt(process.env.HERMES_TIMEOUT_MS ?? '30000', 10),
  },
} as const;
