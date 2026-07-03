# TARS Tools Roadmap

Turning TARS from a chatbot that occasionally searches the web into an agent that can actually *do things* — read/write files, run commands, hit APIs, control the machine it runs on — gated by an explicit permission model.

## Where things stand today

TARS has exactly two tools, and neither is a "tool" in the OpenAI function-calling sense:

- **`src/tools/search.ts`** — `webSearch(query, maxResults)`. Called two ways: proactively before the first LLM call when `isSearchWorthy()` (a regex heuristic in `src/llm/client.ts`) matches the user's message, or reactively when the model's own output matches one of several hand-written regexes for "the model asked to search" (`extractToolQuery()`).
- **`src/tools/hermes.ts`** — a fixed bridge to one external ACP agent, triggered by the literal word "hermes" appearing in the user's message. Not model-invoked at all.

**The core limitation**: there's no real tool-calling loop. `extractToolQuery()` is a growing pile of regexes trying to catch every format a local model might hallucinate for "I want to call a tool" (`<tool_code>`, `<tool_call>{...}`, `[Web Search: ...]`, and whatever the next model quantization decides to emit). Every new tool would mean another regex, another failure mode, another silent no-op when a model phrases its intent slightly differently — we already had to patch this once (bracket-format leak, see `extractToolQuery` history). This doesn't scale past one tool.

**Before adding more tools, the tool-calling mechanism itself needs to be fixed.** That's Phase 0, and it's the prerequisite for everything below.

---

## Phase 0 — Real tool-calling architecture

**Goal:** replace regex-sniffing with the OpenAI SDK's native `tools` / `tool_choice` request params, which LM Studio supports for tool-capable models (Qwen, Llama 3.x, Mistral, etc. — check the loaded model's capabilities in LM Studio's model card). Keep the current regex/prompt-based path as a fallback for models that don't support native tool calls, since this is a local-model app and not every model the user loads will support it.

1. **Tool interface** (`src/tools/types.ts`):
   ```ts
   interface Tool {
     name: string;
     description: string;
     parameters: JSONSchema;          // passed straight to the OpenAI tools param
     execute(args: Record<string, unknown>): Promise<string>;
     requiresConfirmation?: boolean;  // see Phase 0.3, permission model
   }
   ```
2. **Tool registry** (`src/tools/registry.ts`) — an array/map of `Tool` instances. `search` and `hermes` get wrapped as the first two entries, migrated off their bespoke trigger logic (`isSearchWorthy`, the `hermes` keyword regex) and onto real tool-choice — the model decides when to call them, not a regex on the user's raw text.
3. **Dispatcher loop in `TARSClient.chat()`** — replace the current "one search, one retry" flow in `src/llm/client.ts` with a real loop: send `tools` on the request, if the response has `tool_calls`, execute each via the registry, append `role: 'tool'` results to history, call again — repeat until the model returns a plain text response or a max-iteration guard trips (cap at ~4 to avoid runaway loops on a misbehaving local model).
4. **Fallback path** — detect tool support once per model (LM Studio's `/v1/models` doesn't expose this reliably, so probably: try a tool-call request, catch the "does not support tools" error class, remember the result per `chatModel` for the session). When unsupported, fall back to today's prompt-injection + regex approach, but drive it off the same `Tool[]` registry (generate the "you have access to: search(query), readFile(path), ..." prompt block from the registry instead of hardcoding search into `buildSystemPrompt()`).
5. **Wire `onCallLog`** (already exists, `src/llm/client.ts`) to log every tool call/result through the same pipe search results currently use — the CALL LOG panel in the Electron UI becomes a real tool-execution log for free, no UI work needed.

This phase touches `src/llm/client.ts` significantly and is the highest-leverage, highest-risk piece of work here. Everything after this point is "write a `Tool`, add it to the registry."

---

## Phase 1 — Low-risk utility tools

No side effects outside the process, nothing that touches the filesystem or network beyond a single API call. Good first tools to validate the Phase 0 architecture against.

| Tool | What it does | Notes |
|---|---|---|
| `calculator` | Evaluate a math expression | Don't `eval()` — use a small expression parser (e.g. hand-rolled recursive-descent, or a tiny audited dep) |
| `datetime` | Current date/time, timezone conversion, "X days from now" | No API needed, pure JS `Intl`/`Date` |
| `unit_convert` | Length/weight/temp/currency-adjacent unit conversion | Static conversion tables; currency needs an API (see Phase 3) |
| `clipboard_read` / `clipboard_write` | Read/write the system clipboard | macOS: `pbpaste`/`pbcopy` via `child_process`, same pattern as `src/audio/speaker.ts`'s `execFile` |

