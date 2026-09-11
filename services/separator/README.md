# Vocal separator sidecar

Isolates the vocal stem from a reel before it is transcribed.

## Why it is a separate service

Tuned transcription parameters (`lib/transcription.js`) help on clean speech
but cannot recover a vocal buried under a beat — the model is hearing the
mix. Separating the vocal first is the fix that addresses that directly.

It cannot run inside the API process:

- **PyTorch publishes no musl wheels**, so `torch` cannot be pip-installed
  into the `node:22-alpine` runtime image at all.
- Rebasing that image on Debian to fit torch would take it from ~150MB to
  over 2GB, and undo the hardening that removed npm and patched openssl.

So separation runs in its own Debian image and the API talks to it over HTTP.

## It is optional, and it never breaks transcription

`SEPARATOR_URL` unset → the API transcribes the original mix, exactly as it
behaved before this existed. Nobody has to run a multi-gigabyte container.

When it is set, the API still falls back to the original audio if the sidecar
is down, slow, or returns an implausible stem. Separation is an accuracy
improvement, not a dependency: a caller always gets their analysis.

The response reports which happened via `vocals_isolated` and
`separation_skipped`.

## Running it

```bash
docker compose --profile separation up
```

The API reaches it at `http://vocal-separator:8000`; the port is not
published on the host.

## API

| Route | Purpose |
|---|---|
| `GET /health` | Process is up |
| `GET /ready` | `demucs` and `ffmpeg` resolve on PATH |
| `POST /separate` | multipart `clip` → `audio/wav` vocal stem |

## Cost

Measured on 4 CPU cores with `htdemucs`: **~2x real time**. A 4-second clip
took 8.1s warm; that extrapolates to ~60s for a 30-second reel and ~120s for
a 60-second one. This is added latency on every reel analysis, and it is the
real cost of the accuracy — budget for it before enabling the sidecar.

It is also why `SEPARATOR_TIMEOUT_MS` defaults to 600000 (10 minutes). An
earlier 120s default would have timed out on any reel longer than a minute.
A timeout is not a failure: the API falls back to transcribing the mix.

`--two-stems vocals` is used to avoid writing three stems that get discarded.
It does **not** halve the work — htdemucs computes all four stems either way.

Model weights are baked into the image so the first request does not pay for
an ~80MB download.
