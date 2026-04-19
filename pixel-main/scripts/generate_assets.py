#!/usr/bin/env python3
"""
Pixel Social — Asset Generator

Generates tile and furniture sprites using Gemini API.
Furniture gets background removed via rembg API.
Outputs PNGs + auto-generates manifest tileset/furniture blocks.

Usage:
  python generate_assets.py
"""

import json
import logging
import os
import sys
import time
from pathlib import Path
from io import BytesIO

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("generate_assets")

try:
    from google import genai
    from google.genai import types
except ImportError:
    log.error("Install the Gemini SDK: pip install google-genai")
    sys.exit(1)

try:
    import httpx
except ImportError:
    log.error("Install httpx: pip install httpx")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    log.error("Install Pillow: pip install Pillow")
    sys.exit(1)

# Load .env from scripts dir if python-dotenv is available
# Load .env from lambda/ dir (project's Python env config)
_dotenv_path = (Path(__file__).parent.parent / "lambda" / ".env")
try:
    from dotenv import load_dotenv
    load_dotenv(_dotenv_path)
except ImportError:
    pass  # python-dotenv optional — env vars must come from parent shell otherwise


GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
REMBG_API_URL = os.environ.get("REMBG_API_URL", "")

# Support multiple rembg keys: REMBG_API_KEY or comma-separated REMBG_API_KEYS
_rembg_keys_raw = os.environ.get("REMBG_API_KEYS", "") or os.environ.get("REMBG_API_KEY", "")
REMBG_API_KEYS = [k.strip() for k in _rembg_keys_raw.split(",") if k.strip()]
_rembg_key_index = 0

MODEL = "gemini-3.1-flash-image-preview"

STYLE_SUFFIX = (
    "Pixel art in the exact style of Stardew Valley. "
    "16-bit pixel art, clean pixel edges, no anti-aliasing, "
    "no text, no labels, no watermark."
)

OUT_DIR = Path(__file__).parent.parent / "client"
TILES_DIR = OUT_DIR / "tiles"
FURNITURE_DIR = OUT_DIR / "furniture"

ASSETS = {
    "tiles": [
        {"id": "wall_stone",   "prompt": "A stone wall tile, front view, gray cobblestone brick pattern, dark mortar lines", "walkable": False},
        {"id": "wall_window",  "prompt": "A stone wall tile with a small arched window showing blue sky, front view, gray cobblestone", "walkable": False},
        {"id": "floor_wood",   "prompt": "A wooden floor tile, top-down view, warm oak planks with subtle grain, seamless pattern", "walkable": True},
        {"id": "floor_stone",  "prompt": "A stone floor tile, top-down view, gray flagstone slabs with subtle cracks, seamless pattern", "walkable": True},
        {"id": "door_wood",    "prompt": "A dark wooden door tile, front view, arched doorway with iron handle, stone frame", "walkable": True},
        {"id": "rug_center",   "prompt": "A red and gold patterned rug tile, top-down view, woven Persian carpet texture", "walkable": True},
        # new
        {"id": "wall_brick",   "prompt": "A red brick wall tile, front view, classic rectangular brick pattern with white mortar lines, warm terracotta tones", "walkable": False},
        {"id": "floor_carpet", "prompt": "A soft dark green carpet tile, top-down view, plush velvet texture, seamless pattern, rich forest green", "walkable": True},
        {"id": "floor_marble", "prompt": "A white marble floor tile, top-down view, elegant veined marble with light gray streaks, polished surface, seamless pattern", "walkable": True},
    ],
    "furniture": [
        {"id": "chair_wood_01",   "prompt": "A small wooden chair, 3/4 top-down isometric perspective, simple design", "gridWidth": 1, "gridHeight": 1, "sittable": True},
        {"id": "table_round_01",  "prompt": "A small round wooden table, 3/4 top-down isometric perspective, simple design", "gridWidth": 1, "gridHeight": 1, "sittable": False},
        {"id": "sofa_blue_01",    "prompt": "A cozy blue two-seat sofa with cushions, 3/4 top-down isometric perspective", "gridWidth": 2, "gridHeight": 1, "sittable": True},
        {"id": "lamp_tall_01",    "prompt": "A tall standing floor lamp with warm yellow shade, 3/4 top-down isometric perspective", "gridWidth": 1, "gridHeight": 1, "sittable": False},
        {"id": "bookshelf_01",    "prompt": "A wide wooden bookshelf full of colorful books, 3/4 top-down isometric perspective", "gridWidth": 2, "gridHeight": 1, "sittable": False},
        # new
        {"id": "desk_01",         "prompt": "A wide wooden writing desk with a small lamp and papers on top, 3/4 top-down isometric perspective", "gridWidth": 2, "gridHeight": 1, "sittable": False},
        {"id": "desk_chair_01",   "prompt": "A dark leather office chair with armrests on wheels, 3/4 top-down isometric perspective", "gridWidth": 1, "gridHeight": 1, "sittable": True},
        {"id": "bar_counter_01",  "prompt": "A wooden bar counter with a flat top surface and decorative front panel, 3/4 top-down isometric perspective, cafe style", "gridWidth": 2, "gridHeight": 1, "sittable": False},
        {"id": "bar_stool_01",    "prompt": "A tall round wooden bar stool, 3/4 top-down isometric perspective, simple metal legs", "gridWidth": 1, "gridHeight": 1, "sittable": True},
        {"id": "plant_potted_01", "prompt": "A small potted tropical plant with broad green leaves in a terracotta pot, 3/4 top-down isometric perspective", "gridWidth": 1, "gridHeight": 1, "sittable": False},
        {"id": "fireplace_01",    "prompt": "A stone fireplace with a warm glowing fire inside, 3/4 top-down isometric perspective, brick surround, mantel shelf", "gridWidth": 2, "gridHeight": 1, "sittable": False},
        {"id": "piano_01",        "prompt": "An upright black piano with white and black keys visible, 3/4 top-down isometric perspective, elegant design", "gridWidth": 2, "gridHeight": 1, "sittable": False},
        {"id": "coffee_table_01", "prompt": "A low rectangular coffee table in dark wood, 3/4 top-down isometric perspective, simple modern design", "gridWidth": 1, "gridHeight": 1, "sittable": False},
    ]
}

