"""
Avatar generation Lambda — Gemini image gen (gemini-3-pro-image-preview, 4K) → process_sprite → S3.

Input:  { "playerId": "abc123", "description": "blue spiky hair, red hoodie, glasses" }
Output: { "avatarUrl": "https://{cdn}/avatars/abc123.png" }

Local test:
    python avatar_lambda.py "blue spiky hair, red hoodie"
    → saves output/raw/<id>.png and output/sheets/<id>.png
    → open client/test_client.html in Chrome, pick output/sheets/
"""

import json
import os
import io
import logging
import time
from pathlib import Path

import boto3
from google import genai
from google.genai import types
from PIL import Image

from botocore.exceptions import ClientError

from process_sprite import process_image, DEFAULT_RAW_DIR, DEFAULT_OUT_DIR


class AvatarLimitReached(Exception):
    """Raised when a non-admin player hits the per-user generation cap."""
    def __init__(self, existing_url: str, gen_count: int):
        super().__init__("AVATAR_LIMIT_REACHED")
        self.existing_url = existing_url
        self.gen_count = gen_count

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
IMAGE_GEN_MODEL   = os.environ.get("IMAGE_GEN_MODEL", "gemini-3-pro-image-preview")
GCP_PROJECT       = os.environ.get("GOOGLE_CLOUD_PROJECT", "nlp-school-488918")
GCP_LOCATION      = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
S3_BUCKET         = os.environ.get("S3_BUCKET", "pixel-social-assets")
CLOUDFRONT_DOMAIN = os.environ.get("CLOUDFRONT_DOMAIN", "")

# Per-user generation cap. Admins bypass the cap and aren't counted.
MAX_GENERATIONS   = 2
ADMIN_PLAYER_IDS  = {pid.strip() for pid in os.environ.get("ADMIN_PLAYER_IDS", "").split(",") if pid.strip()}

# ---------------------------------------------------------------------------
# Prompt template
# ---------------------------------------------------------------------------
PROMPT_TEMPLATE = """A 4×4 pixel art sprite sheet in the Stardew Valley style. 4 columns, 4 rows, 16 equal square cells on a pure white background. Same chibi character in every cell: {description}. 16-bit pixel art, clean pixel edges, no anti-aliasing, no text, no labels.
Row 1 — front view, the character faces the camera: Cell 1: Standing idle, arms at sides, looking straight at the camera. Cell 2: Walking toward the camera facing front directly. Body perfectly centered facing the camera, not turned to either side. Cell 3: Seated pose, knees bent, hands on lap, feet dangling. No chair, no furniture, just the body in a sitting position on white background. Cell 4: Standing, one hand raised waving at the camera.
Row 2 — facing → right. The character's face is on the RIGHT side of each cell. The back of the character's body is on the LEFT side of each cell: Cell 1: Standing idle. Cell 2: Walking to right. Cell 3: Seated pose, knees bent, hands on lap. No chair, no furniture, just the body in a sitting position on white background. Cell 4: One hand raised waving facing right.
Row 3 — rear view, camera sees the character's back and the back of their head: Cell 1: Standing idle, back to camera. Cell 2: Walking away from camera, right leg forward, left arm forward. Cell 3: Seated pose from behind, knees bent. No chair, no furniture, just the body in a sitting position on white background. Cell 4: Back to camera, one hand raised waving.
Row 4 — extra poses: Cell 1: Same facing → right direction as Row 2, only different walking pose of arm and leg, face is still towards the RIGHT side of cell. Cell 2: Lying flat asleep, eyes closed, head at top of cell, feet at bottom of cell, arms resting at sides. Cell 3: Facing camera, both hands at mouth eating food, happy face. Cell 4: Facing camera, mouth wide open laughing, eyes squished shut, body leaning back.
Identical proportions, colors, and style in every cell. Cells clearly separated with even spacing."""


# ===================================================================
# Image generation
# ===================================================================
MAX_RETRIES = 3
RETRY_DELAYS = [5, 15, 30]  # seconds between retries

def generate_image(prompt: str) -> Image.Image:
    """Call Gemini with retries for transient errors. Returns a PIL Image."""
    logger.info(f"  model={IMAGE_GEN_MODEL}  size=4K  aspect=1:1  vertex=({GCP_PROJECT}/{GCP_LOCATION})")
    client = genai.Client(vertexai=True, project=GCP_PROJECT, location=GCP_LOCATION)

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"  Gemini request attempt {attempt}/{MAX_RETRIES}")
            response = client.models.generate_content(
                model=IMAGE_GEN_MODEL,
                contents=[prompt],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                    image_config=types.ImageConfig(
                        aspect_ratio="1:1",
                        image_size="4K",
                    ),
                ),
            )

            for part in response.parts:
                if part.inline_data:
                    img = Image.open(io.BytesIO(part.inline_data.data))
                    logger.info(f"  received: {img.size}  mode={img.mode}")
                    return img

            raise RuntimeError("Gemini returned no image data")

        except Exception as e:
            last_error = e
            err_str = str(e)
            is_retryable = any(code in err_str for code in ["503", "429", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "overloaded"])
            if is_retryable and attempt < MAX_RETRIES:
                delay = RETRY_DELAYS[attempt - 1]
                logger.warning(f"  Attempt {attempt} failed (retryable): {err_str[:120]}. Retrying in {delay}s...")
                time.sleep(delay)
            else:
                raise last_error


