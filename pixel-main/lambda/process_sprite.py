"""
Sprite post-processing pipeline — rembg + split + flip + assemble.

As a module (imported by avatar_lambda.py):
    from process_sprite import process_image
    sheet = process_image(raw_pil_image)

Standalone scanner:
    python process_sprite.py [--raw output/raw] [--out output/sheets]

    Scans --raw for *.png files that don't have a matching *.png in --out,
    processes each one and writes the 256×128 sprite sheet.
"""

import argparse
import logging
import os
import io
import time
from pathlib import Path

import httpx
from PIL import Image

# Load .env from lambda/ dir if python-dotenv is available
_dotenv_path = Path(__file__).parent / ".env"
try:
    from dotenv import load_dotenv
    load_dotenv(_dotenv_path)
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REMBG_API_URL  = os.environ.get("REMBG_API_URL", "https://api.remove.bg/v1.0/removebg")
_rembg_keys_raw = os.environ.get("REMBG_API_KEYS", "") or os.environ.get("REMBG_API_KEY", "")
REMBG_API_KEYS  = [k.strip() for k in _rembg_keys_raw.split(",") if k.strip()]
_rembg_key_index = 0

CELL = 32  # final sprite cell size in px

DEFAULT_RAW_DIR = Path(__file__).parent.parent / "output" / "raw"
DEFAULT_OUT_DIR = Path(__file__).parent.parent / "output" / "sheets"


# ===================================================================
# Background removal
# ===================================================================
def remove_background(image: Image.Image) -> Image.Image:
    """rembg API with multi-key rotation on 429. Returns RGBA image."""
    global _rembg_key_index
    if not REMBG_API_KEYS:
        raise RuntimeError("No REMBG_API_KEY(S) configured")

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_bytes = buf.getvalue()
    logger.info(f"  rembg: sending {len(image_bytes)//1024}KB ({len(REMBG_API_KEYS)} key(s))")

    for attempt in range(len(REMBG_API_KEYS)):
        key = REMBG_API_KEYS[_rembg_key_index % len(REMBG_API_KEYS)]
        with httpx.Client(timeout=120.0) as http:
            resp = http.post(
                REMBG_API_URL,
                headers={"x-api-key": key},
                files={"image": ("sprite.png", image_bytes, "image/png")},
                data={"format": "png"},
            )
        if resp.status_code == 429 and attempt < len(REMBG_API_KEYS) - 1:
            _rembg_key_index += 1
            logger.warning(f"  429 rate-limited, rotating to key #{_rembg_key_index % len(REMBG_API_KEYS) + 1}/{len(REMBG_API_KEYS)}")
            time.sleep(2)
            continue
        resp.raise_for_status()
        result = Image.open(io.BytesIO(resp.content)).convert("RGBA")
        logger.info(f"  rembg: done → {result.size}")
        return result

    raise RuntimeError("All rembg API keys exhausted (429)")


def remove_background_simple(image: Image.Image, threshold: int = 240) -> Image.Image:
    """Fallback: replace white/near-white pixels with transparency."""
    logger.warning("  Using simple threshold background removal (no rembg API)")
    image = image.convert("RGBA")
    # Use Pillow point() per-channel — no giant Python list, constant memory
    r, g, b, a = image.split()
    mask = Image.merge("RGB", (r, g, b)).convert("L").point(lambda x: 0 if x > threshold else 255)
    image.putalpha(mask)
    return image


# ===================================================================
# Grid split
# ===================================================================
def split_grid(img: Image.Image, rows: int = 4, cols: int = 4) -> list:
    """Returns cells[row][col] = PIL Image resized to CELL×CELL."""
    w, h = img.size
    cw, ch = w // cols, h // rows
    logger.info(f"  split: {w}×{h} → {cols}×{rows} cells ({cw}×{ch} → {CELL}×{CELL})")
    cells = []
    for r in range(rows):
        row = []
        for c in range(cols):
            box = (c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)
            cell = img.crop(box).resize((CELL, CELL), Image.NEAREST)
            row.append(cell)
        cells.append(row)
    return cells


# ===================================================================
# Flip helper
# ===================================================================
def flip_h(img: Image.Image) -> Image.Image:
    return img.transpose(Image.FLIP_LEFT_RIGHT)


