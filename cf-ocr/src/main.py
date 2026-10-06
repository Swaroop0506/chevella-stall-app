"""cf-ocr — local visiting-card OCR service.

PP-OCRv5 weights served through RapidOCR's ONNX Runtime build. No API key, no network
call, no per-scan cost: the models are baked into the image and everything runs on CPU.

The accuracy strategy is best-of-N rather than one-shot. preprocess.build_variants hands
back several renderings of the same photo; we read each one, score the results, and keep
the best. If even the best read looks poor we retry the three cardinal rotations, which
catches cards photographed sideways. parse.parse_card then turns the winning text into
fields.
"""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import preprocess
from .parse import parse_card

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("cf-ocr")

ENGINE_NAME = "rapidocr-ppocrv5-onnx"
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "15")) * 1024 * 1024

# Model selection, measured on real card photos rather than taken from the defaults.
#
# RapidOCR ships PP-OCRv4 (Chinese) as its default, and that model does not emit spaces in
# Latin text: "SRI LAKSHMI TRADERS" comes back as "SRILAKSHMITRADERS". That is fatal here,
# because the company and person-name heuristics in parse.py are built on word boundaries.
# PP-OCRv5 fixes it — on the benchmark card it recovered 16 of 19 spaces against v4's 2 —
# and it is also faster, so this is pinned explicitly.
#
# The "server" variants are deliberately NOT used. They score marginally higher per
# character but their detector splits a large heading into one box per word
# ("SRI" / "LAKSHMI" / "TRADERS"), which destroys exactly the line-level grouping the
# field extractor depends on, and they are 4-6x slower on CPU.
def _engine_params():
    from rapidocr import ModelType, OCRVersion

    return {
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.MOBILE,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
        # Cards carry small print (GSTIN, addresses); keeping weak lines and letting the
        # parser judge them beats discarding them at the engine.
        "Global.text_score": float(os.environ.get("TEXT_SCORE", "0.4")),
    }

# Below this mean confidence we assume the orientation is wrong and try rotations.
ROTATION_RETRY_BELOW = float(os.environ.get("ROTATION_RETRY_BELOW", "0.62"))
MIN_BLOCKS_BEFORE_RETRY = int(os.environ.get("MIN_BLOCKS_BEFORE_RETRY", "4"))

app = FastAPI(
    title="cf-ocr",
    version="1.0.0",
    description="Visiting-card OCR for the Chevella Farms stall app",
)

_engine = None
_engine_err: str | None = None
# RapidOCR's session is not thread-safe; serialise through a single worker.
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr")


def engine():
    global _engine, _engine_err
    if _engine is None and _engine_err is None:
        try:
            from rapidocr import RapidOCR

            t0 = time.time()
            _engine = RapidOCR(params=_engine_params())
            log.info("PP-OCRv5 (mobile) ready in %.1fs", time.time() - t0)
        except Exception as exc:  # pragma: no cover
            _engine_err = f"{type(exc).__name__}: {exc}"
            log.exception("engine failed to load")
    if _engine is None:
        raise HTTPException(503, detail=f"OCR engine unavailable: {_engine_err}")
    return _engine


@app.on_event("startup")
def warm() -> None:
    """Load the models at boot, not on the first card, so the first scan is not slow."""
    try:
        eng = engine()
        eng(np.full((64, 256, 3), 255, dtype=np.uint8))
        log.info("warm-up pass complete")
    except Exception as exc:
        log.warning("warm-up skipped: %s", exc)


# --------------------------------------------------------------------------- engine glue


def _normalise_output(result) -> list[dict]:
    """RapidOCR has shipped three different return shapes; accept all of them."""
    blocks: list[dict] = []

    # 3.x: an object with .boxes / .txts / .scores
    boxes = getattr(result, "boxes", None)
    txts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if txts is not None:
        for i, text in enumerate(txts or []):
            box = boxes[i] if boxes is not None and i < len(boxes) else []
            score = scores[i] if scores is not None and i < len(scores) else 0.9
            blocks.append({
                "text": str(text),
                "score": float(score),
                "box": [[float(p[0]), float(p[1])] for p in (box if box is not None else [])],
            })
        return blocks

    # 1.x / 2.x: (list_of_[box, text, score], elapse) or just the list
    payload = result[0] if isinstance(result, tuple) else result
    for item in payload or []:
        if not item:
            continue
        box, text, score = (list(item) + [None, None, None])[:3]
        blocks.append({
            "text": str(text or ""),
            "score": float(score or 0.9),
            "box": [[float(p[0]), float(p[1])] for p in (box or [])],
        })
    return blocks


def _read(img: np.ndarray) -> list[dict]:
    return _normalise_output(engine()(img))


def _quality(blocks: list[dict]) -> tuple[float, float]:
    """(ranking score, mean confidence).

    Ranking weights confidence by how much text it covers: a variant that reads two words
    at 0.99 is worse than one that reads the whole card at 0.88.
    """
    real = [b for b in blocks if b["text"].strip()]
    if not real:
        return 0.0, 0.0
    chars = sum(len(b["text"].strip()) for b in real)
    weighted = sum(b["score"] * len(b["text"].strip()) for b in real)
    mean = weighted / chars if chars else 0.0
    # sqrt keeps a long low-confidence read from beating a solid shorter one outright.
    return mean * (chars ** 0.5), mean


