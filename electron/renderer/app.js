// TARS renderer — communicates with main via window.tars (context bridge)
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const app = {
  state: 'idle',          // mirrors main-process AppState
  ttsEnabled: true,
  whisperReady: false,
  sessionStart: Date.now(),

  // Analytics accumulators
  totalIn: 0,
  totalOut: 0,
  totalLatMs: 0,
  turns: 0,
  lastIn: 0,
  lastOut: 0,
  lastLatMs: 0,
  modelName: 'local-model',

  // Streaming
  streamEl: null,         // <span> being built during streaming
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  chatLog:       $('chat-log'),
  stateDot:      $('state-dot'),
  stateLabel:    $('state-label'),
  statusMsg:     $('status-msg'),
  statusProg:    $('status-progress'),
  inputOverlay:  $('input-overlay'),
  textInput:     $('text-input'),
  ttsLbl:        $('tts-lbl'),
  aWhisper:      $('a-whisper'),
  aWhisperProg:  $('a-whisper-prog'),
  aTokIn:        $('a-tok-in'),
  aTokOut:       $('a-tok-out'),
  aLat:          $('a-lat'),
  aTurns:        $('a-turns'),
  aSession:      $('a-session'),
  aLastIn:       $('a-last-in'),
  aLastOut:      $('a-last-out'),
  aLastLat:      $('a-last-lat'),
  aModel:        $('a-model'),
  aHumor:        $('a-humor'),
  aHonesty:      $('a-honesty'),
  aTts:          $('a-tts'),
  aVoiceEngine:  $('a-voice-engine'),
  aVoiceLabel:   $('a-voice-label'),
  oracleTarot:       $('oracle-tarot'),
  oracleIching:      $('oracle-iching'),
  oracleArtOfWar:    $('oracle-artofwar'),
  oracleMeditations: $('oracle-meditations'),
  oracleZen:         $('oracle-zen'),
  cfgHumor:      $('cfg-humor'),
  cfgHonesty:    $('cfg-honesty'),
  cfgUrl:        $('cfg-url'),
  cfgVoice:      $('cfg-voice'),
  uptime:        $('uptime'),
};

// ── Progress bar ──────────────────────────────────────────────────────────────

const BARS = [
  '░░░░░░░░░░░░░░░░░░░░', '▒░░░░░░░░░░░░░░░░░░░', '▒▒░░░░░░░░░░░░░░░░░░',
  '▓▒▒░░░░░░░░░░░░░░░░░', '▓▓▒▒░░░░░░░░░░░░░░░░', '▓▓▓▒▒░░░░░░░░░░░░░░░',
  '▓▓▓▓▒▒░░░░░░░░░░░░░░', '▓▓▓▓▓▒▒░░░░░░░░░░░░░', '▓▓▓▓▓▓▒▒░░░░░░░░░░░░',
  '▓▓▓▓▓▓▓▒▒░░░░░░░░░░░', '▓▓▓▓▓▓▓▓▒▒░░░░░░░░░░', '▓▓▓▓▓▓▓▓▓▒▒░░░░░░░░░',
  '▓▓▓▓▓▓▓▓▓▓▒▒░░░░░░░░', '▓▓▓▓▓▓▓▓▓▓▓▒▒░░░░░░░', '▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░░░░░',
  '▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░░░░', '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░░░', '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░░',
  '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░', '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓',
];

let barFrame = 0;
let barTimer = null;

function startBarAnim() {
  if (barTimer) return;
  barTimer = setInterval(() => {
    barFrame = (barFrame + 1) % BARS.length;
    els.statusProg.textContent = BARS[barFrame];
  }, 100);
}

function stopBarAnim() {
  if (barTimer) { clearInterval(barTimer); barTimer = null; }
  els.statusProg.textContent = BARS[0];
}

// ── State management ──────────────────────────────────────────────────────────

const STATE_LABELS = {
  idle:         'READY',
  recording:    'RECORDING',
  transcribing: 'TRANSCRIBING',
  thinking:     'PROCESSING',
  speaking:     'TRANSMITTING',
  error:        'ERROR',
};