TILE_SIZE = 32


def generate_image(client, prompt: str, aspect_ratio: str = "1:1") -> Image.Image:
    full_prompt = f"{prompt}. {STYLE_SUFFIX}"
    log.debug(f"  Generating ({aspect_ratio})...")
    response = client.models.generate_content(
        model=MODEL,
        contents=full_prompt,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(aspect_ratio=aspect_ratio),
        ),
    )
    for part in response.candidates[0].content.parts:
        if hasattr(part, "inline_data") and part.inline_data is not None:
            return Image.open(BytesIO(part.inline_data.data))
    raise RuntimeError("No image in API response")


def remove_background(image: Image.Image) -> Image.Image:
    global _rembg_key_index
    buf = BytesIO()
    image.save(buf, format="PNG")
    img_bytes = buf.getvalue()
    log.info("  Removing background...")
    attempts = len(REMBG_API_KEYS)
    for attempt in range(attempts):
        key = REMBG_API_KEYS[_rembg_key_index % len(REMBG_API_KEYS)]
        with httpx.Client(timeout=120.0) as http:
            response = http.post(
                REMBG_API_URL,
                headers={"x-api-key": key},
                files={"image": ("image.png", img_bytes, "image/png")},
                data={"format": "png"},
            )
        if response.status_code == 429 and attempt < attempts - 1:
            _rembg_key_index += 1
            log.warning(f"  429 rate-limited, rotating to key #{_rembg_key_index % len(REMBG_API_KEYS) + 1}/{len(REMBG_API_KEYS)}")
            time.sleep(2)
            continue
        response.raise_for_status()
        return Image.open(BytesIO(response.content)).convert("RGBA")
    raise RuntimeError("All rembg API keys exhausted (429)")


def resize_tile(image: Image.Image, size: int = TILE_SIZE) -> Image.Image:
    return image.resize((size, size), Image.NEAREST)


def resize_furniture(image: Image.Image, grid_w: int, grid_h: int) -> Image.Image:
    return image.resize((grid_w * TILE_SIZE, grid_h * TILE_SIZE), Image.NEAREST)


def pick_aspect_ratio(grid_w: int, grid_h: int) -> str:
    ratio = grid_w / grid_h
    options = [("1:1",1.0),("5:4",1.25),("4:3",1.333),("3:2",1.5),("16:9",1.778),("21:9",2.333),("4:1",4.0),("4:5",0.8),("3:4",0.75),("2:3",0.667),("9:16",0.5625),("1:4",0.25)]
    best = min(options, key=lambda o: abs(o[1] - ratio))
    return best[0]


