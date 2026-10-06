"""Image preparation for visiting-card OCR.

A card photo taken at a stall is the worst case for OCR: handheld, often at an angle,
under mixed hall lighting, sometimes glossy. None of that is fixable with a single
"clean up the image" step, because the fix that rescues a dark photo ruins a glossy one.

So this module does not try to produce *the* best image. It produces a small set of
candidate renderings, and main.py runs the engine over them and keeps whichever one the
engine reads most confidently. That costs a few hundred milliseconds of CPU and buys
several percentage points of character accuracy on real-world photos.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps

try:  # iPhones hand out HEIC unless the user changed a setting
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover - optional
    pass


# PP-OCRv5's recogniser is trained at 48 px text height. Text on a card photographed from
# 20 cm lands around 20-30 px, so a 2x upscale genuinely helps; past ~2600 px on the long
# edge it stops helping and just costs time.
TARGET_LONG_EDGE = 2000
MAX_LONG_EDGE = 2600


@dataclass
class Variant:
    name: str
    image: np.ndarray


def decode(data: bytes) -> np.ndarray:
    """bytes -> BGR ndarray, with EXIF rotation already applied."""
    pil = Image.open(io.BytesIO(data))
    pil = ImageOps.exif_transpose(pil)
    if pil.mode not in ("RGB", "L"):
        pil = pil.convert("RGB")
    arr = np.array(pil)
    if arr.ndim == 2:
        return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def _resize_long_edge(img: np.ndarray, target: int) -> np.ndarray:
    h, w = img.shape[:2]
    long_edge = max(h, w)
    if long_edge == 0:
        return img
    scale = target / long_edge
    if 0.95 < scale < 1.05:
        return img
    # INTER_CUBIC on upscale keeps thin strokes joined; AREA is right for downscale.
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=interp)


def normalise(img: np.ndarray) -> np.ndarray:
    """Scale into the band the recogniser likes, without ever exceeding MAX_LONG_EDGE."""
    h, w = img.shape[:2]
    if max(h, w) > MAX_LONG_EDGE:
        return _resize_long_edge(img, MAX_LONG_EDGE)
    if max(h, w) < TARGET_LONG_EDGE:
        return _resize_long_edge(img, TARGET_LONG_EDGE)
    return img


def deskew(img: np.ndarray, max_angle: float = 12.0) -> tuple[np.ndarray, float]:
    """Straightens small rotations using the dominant text-line angle.

    Only small angles: a card held at 40 degrees is a rotation problem, not a skew problem,
    and main.py handles that by retrying the four cardinal orientations.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.bitwise_not(gray)
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]

    # Dilate horizontally so each text line becomes one blob whose angle we can measure.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3))
    dil = cv2.dilate(thresh, kernel, iterations=2)

    contours, _ = cv2.findContours(dil, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    angles: list[float] = []
    for c in contours:
        if cv2.contourArea(c) < 400:
            continue
        (_, (w, h), angle) = cv2.minAreaRect(c)
        if w < h:  # normalise so angle describes the long axis
            angle += 90
        if angle > 90:
            angle -= 180
        if abs(angle) <= max_angle:
            angles.append(angle)

    if len(angles) < 3:
        return img, 0.0

    angle = float(np.median(angles))
    if abs(angle) < 0.4:
        return img, 0.0

    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    # Grow the canvas so the corners are not clipped off.
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    rotated = cv2.warpAffine(
        img, m, (nw, nh),
        flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE,
    )
    return rotated, angle


def _clahe(img: np.ndarray) -> np.ndarray:
    """Local contrast lift in LAB space — rescues shadowed and backlit photos."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.4, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def _sharpen(img: np.ndarray) -> np.ndarray:
    """Unsharp mask — recovers strokes lost to a slightly soft autofocus."""
    blur = cv2.GaussianBlur(img, (0, 0), 1.4)
    return cv2.addWeighted(img, 1.6, blur, -0.6, 0)


def _binarise(img: np.ndarray) -> np.ndarray:
    """Adaptive threshold. Wins on low-ink, low-contrast and coloured-background cards."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, 7, 60, 60)
    bw = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11
    )
    return cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)


def _glare_tamed(img: np.ndarray) -> np.ndarray:
    """Pulls back blown-out highlights on laminated / glossy cards."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    # Compress only the top of the value range, leave mid-tones alone.
    v = np.where(v > 200, (200 + (v.astype(np.int16) - 200) * 0.35).astype(np.uint8), v)
    toned = cv2.cvtColor(cv2.merge((h, s, v)), cv2.COLOR_HSV2BGR)
    return _clahe(toned)


def build_variants(img: np.ndarray, level: str = "full") -> list[Variant]:
    """Candidate renderings, cheapest and most-likely-to-win first.

    level="fast" keeps it to two passes for when latency matters more than the last
    half-percent of accuracy.
    """
    base = normalise(img)
    straight, _angle = deskew(base)
    straight = normalise(straight)

    variants = [
        Variant("deskew", straight),
        Variant("deskew+clahe", _clahe(straight)),
    ]
    if level == "fast":
        return variants

    variants += [
        Variant("deskew+sharpen", _sharpen(straight)),
        Variant("deskew+clahe+sharpen", _sharpen(_clahe(straight))),
        Variant("binarised", _binarise(straight)),
        Variant("deglared", _glare_tamed(straight)),
    ]
    return variants


def rotations(img: np.ndarray) -> list[Variant]:
    """The three non-identity cardinal rotations, for a card photographed sideways."""
    return [
        Variant("rot90", cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)),
        Variant("rot180", cv2.rotate(img, cv2.ROTATE_180)),
        Variant("rot270", cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)),
    ]


def sharpness(img: np.ndarray) -> float:
    """Variance of Laplacian. Below ~60 the photo is too blurry to trust; the app warns."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def brightness(img: np.ndarray) -> float:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(gray.mean())


def quality_report(img: np.ndarray) -> dict:
    sharp = sharpness(img)
    bright = brightness(img)
    h, w = img.shape[:2]
    warnings = []
    if sharp < 60:
        warnings.append("blurry")
    if bright < 55:
        warnings.append("too_dark")
    if bright > 215:
        warnings.append("overexposed")
    if min(h, w) < 600:
        warnings.append("low_resolution")
    return {
        "width": w,
        "height": h,
        "sharpness": round(sharp, 1),
        "brightness": round(bright, 1),
        "megapixels": round(w * h / 1e6, 2),
        "warnings": warnings,
    }
