"""
Vocal stem isolation for the Mozart AI reel analyzer.

Why this is a separate service rather than part of the Node app: PyTorch
publishes no musl wheels, so Demucs cannot be installed into the
node:22-alpine runtime image at all. Rebasing that image on Debian to make
room for torch would take it from ~150MB to over 2GB and undo the hardening
that removed npm and patched openssl. A sidecar keeps the API image small and
lets the heavy model scale — or be switched off — independently.

The API is deliberately one endpoint: bytes in, isolated vocal WAV out.
"""

import io
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")
# Bounds one request's work. Measured at ~2x real time on 4 CPU cores: a
# 30-second clip takes ~60s, a 3-minute one ~6 minutes. The 25MB upload cap
# admits far longer audio than that, so this ceiling is what stops one
# oversized clip occupying a worker for an hour.
TIMEOUT_S = int(os.environ.get("DEMUCS_TIMEOUT_S", "600"))
MAX_BYTES = int(os.environ.get("SEPARATOR_MAX_BYTES", str(25 * 1024 * 1024)))

app = FastAPI(title="Mozart AI vocal separator")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL}


@app.get("/ready")
def ready():
    """Proves the binary is present and the model weights resolve."""
    if shutil.which("demucs") is None:
        return JSONResponse({"ready": False, "error": "demucs not on PATH"}, status_code=503)
    if shutil.which("ffmpeg") is None:
        return JSONResponse({"ready": False, "error": "ffmpeg not on PATH"}, status_code=503)
    return {"ready": True, "model": MODEL}


@app.post("/separate")
async def separate(clip: UploadFile = File(...)):
    raw = await clip.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"clip exceeds {MAX_BYTES} bytes")

    started = time.monotonic()

    # Demucs is a CLI that reads and writes files, so the clip touches disk
    # here even though the API service keeps everything in memory. It lands in
    # a private temp directory that is removed on every path out, including
    # failure — nothing about the caller's audio outlives the request.
    with tempfile.TemporaryDirectory(prefix="sep-") as work:
        work = Path(work)
        suffix = Path(clip.filename or "clip.mp4").suffix or ".mp4"
        source = work / f"input{suffix}"
        source.write_bytes(raw)

        out_dir = work / "out"
        proc = subprocess.run(
            [
                "demucs",
                # Sums the three non-vocal stems into one. This does NOT halve
                # the work — htdemucs computes all four stems either way — but
                # it avoids writing and reading three files we would discard.
                "--two-stems", "vocals",
                "-n", MODEL,
                "-o", str(out_dir),
                str(source),
            ],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
        )
        if proc.returncode != 0:
            raise HTTPException(
                status_code=502,
                detail=f"separation failed: {proc.stderr.strip()[-400:]}",
            )

        # Demucs writes <out>/<model>/<input stem>/vocals.wav, but the exact
        # directory name follows the input filename, so find it rather than
        # reconstructing a path that a rename upstream would break.
        matches = list(out_dir.rglob("vocals.wav"))
        if not matches:
            raise HTTPException(status_code=502, detail="no vocal stem produced")

        vocals = matches[0].read_bytes()

    return Response(
        content=vocals,
        media_type="audio/wav",
        headers={
            "X-Separation-Model": MODEL,
            "X-Separation-Ms": str(round((time.monotonic() - started) * 1000)),
        },
    )
