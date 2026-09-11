# Debian, not Alpine: PyTorch publishes no musl wheels, so torch cannot be
# pip-installed on Alpine at all. This is precisely why separation lives in
# its own image instead of the API's.
FROM python:3.11-slim AS base

# ffmpeg is how demucs decodes mp4/m4a/webm containers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch. The default index resolves a CUDA build many times larger
# for no benefit on a CPU host.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the model weights in. Downloading ~80MB on first request would make the
# first reel of every deployment time out.
ENV TORCH_HOME=/opt/torch
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

COPY app.py ./

# Model cache must be readable by the unprivileged user.
RUN useradd --create-home --uid 10001 separator \
    && chown -R separator:separator /opt/torch
USER separator

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
