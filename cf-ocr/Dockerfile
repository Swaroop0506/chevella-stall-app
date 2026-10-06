# cf-ocr — PP-OCRv5 via RapidOCR / ONNX Runtime. CPU only, no GPU, no API keys.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # RapidOCR caches its ONNX weights here; baked in below so the container never
    # needs network access at runtime.
    RAPIDOCR_MODEL_DIR=/models \
    OMP_NUM_THREADS=2

WORKDIR /app

# libglib is all the *headless* OpenCV build needs. The rest are here because RapidOCR
# declares a dependency on plain `opencv-python`, so pip installs it alongside the headless
# build we asked for, and whichever one ends up providing `cv2` may then try to dlopen the
# GUI stack. Shipping these few libs is more robust than fighting pip's resolver.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libglib2.0-0 libgl1 libxcb1 libxext6 libsm6 libxrender1 curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Install, then force the headless build to win: it is the one that is actually safe to
# import in a container, and it keeps the image smaller.
RUN pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless==4.10.0.84 \
 && python -c "import cv2; print('cv2', cv2.__version__, 'imports cleanly')"

COPY src ./src

# Download + warm the PP-OCRv5 weights at build time. Skipping this would make the first
# scan at the stall hang for 30+ seconds pulling models over the venue wifi — exactly when
# you cannot afford it. Importing the app's own params keeps the baked models and the
# runtime selection from drifting apart.
RUN mkdir -p /models \
 && python -c "import numpy as np; \
from rapidocr import RapidOCR; \
from src.main import _engine_params; \
e = RapidOCR(params=_engine_params()); \
e(np.full((64, 256, 3), 255, dtype=np.uint8)); \
print('PP-OCRv5 models cached')"

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

# One worker on purpose: the ONNX session is not thread-safe and a stall has a handful of
# phones, not hundreds. Scale by raising this only if you also raise the CPU limit.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
