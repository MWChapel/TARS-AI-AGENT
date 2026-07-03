# TARS Agent

A local, voice-driven chatbot styled after TARS — the tactical robot from *Interstellar* — with a retro green-on-black terminal UI (VT100-style, via [blessed](https://github.com/chjj/blessed)) and an optional Electron desktop shell. Runs entirely against a local LLM (via [LM Studio](https://lmstudio.ai)); no cloud LLM API keys required.

```
 _____ _    ____  ____
|_   _/ \  |  _ \/ ___|
  | |/ _ \ | |_) \___ \
  | / ___ \|  _ < ___) |
  |_/_/   \_\_| \_\____/
```

## Features

- **Local-first LLM** — talks to any OpenAI-compatible endpoint (default: [LM Studio](https://lmstudio.ai) at `localhost:1234`). No API key or internet connection required for chat itself.
- **In-character persona** — TARS's HUMOR / HONESTY dials are configurable and baked into the system prompt; responses stay in character and strip any leaked tool-call markup.
- **Live typing animation** — responses are paced out character-by-character instead of appearing all at once, and text-to-speech starts in parallel with the typing (not after it finishes) — see `TARSClient.onResponseReady` / `typeOut()` in `src/llm/client.ts`.
- **Voice input** — fully local speech-to-text via [Whisper](https://github.com/openai/whisper) (through `@xenova/transformers`, running in a separate Node worker process so the model never touches Electron's ABI). Model weights are downloaded once and cached at `~/.cache/tars-agent/`.
- **Voice output** — text-to-speech via macOS's built-in `say` command (no network calls, no extra dependencies).
- **Live web search** — the model can pull current information (news, prices, scores, etc.) into its context via DuckDuckGo (free, no key) or [Brave Search API](https://brave.com/search/api/) (optional key, better quality). A heuristic decides when a query needs fresh data, and results are injected into context transparently.
- **Hermes agent bridge** — mentioning "hermes" in a message routes it to an external agent over the [ACP (Agent Communication Protocol)](https://agentcommunicationprotocol.dev/) REST API, with TARS relaying the reply in character.
- **Two front ends** — a terminal UI (`blessed`-based TUI) for the CLI, and a matching Electron desktop app with the same commands and visuals.
- **Live analytics panel** — token counts, latency, turn count, session time, model, and whisper/TTS state, updated per turn. In the Electron app this panel is styled in a distinct blue/cyan palette (vs. the mission log's green) and includes a **CALL LOG** sub-panel showing the raw input/output of every actual LLM request.
- **Cosmetic header telemetry graph** (Electron only) — a 10-bar graph in the header that reacts to incoming response text: idles at low random noise, and each word streamed in is hashed to a bar and spikes it before decaying back down. Purely decorative, no data behind it.

## Prerequisites

| Requirement | Purpose | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) 18+ | Runtime | Tested with Node 22 |
| macOS | TTS (`say`) + Electron mic permissions | TTS and the Electron build assume macOS; STT and text chat should work cross-platform |
| [LM Studio](https://lmstudio.ai) (or any OpenAI-compatible server) | Chat model | Must expose an OpenAI-compatible `/v1/chat/completions` endpoint |
| [SoX](https://sox.sourceforge.net) (`rec` command) | Voice input recording | `brew install sox` |

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Install SoX** (required for voice input recording):

   ```bash
   brew install sox
   ```

3. **Start LM Studio** (or another OpenAI-compatible server), load a chat model, and start the local server (default `http://localhost:1234/v1`).

4. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` — see [Configuration](#configuration) below for all available variables.

5. **Run it**

   ```bash
   npm run cli    # terminal UI
   # or
   npm start       # Electron desktop app
   ```

   First launch downloads the Whisper model (a few dozen to a few hundred MB depending on `WHISPER_MODEL`) to `~/.cache/tars-agent/`. Subsequent launches skip this — see [`npm run prefetch`](#scripts).

## Usage

### Terminal UI (`npm run cli`)

| Key | Action |
|---|---|
| `SPACE` | Start / stop voice recording |
| `ENTER` | Open a text input prompt |
| `C` | Clear conversation history — resets the mission log, the LLM's conversation history, and all analytics counters (tokens, turns, latency) back to zero |
| `T` | Toggle text-to-speech on/off |
| `S` | Stop TARS mid-speech |
| `Q` / `Ctrl+C` | Quit |

The screen is split into a header (ASCII logo + uptime), a scrollable mission log (chat transcript), an analytics sidebar (tokens in/out, latency, turn count, model, whisper/TTS state), and a status/controls footer.

### Electron app (`npm start` / `npm run dev`)

Same keyboard shortcuts and behavior as the terminal UI, in a native window (`electron/renderer/`). `npm run dev` runs with `NODE_ENV=development`. On first launch, macOS will prompt for microphone access.

The Electron window additionally has:
- A **CALL LOG** panel (bottom of the right sidebar, below ANALYTICS) that streams the raw input/output text of every actual LLM request as it happens — useful for seeing exactly what's being sent when search results or Hermes replies get injected into context.
- A cosmetic **telemetry bar graph** in the header, to the left of the state indicator, that visually reacts to each word as TARS's response types out (see Features above).
- Clicking **CLEAR** (or pressing `C`) resets the mission log, CALL LOG panel, and all analytics counters together.

### Triggering a web search

Search is heuristic-driven — TARS decides per message whether to look something up (question marks, words like "latest"/"current"/"today"/"news"/"score"/"price", or a year in the 2024–2039 range) before deciding whether to answer directly. You don't need to ask it to "search" explicitly, though you can.

### Triggering the Hermes agent

Include the word "hermes" anywhere in your message to route it to the configured ACP agent instead of the local LLM directly; TARS relays the agent's reply in character.

## Configuration

All configuration is via environment variables (loaded from `.env` with [`dotenv`](https://www.npmjs.com/package/dotenv)); see `src/config.ts` for the source of truth.

### LM Studio / chat model

| Variable | Default | Description |
|---|---|---|
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | OpenAI-compatible base URL |
| `LM_STUDIO_API_KEY` | `lm-studio` | API key (LM Studio accepts any non-empty string by default) |
| `CHAT_MODEL` | `local-model` | Model identifier as shown in LM Studio |

### Whisper (speech-to-text)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_ENABLED` | `true` | Set `false` to disable voice input (type-only mode) |
| `WHISPER_MODEL` | `Xenova/whisper-tiny.en` | `Xenova/whisper-tiny.en` (~77 MB, fastest) · `Xenova/whisper-base.en` (~145 MB) · `Xenova/whisper-small.en` (~465 MB, most accurate) |

### Text-to-speech

| Variable | Default | Description |
|---|---|---|
| `TTS_ENABLED` | `true` | Set `false` to mute TARS (text only) |
| `TTS_VOICE` | `Fred` | Any macOS `say` voice — e.g. `Fred` (robotic), `Zarvox` (alien), `Daniel` (British), `Alex` (US male) |

### Personality

| Variable | Default | Description |
|---|---|---|
| `TARS_HUMOR` | `75` | 0–100, injected into the system prompt |
| `TARS_HONESTY` | `90` | 0–100, injected into the system prompt |

### Web search

| Variable | Default | Description |
|---|---|---|
| `SEARCH_ENABLED` | `true` | Set `false` to disable web search entirely |
| `BRAVE_SEARCH_API_KEY` | unset | Optional. If set, uses [Brave Search API](https://brave.com/search/api/) (free tier: 2,000 queries/month). If unset, falls back to scraping `html.duckduckgo.com/html/` (no key needed). Note: DuckDuckGo's `lite.duckduckgo.com/lite/` endpoint now blocks scripted requests with a CAPTCHA challenge — the `html.duckduckgo.com/html/` endpoint with a browser `User-Agent` still works as of this writing, but as with any scrape, it isn't a stable contract. |

### Hermes agent (ACP)

| Variable | Default | Description |
|---|---|---|
| `HERMES_ENABLED` | `true` | Set `false` to disable the Hermes routing entirely |
| `HERMES_ACP_URL` | `http://localhost:8000` | Base URL of the ACP-compatible agent server |
| `HERMES_ACP_TOKEN` | *(empty)* | Optional bearer token sent as `Authorization: Bearer <token>` |
| `HERMES_AGENT_NAME` | `hermes` | Agent name passed in the ACP run request |
| `HERMES_TIMEOUT_MS` | `30000` | Max time to wait for a run to complete (initial request + polling) |

> `.env.example` currently only documents the LM Studio / Whisper / TTS / personality variables. The search and Hermes variables above are supported by the code (`src/config.ts`) but not yet listed there — add them to your `.env` manually if you want non-default values.

## Scripts

| Command | Description |
|---|---|
| `npm run cli` | Run the terminal UI directly via `tsx` (no build step) |
| `npm start` | Build, prefetch the Whisper model, then launch the Electron app |
| `npm run dev` | Same as `start`, with `NODE_ENV=development` |
| `npm run build` | Compile TypeScript (`src/` + `electron/`) to `dist/` via `tsconfig.electron.json` |
| `npm run prefetch` | Pre-download the configured Whisper model to `~/.cache/tars-agent/` (idempotent — skips if already cached) |
| `npm run typecheck` | Type-check `src/` only, no emit |

## Architecture

```
src/
  index.ts            Terminal UI entry point (npm run cli)
  config.ts            Central config, reads from .env
  ui/terminal.ts        blessed-based TUI (header, chat log, analytics, status/controls)
  llm/client.ts          OpenAI-compatible chat client, system prompt, search/Hermes routing
  audio/recorder.ts       Microphone capture via SoX (`rec`), resampled to 16 kHz WAV
  audio/speaker.ts        TTS via macOS `say`
  stt/transcriber.ts       Spawns whisper-worker.ts as a child process, talks over stdio (JSON lines)
  stt/whisper-worker.ts     Runs @xenova/transformers Whisper pipeline in isolation
  tools/search.ts          Brave Search API / DuckDuckGo HTML fallback
  tools/hermes.ts          ACP client (POST /runs, poll GET /runs/{id})

electron/
  main.ts              Electron main process — mirrors src/ui/terminal.ts logic over IPC
  preload.ts            contextBridge-exposed IPC surface, whitelists IPC channels
  renderer/            HTML/CSS/JS front end for the Electron window — chat log, blue/cyan
                        ANALYTICS + CALL LOG sidebar, cosmetic header telemetry graph

scripts/
  prefetch-whisper.ts   Standalone Whisper model downloader with progress UI
```

**Why Whisper runs in a separate process:** `@xenova/transformers` and `onnxruntime-node` are ESM/native modules that can conflict with Electron's Node ABI. `transcriber.ts` spawns a plain system Node process and communicates over newline-delimited JSON on stdin/stdout, sidestepping the issue entirely. It runs the compiled `whisper-worker.js` when available (Electron, after `npm run build`), and falls back to running `whisper-worker.ts` directly via the local `tsx` binary when there's no build (`npm run cli`, which runs `src/index.ts` straight through `tsx` with no compile step).

**Why the LLM system prompt strips tool-call markup:** local models served through LM Studio don't reliably support OpenAI-style function calling, and different models leak their attempted tool calls in different ad-hoc formats. `llm/client.ts` decides heuristically (via `isSearchWorthy`) whether to run a search *before* calling the model, and separately scans the model's output for leaked tool-call-style syntax — XML-ish (`<tool_code>`, `<tool_call>`, `<parameter=query>`), JSON-ish (`{"name":"web_search",...}`), and plain bracket pseudo-calls (`[Web Search: query]`) have all been observed from different models — in case the model tries to call a tool anyway. If found, it extracts the query, actually performs the search, and re-prompts with results instead of showing the raw placeholder text to the user. See `ROADMAP.md` for the plan to replace this regex-sniffing with real OpenAI-style tool calling.

**How the typing animation works:** the LM Studio chat completion call itself is non-streaming (`stream: false`) — the full response comes back in one shot. `TARSClient.chat()` fires `onResponseReady` the instant that full text is known (so callers can start TTS immediately), then paces the *same* text back out to the caller one character at a time via `typeOut()` at a flat delay, independent of response length. Both UIs consume it through the same `for await` loop they'd use for real token streaming, so neither had to be restructured to get the typing effect.

## Known limitations

- **TTS is macOS-only** (`/usr/bin/say`). On other platforms, set `TTS_ENABLED=false`.
- **Voice recording depends on SoX's `rec`** being on `PATH` (or at `/opt/homebrew/bin/rec` / `/usr/local/bin/rec`).
- **DuckDuckGo fallback search is a best-effort HTML scrape**, not an official API — it can break again if DuckDuckGo changes their markup or starts blocking this request pattern too. For reliable search, set `BRAVE_SEARCH_API_KEY`.
- **Tool calling is regex-based, not native** — see the "Why the LLM system prompt strips tool-call markup" note above and `ROADMAP.md`.
- **No automated test suite** — validate changes with `npm run typecheck` and manual runs of `npm run cli`.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the plan to extend TARS from a chatbot with a search fallback into a proper tool-using agent (real OpenAI-style tool calling, filesystem/shell/calendar tools, a permission model for anything with side effects, and multi-agent routing via Hermes).