const STATUS_MSGS = {
  idle_voice:   'AWAITING INPUT  [HOLD SPACE] voice  [ENTER] type',
  idle_novoice: 'AWAITING INPUT  [ENTER] to type',
  idle_loading: 'AWAITING INPUT  [ENTER] type  (WHISPER LOADING...)',
  recording:    '● RECORDING — speak clearly, [SPACE] to stop',
  transcribing: 'TRANSCRIBING AUDIO ...',
  thinking:     'TARS IS PROCESSING ...',
  speaking:     'TRANSMITTING RESPONSE ...',
  error:        'ERROR — check mission log',
};

function applyState(state) {
  app.state = state;
  document.body.className = `state-${state}`;

  els.stateLabel.textContent = STATE_LABELS[state] ?? state.toUpperCase();

  const active = ['recording', 'transcribing', 'thinking', 'speaking'].includes(state);
  if (active) startBarAnim(); else stopBarAnim();

  // Status message
  let msg;
  if (state === 'idle') {
    if (!app.whisperReady) msg = STATUS_MSGS.idle_loading;
    else msg = STATUS_MSGS.idle_voice;
  } else {
    msg = STATUS_MSGS[state] ?? state;
  }
  els.statusMsg.textContent = msg;

  // Button highlight
  $('btn-talk').classList.toggle('active', state === 'recording');
}

// ── Chat rendering ────────────────────────────────────────────────────────────

function scrollToBottom() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = text;
  els.chatLog.appendChild(div);
  scrollToBottom();
}

function addDivider() {
  const div = document.createElement('div');
  div.className = 'msg-divider';
  div.textContent = '──────────────────────────────────────────────────';
  els.chatLog.appendChild(div);
}

function addUserMessage(text) {
  addDivider();
  const block = document.createElement('div');
  block.className = 'msg-block';
  block.innerHTML =
    `<div class="msg-speaker user">YOU  ▶</div>` +
    `<div class="msg-body">${escHtml(text)}</div>`;
  els.chatLog.appendChild(block);
  scrollToBottom();
}

function beginTARSResponse() {
  const block = document.createElement('div');
  block.className = 'msg-block';

  const speaker = document.createElement('div');
  speaker.className = 'msg-speaker tars';
  speaker.textContent = 'TARS ▶';

  const body = document.createElement('div');
  body.className = 'msg-body tars-body';

  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  body.appendChild(cursor);
  app.streamEl = body;

  block.appendChild(speaker);
  block.appendChild(body);
  els.chatLog.appendChild(block);
  scrollToBottom();
}

function appendToken(token) {
  if (!app.streamEl) beginTARSResponse();
  const cursor = app.streamEl.querySelector('.cursor');
  const text = document.createTextNode(token);
  app.streamEl.insertBefore(text, cursor);
  scrollToBottom();
}

function finalizeResponse() {
  if (app.streamEl) {
    const cursor = app.streamEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    app.streamEl = null;
  }
}

function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

function refreshAnalytics() {
  const avgLat = app.turns > 0
    ? (app.totalLatMs / app.turns / 1000).toFixed(2) + 's'
    : '--';
  const sessionMin = Math.floor((Date.now() - app.sessionStart) / 60000);

  els.aTokIn.textContent   = fmtNum(app.totalIn);
  els.aTokOut.textContent  = fmtNum(app.totalOut);
  els.aLat.textContent     = avgLat;
  els.aTurns.textContent   = String(app.turns);
  els.aSession.textContent = `${sessionMin}m`;
  els.aLastIn.textContent  = app.lastIn  ? fmtNum(app.lastIn)  : '--';
  els.aLastOut.textContent = app.lastOut ? fmtNum(app.lastOut) : '--';
  els.aLastLat.textContent = app.lastLatMs
    ? (app.lastLatMs / 1000).toFixed(2) + 's' : '--';
  els.aModel.textContent   = app.modelName;
  els.aTts.textContent     = app.ttsEnabled ? 'ON' : 'OFF';
}

// ── Oracle (Tarot / I Ching / Art of War / Meditations / Zen) ───────────────
// Purely cosmetic flavor text generated by the same local model as chat (see
// TARSClient.generateOracleReading in src/llm/client.ts), refreshed on a timer
// in main.ts rather than per-turn. Only updates fields that are present, so a
// partial/malformed generation doesn't blank out sections that already have
// content from a previous reading.