# ===================================================================
# Assemble 8×4 sheet
# ===================================================================
#  AI grid layout (Gemini output):
#    Row 0 (down):   idle, walkA, sit, wave
#    Row 1 (right):  idle, walkA, sit, wave
#    Row 2 (up):     idle, walkA, sit, wave
#    Row 3 (extras): walkB_right, sleep, eat, laugh
#
#  Final sheet (game client):
#    Cols: idle(0) stepA(1) stepB(2) sit(3) wave(4) sleep(5) eat(6) laugh(7)
#    Rows: down(0) left(1) up(2) right(3)
#
def assemble_sheet(cells: list) -> Image.Image:
    sheet = Image.new("RGBA", (8 * CELL, 4 * CELL), (0, 0, 0, 0))

    sleep_cell  = cells[3][1]
    eat_cell    = cells[3][2]
    laugh_cell  = cells[3][3]
    walkB_right = cells[3][0]  # opposite-leg walk (right-facing)

    for final_row, ai_row, is_flip in [
        (0, 0, False),  # down  = AI row 0 as-is
        (1, 1, True),   # left  = flip of right row (AI row 1)
        (2, 2, False),  # up    = AI row 2 as-is
        (3, 1, False),  # right = AI row 1 as-is
    ]:
        idle  = cells[ai_row][0]
        stepA = cells[ai_row][1]
        sit   = cells[ai_row][2]
        wave  = cells[ai_row][3]

        if is_flip:
            idle  = flip_h(idle)
            stepA = flip_h(stepA)
            sit   = flip_h(sit)
            wave  = flip_h(wave)

        # stepB computed after is_flip to avoid double-flip
        if final_row in (0, 2):
            stepB = flip_h(stepA)       # down/up: mirror of (already-flipped) stepA
        elif final_row == 1:
            stepB = flip_h(walkB_right) # left: flip right-facing walkB
        else:
            stepB = walkB_right         # right: use walkB_right directly

        for c, cell_img in enumerate([idle, stepA, stepB, sit, wave, sleep_cell, eat_cell, laugh_cell]):
            sheet.paste(cell_img, (c * CELL, final_row * CELL))

    logger.info(f"  assembled: {sheet.size}")
    return sheet


# ===================================================================
# Main pipeline — takes a raw PIL image, returns finished sheet
# ===================================================================
def process_image(raw_img: Image.Image) -> Image.Image:
    """rembg → split → assemble. Returns 256×128 RGBA sprite sheet."""
    # Downsize before processing — 4K is wasteful when final cells are 32×32
    max_dim = 512
    if max(raw_img.size) > max_dim:
        logger.info(f"  downsizing {raw_img.size} → {max_dim}×{max_dim}")
        raw_img = raw_img.resize((max_dim, max_dim), Image.LANCZOS)
    try:
        clean = remove_background(raw_img)
    except Exception as e:
        logger.warning(f"  rembg failed ({e}), using threshold fallback")
        clean = remove_background_simple(raw_img)

    cells = split_grid(clean)
    return assemble_sheet(cells)


# ===================================================================
# Standalone scanner
# ===================================================================
def scan_and_process(raw_dir: Path, out_dir: Path):
    """Process any raw PNG in raw_dir that doesn't have a sheet in out_dir."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    raws = sorted(p for ext in ("*.png", "*.jpg", "*.jpeg") for p in raw_dir.glob(ext))
    if not raws:
        logger.info(f"No raw images in {raw_dir}")
        return

    # Output is always .png regardless of input extension
    pending = [p for p in raws if not (out_dir / (p.stem + ".png")).exists()]
    logger.info(f"Found {len(raws)} raw image(s), {len(pending)} unprocessed")

    for raw_path in pending:
        out_path = out_dir / (raw_path.stem + ".png")
        logger.info(f"Processing: {raw_path.name}")
        try:
            t0 = time.time()
            raw_img = Image.open(raw_path)
            logger.info(f"  loaded: {raw_img.size}")
            sheet = process_image(raw_img)
            sheet.save(out_path, format="PNG")
            logger.info(f"  saved → {out_path}  ({time.time()-t0:.1f}s)")
        except Exception as e:
            logger.error(f"  FAILED: {e}")

    done = sum(1 for p in raws if (out_dir / p.name).exists())
    logger.info(f"Done — {done}/{len(raws)} sheets in {out_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scan raw Gemini outputs and assemble sprite sheets")
    parser.add_argument("--raw", default=str(DEFAULT_RAW_DIR), help="Folder with raw PNG files")
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR), help="Folder to write sprite sheets")
    args = parser.parse_args()
    scan_and_process(Path(args.raw), Path(args.out))
