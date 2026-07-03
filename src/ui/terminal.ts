import blessed from 'blessed';
import { AudioRecorder } from '../audio/recorder';
import { SpeakerLike } from '../audio/speaker';
import { createSpeaker } from '../audio/createSpeaker';
import { getVoiceInfo, VoiceInfo } from '../audio/voiceInfo';
import { Transcriber, type ProgressInfo } from '../stt/transcriber';
import { TARSClient, CallStats } from '../llm/client';
import { config } from '../config';

type AppState = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

// blessed tag helpers
const t = {
  g: (s: string) => `{green-fg}${s}{/green-fg}`,
  w: (s: string) => `{white-fg}${s}{/white-fg}`,
  d: (s: string) => `{#005c2e-fg}${s}{/#005c2e-fg}`,
  b: (s: string) => `{bright-green-fg}${s}{/bright-green-fg}`,
};

// blue/cyan tag helpers — used for the ANALYTICS panel (right side)
const c = {
  bright: (s: string) => `{#00e5ff-fg}${s}{/#00e5ff-fg}`,
  mid:    (s: string) => `{#4dd8f0-fg}${s}{/#4dd8f0-fg}`,
  dim:    (s: string) => `{#0a5c73-fg}${s}{/#0a5c73-fg}`,
};

const HEADER_ART = [
  t.b('████████╗ █████╗ ██████╗ ███████╗'),
  t.b('╚══██╔══╝██╔══██╗██╔══██╗██╔════╝'),
  t.b('   ██║   ███████║██████╔╝███████╗'),
  t.b('   ██║   ██╔══██║██╔══██╗╚════██║'),
  t.b('   ██║   ██║  ██║██║  ██║███████║'),
  t.b('   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝'),
];

const BARS = [
  '░░░░░░░░░░', '▒░░░░░░░░░', '▒▒░░░░░░░░', '▒▒▒░░░░░░░',
  '▓▒▒░░░░░░░', '▓▓▒▒░░░░░░', '▓▓▓▒▒░░░░░', '▓▓▓▓▒▒░░░░',
  '▓▓▓▓▓▒░░░░', '▓▓▓▓▓▓▒░░░', '▓▓▓▓▓▓▓▒░░', '▓▓▓▓▓▓▓▓▒░',
  '▓▓▓▓▓▓▓▓▓▒', '▓▓▓▓▓▓▓▓▓▓',
];

interface Analytics {
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
  turns: number;
  lastTokensIn: number;
  lastTokensOut: number;
  lastLatencyMs: number;
  sessionStart: number;
  modelName: string;
}

const ANALYTICS_W = 28;
const HEADER_H = 10;
const CONTROLS_H = 2;
const STATUS_H = 2;
const FOOTER_H = CONTROLS_H + STATUS_H;

export class TARSTerminal {
  private screen: blessed.Widgets.Screen;
  private headerBox!: blessed.Widgets.BoxElement;
  private chatBox!: blessed.Widgets.BoxElement;
  private analyticsBox!: blessed.Widgets.BoxElement;
  private statusBar!: blessed.Widgets.BoxElement;
  private controlsBar!: blessed.Widgets.BoxElement;

  private state: AppState = 'idle';
  private animFrame = 0;
  private animTimer: ReturnType<typeof setInterval> | null = null;

  private chatLines: string[] = [];
  private streamBuffer = '';

  private recorder = new AudioRecorder();
  private speaker: SpeakerLike = createSpeaker();
  private transcriber = new Transcriber();
  private tarsClient = new TARSClient();
  private ttsEnabled = config.tts.enabled;

  // Whisper model load tracking
  private whisperState: 'loading' | 'ready' | 'disabled' | 'error' = 'disabled';
  private whisperProgress = '';

  // Populated async (a live /health check when Qwen TTS is in use) -- see constructor.
  private voiceInfo: VoiceInfo = {
    engine: config.qwenTts.enabled ? 'QWEN3-TTS' : 'SAY',
    voice: config.qwenTts.enabled ? 'CHECKING...' : config.tts.voice.toUpperCase(),
  };

