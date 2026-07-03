# TARS Qwen3-TTS server

A small local HTTP server that loads [Qwen3-TTS-12Hz-1.7B-Base](https://github.com/QwenLM/Qwen3-TTS) via its native **MLX** build ([mlx-audio](https://github.com/Blaizzy/mlx-audio), not the PyTorch/`transformers` package) once, then **streams** voice-clone speech synthesis to the main TARS app as it's generated.

**This is not LM Studio.** LM Studio can't run this model — it's not a standard chat-completions model. This runs as its own separate process, the same way LM Studio does; the Node app just talks to it over HTTP (`QWEN_TTS_URL`, default `http://127.0.0.1:8008`).

The **Base** model variant only does *voice cloning* — there are no built-in named voices. By default this server clones the official Qwen3-TTS demo reference clip. To use a different voice, set `TARS_TTS_REF_AUDIO` (a URL or local file path — a URL is downloaded once and cached locally, since the MLX loader needs a local file) and `TARS_TTS_REF_TEXT` (the exact transcript of that clip) to your own 3+ second reference clip.

## Setup

1. **Create a virtualenv and install dependencies** (from this directory):

   ```bash
   python3.13 -m venv venv   # or python3.12 — either works
   source venv/bin/activate
   pip install -r requirements.txt
   ```

   This pulls in `mlx-audio` (which pulls in `mlx` itself) and `soundfile`. Runs natively on Apple Silicon's GPU via MLX — no CUDA, no PyTorch, no `flash-attn` needed.

2. **Run the server**:

   ```bash
   source venv/bin/activate
   python server.py
   ```

   First run downloads the MLX model weights from Hugging Face (`mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit`) and caches the reference clip locally. Wait for `[tars-tts] ready on http://127.0.0.1:8008 ...` before starting TARS.

3. **Enable it in the main app's `.env`**:

   ```
   QWEN_TTS_ENABLED=true
   ```

   Then run `npm run cli` or `npm start` as usual. If this server isn't running or unreachable, TARS automatically falls back to the macOS `say` voice — nothing else breaks.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `TARS_TTS_PORT` | `8008` | Port to listen on — must match `QWEN_TTS_URL` in the main app's `.env` |
| `TARS_TTS_MODEL` | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit` | Hugging Face model id (MLX build). The 8-bit quantized variant generates at ~3x real-time on Apple Silicon — the bf16 variant is ~0.7x real-time (slower than playback), which causes audible stutter/gaps on longer responses as `sox` outruns generation. Stick with 8-bit unless you've verified bf16 keeps up on your hardware. |
| `TARS_TTS_LANGUAGE` | `English` | Passed to `generate()` |
| `TARS_TTS_SAMPLE_RATE` | `24000` | Must match what the model actually outputs — only change this if you swap in a different model |
| `TARS_TTS_STREAMING_INTERVAL` | `0.32` | Seconds of audio per streamed chunk — smaller is lower-latency per chunk but more per-chunk overhead |
| `TARS_TTS_REF_AUDIO` | official demo clip URL | Reference clip to clone the voice from — URL (downloaded once, cached in `~/.cache/tars-agent/tts/`) or local path |
| `TARS_TTS_REF_TEXT` | demo clip's transcript | Exact transcript of `TARS_TTS_REF_AUDIO` — must match precisely for good cloning quality |

## API

```
GET  /health       -> {"status": "ok", "model": "...", "backend": "mlx", "sample_rate": 24000}
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