def _best_read(img: np.ndarray, level: str) -> dict:
    attempts: list[dict] = []

    for variant in preprocess.build_variants(img, level=level):
        blocks = _read(variant.image)
        rank, mean = _quality(blocks)
        attempts.append({"variant": variant.name, "blocks": blocks, "rank": rank, "mean": mean})
        log.info("variant=%s blocks=%d mean=%.3f rank=%.1f",
                 variant.name, len(blocks), mean, rank)

    best = max(attempts, key=lambda a: a["rank"]) if attempts else {
        "variant": "none", "blocks": [], "rank": 0.0, "mean": 0.0,
    }

    # Sideways card? The reader will have produced little text at low confidence.
    if best["mean"] < ROTATION_RETRY_BELOW or len(best["blocks"]) < MIN_BLOCKS_BEFORE_RETRY:
        log.info("retrying rotations (mean=%.3f blocks=%d)", best["mean"], len(best["blocks"]))
        straight = preprocess.normalise(img)
        for variant in preprocess.rotations(straight):
            blocks = _read(variant.image)
            rank, mean = _quality(blocks)
            log.info("variant=%s blocks=%d mean=%.3f", variant.name, len(blocks), mean)
            if rank > best["rank"]:
                best = {"variant": variant.name, "blocks": blocks, "rank": rank, "mean": mean}

    best["attempts"] = [
        {"variant": a["variant"], "blocks": len(a["blocks"]), "mean": round(a["mean"], 4)}
        for a in attempts
    ]
    return best


# --------------------------------------------------------------------------- endpoints


@app.get("/health")
def health() -> dict:
    ready = _engine is not None
    return {
        "ok": ready or _engine_err is None,
        "engine": ENGINE_NAME,
        "models_loaded": ready,
        "error": _engine_err,
    }


@app.post("/v1/card")
async def read_card(
    file: UploadFile = File(...),
    level: str = Form("full"),
) -> JSONResponse:
    """Full pipeline: preprocess -> best-of-N OCR -> field extraction."""
    started = time.time()
    data = await file.read()
    if not data:
        raise HTTPException(400, detail="empty_file")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, detail=f"file_too_large (max {MAX_BYTES // 1024 // 1024} MB)")

    try:
        img = preprocess.decode(data)
    except Exception as exc:
        raise HTTPException(400, detail=f"undecodable_image: {exc}") from exc

    quality = preprocess.quality_report(img)

    loop_level = "fast" if level == "fast" else "full"
    best = await _run(lambda: _best_read(img, loop_level))

    blocks = best["blocks"]
    parsed = parse_card(blocks)

    # A blurry photo is the one case where we override the parser's optimism.
    needs_review = parsed.needs_review or "blurry" in quality["warnings"]
    notes = list(parsed.notes)
    if quality["warnings"]:
        notes.append("image_" + ",".join(quality["warnings"]))

    ms = int((time.time() - started) * 1000)
    log.info("card read in %dms variant=%s conf=%.3f review=%s",
             ms, best["variant"], best["mean"], needs_review)

    return JSONResponse({
        "engine": ENGINE_NAME,
        "version": _rapidocr_version(),
        "ms": ms,
        "variant_used": best["variant"],
        "attempts": best.get("attempts", []),
        "confidence": round(best["mean"], 4),
        "raw_text": "\n".join(b["text"] for b in blocks),
        "blocks": blocks,
        "fields": parsed.fields,
        "field_confidence": parsed.confidence,
        "needs_review": needs_review,
        "notes": notes,
        "image_quality": quality,
    })


@app.post("/v1/text")
async def read_text(file: UploadFile = File(...)) -> JSONResponse:
    """Plain OCR, no field extraction — handy for debugging a card that parses badly."""
    data = await file.read()
    if not data:
        raise HTTPException(400, detail="empty_file")
    img = preprocess.decode(data)
    blocks = await _run(lambda: _read(preprocess.normalise(img)))
    _rank, mean = _quality(blocks)
    return JSONResponse({
        "engine": ENGINE_NAME,
        "confidence": round(mean, 4),
        "raw_text": "\n".join(b["text"] for b in blocks),
        "blocks": blocks,
    })


@app.post("/v1/parse")
async def parse_only(payload: dict) -> JSONResponse:
    """Re-runs field extraction over blocks you already have. Used by the parser tests."""
    parsed = parse_card(payload.get("blocks") or [])
    return JSONResponse({
        "fields": parsed.fields,
        "field_confidence": parsed.confidence,
        "needs_review": parsed.needs_review,
        "notes": parsed.notes,
    })


async def _run(fn):
    import asyncio

    return await asyncio.get_running_loop().run_in_executor(_pool, fn)


def _rapidocr_version() -> str:
    try:
        from importlib.metadata import version

        return version("rapidocr")
    except Exception:
        return "unknown"
