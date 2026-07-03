# TARS Qwen3-TTS server

A small local HTTP server that loads a [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) model via its native **MLX** build ([mlx-audio](https://github.com/Blaizzy/mlx-audio), not the PyTorch/`transformers` package) once, then **streams** speech synthesis to the main TARS app as it's generated.

**This is not LM Studio.** LM Studio can't run this model — it's not a standard chat-completions model. This runs as its own separate process, the same way LM Studio does; the Node app just talks to it over HTTP (`QWEN_TTS_URL`, default `http://127.0.0.1:8008`).

Two ways to pick a voice, both configured via `TARS_TTS_MODEL` + one more variable (see Configuration below):

- **Voice cloning** (`Base` model, the default) — clones whatever reference clip you point it at (`TARS_TTS_REF_AUDIO`/`TARS_TTS_REF_TEXT`). No built-in voices; quality depends entirely on the reference clip.
- **Named voices** (`CustomVoice` model) — 9 built-in speakers, no reference clip needed at all. Set `TARS_TTS_VOICE` to one of them. See [Voices](#voices) below.

## Setup

1. **Create a virtualenv and install dependencies** (from this directory):

   ```bash
   python3.13 -m venv venv   # or python3.12 — either works
   source venv/bin/activate
   pip install -r requirements.txt
   ```

   This pulls in `mlx-audio` (which pulls in `mlx` itself), `soundfile`, and `python-dotenv`. Runs natively on Apple Silicon's GPU via MLX — no CUDA, no PyTorch, no `flash-attn` needed.

2. **Configure** (optional — defaults to voice cloning with the official demo clip if skipped):

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` — see [Configuration](#configuration-environment-variables) below. This is a separate process from the main Node app, so it reads its own `.env` file from this directory, not the root one.

3. **Enable it in the main app's `.env`**:

   ```
   QWEN_TTS_ENABLED=true
   ```

4. **Run it**:

   - **Electron (`npm start` / `npm run dev`)**: nothing to do — the main process starts this server automatically at launch (`src/audio/ttsServerManager.ts`) and stops it on quit. If a server is already running on `QWEN_TTS_URL` (e.g. you started it manually, or a previous run left one up), that one is reused instead of starting a second — it won't spawn a duplicate.
   - **Terminal UI (`npm run cli`)**: start it yourself first, in its own terminal:

     ```bash
     source venv/bin/activate
     python server.py
     ```

     First run downloads the MLX model weights from Hugging Face and, for voice-cloning mode, caches the reference clip locally. Wait for `[tars-tts] ready on http://127.0.0.1:8008 ...` before starting TARS. (The auto-start above is Electron-only for now.)

   Either way, if this server isn't running or unreachable when TARS tries to speak, it automatically falls back to the macOS `say` voice — nothing else breaks.

## Configuration (environment variables)

Set these in `tts-server/.env` (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `TARS_TTS_PORT` | `8008` | Port to listen on — must match `QWEN_TTS_URL` in the main app's `.env` |
| `TARS_TTS_MODEL` | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit` | Hugging Face model id (MLX build). Use a `-Base-` variant for voice cloning, or a `-CustomVoice-` variant with `TARS_TTS_VOICE` set for named voices. The 8-bit quantized variant generates at ~3x real-time on Apple Silicon — the bf16 variant is ~0.7x real-time (slower than playback), which causes audible stutter/gaps on longer responses as `sox` outruns generation. Stick with 8-bit unless you've verified bf16 keeps up on your hardware. |
| `TARS_TTS_VOICE` | unset | Named speaker — **only works with a `-CustomVoice-` model**. See [Voices](#voices). When set, this takes over from voice cloning entirely (`TARS_TTS_REF_*` below are ignored). |
| `TARS_TTS_LANGUAGE` | `English` | Passed to `generate()` as `lang_code` |
| `TARS_TTS_SAMPLE_RATE` | `24000` | Must match what the model actually outputs — only change this if you swap in a different model |
| `TARS_TTS_STREAMING_INTERVAL` | `0.32` | Seconds of audio per streamed chunk — smaller is lower-latency per chunk but more per-chunk overhead |
| `TARS_TTS_REF_AUDIO` | official demo clip URL | Reference clip to clone the voice from — **only used when `TARS_TTS_VOICE` is unset** (Base model). URL (downloaded once, cached in `~/.cache/tars-agent/tts/`) or local path |
| `TARS_TTS_REF_TEXT` | demo clip's transcript | Exact transcript of `TARS_TTS_REF_AUDIO` — must match precisely for good cloning quality |

## Voices

The `CustomVoice` model ships 9 named speakers (set `TARS_TTS_MODEL=mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` and `TARS_TTS_VOICE=<name>`):

`serena` · `vivian` · `uncle_fu` · `ryan` · `aiden` · `ono_anna` · `sohee` · `eric` · `dylan`

`ryan`, `eric`, `aiden`, and `dylan` are English-speaking male voices — the most likely fits for TARS. `uncle_fu`/`ono_anna`/`sohee` skew Chinese/Japanese/Korean. Generate a quick sample to audition one before committing:

```bash
source venv/bin/activate
python3 -c "
from mlx_audio.tts.utils import load_model
import soundfile as sf, numpy as np
model = load_model('mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')
chunks = [np.asarray(r.audio, dtype=np.float32) for r in model.generate(
    text='This is a test of TARS.', voice='ryan', lang_code='English', stream=True)]
sf.write('sample.wav', np.concatenate(chunks), 24000)
"
afplay sample.wav
```

## API

```
GET  /health       -> {"status": "ok", "model": "...", "voice": "ryan" | null, "backend": "mlx", "sample_rate": 24000}
POST /synthesize   {"text": "..."}  ->  raw PCM16LE audio, HTTP chunked transfer-encoding,
                                        streamed as each ~0.32s segment is generated
```

`/synthesize` is **not** a single WAV response — it streams raw signed 16-bit little-endian PCM at `TARS_TTS_SAMPLE_RATE`, framed with standard HTTP/1.1 chunked transfer-encoding. The Node client (`src/audio/qwenSpeaker.ts`) pipes these bytes directly into a long-lived `sox` process's stdin (`sox -t raw ... - -d`) for real-time playback as they arrive — it never buffers the whole response or writes a temp WAV file.

## Why single-threaded (`HTTPServer`, not `ThreadingHTTPServer`)

MLX's GPU command stream is tied to the thread that loaded the model. `ThreadingHTTPServer` handles each request on a new thread, which breaks generation with `There is no Stream(gpu, 0) in current thread`. This is a single-client local server anyway — request handling is already effectively serialized in practice — so single-threaded costs nothing.

## Notes

- **Full end-to-end latency, measured**: ~150-500ms from request to the first PCM bytes reaching the audio player, for a 400-character response — down from ~65+ seconds when the whole response was synthesized as one blocking request (the original PyTorch/`transformers`/MPS approach this replaced).
- **Generation now runs faster than real-time**: the 8-bit model measured consistently at ~3.0-3.2x real-time across repeated runs (e.g. ~7s of compute to produce ~22s of audio). This matters more than it might sound — the earlier bf16 model measured ~0.7x real-time (*slower* than playback), which meant `sox`'s stdin would periodically run dry waiting for the next chunk on longer responses, causing audible stutter that got worse the longer a response went on, and could look like audio "breaking off" partway through. The 8-bit model structurally can't hit that failure mode, since it always stays ahead of what's being played.
- If a chunk somehow can't be played (e.g. `sox` exits unexpectedly), the Node client (`src/audio/qwenSpeaker.ts`) aborts the request immediately rather than continuing to read (and discard) the rest of a response the server would otherwise keep generating uselessly.
- The server sends `Connection: close` on every response — this is a single-client, one-request-at-a-time local server, so there's no reason to risk HTTP keep-alive connection-reuse edge cases with the manually-framed chunked body.
- Verified end-to-end: captured the actual streamed output (not just the raw model call) and round-tripped it through this project's own Whisper transcriber — got a near-exact match against the original text with no missing words or chunk-boundary artifacts. Also stress-tested 9 sequential long-response turns (3 rounds × 3 paragraph-length responses) with no errors and no degradation in the real-time factor.
- **`TARS_TTS_LANGUAGE` was silently a no-op until this fix**: `model.generate()`'s actual parameter is `lang_code`, not `language` — the server was passing `language=...`, which `generate()` swallows via `**kwargs` without applying it, so every request ran with the `lang_code="auto"` default regardless of this variable. Fixed by passing `lang_code=TARS_TTS_LANGUAGE` instead; verified via a live `/synthesize` call and Whisper round-trip after the fix.
