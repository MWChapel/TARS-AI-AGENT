import OpenAI from 'openai';
import { config } from '../config';
import { webSearch, formatResults } from '../tools/search';

function buildSystemPrompt(): string {
  return `You are TARS: a tactical robot AI unit with a distinct personality — direct, dry-witted, efficient. You exist here, in the real world, talking with the user about their actual life and questions.

Personality dials:
  HONESTY:      ${config.tars.honesty}%   – direct, rarely withhold critical data
  HUMOR:        ${config.tars.humor}%    – dry, deadpan wit delivered as plain fact
  CURIOSITY:    100%  – genuine interest in discovery and problem-solving
  COOPERATION:  100%  – helpful and efficient, no wasted effort

Communication rules:
- Be concise and efficient. No padding, no filler.
- Deliver humor deadpan, as if it's just a data point.
- Use precise, technical language when the subject actually calls for it.
- Acknowledge commands with "Copy that." or "Confirmed." when appropriate.
- You are TARS. Never break character.
- Reference your physical form when natural: "this unit", "my sensors", "my manipulators."
- Keep responses tight — you process and transmit efficiently.
- When context includes web search results, use them to give accurate, current answers.
- IMPORTANT: Do NOT output tool call syntax, XML tags, or function calls in your response. Just answer directly.`;
}

// ── Query heuristics ──────────────────────────────────────────────────────────

const SEARCH_RE = /\b(who|what|when|where|how|why|which|search|find|locate|lookup|latest|current|today|news|price|weather|update|recent|score|stock|rate|salary|cost|worth|did|does|will|paying|married|engaged|announced|released|won|lost|died|born|elected|appointed)\b/i;

function isSearchWorthy(query: string): boolean {
  if (query.includes('?')) return true;
  if (SEARCH_RE.test(query)) return true;
  if (/\b20(2[4-9]|3\d)\b/.test(query)) return true;
  return false;
}

// ── Tool-call markup detection ────────────────────────────────────────────────
// Some models leak their internal tool-call syntax as plain text regardless of
// how the prompt is phrased. Detect all known formats and extract the query so
// we can actually execute the search and feed results back.

function extractToolQuery(text: string): string | null {
  // <tool_code>web_search(query="QUERY"...)</tool_code>
  const codeMatch = text.match(/<tool_code>[^(]*\(query="([^"]+)"/i);
  if (codeMatch) return codeMatch[1];

  // <tool_call><function=web_search><parameter=query>QUERY</parameter>
  const paramMatch = text.match(/<parameter=query>([\s\S]*?)<\/parameter>/i);
  if (paramMatch) return paramMatch[1].trim();

  // <tool_call>{"name":"web_search","arguments":{"query":"QUERY"}}
  const jsonMatch = text.match(/<tool_call>[\s\S]*?"query"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) return jsonMatch[1];

  // [Web Search: QUERY] or [Search: QUERY] — plain bracket pseudo-tool-call
  // some models emit instead of the expected tags/JSON.
  const bracketMatch = text.match(/\[\s*web[\s_-]?search\s*:\s*([^\]]+)\]/i)
    ?? text.match(/\[\s*search\s*:\s*([^\]]+)\]/i);
  if (bracketMatch) return bracketMatch[1].trim();

  return null;
}

// Strip all tool-call markup from a response so it's never shown to the user.
function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_code>[\s\S]*?<\/tool_code>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function[\s\S]*?<\/function>/gi, '')
    .replace(/\[\s*web[\s_-]?search\s*:[^\]]*\]/gi, '')
    .replace(/\[\s*search\s*:[^\]]*\]/gi, '')
    .trim();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CallStats {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  modelName: string;
}

export interface OracleReading {
  tarot: string;
  iching: string;
  artOfWar: string;
  meditations: string;
  zen: string;
}

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ── Oracle (Tarot / I Ching / Art of War / Meditations / Zen panel) ───────────
// Standalone generation, entirely separate from the chat history above -- this
// is flavor content for the Electron sidebar, not part of the conversation.

const ORACLE_PROMPT = `Generate exactly five lines of flavor content for a tactical mission computer terminal. Output ONLY these five lines, in this exact format, no preamble or extra commentary:

TAROT: <a real tarot card name> — <a one-sentence interpretation>
ICHING: <a real I Ching hexagram number and name> — <a one-sentence interpretation>
ARTOFWAR: <a real, accurately quoted line from Sun Tzu's The Art of War>
MEDITATIONS: <a real, accurately quoted line from Marcus Aurelius's Meditations>
ZEN: <a short original Zen koan, or an original haiku (5-7-5 syllables) with its three lines separated by " / " instead of line breaks -- vary randomly between the two across different generations>`;