  private analytics: Analytics = {
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalLatencyMs: 0,
    turns: 0,
    lastTokensIn: 0,
    lastTokensOut: 0,
    lastLatencyMs: 0,
    sessionStart: Date.now(),
    modelName: config.lmStudio.chatModel,
  };

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: 'TARS — Tactical Artificial Robot System',
    });
    this.createUI();
    this.setupKeys();
    this.startAnimation();

    this.addSystemMessage('SYSTEM ONLINE. Link: ' + config.lmStudio.baseURL);
    this.addSystemMessage(
      `HUMOR ${config.tars.humor}%  HONESTY ${config.tars.honesty}%  COOPERATION 100%`
    );

    if (!config.whisper.enabled) {
      this.whisperState = 'disabled';
      this.addSystemMessage('Voice input DISABLED — press [ENTER] to type.');
    } else {
      this.whisperState = 'loading';
      this.addSystemMessage(
        `WHISPER: Loading model ${config.whisper.model} — voice input available when ready.`
      );
      this.transcriber.onProgress = (info: ProgressInfo) => {
        if (info.status === 'downloading') {
          const pct = info.progress != null ? `${info.progress.toFixed(1)}%` : '...';
          const file = info.name?.split('/').pop() ?? '';
          this.whisperProgress = `${file} ${pct}`;
          this.renderStatus();
          this.screen.render();
        } else if (info.status === 'ready') {
          this.whisperState = 'ready';
          this.whisperProgress = '';
          this.addSystemMessage('WHISPER READY — press [SPACE] to transmit voice.');
          this.render();
        } else if (info.status === 'error') {
          this.whisperState = 'error';
          this.whisperProgress = '';
          this.addSystemMessage(`WHISPER ERROR: ${info.error?.message ?? 'unknown'}`);
          this.render();
        }
      };
      this.transcriber.loadModel();
    }

    getVoiceInfo().then((v) => {
      this.voiceInfo = v;
      this.render();
    });

    this.render();
  }

  // ── UI construction ───────────────────────────────────────────────────────

  private createUI(): void {
    this.headerBox = blessed.box({
      top: 0, left: 0,
      width: '100%', height: HEADER_H,
      tags: true,
      style: { fg: '#00ff41', bg: '#001200', border: { fg: '#00ff41' } },
      border: { type: 'line' },
    });

    this.chatBox = blessed.box({
      top: HEADER_H, left: 0,
      width: `100%-${ANALYTICS_W}`,
      height: `100%-${HEADER_H + FOOTER_H}`,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '│',
        track: { bg: '#001200' },
        style: { fg: '#00ff41' },
      },
      style: { fg: '#00ff41', bg: '#001200', border: { fg: '#005c2e' } },
      border: { type: 'line' },
      label: t.d(' MISSION LOG '),
    });

    this.analyticsBox = blessed.box({
      top: HEADER_H, right: 0,
      width: ANALYTICS_W,
      height: `100%-${HEADER_H + FOOTER_H}`,
      tags: true,
      style: { fg: '#4dd8f0', bg: '#000d14', border: { fg: '#0a5c73' } },
      border: { type: 'line' },
      label: c.dim(' ANALYTICS '),
    });

    this.statusBar = blessed.box({
      bottom: CONTROLS_H, left: 0,
      width: '100%', height: STATUS_H,
      tags: true,
      style: { fg: '#00ff41', bg: '#001200', border: { fg: '#005c2e' } },
      border: { type: 'line' },
    });

    this.controlsBar = blessed.box({
      bottom: 0, left: 0,
      width: '100%', height: CONTROLS_H,
      tags: true,
      style: { fg: '#005c2e', bg: '#001200', border: { fg: '#003318' } },
      border: { type: 'line' },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.chatBox);
    this.screen.append(this.analyticsBox);
    this.screen.append(this.statusBar);
    this.screen.append(this.controlsBar);
  }

  // ── Renderers ─────────────────────────────────────────────────────────────

  private renderHeader(): void {
    const art = HEADER_ART.join('\n  ');
    const subtitle = t.d(
      `  TACTICAL ARTIFICIAL ROBOT SYSTEM  v1.0` +
      `  ⏱ ${this.formatUptime()}`
    );
    this.headerBox.setContent(`\n  ${art}\n${subtitle}`);
  }

  private renderChat(): void {
    const all = [...this.chatLines];
    if (this.streamBuffer) {
      all.push(
        t.g('TARS ▶') + ' ' + this.wrapText(this.streamBuffer, 56) +
        t.g('▌')
      );
      all.push('');
    }
    this.chatBox.setContent(all.join('\n'));
    // Scroll to bottom
    (this.chatBox as blessed.Widgets.BoxElement & { setScrollPerc(n: number): void })
      .setScrollPerc(100);
  }

  private renderAnalytics(): void {
    const avgLat = this.analytics.turns > 0
      ? (this.analytics.totalLatencyMs / this.analytics.turns / 1000).toFixed(2)
      : '--';
    const sessionMin = Math.floor((Date.now() - this.analytics.sessionStart) / 60000);

    const stateLabel: Record<AppState, string> = {
      idle: c.bright('● READY'),
      recording: c.mid('◉ RECORDING'),
      transcribing: c.mid('◎ TRANSCRIBING'),
      thinking: c.mid('◌ PROCESSING'),
      speaking: c.bright('◈ TRANSMITTING'),
      error: '{red-fg}✖ ERROR{/red-fg}',
    };

    const row = (label: string, val: string) =>
      ` ${c.dim(label.padEnd(8))} ${c.mid(val)}`;

    const sep = c.dim('─────────────────────────');

    const lines = [
      '',
      sep,
      row('TOK IN', this.fmt(this.analytics.totalTokensIn)),
      row('TOK OUT', this.fmt(this.analytics.totalTokensOut)),
      row('AVG LAT', `${avgLat}s`),
      row('TURNS', String(this.analytics.turns)),
      row('SESSION', `${sessionMin}m`),
      sep,
      c.dim(' LAST CALL'),
      row('IN', this.fmt(this.analytics.lastTokensIn)),
      row('OUT', this.fmt(this.analytics.lastTokensOut)),
      row('LAT', `${(this.analytics.lastLatencyMs / 1000).toFixed(2)}s`),
      sep,
      c.dim(' MODEL'),
      ` ${c.mid(this.analytics.modelName.slice(0, 22))}`,
      sep,
      c.dim(' STATE'),
      ` ${stateLabel[this.state]}`,
      sep,
      c.dim(' VOICE'),
      row('ENGINE', this.voiceInfo.engine),
      ` ${c.mid(this.voiceInfo.voice.slice(0, 22))}`,
      sep,
      row('HUMOR', `${config.tars.humor}%`),
      row('HONESTY', `${config.tars.honesty}%`),
      row('TTS', this.ttsEnabled ? 'ON' : 'OFF'),
      sep,
      c.dim(' WHISPER'),
      ` ${this.whisperStateLabel()}`,
    ];

    this.analyticsBox.setContent(lines.join('\n'));
  }

  private renderStatus(): void {
    let msg: string;
    const active: AppState[] = ['recording', 'transcribing', 'thinking', 'speaking'];
    const animated = active.includes(this.state) || this.whisperState === 'loading';
    const bar = animated
      ? t.d(BARS[this.animFrame % BARS.length])
      : t.d(BARS[0]);

    if (this.whisperState === 'loading' && this.state === 'idle') {
      const prog = this.whisperProgress ? `  ${t.d(this.whisperProgress)}` : '';
      msg = `WHISPER LOADING${prog}  — [ENTER] to type while waiting`;
    } else {
      const msgs: Record<AppState, string> = {
        idle: this.whisperState === 'ready'
          ? 'AWAITING INPUT  [SPACE] voice  [ENTER] type'
          : 'AWAITING INPUT  [ENTER] to type',
        recording: 'RECORDING — speak clearly  [SPACE] to stop',
        transcribing: 'TRANSCRIBING AUDIO ...',
        thinking: 'TARS IS PROCESSING ...',
        speaking: 'TRANSMITTING RESPONSE ...',
        error: 'SYSTEM ERROR — check mission log',
      };
      msg = msgs[this.state];
    }

    this.statusBar.setContent(`  ${t.w('STATUS ▶')} ${msg}  ${bar}`);
  }

  private renderControls(): void {
    const key = (k: string, label: string) => `${t.d(`[${k}]`)} ${label}`;
    this.controlsBar.setContent(
      '  ' + [
        key('SPACE', 'VOICE'),
        key('ENTER', 'TYPE'),
        key('C', 'CLEAR'),
        key('T', `TTS:${this.ttsEnabled ? 'ON' : 'OFF'}`),
        key('S', 'STOP'),
        key('Q', 'QUIT'),
      ].join('  ')
    );
  }

  private render(): void {
    this.renderHeader();
    this.renderChat();
    this.renderAnalytics();
    this.renderStatus();
    this.renderControls();
    this.screen.render();
  }

  private startAnimation(): void {
    this.animTimer = setInterval(() => {
      this.animFrame++;
      this.renderStatus();
      this.renderAnalytics();
      this.renderHeader();
      this.screen.render();
    }, 150);
  }

  // ── Key bindings ──────────────────────────────────────────────────────────

  private setupKeys(): void {
    this.screen.key(['q', 'C-c'], () => this.quit());

    this.screen.key(['space'], () => {
      if (this.whisperState !== 'ready') return;
      if (this.state === 'idle') {
        this.startRecording();
      } else if (this.state === 'recording') {
        this.stopRecordingAndProcess();
      }
    });

    this.screen.key(['enter'], () => {
      if (this.state === 'idle' || this.state === 'error') {
        this.showTypePrompt();
      }
    });

    this.screen.key(['c'], () => {
      if (this.state === 'idle' || this.state === 'error') {
        this.clearConversation();
      }
    });

    this.screen.key(['t'], () => {
      this.ttsEnabled = !this.ttsEnabled;
      this.addSystemMessage(`TTS ${this.ttsEnabled ? 'ENABLED' : 'DISABLED'}`);
      this.render();
    });

    this.screen.key(['s'], () => {
      this.speaker.stop();
      if (this.state === 'speaking') {
        this.setState('idle');
        this.render();
      }
    });
  }

  // ── Voice flow ────────────────────────────────────────────────────────────

  private startRecording(): void {
    this.setState('recording');
    this.recorder.start();
    this.render();
  }

  private stopRecordingAndProcess(): void {
    if (this.state !== 'recording') return;
    this.setState('transcribing');
    this.render();

    void (async () => {
      try {
        const audioPath = await this.recorder.stop();

        let userText: string;
        try {
          userText = await this.transcriber.transcribe(audioPath);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'AUDIO_TOO_SHORT') {
            this.addSystemMessage('Audio clip too short — nothing recorded.');
            this.setState('idle');
            this.render();
            return;
          }
          throw err;
        }

        if (!userText) {
          this.addSystemMessage('No speech detected in recording.');
          this.setState('idle');
          this.render();
          return;
        }

        await this.processInput(userText);
      } catch (err: unknown) {
        this.handleError(err);
      }
    })();
  }

  // ── Text input overlay ────────────────────────────────────────────────────

  private showTypePrompt(): void {
    const prompt = blessed.prompt({
      parent: this.screen,
      top: 'center', left: 'center',
      width: '70%', height: 5,
      tags: true,
      border: { type: 'line' },
      style: { fg: '#00ff41', bg: '#001200', border: { fg: '#00ff41' } },
      label: t.w(' TRANSMIT MESSAGE '),
    });

    prompt.input('', '', (_err: unknown, value?: string) => {
      const text = (value ?? '').trim();
      if (text) {
        void this.processInput(text);
      } else {
        this.setState('idle');
        this.render();
      }
    });

    this.screen.render();
  }

  // ── Core LLM pipeline ─────────────────────────────────────────────────────

  private async processInput(text: string): Promise<void> {
    this.addUserMessage(text);
    this.setState('thinking');
    this.streamBuffer = '';
    this.render();

    try {
      const gen = this.tarsClient.chat(text);
      let full = '';
      let speakPromise: Promise<void> = Promise.resolve();

      // Fires as soon as the full response is known (before it's typed out),
      // so speech starts in parallel with the typing animation instead of after it.
      this.tarsClient.onResponseReady = (fullText) => {
        if (!fullText.trim()) return;
        this.setState('speaking');
        this.render();
        if (this.ttsEnabled) speakPromise = this.speaker.speak(fullText);
      };

      for await (const token of gen) {
        full += token;
        this.streamBuffer = full;
        this.renderChat();
        this.screen.render();
      }

      await speakPromise;

      this.streamBuffer = '';
      this.addTARSMessage(full);
      this.updateAnalytics(this.tarsClient.lastStats);

      this.setState('idle');
      this.render();
    } catch (err: unknown) {
      this.streamBuffer = '';
      this.handleError(err);
    }
  }

  // ── Chat content helpers ──────────────────────────────────────────────────

  private addUserMessage(text: string): void {
    this.chatLines.push('');
    this.chatLines.push(t.d('──────────────────────────────────────────'));
    this.chatLines.push(t.w('YOU  ▶') + ' ' + this.wrapText(text, 58));
  }

  private addTARSMessage(text: string): void {
    this.chatLines.push(t.g('TARS ▶') + ' ' + this.wrapText(text, 56));
    this.chatLines.push('');
  }

  private addSystemMessage(text: string): void {
    this.chatLines.push(t.d(`  ◆ ${text}`));
  }

  private setState(s: AppState): void {
    this.state = s;
  }

  private updateAnalytics(stats: CallStats): void {
    this.analytics.totalTokensIn += stats.promptTokens;
    this.analytics.totalTokensOut += stats.completionTokens;
    this.analytics.totalLatencyMs += stats.latencyMs;
    this.analytics.turns = this.tarsClient.turnCount;
    this.analytics.lastTokensIn = stats.promptTokens;
    this.analytics.lastTokensOut = stats.completionTokens;
    this.analytics.lastLatencyMs = stats.latencyMs;
    if (stats.modelName) this.analytics.modelName = stats.modelName;
  }

  private clearConversation(): void {
    this.tarsClient.clearHistory();
    this.chatLines = [];
    this.analytics.totalTokensIn = 0;
    this.analytics.totalTokensOut = 0;
    this.analytics.totalLatencyMs = 0;
    this.analytics.turns = 0;
    this.analytics.lastTokensIn = 0;
    this.analytics.lastTokensOut = 0;
    this.analytics.lastLatencyMs = 0;
    this.addSystemMessage('Mission log cleared. Conversation history reset.');
    this.render();
  }

  private handleError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.addSystemMessage(`ERROR: ${msg}`);
    this.setState('error');
    this.render();
    setTimeout(() => {
      if (this.state === 'error') {
        this.setState('idle');
        this.render();
      }
    }, 5000);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private wrapText(text: string, width: number): string {
    const indent = '       ';
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.join(`\n${indent}`);
  }

  private fmt(n: number): string {
    return n.toLocaleString('en-US').padStart(7);
  }

  private formatUptime(): string {
    const ms = Date.now() - this.analytics.sessionStart;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  private whisperStateLabel(): string {
    switch (this.whisperState) {
      case 'ready':    return c.bright('● READY');
      case 'loading':  return c.mid('◌ LOADING');
      case 'error':    return '{red-fg}✖ ERROR{/red-fg}';
      case 'disabled': return c.dim('— OFF');
    }
  }

  private quit(): void {
    this.speaker.stop();
    if (this.animTimer) clearInterval(this.animTimer);
    this.screen.destroy();
    process.stdout.write('\x1b[?25h');
    process.exit(0);
  }

  run(): void {
    this.screen.render();
  }
}
