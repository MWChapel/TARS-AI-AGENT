"""
Local Qwen3-TTS (MLX) voice-clone streaming server for TARS.

Loads Qwen3-TTS-12Hz-1.7B-Base via the native MLX build (mlx-audio, not the
PyTorch/transformers package) once at startup, then streams synthesis as raw
PCM16LE bytes over HTTP as they're generated -- audio starts playing in well
under a second instead of waiting for the whole response to finish.

Run this as its own long-lived process (like LM Studio or the Hermes agent) --
the Node app just talks to it over HTTP, it doesn't spawn or manage it.

    POST /synthesize   {"text": "..."}  ->  raw PCM16LE bytes, chunked as generated
    GET  /health                        ->  {"status": "ok", ...}
"""

import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from dotenv import load_dotenv
from mlx_audio.tts.utils import load_model

# Picks up tts-server/.env -- this is a separate Python process from the Node
# app, so it needs its own env file rather than sharing the root .env.
load_dotenv()

PORT = int(os.environ.get("TARS_TTS_PORT", "8008"))
MODEL_ID = os.environ.get("TARS_TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit")
LANGUAGE = os.environ.get("TARS_TTS_LANGUAGE", "English")
SAMPLE_RATE = int(os.environ.get("TARS_TTS_SAMPLE_RATE", "24000"))
STREAMING_INTERVAL = float(os.environ.get("TARS_TTS_STREAMING_INTERVAL", "0.32"))

# Named voice (CustomVoice models only) -- one of: serena, vivian, uncle_fu,
# ryan, aiden, ono_anna, sohee, eric, dylan. When set, this takes over from
# voice cloning entirely (below) -- requires TARS_TTS_MODEL to be a CustomVoice
# variant, e.g. mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit.
VOICE = os.environ.get("TARS_TTS_VOICE", "").strip()

if VOICE and "customvoice" not in MODEL_ID.lower():
    print(
        f"[tars-tts] WARNING: TARS_TTS_VOICE={VOICE!r} is set but TARS_TTS_MODEL "
        f"({MODEL_ID}) doesn't look like a CustomVoice variant -- generation will "
        f"likely fail. Use e.g. mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit.",
        flush=True,
    )

# Official Qwen3-TTS demo reference clip -- only used when TARS_TTS_VOICE isn't
# set. Swap these for your own 3+ second clip + exact transcript to clone a
# different voice. mlx-audio needs a local file (unlike the transformers
# package, it can't fetch a URL itself), so a URL here gets downloaded once
# and cached.
REF_AUDIO_SOURCE = os.environ.get(
    "TARS_TTS_REF_AUDIO",
    "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-TTS-Repo/clone.wav",
)
REF_TEXT = os.environ.get(
    "TARS_TTS_REF_TEXT",
    "Okay. Yeah. I resent you. I love you. I respect you. "
    "But you know what? You blew it! And thanks to you.",
)

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "tars-agent", "tts")
os.makedirs(CACHE_DIR, exist_ok=True)


def resolve_ref_audio(source: str) -> str:
    if not source.startswith("http://") and not source.startswith("https://"):
        return source

    local_path = os.path.join(CACHE_DIR, "ref_audio.wav")
    if not os.path.exists(local_path):
        print(f"[tars-tts] downloading reference clip to {local_path}...", flush=True)
        urllib.request.urlretrieve(source, local_path)
    return local_path


print("[tars-tts] starting up...", flush=True)
print(f"[tars-tts] loading {MODEL_ID} (mlx)...", flush=True)
model = load_model(MODEL_ID)
print("[tars-tts] model ready", flush=True)

REF_AUDIO = None
if VOICE:
    print(f"[tars-tts] using named voice: {VOICE}", flush=True)
else:
    REF_AUDIO = resolve_ref_audio(REF_AUDIO_SOURCE)
    print(f"[tars-tts] using reference clip: {REF_AUDIO}", flush=True)

print(
    f"[tars-tts] ready on http://127.0.0.1:{PORT} "
    f"(sample_rate={SAMPLE_RATE}, streaming_interval={STREAMING_INTERVAL}s)",
    flush=True,
)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[tars-tts] {self.address_string()} - {fmt % args}", flush=True)

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # This server is single-threaded (see the __main__ note below) --
        # without this, a kept-alive /health connection can leave the main
        # accept loop stuck waiting on that idle socket's next request,
        # making a genuinely new connection (e.g. another health check) look
        # like the server is unreachable even though the process is fine.
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _write_chunk(self, data: bytes):
        # Manual HTTP/1.1 chunked-transfer-encoding framing: <hex length>\r\n<data>\r\n
        self.wfile.write(f"{len(data):x}\r\n".encode("ascii"))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_ID,
                "voice": VOICE or None,
                "backend": "mlx",
                "sample_rate": SAMPLE_RATE,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""

        try:
            body = json.loads(raw or b"{}")
            text = (body.get("text") or "").strip()
            if not text:
                self._send_json(400, {"error": "missing 'text'"})
                return

            self.send_response(200)
            self.send_header("Content-Type", "audio/l16")
            self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
            self.send_header("Transfer-Encoding", "chunked")
            # Force a fresh connection per request rather than keep-alive --
            # this is a single-client local server, one request at a time,
            # and avoids any ambiguity in connection-reuse state around the
            # manually-framed chunked body above.
            self.send_header("Connection", "close")
            self.end_headers()

            gen_kwargs = dict(
                text=text,
                lang_code=LANGUAGE,
                stream=True,
                streaming_interval=STREAMING_INTERVAL,
            )
            if VOICE:
                gen_kwargs["voice"] = VOICE
            else:
                gen_kwargs["ref_audio"] = REF_AUDIO
                gen_kwargs["ref_text"] = REF_TEXT

            for result in model.generate(**gen_kwargs):
                audio = np.asarray(result.audio, dtype=np.float32)
                pcm16 = np.clip(audio * 32767.0, -32768, 32767).astype("<i2").tobytes()
                if pcm16:
                    self._write_chunk(pcm16)
                    self.wfile.flush()

            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        except (BrokenPipeError, ConnectionResetError):
            print("[tars-tts] client disconnected mid-stream", file=sys.stderr, flush=True)
        except Exception as err:  # noqa: BLE001 -- report inference errors to caller
            print(f"[tars-tts] synthesis error: {err}", file=sys.stderr, flush=True)
            try:
                self._send_json(500, {"error": str(err)})
            except Exception:  # noqa: BLE001 -- headers may already be sent
                pass


if __name__ == "__main__":
    # Single-threaded on purpose: MLX's GPU command stream is tied to the
    # thread that loaded the model. ThreadingHTTPServer handles each request
    # on a new thread, which breaks MLX generation ("There is no Stream(gpu, 0)
    # in current thread"). This is a single-client local server -- requests
    # are already effectively serialized in practice, so this costs nothing.
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()