const ORACLE_MAX_CHARS = 300;

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function applyOracleReading(reading) {
  if (reading.tarot)       els.oracleTarot.textContent       = truncate(reading.tarot, ORACLE_MAX_CHARS);
  if (reading.iching)      els.oracleIching.textContent      = truncate(reading.iching, ORACLE_MAX_CHARS);
  if (reading.artOfWar)    els.oracleArtOfWar.textContent    = truncate(reading.artOfWar, ORACLE_MAX_CHARS);
  if (reading.meditations) els.oracleMeditations.textContent = truncate(reading.meditations, ORACLE_MAX_CHARS);
  // A haiku comes back as one line with " / " between its three lines --
  // render those as real line breaks (.oracle-text has white-space: pre-wrap).
  if (reading.zen) els.oracleZen.textContent = truncate(reading.zen, ORACLE_MAX_CHARS).replace(/\s*\/\s*/g, '\n');
}

// ── Telemetry (purely cosmetic — a spectrum analyzer for the TTS voice output) ─
//
// Each bar tracks one frequency band of the actual audio being spoken (fed by
// QwenSpeaker's onSpectrum -> main.ts -> 'telemetry-spectrum' IPC). When TTS
// isn't speaking (say-fallback voice, or between turns) it idles at low random
// noise instead, same as before.

const TELEMETRY_BAR_COUNT = 10;
const TELEMETRY_IDLE_MAX_PCT = 15;
const TELEMETRY_TICK_MS = 400;
const TELEMETRY_DECAY = 0.82;   // per-tick blend toward the idle baseline
// Redraw rate for the speaking-driven animation loop -- deliberately much
// faster than the ~320ms cadence real spectrum data arrives at, so bars are
// still animating smoothly between updates instead of only moving 3x/sec.
const TELEMETRY_ANIM_MS = 40;
const TELEMETRY_ATTACK = 0.65;   // toward a louder target -- snap up fast
const TELEMETRY_RELEASE = 0.3;   // toward a quieter target -- fall a bit slower
// Lower edge (Hz) of each band in BAND_EDGES from src/audio/qwenSpeaker.ts --
// keep in sync if that array changes.
const TELEMETRY_LABELS = ['60', '150', '300', '500', '800', '1.3K', '2K', '3.2K', '5K', '8K'];

let telemetryBars = [];   // [{ fill, label, value }]
let telemetrySpeaking = false;
let telemetryTargets = null;   // latest real spectrum values while speaking

function initTelemetry() {
  const container = $('telemetry-bars');
  if (!container) return;

  for (let i = 0; i < TELEMETRY_BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'telemetry-bar';

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    track.appendChild(fill);

    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = TELEMETRY_LABELS[i] ?? '';

    bar.appendChild(track);
    bar.appendChild(label);
    container.appendChild(bar);
    telemetryBars.push({ fill, value: Math.random() * TELEMETRY_IDLE_MAX_PCT });
  }

  renderTelemetry();
  setInterval(telemetryTick, TELEMETRY_TICK_MS);
  setInterval(telemetryAnimate, TELEMETRY_ANIM_MS);
}

function renderTelemetry() {
  for (const bar of telemetryBars) {
    bar.fill.style.height = `${bar.value}%`;
  }
}

// Ambient idle noise only -- skipped while real spectrum data is driving the
// bars, so it can't fight the audio-reactive values every tick.
function telemetryTick() {
  if (telemetrySpeaking) return;
  for (const bar of telemetryBars) {
    const idleTarget = Math.random() * TELEMETRY_IDLE_MAX_PCT;
    bar.value = bar.value * TELEMETRY_DECAY + idleTarget * (1 - TELEMETRY_DECAY);
  }
  renderTelemetry();
}

// Fed by 'telemetry-spectrum' IPC events, one per streamed audio chunk
// (~3/sec). Just records the latest real target per bar -- telemetryAnimate
// does the actual frame-by-frame movement so the display isn't capped at the
// network's update rate.
function applySpectrum(bands) {
  telemetrySpeaking = true;
  telemetryTargets = bands;
}