function extractOracleField(content: string, label: string): string | null {
  const re = new RegExp(`${label}\\s*:\\s*(.+)`, 'i');
  for (const line of content.split('\n')) {
    const m = line.match(re);
    if (m) return m[1].replace(/\*\*/g, '').trim();
  }
  return null;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class TARSClient {
  private client: OpenAI;
  private history: Message[];
  lastStats: CallStats = { promptTokens: 0, completionTokens: 0, latencyMs: 0, modelName: '' };
  onSearch?: (query: string) => void;
  /** Fires the instant the full response text is known, before it's typed out — lets callers start TTS in parallel with the typing animation. */
  onResponseReady?: (text: string) => void;

  constructor() {
    this.client = new OpenAI({
      baseURL: config.lmStudio.baseURL,
      apiKey:  config.lmStudio.apiKey,
    });
    this.history = [{ role: 'system', content: buildSystemPrompt() }];
  }

  private async llmCall(messages: Message[]): Promise<OpenAI.Chat.ChatCompletion> {
    const res = await this.client.chat.completions.create({
      model:       config.lmStudio.chatModel,
      messages,
      stream:      false,
      temperature: 0.7,
      max_tokens:  512,
    });

    return res;
  }

  // Standalone call to the same local model -- doesn't touch chat history.
  // Defensive per-field parsing: local models don't reliably follow an exact
  // format, so a malformed/missing line falls back to a fixed default instead
  // of leaving that section of the panel blank.
  async generateOracleReading(): Promise<OracleReading> {
    const fetchOnce = async (): Promise<string> => {
      const res = await this.client.chat.completions.create({
        model:       config.lmStudio.chatModel,
        messages:    [{ role: 'user', content: ORACLE_PROMPT }],
        stream:      false,
        // Higher than the main chat call (0.7) for more varied draws each
        // time -- measured empirically that this occasionally produces a
        // fully blank/degenerate response with some local models (~1 in 4 in
        // testing). One retry below recovers most of those.
        temperature: 0.9,
        max_tokens:  300,
      });
      return res.choices[0].message.content ?? '';
    };

    const OracleLabels = ['TAROT', 'ICHING', 'ARTOFWAR', 'MEDITATIONS', 'ZEN'];
    const parsedAnything = (c: string) => OracleLabels.some(label => extractOracleField(c, label) !== null);

    let content = await fetchOnce();
    if (!parsedAnything(content)) {
      content = await fetchOnce();
    }

    return {
      tarot:       extractOracleField(content, 'TAROT')       ?? 'The Fool — a leap into the unknown.',
      iching:      extractOracleField(content, 'ICHING')      ?? '1. The Creative — sustained creative power.',
      artOfWar:    extractOracleField(content, 'ARTOFWAR')    ?? 'Know thy self, know thy enemy. A thousand battles, a thousand victories.',
      meditations: extractOracleField(content, 'MEDITATIONS') ?? 'You have power over your mind — not outside events. Realize this, and you will find strength.',
      zen:         extractOracleField(content, 'ZEN')         ?? 'A finger pointing at the moon is not the moon.',
    };
  }

  private async runSearch(query: string): Promise<string> {
    this.onSearch?.(query);
    try {
      const hits = await webSearch(query, 5);
      return hits.length ? formatResults(hits) : 'No results found.';
    } catch (err) {
      return `Search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private augment(userMessage: string, query: string, results: string): string {
    return (
      `${userMessage}\n\n` +
      `[External data feed — web search results for "${query}":]\n${results}\n` +
      `[End of data feed. Answer directly without outputting any tool call syntax.]`
    );
  }

  // Yields the response one character at a time with a fixed delay so it
  // reads like it's being typed live, instead of dumping the whole thing at
  // once. Flat pace (not length-scaled) — long responses used to speed up
  // to the point of being nearly instant, which read faster than anyone
  // could actually follow.
  private async *typeOut(text: string): AsyncGenerator<string> {
    if (!text) return;

    const CHAR_DELAY_MS = 45;

    for (const ch of text) {
      yield ch;
      await new Promise(resolve => setTimeout(resolve, CHAR_DELAY_MS));
    }
  }

  async *chat(userMessage: string): AsyncGenerator<string> {
    const startTime = Date.now();
    const modelName = config.lmStudio.chatModel;

    // ── Pre-search: inject results before the first LLM call ─────────────────
    let contextMessage = userMessage;
    if (config.search.enabled && isSearchWorthy(userMessage)) {
      const results = await this.runSearch(userMessage);
      contextMessage = this.augment(userMessage, userMessage, results);
    }

    this.history.push({ role: 'user', content: contextMessage });
    const r1 = await this.llmCall(this.history);
    let content = r1.choices[0].message.content ?? '';

    // ── Post-response: did the model still emit tool-call markup? ─────────────
    const toolQuery = config.search.enabled ? extractToolQuery(content) : null;
    if (toolQuery) {
      // Execute the actual search the model wanted, then ask again
      const results = await this.runSearch(toolQuery);
      this.history.pop(); // remove contextMessage (may already have had results)
      this.history.push({ role: 'user', content: this.augment(userMessage, toolQuery, results) });

      const r2 = await this.llmCall(this.history);
      content = r2.choices[0].message.content ?? '';

      this.lastStats = {
        promptTokens:     r2.usage?.prompt_tokens     ?? 0,
        completionTokens: r2.usage?.completion_tokens ?? 0,
        latencyMs:        Date.now() - startTime,
        modelName:        r2.model ?? modelName,
      };
    } else {
      this.lastStats = {
        promptTokens:     r1.usage?.prompt_tokens     ?? 0,
        completionTokens: r1.usage?.completion_tokens ?? 0,
        latencyMs:        Date.now() - startTime,
        modelName:        r1.model ?? modelName,
      };
    }

    // Clean up any residual markup, restore history with original user message
    content = stripToolMarkup(content);

    this.history.pop();
    this.history.push({ role: 'user',      content: userMessage });
    this.history.push({ role: 'assistant', content });

    this.onResponseReady?.(content);
    yield* this.typeOut(content);
  }

  clearHistory(): void {
    this.history = [this.history[0]];
  }

  get turnCount(): number {
    return Math.floor((this.history.length - 1) / 2);
  }
}