---

## Phase 2 — Filesystem & memory tools

First tools with real side effects. This is where the permission model (Phase 0.3 below) actually matters.

| Tool | What it does | Notes |
|---|---|---|
| `read_file` | Read a file's contents | Scope to an allowlisted workspace dir by default (e.g. `~/tars-workspace/`), configurable via `.env` like everything else in `src/config.ts` |
| `write_file` | Write/append to a file | Same scoping; should be in `requiresConfirmation` set |
| `list_dir` | List a directory's contents | Read-only, low risk |
| `memory` | Persistent scratchpad TARS can read/write across sessions | Simplest version: a single JSON/markdown file in the cache dir (mirrors the pattern in `scripts/prefetch-whisper.ts` / `~/.cache/tars-agent/`) that TARS can append notes to and recall later — gives it continuity `clearHistory()` currently wipes out entirely |

---

## Phase 3 — System & external data tools

Higher value, higher complexity, mix of local system control and third-party APIs.

| Tool | What it does | Notes |
|---|---|---|
| `run_shell` | Execute a shell command | The big one. Must be `requiresConfirmation`, ideally with a configurable allowlist/denylist (block `rm -rf`, `sudo`, etc. at minimum) rather than trusting the model's judgment |
| `open_url` / `open_app` | Open a URL or launch an app | macOS `open` command, same `execFile` pattern already used for `say` and `rec` |
| `system_info` | Battery, disk space, CPU load | `os` module + maybe `pmset`/`df` on macOS |
| `weather` | Current conditions / forecast for a location | Needs a dedicated API (Open-Meteo is free, no key) — much more reliable than routing weather questions through generic web search the way `isSearchWorthy()` currently does |
| `stock_price` / `crypto_price` | Price lookup | Same rationale as weather — a real API beats scraping search results for numeric data |
| `reminders` / `calendar` | Create reminders, check calendar | macOS EventKit isn't directly Node-accessible; realistic path is `osascript` shelling out to Reminders.app/Calendar.app, or the `shortcuts` CLI on newer macOS |

---

## Phase 4 — Multi-agent expansion

`src/tools/hermes.ts` already speaks ACP (Agent Communication Protocol) to one fixed agent. Once Phase 0 lands, this generalizes naturally:

- Support multiple named ACP agents (config becomes a list instead of one `hermes.acpUrl`/`agentName` pair).
- Expose each configured agent as its own tool (`ask_hermes`, `ask_<agent2>`, ...) rather than a magic-keyword trigger — the model picks the right one based on the request, the same way it'll pick `web_search` vs `run_shell`.
- This turns TARS into a router/orchestrator in front of a small fleet of specialized agents, not just a single chatbot with a search fallback.

---

## Cross-cutting: the permission model

This is not optional once Phase 2+ tools exist — `run_shell` and `write_file` mean TARS can genuinely modify the user's machine. Minimum viable version:

- `Tool.requiresConfirmation: boolean` (Phase 0 interface, above). When true, surface the pending call in the UI (both `src/ui/terminal.ts` and `electron/renderer/`) and block execution until the user approves — mirrors how `blessed.prompt` is already used for the text-input overlay, or a simple y/n confirmation line in the mission log.
- Config-level kill switches per tool category, following the existing `SEARCH_ENABLED`/`HERMES_ENABLED` pattern in `src/config.ts` (e.g. `SHELL_TOOL_ENABLED=false` by default, opt-in).
- Workspace scoping for filesystem tools (never let `read_file`/`write_file` touch arbitrary absolute paths without an explicit override).

## Suggested `src/tools/` layout once this is underway

```
src/tools/
  types.ts        Tool interface, JSONSchema type
  registry.ts      Central Tool[] registry, lookup by name
  search.ts         (existing — migrate to Tool interface)
  hermes.ts          (existing — migrate to Tool interface, then Phase 4 multi-agent)
  calculator.ts
  datetime.ts
  clipboard.ts
  filesystem.ts       read_file / write_file / list_dir
  memory.ts
  shell.ts
  system.ts
  weather.ts
  finance.ts           stock/crypto price
  reminders.ts
```

## Explicit non-goals (for now)

- **Multi-user / remote access** — TARS is a single-user local app; no auth model needed unless that changes.
- **Arbitrary code execution sandboxing** (e.g. a real container/VM for `run_shell`) — start with allowlist + confirmation; revisit if this app ever leaves "personal tool on my own Mac" territory.
- **Cloud LLM fallback for tool calling** — this app is explicitly local-first (LM Studio only); don't add an Anthropic/OpenAI API fallback just to get more reliable tool calls without the user asking for it.