def main():
    if not GOOGLE_API_KEY:
        log.critical("ERROR: Set GOOGLE_API_KEY in scripts/.env")
        sys.exit(1)

    client = genai.Client(api_key=GOOGLE_API_KEY)
    use_rembg = bool(REMBG_API_KEYS and REMBG_API_URL)
    if not use_rembg:
        log.warning("REMBG not configured — furniture will keep original background")
    else:
        log.info(f"REMBG configured with {len(REMBG_API_KEYS)} API key(s)")

    TILES_DIR.mkdir(parents=True, exist_ok=True)
    FURNITURE_DIR.mkdir(parents=True, exist_ok=True)

    # Tiles
    log.info(f"TILES — {len(ASSETS['tiles'])} items")
    for tile in ASSETS["tiles"]:
        tid = tile["id"]
        out_path = TILES_DIR / f"{tid}.png"
        if out_path.exists():
            log.info(f"  [{tid}] already exists, skipping")
            continue
        log.info(f"  [{tid}] {tile['prompt'][:60]}...")
        try:
            raw = generate_image(client, tile["prompt"], "1:1")
            final = resize_tile(raw)
            final.save(out_path, "PNG")
            log.info(f"  [{tid}] saved → {out_path} ({final.size[0]}x{final.size[1]})")
        except Exception as e:
            log.error(f"  [{tid}] FAILED: {e}")
        time.sleep(1)

    # Furniture
    log.info(f"FURNITURE — {len(ASSETS['furniture'])} items")
    for item in ASSETS["furniture"]:
        iid = item["id"]
        out_path = FURNITURE_DIR / f"{iid}.png"
        if out_path.exists():
            log.info(f"  [{iid}] already exists, skipping")
            continue
        gw, gh = item.get("gridWidth", 1), item.get("gridHeight", 1)
        aspect = pick_aspect_ratio(gw, gh)
        log.info(f"  [{iid}] {gw}x{gh} grid cells")
        raw_path = FURNITURE_DIR / f"{iid}_raw.png"
        try:
            if raw_path.exists():
                log.info(f"  [{iid}] loading cached raw image")
                raw = Image.open(raw_path)
            else:
                raw = generate_image(client, item["prompt"], aspect)
                raw.save(raw_path, "PNG")
                log.info(f"  [{iid}] saved raw → {raw_path}")
            if use_rembg:
                clean = remove_background(raw)
            else:
                clean = raw.convert("RGBA")
            final = resize_furniture(clean, gw, gh)
            final.save(out_path, "PNG")
            log.info(f"  [{iid}] saved → {out_path} ({final.size[0]}x{final.size[1]})")
            if raw_path.exists():
                raw_path.unlink()
        except Exception as e:
            log.error(f"  [{iid}] FAILED: {e} (raw image kept at {raw_path})")
        time.sleep(1)

    # Build manifest
    tileset = {}
    for tile in ASSETS["tiles"]:
        tileset[tile["id"]] = {"sprite": f"/tiles/{tile['id']}.png", "walkable": tile.get("walkable", True)}
    furniture = {}
    for item in ASSETS["furniture"]:
        gw, gh = item.get("gridWidth", 1), item.get("gridHeight", 1)
        furniture[item["id"]] = {
            "sprite": f"/furniture/{item['id']}.png",
            "pixelWidth": gw * TILE_SIZE, "pixelHeight": gh * TILE_SIZE,
            "gridWidth": gw, "gridHeight": gh,
            "sittable": item.get("sittable", False), "zLayer": 2,
        }
    # spriteSheet layout — must match avatar_lambda.py assemble_sheet()
    # Cols: idle(0) stepA(1) stepB(2) sit(3) wave(4) sleep(5) eat(6) laugh(7)
    # Rows: down(0) left(1) up(2) right(3)
    manifest = {
        "tileset": tileset,
        "furniture": furniture,
        "spriteSheet": {
            "cellSize": TILE_SIZE, "cols": 8, "rows": 4,
            "colMap": {"idle": 0, "stepA": 1, "stepB": 2, "sit": 3, "wave": 4, "sleep": 5, "eat": 6, "laugh": 7},
            "rowMap": {"down": 0, "left": 1, "up": 2, "right": 3},
        },
        "tileSize": TILE_SIZE,
    }
    manifest_path = OUT_DIR / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    log.info(f"Wrote {manifest_path}")

    tiles_ok = sum(1 for t in ASSETS["tiles"] if (TILES_DIR / f"{t['id']}.png").exists())
    furn_ok = sum(1 for f in ASSETS["furniture"] if (FURNITURE_DIR / f"{f['id']}.png").exists())
    log.info(f"DONE — {tiles_ok}/{len(ASSETS['tiles'])} tiles, {furn_ok}/{len(ASSETS['furniture'])} furniture")
    log.info(f"Output: {OUT_DIR.absolute()}")


if __name__ == "__main__":
    main()