// Runs independently of when spectrum data actually arrives (every
// TELEMETRY_ANIM_MS), easing each bar toward its latest target -- fast attack,
// slightly slower release, like a real VU meter -- so motion stays fluid
// between the ~320ms audio updates instead of only jumping 3x/sec.
function telemetryAnimate() {
  if (!telemetrySpeaking || !telemetryTargets) return;
  telemetryBars.forEach((bar, i) => {
    const target = telemetryTargets[i] ?? 0;
    const rate = target > bar.value ? TELEMETRY_ATTACK : TELEMETRY_RELEASE;
    bar.value += (target - bar.value) * rate;
  });
  renderTelemetry();
}

// Called when a turn ends (or TTS is stopped) so the bars fall back to idle
// ambient noise instead of freezing on the last audio frame.
function stopTelemetrySpectrum() {
  telemetrySpeaking = false;
  telemetryTargets = null;
}

// ── Uptime ticker ─────────────────────────────────────────────────────────────

function fmtUptime() {
  const ms = Date.now() - app.sessionStart;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

setInterval(() => {
  els.uptime.textContent = fmtUptime();
  const sessionMin = Math.floor((Date.now() - app.sessionStart) / 60000);
  els.aSession.textContent = `${sessionMin}m`;
}, 1000);

// ── Input overlay ─────────────────────────────────────────────────────────────

function showInput() {
  els.inputOverlay.classList.remove('hidden');
  els.textInput.value = '';
  setTimeout(() => els.textInput.focus(), 50);
}

function hideInput() {
  els.inputOverlay.classList.add('hidden');
  els.textInput.blur();
}

function submitTyped() {
  const text = els.textInput.value.trim();
  hideInput();
  if (text) window.tars.sendMessage(text);
}

$('send-btn').addEventListener('click', submitTyped);
$('cancel-btn').addEventListener('click', hideInput);

els.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitTyped(); }
  if (e.key === 'Escape') hideInput();
});

// ── Button controls ───────────────────────────────────────────────────────────

const talkBtn = $('btn-talk');
talkBtn.addEventListener('mousedown', () => {
  if (!app.whisperReady || app.state !== 'idle') return;
  window.tars.startRecording();
});
talkBtn.addEventListener('mouseup', () => {
  if (app.state === 'recording') window.tars.stopRecording();
});
talkBtn.addEventListener('mouseleave', () => {
  if (app.state === 'recording') window.tars.stopRecording();
});

$('btn-type').addEventListener('click', () => {
  if (['idle', 'error'].includes(app.state)) showInput();
});

function clearConversation() {
  els.chatLog.innerHTML = '';
  app.streamEl      = null;
  app.totalIn        = 0;
  app.totalOut       = 0;
  app.totalLatMs     = 0;
  app.turns          = 0;
  app.lastIn         = 0;
  app.lastOut        = 0;
  app.lastLatMs      = 0;
  refreshAnalytics();
  window.tars.clearHistory();
}

$('btn-clear').addEventListener('click', () => {
  if (['idle', 'error'].includes(app.state)) clearConversation();
});

$('btn-tts').addEventListener('click', () => window.tars.toggleTTS());
$('btn-stop').addEventListener('click', () => window.tars.stopTTS());
$('btn-quit').addEventListener('click', () => window.tars.quit());

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in input overlay
  if (!els.inputOverlay.classList.contains('hidden')) return;
  // Ignore key-repeat events — holding SPACE would otherwise immediately
  // fire start then stop before any audio is captured.
  if (e.repeat) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (!app.whisperReady) return;
      if (app.state === 'idle') window.tars.startRecording();
      break;
    case 'Enter':
      if (['idle', 'error'].includes(app.state)) showInput();
      break;
    case 'c':
    case 'C':
      if (['idle', 'error'].includes(app.state)) clearConversation();
      break;
    case 't':
    case 'T':
      window.tars.toggleTTS();
      break;
    case 's':
    case 'S':
      window.tars.stopTTS();
      break;
    case 'q':
    case 'Q':
      window.tars.quit();
      break;
  }
});

// Release SPACE to stop recording (push-to-talk)
document.addEventListener('keyup', (e) => {
  if (!els.inputOverlay.classList.contains('hidden')) return;
  if (e.key === ' ' && app.state === 'recording') {
    e.preventDefault();
    window.tars.stopRecording();
  }
});

// ── IPC event listeners ───────────────────────────────────────────────────────