# ===================================================================
# Full pipeline (Lambda use)
# ===================================================================
def _read_gen_count(s3, key: str) -> int:
    """Returns existing gen-count (0 if object doesn't exist)."""
    try:
        obj = s3.head_object(Bucket=S3_BUCKET, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return 0
        raise
    # Legacy objects without metadata are treated as "already generated once".
    return int(obj.get("Metadata", {}).get("gen-count", "1"))


def generate_avatar(player_id: str, description: str) -> dict:
    """prompt → Gemini → process_sprite → S3. Returns { avatarUrl }.

    Non-admin players are capped at MAX_GENERATIONS total. Count is stored as
    S3 object metadata (gen-count) on avatars/{playerId}.png — no DB needed.
    """
    safe_desc = description.strip()[:300]
    key       = f"avatars/{player_id}.png"
    is_admin  = player_id in ADMIN_PLAYER_IDS

    s3 = boto3.client("s3")
    current_count = 0 if is_admin else _read_gen_count(s3, key)
    if not is_admin and current_count >= MAX_GENERATIONS:
        existing_url = f"https://{CLOUDFRONT_DOMAIN}/{key}"
        logger.info(f"  LIMIT REACHED player={player_id} count={current_count} → {existing_url}")
        raise AvatarLimitReached(existing_url, current_count)

    full_prompt = PROMPT_TEMPLATE.format(description=safe_desc)
    logger.info(f"[1/3] Generating image  player={player_id} (gen #{current_count + 1}, admin={is_admin}): {safe_desc[:80]}...")
    raw_img = generate_image(full_prompt)

    logger.info("[2/3] Processing sprite (rembg → split → assemble)...")
    sheet = process_image(raw_img)

    logger.info("[3/3] Uploading to S3...")
    buf = io.BytesIO()
    sheet.save(buf, format="PNG")

    # Admins always write gen-count=0 so they stay unlimited even if removed from admin list.
    new_count = 0 if is_admin else current_count + 1
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=buf.getvalue(),
        ContentType="image/png",
        CacheControl="max-age=86400",
        Metadata={"gen-count": str(new_count)},
    )
    logger.info(f"  → s3://{S3_BUCKET}/{key}  gen-count={new_count}")

    return {"avatarUrl": f"https://{CLOUDFRONT_DOMAIN}/{key}"}


# ===================================================================
# Lambda handler
# ===================================================================
def handler(event, context):
    if 'httpMethod' in event or 'requestContext' in event:
        try:
            body = json.loads(event.get('body', '{}'))
        except Exception:
            return {'statusCode': 400, 'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'Bad JSON in request body'})}

        description = body.get('description', '').strip()
        if not description:
            return {'statusCode': 400, 'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'description is required'})}

        import uuid
        player_id = body.get('playerId') or f'gen-{uuid.uuid4().hex[:12]}'

        try:
            result = generate_avatar(player_id, description)
            return {'statusCode': 200, 'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, 'body': json.dumps(result)}
        except AvatarLimitReached as e:
            return {'statusCode': 409, 'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'AVATAR_LIMIT_REACHED', 'avatarUrl': e.existing_url, 'genCount': e.gen_count})}
        except Exception as e:
            logger.error(f"Failed: {e}", exc_info=True)
            return {'statusCode': 500, 'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': str(e)})}

    try:
        player_id   = event["playerId"]
        description = event.get("description", "a friendly character with colorful clothes")
        return generate_avatar(player_id, description)
    except AvatarLimitReached as e:
        return {"error": "AVATAR_LIMIT_REACHED", "avatarUrl": e.existing_url, "genCount": e.gen_count}
    except Exception as e:
        logger.error(f"Failed: {e}", exc_info=True)
        return {"error": str(e)}


# ===================================================================
# Local test — python avatar_lambda.py "blue spiky hair, red hoodie"
# ===================================================================
if __name__ == "__main__":
    import sys

    desc      = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "spiky blue hair, light skin, red hoodie, round glasses"
    player_id = f"local_{int(time.time())}"

    raw_dir = DEFAULT_RAW_DIR
    out_dir = DEFAULT_OUT_DIR
    raw_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    safe_desc   = desc.strip()[:300]
    full_prompt = PROMPT_TEMPLATE.format(description=safe_desc)

    logger.info(f"=== LOCAL TEST  id={player_id} ===")
    logger.info(f"  desc: {safe_desc}")

    logger.info("[1/3] Generating image via Gemini (4K, 1:1)...")
    t0      = time.time()
    raw_img = generate_image(full_prompt)
    raw_path = raw_dir / f"{player_id}.png"
    raw_img.save(raw_path)
    logger.info(f"  saved raw → {raw_path}  ({time.time()-t0:.1f}s)")

    logger.info("[2/3] Processing (rembg → split → assemble)...")
    t0    = time.time()
    sheet = process_image(raw_img)
    sheet_path = out_dir / f"{player_id}.png"
    sheet.save(sheet_path)
    logger.info(f"  saved sheet → {sheet_path}  ({time.time()-t0:.1f}s)")

    logger.info("[3/3] Skipping S3 upload (local mode)")
    logger.info("")
    logger.info(f"Open client/test_client.html in Chrome → pick folder: {out_dir.resolve()}")