window.tars.on('state-change', ({ state }) => {
  if (state === 'thinking') beginTARSResponse();
  // 'speaking' now starts as soon as the response is ready — concurrently
  // with the typing animation, not after it — so the cursor must stay until
  // the turn is actually done (idle/error), not get cut off mid-type.
  if (['idle', 'error'].includes(state)) finalizeResponse();
  if (['idle', 'error'].includes(state)) stopTelemetrySpectrum();
  applyState(state);
});

window.tars.on('whisper-progress', (info) => {
  if (info.status === 'ready') {
    app.whisperReady = true;
    els.aWhisper.textContent = '● READY';
    els.aWhisper.className = 'whisper-ready';
    els.aWhisperProg.textContent = '';
    applyState(app.state); // refresh status msg
  } else if (info.status === 'error') {
    els.aWhisper.textContent = '✖ ERROR';
    els.aWhisper.className = 'whisper-error';
    els.aWhisperProg.textContent = info.error ?? '';
  } else if (info.status === 'downloading') {
    const pct = info.progress != null ? `${info.progress.toFixed(1)}%` : '...';
    const file = (info.name ?? '').split('/').pop() ?? '';
    els.aWhisper.textContent = `◌ ${pct}`;
    els.aWhisperProg.textContent = file;
  }
});

window.tars.on('whisper-status', ({ status }) => {
  if (status === 'disabled') {
    app.whisperReady = false;
    els.aWhisper.textContent = '— OFF';
    els.aWhisper.className = 'whisper-disabled';
    // In disabled mode allow type-only
    applyState('idle');
  }
});

window.tars.on('user-message', ({ text }) => addUserMessage(text));

window.tars.on('token', ({ text }) => appendToken(text));

window.tars.on('response-complete', ({ stats, turns }) => {
  app.totalIn   += stats.promptTokens;
  app.totalOut  += stats.completionTokens;
  app.totalLatMs += stats.latencyMs;
  app.turns      = turns;
  app.lastIn     = stats.promptTokens;
  app.lastOut    = stats.completionTokens;
  app.lastLatMs  = stats.latencyMs;
  if (stats.modelName) app.modelName = stats.modelName;
  refreshAnalytics();
});

window.tars.on('system-message', ({ text }) => addSystemMsg(text));

window.tars.on('oracle-reading', (reading) => applyOracleReading(reading));

window.tars.on('telemetry-spectrum', (bands) => applySpectrum(bands));

// The initial getConfig() check can catch the Qwen server mid-load (still
// loading MLX weights) and report "unreachable" -- main.ts retries in the
// background and pushes corrections here as they resolve.
window.tars.on('voice-info', ({ engine, voice }) => {
  els.aVoiceEngine.textContent = engine;
  els.aVoiceLabel.textContent = voice;
  els.cfgVoice.textContent = voice;
});

window.tars.on('tts-state', ({ enabled }) => {
  app.ttsEnabled = enabled;
  els.ttsLbl.textContent = `TTS:${enabled ? 'ON' : 'OFF'}`;
  els.aTts.textContent   = enabled ? 'ON' : 'OFF';
});

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  const cfg = await window.tars.getConfig();

  // Populate header
  els.cfgHumor.textContent   = cfg.humor + '%';
  els.cfgHonesty.textContent = cfg.honesty + '%';
  els.cfgUrl.textContent     = cfg.lmStudioUrl.replace('http://', '').replace('/v1', '');
  els.cfgVoice.textContent   = cfg.voiceLabel;

  // Populate analytics
  els.aHumor.textContent   = cfg.humor + '%';
  els.aHonesty.textContent = cfg.honesty + '%';
  els.aTts.textContent     = cfg.ttsEnabled ? 'ON' : 'OFF';
  els.ttsLbl.textContent   = `TTS:${cfg.ttsEnabled ? 'ON' : 'OFF'}`;
  els.aModel.textContent   = cfg.chatModel;
  els.aVoiceEngine.textContent = cfg.voiceEngine;
  els.aVoiceLabel.textContent  = cfg.voiceLabel;
  app.ttsEnabled           = cfg.ttsEnabled;
  app.modelName            = cfg.chatModel;

  if (!cfg.whisperEnabled) {
    app.whisperReady = false;
    els.aWhisper.textContent = '— OFF';
    els.aWhisper.className   = 'whisper-disabled';
  }

  applyState('idle');
  refreshAnalytics();
  initTelemetry();
});
