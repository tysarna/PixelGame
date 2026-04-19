# Pixel Social Rooms — Person A + D Unified Guide (AI-Generated Assets)

## Philosophy

**Every visual asset in this game is AI-generated.** Characters, furniture, floor tiles, wall tiles, room backgrounds — all of it. No hand-drawn pixel art. No layer compositing.

Characters are generated **per player at creation time** via an AI image generation API. The player picks structured options (hair style, hair color, outfit, etc.), the server builds a prompt, calls the API, post-processes the output into a final sprite sheet, and stores it in S3. Each player gets a unique character.

Furniture and environment tiles are generated **once during development**, curated, and uploaded as static assets. They don't change at runtime.

The game server, B's module, C's module, WebSocket schema, and DynamoDB schemas don't know or care that assets are AI-generated. They just see URLs to PNGs in S3.

---

## What Changes vs. the Original Guide

| Original | This Guide |
|----------|------------|
| Pre-drawn sprite layers (body, hair, outfit) composited by Lambda | AI generates a complete character sheet per player; Lambda orchestrates gen + post-processing |
| Sprite sheet is 4 cols × 4 rows (128×128) | Sprite sheet is 8 cols × 4 rows (256×128) — walk cycle + sit + wave + emotes |
| Character creator picks from 5 preset hair/outfit layers | Character creator picks structured traits → mapped to prompt words |
| Hand-drawn furniture sprites | AI-generated furniture sprites, produced once during dev |
| Fixed tile textures | AI-generated tile textures, produced once during dev |
| Lambda: fast (~1s), deterministic, limited combos | Lambda: slower (~10-30s), non-deterministic, unlimited variety |

Everything below this line — the server, B's module, C's module, WebSocket messages, DynamoDB schemas — is **identical** to the original guide. Only the asset pipeline and client renderer change.

---

## Architecture

```
Browser Client (HTML/Canvas)
    │
    ├── HTTPS GET → CloudFront → S3
    │     ├── manifest.json
    │     ├── /furniture/*.png         (AI-generated once, static)
    │     ├── /tiles/*.png             (AI-generated once, static)
    │     └── /avatars/{playerId}.png  (AI-generated per player at creation)
    │
    └── WebSocket → ALB (/ws) → ECS Fargate (game server)
                                      │
                                      ├── Cognito (JWT validation)
                                      ├── DynamoDB (Rooms, Players, Interactions)
                                      ├── Lambda (avatar gen: prompt → AI API → post-process → S3)
                                      └── In-memory state (connections, positions)
```

The Lambda calls an external image generation API (OpenAI DALL-E, Stability AI, Replicate, etc.). It needs outbound internet access.

---

## The Sprite Sheet Contract (CRITICAL — Everyone Reads This)

### Final Format: 8 columns × 4 rows

Each cell is **32×32 pixels**. Total sheet: **256×128 pixels**.

```
         Col 0    Col 1    Col 2    Col 3   Col 4   Col 5   Col 6   Col 7
         (idle)   (stepA)  (stepB)  (sit)   (wave)  (sleep) (eat)   (laugh)
        ┌────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┐
Row 0   │ stand  │ walk   │ walk   │ sit    │ wave   │ sleep  │ eat    │ laugh  │
(down)  │ front  │ A fwd  │ B fwd  │ front  │ front  │  zzz   │ nom    │ haha   │
        ├────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤
Row 1   │ stand  │ walk   │ walk   │ sit    │ wave   │ sleep  │ eat    │ laugh  │
(left)  │ left   │ A left │ B left │ left   │ left   │  zzz   │ nom    │ haha   │
        ├────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤
Row 2   │ stand  │ walk   │ walk   │ sit    │ wave   │ sleep  │ eat    │ laugh  │
(up)    │ back   │ A back │ B back │ back   │ back   │  zzz   │ nom    │ haha   │
        ├────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤
Row 3   │ stand  │ walk   │ walk   │ sit    │ wave   │ sleep  │ eat    │ laugh  │
(right) │ right  │ A rgt  │ B rgt  │ right  │ right  │  zzz   │ nom    │ haha   │
        └────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘
```

**Walk cycle**: idle(col 0) → stepA(col 1) → idle(col 0) → stepB(col 2) → repeat
**Sit**: col 3, position locked to chair
**Wave, sleep, eat, laugh**: cols 4–7. Unused in v1, but the data is in the sheet for v2 emotes.

**Client frame selection**: `sourceX = col * 32`, `sourceY = row * 32` — same formula as the original guide, just with more columns.

### How the AI Prompt Maps to This Sheet

The AI generates a **4×4 grid** (the prompt in this guide). Post-processing expands it to 8×4 via flips:

**AI generates (4 rows × 4 cols = 16 cells):**

```
AI Row 1 (down-facing):  idle, walk-A, sit, wave
AI Row 2 (left-facing):  idle, walk-A, sit, wave
AI Row 3 (back/up):      idle, walk-A, sit, wave
AI Row 4 (extras):       walk-B-left, sleep, eat, laugh
```

**Post-processing derives the remaining cells:**

| Final Cell | Source |
|-----------|--------|
| Down step-B | Horizontal flip of down step-A (front view is symmetric) |
| Up step-B | Horizontal flip of up step-A (back view is symmetric) |
| Left step-B | AI Row 4, Cell 1 (explicitly generated with opposite leg) |
| Right idle | Flip of left idle |
| Right step-A | Flip of left step-A |
| Right step-B | Flip of left step-B (which is AI Row 4 Cell 1) |
| Right sit | Flip of left sit |
| Right wave | Flip of left wave |
| All rows: sleep | AI Row 4, Cell 2 (direction-independent) |
| All rows: eat | AI Row 4, Cell 3 (direction-independent) |
| All rows: laugh | AI Row 4, Cell 4 (direction-independent) |

The right-facing row is entirely derived by flipping the left-facing row. That's why the AI prompt only needs 3 directional rows + 1 extras row.

---

## Phase 1: Infrastructure (Person A)

### 1.1 VPC & Networking

Standard two-AZ setup:

- VPC with CIDR `10.0.0.0/16`
- 2 public subnets (for ALB): `10.0.1.0/24`, `10.0.2.0/24`
- 2 private subnets (for Fargate): `10.0.3.0/24`, `10.0.4.0/24`
- Internet Gateway on public subnets
- NAT Gateway (single, for cost) in one public subnet — private subnets route through it
- Security group for ALB: inbound 443 from `0.0.0.0/0`
- Security group for Fargate task: inbound from ALB security group only, outbound all (needs to reach DynamoDB, Cognito)

### 1.2 DynamoDB Tables

Create all three tables up front. B and C define the schemas, you create the infra.

**Rooms Table**

```
Table name:   Rooms
Partition key: PK (String)        — values like "ROOM#abc123"
No sort key
Billing:      On-demand (PAY_PER_REQUEST)
```

**Players Table**

```
Table name:   Players
Partition key: PK (String)        — values like "PLAYER#abc123"
No sort key
Billing:      On-demand
```

**Interactions Table**

```
Table name:   Interactions
Partition key: PK (String)        — values like "ROOM#abc123"
Sort key:      SK (String)        — values like "CHAIR#3_4"
Billing:      On-demand
```

On-demand billing is correct at this scale. No need to guess capacity.

### 1.3 Cognito User Pool

```
User Pool name: pixel-social-users
Sign-in:        Email
Required attrs: email, preferred_username (this is the display name)
Password:       8+ chars, at least 1 upper, 1 lower, 1 number
App client:     pixel-social-client (no secret — it's a public SPA client)
Auth flow:      USER_SRP_AUTH
```

The app client must NOT have a client secret. Browser clients can't keep secrets. SRP auth flow means the password never leaves the browser in plaintext.

After sign-up, the client gets back an ID token (JWT). This JWT is what gets sent on WebSocket connection and validated server-side.

### 1.4 S3 Bucket

```
Bucket name:  pixel-social-assets (or your preferred name)
Public access: Blocked (CloudFront serves it via OAC)
Versioning:   Off (not needed for v1)
Structure:
  /furniture/          — AI-generated furniture PNGs (static, produced during dev)
  /tiles/              — AI-generated tile textures (floor, wall, door)
  /avatars/            — Lambda writes per-player sprite sheets here at runtime
  /manifest.json       — asset manifest
```

No `/sprites/` directory. No layer files. The Lambda generates complete sheets, not composited layers.

### 1.5 CloudFront Distribution

- Origin: the S3 bucket via Origin Access Control (OAC)
- Behavior: default `/*`, GET/HEAD only, caching enabled (TTL 86400 for assets)
- A second behavior for `/manifest.json` with shorter TTL (300s) so you can update it during dev without waiting
- A third behavior for `/avatars/*` with shorter TTL (300s) — new avatars need to be available quickly
- HTTPS only, redirect HTTP→HTTPS
- No custom domain needed for dev — the `d1234.cloudfront.net` domain works fine

Grant the CloudFront distribution read access to the S3 bucket via an OAC bucket policy.

### 1.6 ACM Certificate

If you want a custom domain for the ALB (`game.yourdomain.com`), create an ACM certificate in the same region as the ALB. Otherwise, for dev, you can use the ALB's default DNS name, but WebSocket connections over `wss://` require a valid cert on the ALB listener.

Option for dev without custom domain: create a self-signed cert or use the ALB's HTTP listener (port 80, `ws://` not `wss://`). This works for local testing but is obviously not production.

### 1.7 ECS Fargate

**Cluster**: `pixel-social-cluster`, Fargate only (no EC2).

**Task Definition**:

```
Family:         pixel-social-server
CPU:            512 (0.5 vCPU)
Memory:         1024 MB
Network mode:   awsvpc
Container:
  Name:         game-server
  Image:        {your-ecr-repo}:latest
  Port:         3000 (TCP)
  Environment:
    COGNITO_USER_POOL_ID:   {pool-id}
    COGNITO_CLIENT_ID:      {client-id}
    COGNITO_REGION:         {region}
    DYNAMODB_REGION:        {region}
    TABLE_ROOMS:            Rooms
    TABLE_PLAYERS:          Players
    TABLE_INTERACTIONS:     Interactions
    AVATAR_LAMBDA_ARN:      {lambda-arn}
    CLOUDFRONT_DOMAIN:      {d1234.cloudfront.net}
  Log driver:   awslogs → CloudWatch log group /ecs/pixel-social
```

**Service**: 1 desired task, 1 min, 1 max (no scaling for v1). Assign to private subnets. Attach the ALB target group.

**Task Role** (IAM role attached to the task):

- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `BatchGetItem` on all three tables
- `lambda:InvokeFunction` on the avatar generation Lambda
- `cognito-idp:GetUser` (if you need server-side user lookups — optional if you only validate JWTs)

### 1.8 ALB

- Scheme: internet-facing
- Subnets: both public subnets
- Listener: HTTPS (443) with ACM cert (or HTTP 80 for dev)
- Target group: IP type (Fargate awsvpc), port 3000, health check on `/health` (HTTP 200)
- Stickiness: enabled (WebSocket connections must stay on the same target, though with 1 task it's moot)
- Idle timeout: 3600 seconds (WebSockets need long idle timeouts)

The ALB natively supports WebSocket upgrade. No special configuration needed beyond the idle timeout.

### 1.9 Avatar Generation Lambda

```
Function name:  pixel-social-avatar-gen
Runtime:        Python 3.12 (Pillow for image post-processing)
Memory:         1024 MB
Timeout:        60 seconds (AI generation takes 10-30s + post-processing)
Trigger:        Direct invoke from game server (not API Gateway, not S3 event)
```

**Lambda Role**:

- `s3:PutObject` on the S3 bucket `/avatars/*` path (writes generated sheets)

**Lambda Environment Variables**:

```
IMAGE_GEN_API_KEY:    {your API key for the image gen service}
IMAGE_GEN_PROVIDER:   openai | stability | replicate
S3_BUCKET:            pixel-social-assets
CLOUDFRONT_DOMAIN:    d1234.cloudfront.net
```

**Important**: The Lambda needs outbound internet access to call the image generation API. If running in a VPC, it needs a NAT Gateway. Alternatively, don't put the Lambda in a VPC at all — it only needs S3 access (via the AWS SDK, no VPC needed) and external API access.

**What it does** (completely different from the original compositing Lambda):

1. Receives `{ playerId, characterDescription }` — the description is pre-built by the game server from player choices
2. Builds the full image generation prompt (the Stardew Valley sprite sheet prompt — see Phase 2)
3. Calls the image gen API → receives a raw image
4. Splits the 4×4 grid into 16 individual 32×32 cells
5. Applies the flip/rearrange logic to produce 32 cells (8×4 layout)
6. Assembles the final 256×128 sprite sheet PNG
7. Removes the white background → makes it transparent
8. Writes to `s3://bucket/avatars/{playerId}.png`
9. Returns `{ avatarUrl: "https://{cloudfront}/avatars/{playerId}.png" }`

---

## Phase 2: AI-Generated Assets

### 2.1 Character Generation Prompt Template

This is the core prompt. Player choices fill in `[your character description]`.

```
A 4x4 pixel art character sprite sheet in the exact style of Stardew Valley.
16 equally sized square cells, 4 columns and 4 rows, on a pure white background.
Every cell has a pure white background. The same chibi-proportioned character
in every cell: [CHARACTER_DESCRIPTION]. 16-bit pixel art, clean pixel edges,
no anti-aliasing, no text, no labels.

Row 1, Cell 1: Character standing still, body and face pointing toward the
viewer. Arms resting at sides.
Row 1, Cell 2: Character walking toward the viewer, right leg stepping forward,
left arm swinging forward. Body and face pointing toward the viewer.
Row 1, Cell 3: Character sitting on a chair facing the viewer. Hands resting
on lap, feet hanging down.
Row 1, Cell 4: Character facing the viewer, one hand raised and waving. Body
and face pointing toward the viewer.

Row 2, Cell 1: Character standing still, body turned so the character's nose
points toward the left edge of the image. We see the right side of the
character's body.
Row 2, Cell 2: Character walking toward the left edge of the image, right leg
stepping forward, left arm swinging forward. Nose pointing toward the left edge.
Row 2, Cell 3: Character sitting on a chair, nose pointing toward the left edge
of the image. We see the right side of the character's body.
Row 2, Cell 4: Character facing the left edge of the image, one hand raised and
waving. Nose pointing toward the left edge.

Row 3, Cell 1: Character standing still, back of head facing the viewer. We see
the character's back, not their face.
Row 3, Cell 2: Character walking away from the viewer, right leg stepping
forward, left arm swinging forward. We see the character's back.
Row 3, Cell 3: Character sitting on a chair, back of head facing the viewer. We
see the character's back.
Row 3, Cell 4: Character with back to the viewer, one hand raised and waving. We
see the back of the character's head.

Row 4, Cell 1: Character walking toward the left edge of the image, left leg
stepping forward, right arm swinging forward. Nose pointing toward the left edge.
This is the opposite walking pose from Row 2 Cell 2.
Row 4, Cell 2: Character lying flat on their back, eyes closed, asleep. Viewed
from above, head near the top of the cell, feet near the bottom.
Row 4, Cell 3: Character facing the viewer, both hands raised to mouth, eating
food. Happy expression.
Row 4, Cell 4: Character facing the viewer, mouth wide open, eyes squished shut,
laughing. Body leaning back slightly.

Every cell must have identical character proportions, colors, and pixel art style.
Cells are clearly separated with even spacing.
```

### 2.2 Character Description Builder

Player choices map to words that fill `[CHARACTER_DESCRIPTION]`. Keep it structured so the AI produces consistent results.

**Customization options** (presented in character creator UI):

| Category | Options | Maps to prompt fragment |
|----------|---------|----------------------|
| Hair style | Short, Long, Curly, Mohawk, Ponytail | "short brown hair", "long flowing hair", etc. |
| Hair color | Brown, Blonde, Red, Black, White | Appended to hair style |
| Skin tone | Light, Medium, Tan, Dark, Deep | "light skin", "dark skin", etc. |
| Outfit | T-shirt, Hoodie, Dress, Overalls, Jacket | "wearing a red t-shirt", etc. |
| Outfit color | Red, Blue, Green, Yellow, Purple, White, Black | Prepended to outfit |
| Accessory | None, Glasses, Hat, Scarf, Backpack | "wearing round glasses", etc. |

**Example assembled description**:
`"A young person with short red hair, medium skin, wearing a blue hoodie and round glasses"`

**Server-side builder**:

```javascript
function buildCharacterDescription(choices) {
  const parts = [];
  parts.push('A young person with');
  parts.push(`${choices.hairStyle} ${choices.hairColor} hair`);
  parts.push(`${choices.skinTone} skin`);
  parts.push(`wearing a ${choices.outfitColor} ${choices.outfit}`);
  if (choices.accessory && choices.accessory !== 'none') {
    parts.push(`and ${choices.accessory}`);
  }
  return parts.join(', ');
}
```

This description is injected into `[CHARACTER_DESCRIPTION]` in the prompt template. The full prompt is sent to the Lambda.

### 2.3 Lambda Post-Processing Pipeline

The Lambda receives the raw AI image (typically 1024×1024) and transforms it into the final 256×128 sprite sheet. This is the critical code.

```python
# avatar_lambda.py
import json
import os
import io
import boto3
import requests
from PIL import Image

s3 = boto3.client('s3')
BUCKET = os.environ['S3_BUCKET']
CDN = os.environ['CLOUDFRONT_DOMAIN']
API_KEY = os.environ['IMAGE_GEN_API_KEY']
PROVIDER = os.environ.get('IMAGE_GEN_PROVIDER', 'openai')

CELL = 32  # final cell size
PROMPT_TEMPLATE = """A 4x4 pixel art character sprite sheet in the exact style of Stardew Valley...
[full prompt from section 2.1 goes here]"""


def generate_image(prompt):
    """Call AI image gen API. Returns a PIL Image."""
    if PROVIDER == 'openai':
        resp = requests.post(
            'https://api.openai.com/v1/images/generations',
            headers={'Authorization': f'Bearer {API_KEY}'},
            json={
                'model': 'dall-e-3',
                'prompt': prompt,
                'n': 1,
                'size': '1024x1024',
                'response_format': 'b64_json',
                'quality': 'hd',
                'style': 'natural',
            }
        )
        import base64
        b64 = resp.json()['data'][0]['b64_json']
        return Image.open(io.BytesIO(base64.b64decode(b64)))

    elif PROVIDER == 'stability':
        resp = requests.post(
            'https://api.stability.ai/v2beta/stable-image/generate/core',
            headers={'Authorization': f'Bearer {API_KEY}'},
            files={'none': ''},
            data={
                'prompt': prompt,
                'output_format': 'png',
                'aspect_ratio': '1:1',
                'style_preset': 'pixel-art',
            }
        )
        return Image.open(io.BytesIO(resp.content))

    # Add more providers as needed
    raise ValueError(f'Unknown provider: {PROVIDER}')


def split_grid(raw_img, rows=4, cols=4):
    """Split a raw AI image into a grid of cells.
    Returns a 2D list: cells[row][col] = PIL Image (CELL x CELL)."""
    w, h = raw_img.size
    cell_w, cell_h = w // cols, h // rows
    cells = []
    for r in range(rows):
        row = []
        for c in range(cols):
            box = (c * cell_w, r * cell_h, (c + 1) * cell_w, (r + 1) * cell_h)
            cell = raw_img.crop(box).resize((CELL, CELL), Image.NEAREST)
            row.append(cell)
        cells.append(row)
    return cells


def remove_white_bg(img, threshold=240):
    """Replace white/near-white pixels with transparency."""
    img = img.convert('RGBA')
    data = img.getdata()
    new_data = []
    for pixel in data:
        if pixel[0] > threshold and pixel[1] > threshold and pixel[2] > threshold:
            new_data.append((pixel[0], pixel[1], pixel[2], 0))
        else:
            new_data.append(pixel)
    img.putdata(new_data)
    return img


def flip_h(img):
    """Horizontal flip."""
    return img.transpose(Image.FLIP_LEFT_RIGHT)


def assemble_sheet(cells):
    """Take the 4x4 AI grid cells and produce the 8x4 final sheet.

    AI grid layout:
      Row 0 (down):  idle, walkA, sit, wave
      Row 1 (left):  idle, walkA, sit, wave
      Row 2 (up):    idle, walkA, sit, wave
      Row 3 (extra): walkB_left, sleep, eat, laugh

    Final sheet columns:
      0=idle, 1=stepA, 2=stepB, 3=sit, 4=wave, 5=sleep, 6=eat, 7=laugh
    Final sheet rows:
      0=down, 1=left, 2=up, 3=right
    """

    COLS_OUT = 8
    ROWS_OUT = 4
    sheet = Image.new('RGBA', (COLS_OUT * CELL, ROWS_OUT * CELL), (0, 0, 0, 0))

    # Aliases for AI grid cells
    # cells[ai_row][ai_col]
    # AI Row 0 = down, Row 1 = left, Row 2 = up (back), Row 3 = extras

    sleep_cell = cells[3][1]
    eat_cell = cells[3][2]
    laugh_cell = cells[3][3]
    walkB_left = cells[3][0]  # explicitly generated opposite-leg left walk

    for final_row, ai_row, is_flip in [
        (0, 0, False),   # down = AI row 0 as-is
        (1, 1, False),   # left = AI row 1 as-is
        (2, 2, False),   # up = AI row 2 as-is
        (3, 1, True),    # right = flip of AI row 1 (left)
    ]:
        idle = cells[ai_row][0]
        stepA = cells[ai_row][1]
        sit = cells[ai_row][2]
        wave = cells[ai_row][3]

        # Step B logic:
        if final_row == 0:
            # Down: front view is symmetric, flip stepA
            stepB = flip_h(stepA)
        elif final_row == 1:
            # Left: use the explicitly generated opposite-leg cell
            stepB = walkB_left
        elif final_row == 2:
            # Up: back view is symmetric, flip stepA
            stepB = flip_h(stepA)
        elif final_row == 3:
            # Right: flip of left's stepB (which is walkB_left)
            stepB = flip_h(walkB_left)

        if is_flip:
            idle = flip_h(idle)
            stepA = flip_h(stepA)
            stepB = flip_h(stepB)
            sit = flip_h(sit)
            wave = flip_h(wave)

        # Place all 8 columns for this row
        col_cells = [idle, stepA, stepB, sit, wave, sleep_cell, eat_cell, laugh_cell]
        for c, cell_img in enumerate(col_cells):
            sheet.paste(cell_img, (c * CELL, final_row * CELL))

    return sheet


def handler(event, context):
    player_id = event['playerId']
    description = event['characterDescription']

    # 1. Build prompt
    prompt = PROMPT_TEMPLATE.replace('[CHARACTER_DESCRIPTION]', description)

    # 2. Generate image via AI API
    raw_img = generate_image(prompt)

    # 3. Split into grid cells
    cells = split_grid(raw_img)

    # 4. Remove white backgrounds from each cell
    for r in range(4):
        for c in range(4):
            cells[r][c] = remove_white_bg(cells[r][c])

    # 5. Assemble into final 8x4 sheet
    sheet = assemble_sheet(cells)

    # 6. Write to S3
    buf = io.BytesIO()
    sheet.save(buf, format='PNG')
    buf.seek(0)

    key = f'avatars/{player_id}.png'
    s3.put_object(
        Bucket=BUCKET, Key=key, Body=buf.getvalue(),
        ContentType='image/png', CacheControl='max-age=86400'
    )

    return {
        'avatarUrl': f'https://{CDN}/{key}'
    }
```

### 2.4 AI-Generated Furniture (Dev-Time, One-Shot)

Generate each furniture item as an individual image during development. Not at runtime — you generate once, curate the results, and upload to S3.

**Prompt template for furniture**:

```
A single [ITEM_NAME] sprite for a pixel art game in the Stardew Valley style.
Viewed from a 3/4 top-down isometric perspective. Pure white background.
[WIDTH]x[HEIGHT] pixels. 16-bit pixel art, clean pixel edges, no anti-aliasing,
no text, no labels, no shadow, no floor.
```

**Generation script** (run locally or in a notebook):

```python
import requests, os, json
from PIL import Image
import io, base64

API_KEY = os.environ['OPENAI_API_KEY']

FURNITURE = [
    {"itemId": "chair_wood_01",   "name": "small wooden chair",       "w": 32, "h": 32},
    {"itemId": "sofa_blue_01",    "name": "blue two-seat sofa",       "w": 64, "h": 32},
    {"itemId": "table_round_01",  "name": "small round wooden table", "w": 32, "h": 32},
    {"itemId": "rug_red_01",      "name": "red woven area rug",       "w": 64, "h": 64},
    {"itemId": "lamp_tall_01",    "name": "tall standing floor lamp",  "w": 32, "h": 32},
    {"itemId": "bookshelf_01",    "name": "wide wooden bookshelf full of colorful books", "w": 64, "h": 32},
]

os.makedirs("furniture", exist_ok=True)

for item in FURNITURE:
    prompt = f"""A single {item['name']} sprite for a pixel art game in the Stardew Valley style.
Viewed from a 3/4 top-down isometric perspective. Pure white background.
{item['w']}x{item['h']} pixels. 16-bit pixel art, clean pixel edges, no anti-aliasing,
no text, no labels, no shadow, no floor."""

    resp = requests.post(
        'https://api.openai.com/v1/images/generations',
        headers={'Authorization': f'Bearer {API_KEY}'},
        json={'model': 'dall-e-3', 'prompt': prompt, 'n': 1, 'size': '1024x1024',
              'response_format': 'b64_json', 'quality': 'hd', 'style': 'natural'}
    )

    b64 = resp.json()['data'][0]['b64_json']
    raw = Image.open(io.BytesIO(base64.b64decode(b64)))

    # Resize to target dimensions, remove white bg
    resized = raw.resize((item['w'], item['h']), Image.NEAREST).convert('RGBA')
    # White bg removal
    data = resized.getdata()
    new_data = [(r,g,b,0) if r>240 and g>240 and b>240 else (r,g,b,a) for r,g,b,a in data]
    resized.putdata(new_data)

    resized.save(f"furniture/{item['itemId']}.png")
    print(f"Generated {item['itemId']}")
```

**After generation**: open each PNG, check it looks reasonable, touch up in Aseprite/Piskel if needed. These are static assets — you only do this once. If one looks bad, regenerate it with a tweaked prompt.

### 2.5 AI-Generated Tiles (Dev-Time, One-Shot)

Same approach for floor, wall, and door tiles. Each tile is 32×32.

```python
TILES = [
    {"id": "floor_wood",  "prompt": "A wooden floor tile, top-down view, warm oak planks"},
    {"id": "wall_stone",  "prompt": "A stone wall tile, front view, gray cobblestone pattern"},
    {"id": "door_wood",   "prompt": "A wooden door tile, front view, arched doorway"},
]
```

Generate, curate, upload. These feed into the room grid renderer.

### 2.6 Manifest (manifest.json)

```json
{
  "furniture": {
    "chair_wood_01": {
      "sprite": "/furniture/chair_wood_01.png",
      "pixelWidth": 32,
      "pixelHeight": 32,
      "gridWidth": 1,
      "gridHeight": 1,
      "zLayer": 2
    },
    "sofa_blue_01": {
      "sprite": "/furniture/sofa_blue_01.png",
      "pixelWidth": 64,
      "pixelHeight": 32,
      "gridWidth": 2,
      "gridHeight": 1,
      "zLayer": 2
    },
    "table_round_01": {
      "sprite": "/furniture/table_round_01.png",
      "pixelWidth": 32,
      "pixelHeight": 32,
      "gridWidth": 1,
      "gridHeight": 1,
      "zLayer": 2
    },
    "rug_red_01": {
      "sprite": "/furniture/rug_red_01.png",
      "pixelWidth": 64,
      "pixelHeight": 64,
      "gridWidth": 2,
      "gridHeight": 2,
      "zLayer": 0
    },
    "lamp_tall_01": {
      "sprite": "/furniture/lamp_tall_01.png",
      "pixelWidth": 32,
      "pixelHeight": 32,
      "gridWidth": 1,
      "gridHeight": 1,
      "zLayer": 2
    },
    "bookshelf_01": {
      "sprite": "/furniture/bookshelf_01.png",
      "pixelWidth": 64,
      "pixelHeight": 32,
      "gridWidth": 2,
      "gridHeight": 1,
      "zLayer": 2
    }
  },
  "tiles": {
    "floor": "/tiles/floor_wood.png",
    "wall": "/tiles/wall_stone.png",
    "door": "/tiles/door_wood.png"
  },
  "characterOptions": {
    "hairStyles": ["Short", "Long", "Curly", "Mohawk", "Ponytail"],
    "hairColors": ["Brown", "Blonde", "Red", "Black", "White"],
    "skinTones": ["Light", "Medium", "Tan", "Dark", "Deep"],
    "outfits": ["T-shirt", "Hoodie", "Dress", "Overalls", "Jacket"],
    "outfitColors": ["Red", "Blue", "Green", "Yellow", "Purple", "White", "Black"],
    "accessories": ["None", "Glasses", "Hat", "Scarf", "Backpack"]
  },
  "spriteSheet": {
    "cellSize": 32,
    "cols": 8,
    "rows": 4,
    "colMap": {
      "idle": 0, "stepA": 1, "stepB": 2, "sit": 3,
      "wave": 4, "sleep": 5, "eat": 6, "laugh": 7
    },
    "rowMap": { "down": 0, "left": 1, "up": 2, "right": 3 }
  },
  "tileSize": 32,
  "gridSize": 12
}
```

The `characterOptions` block drives the character creator UI. The `spriteSheet` block tells the client exactly how to slice frames. Both are consumed by the client on load. The server doesn't read the manifest.

### 2.7 Upload to S3

```bash
aws s3 sync ./furniture/ s3://pixel-social-assets/furniture/
aws s3 sync ./tiles/ s3://pixel-social-assets/tiles/
aws s3 cp manifest.json s3://pixel-social-assets/manifest.json \
    --content-type application/json
```

### 2.8 Verify CloudFront

```bash
curl -I https://d1234.cloudfront.net/manifest.json
# 200, application/json

curl -I https://d1234.cloudfront.net/furniture/chair_wood_01.png
# 200, image/png

curl -I https://d1234.cloudfront.net/tiles/floor_wood.png
# 200, image/png
```

### 2.9 Test Lambda in Isolation

```bash
aws lambda invoke \
  --function-name pixel-social-avatar-gen \
  --payload '{"playerId":"test001","characterDescription":"A young person with short red hair, medium skin, wearing a blue hoodie and round glasses"}' \
  response.json

cat response.json
# { "avatarUrl": "https://d1234.cloudfront.net/avatars/test001.png" }

# Download and verify:
curl -o test_avatar.png https://d1234.cloudfront.net/avatars/test001.png
# Open it: should be 256x128, 8 cols x 4 rows of a red-haired character in a blue hoodie
# Verify: right-facing row looks like a mirror of left-facing row
# Verify: walk frames show different leg positions
# Verify: sit frame shows character seated
# Verify: transparent background (no white boxes around the character)
```

---

## Phase 3: Game Server

### 3.1 Project Structure

```
game-server/
  package.json
  Dockerfile
  src/
    index.js              — entry point, HTTP + WS server
    auth.js               — Cognito JWT validation
    avatar.js             — Lambda invocation for avatar generation
    prompt.js             — builds character description from player choices
    router.js             — message type → handler dispatch
    broadcast.js          — room-scoped broadcast utility
    state.js              — in-memory state (rooms, connections, positions)
    handlers/
      room.js             — join_room, leave_room, move
      character.js        — create_character (calls avatar pipeline)
      furniture.js        — proxy to B's module (place, move, rotate, remove)
      social.js           — proxy to C's module (sit, stand, chat, friends)
    modules/
      decorEngine.js      — B's module (stub it until B delivers)
      socialEngine.js     — C's module (stub it until C delivers)
```

### 3.2 Character Description Builder (prompt.js)

```javascript
// prompt.js — translates player choices into a text description for the AI prompt

function buildCharacterDescription(choices) {
  const { hairStyle, hairColor, skinTone, outfit, outfitColor, accessory } = choices;

  let desc = `A young person with ${hairStyle.toLowerCase()} ${hairColor.toLowerCase()} hair, ` +
             `${skinTone.toLowerCase()} skin, ` +
             `wearing a ${outfitColor.toLowerCase()} ${outfit.toLowerCase()}`;

  if (accessory && accessory.toLowerCase() !== 'none') {
    const accMap = {
      'glasses': 'round glasses',
      'hat': 'a small cap',
      'scarf': 'a cozy scarf',
      'backpack': 'a small backpack',
    };
    desc += ` and ${accMap[accessory.toLowerCase()] || accessory.toLowerCase()}`;
  }

  return desc;
}

module.exports = { buildCharacterDescription };
```

### 3.3 Avatar Generation (avatar.js)

```javascript
// avatar.js
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({ region: process.env.COGNITO_REGION });

async function generateAvatar(playerId, characterDescription) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: process.env.AVATAR_LAMBDA_ARN,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ playerId, characterDescription }),
  }));

  const result = JSON.parse(Buffer.from(response.Payload));
  if (result.errorMessage) {
    throw new Error(`Avatar Lambda failed: ${result.errorMessage}`);
  }
  return result.avatarUrl;
}

module.exports = { generateAvatar };
```

### 3.4 Character Creation Handler (handlers/character.js)

```javascript
// handlers/character.js
const { generateAvatar } = require('../avatar');
const { buildCharacterDescription } = require('../prompt');
const { sendTo } = require('../broadcast');
const socialEngine = require('../modules/socialEngine');

async function handleCreateCharacter(conn, payload) {
  const { hairStyle, hairColor, skinTone, outfit, outfitColor, accessory } = payload;

  // Build the text description from structured choices
  const description = buildCharacterDescription({
    hairStyle, hairColor, skinTone, outfit, outfitColor, accessory
  });

  // Send a "generating" status so the client can show a loading state
  sendTo(conn, { type: 'character_generating', payload: { message: 'Creating your character...' } });

  // Call the Lambda (this takes 10-30 seconds)
  const avatarUrl = await generateAvatar(conn.playerId, description);

  // Store player record
  await socialEngine.createPlayer(conn.playerId, conn.displayName, avatarUrl);

  // Also store the choices so we can regenerate later if needed
  // (stored as a JSON string in an attribute on the Players table)

  sendTo(conn, { type: 'character_created', payload: { avatarUrl } });
}

module.exports = { handleCreateCharacter };
```

**Note the `character_generating` event.** AI generation takes 10-30 seconds. The client needs to show a loading/progress indicator during this time. This isn't a sub-second Lambda like the old compositing approach.

### 3.5 Entry Point (index.js)

```javascript
const http = require('http');
const { WebSocketServer } = require('ws');
const { validateToken } = require('./auth');
const { handleMessage } = require('./router');
const { addConnection, removeConnection } = require('./state');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  let user;
  try {
    user = await validateToken(token);
  } catch (err) {
    ws.close(4001, 'Invalid token');
    return;
  }

  const conn = { ws, playerId: user.sub, displayName: user.preferred_username };
  addConnection(conn);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(conn, msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', payload: { code: 'PARSE_ERROR', message: 'Invalid JSON' } }));
    }
  });

  ws.on('close', () => {
    removeConnection(conn);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server on :${PORT}`));
```

### 3.6 Auth (auth.js)

```javascript
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const client = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  rateLimit: true,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function validateToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      algorithms: ['RS256'],
      issuer: `https://cognito-idp.${process.env.COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
    }, (err, decoded) => {
      if (err) return reject(err);
      if (decoded.token_use !== 'id') return reject(new Error('Not an ID token'));
      resolve(decoded);
    });
  });
}

module.exports = { validateToken };
```

### 3.7 In-Memory State (state.js)

```javascript
const roomConnections = new Map();
const playerState = new Map();
const allConnections = new Map();

function addConnection(conn) {
  allConnections.set(conn.playerId, conn);
}

function removeConnection(conn) {
  const state = playerState.get(conn.playerId);
  if (state && state.roomId) {
    leaveRoom(conn);
  }
  allConnections.delete(conn.playerId);
}

function joinRoom(conn, roomId, x, y, avatarUrl) {
  if (!roomConnections.has(roomId)) {
    roomConnections.set(roomId, new Set());
  }
  roomConnections.get(roomId).add(conn);
  playerState.set(conn.playerId, {
    roomId, x, y,
    direction: 'down',
    pose: 'standing',
    seatPosition: null,
    avatarUrl,
  });
}

function leaveRoom(conn) {
  const state = playerState.get(conn.playerId);
  if (!state) return null;
  const { roomId } = state;
  const roomSet = roomConnections.get(roomId);
  if (roomSet) {
    roomSet.delete(conn);
    if (roomSet.size === 0) roomConnections.delete(roomId);
  }
  playerState.delete(conn.playerId);
  return roomId;
}

function getConnectionsByRoom(roomId) {
  return roomConnections.get(roomId) || new Set();
}

function getPlayerState(playerId) {
  return playerState.get(playerId);
}

function updatePlayerState(playerId, updates) {
  const current = playerState.get(playerId);
  if (current) Object.assign(current, updates);
}

module.exports = {
  addConnection, removeConnection,
  joinRoom, leaveRoom,
  getConnectionsByRoom, getPlayerState, updatePlayerState,
  allConnections, playerState, roomConnections
};
```

### 3.8 Broadcast (broadcast.js)

```javascript
const { getConnectionsByRoom } = require('./state');

function broadcastToRoom(roomId, message, excludePlayerId = null) {
  const data = JSON.stringify(message);
  for (const conn of getConnectionsByRoom(roomId)) {
    if (conn.playerId !== excludePlayerId && conn.ws.readyState === 1) {
      conn.ws.send(data);
    }
  }
}

function sendTo(conn, message) {
  if (conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify(message));
  }
}

module.exports = { broadcastToRoom, sendTo };
```

### 3.9 Router (router.js)

```javascript
const { handleJoinRoom, handleLeaveRoom, handleMove } = require('./handlers/room');
const { handlePlaceFurniture, handleMoveFurniture, handleRotateFurniture, handleRemoveFurniture } = require('./handlers/furniture');
const { handleSit, handleStand, handleChat, handleAddFriend, handleRemoveFriend } = require('./handlers/social');
const { handleCreateCharacter } = require('./handlers/character');
const { sendTo } = require('./broadcast');

const handlers = {
  create_character: handleCreateCharacter,
  join_room: handleJoinRoom,
  leave_room: handleLeaveRoom,
  move: handleMove,
  place_furniture: handlePlaceFurniture,
  move_furniture: handleMoveFurniture,
  rotate_furniture: handleRotateFurniture,
  remove_furniture: handleRemoveFurniture,
  sit: handleSit,
  stand: handleStand,
  chat: handleChat,
  add_friend: handleAddFriend,
  remove_friend: handleRemoveFriend,
};

function handleMessage(conn, msg) {
  const handler = handlers[msg.type];
  if (!handler) {
    sendTo(conn, { type: 'error', payload: { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${msg.type}` } });
    return;
  }
  handler(conn, msg.payload).catch(err => {
    console.error(`Handler error [${msg.type}]:`, err);
    sendTo(conn, { type: 'error', payload: { code: 'INTERNAL', message: 'Server error' } });
  });
}

module.exports = { handleMessage };
```

### 3.10 Stub Modules

B's and C's stubs are identical to the original guide. The stubs don't care how avatars are generated.

**modules/decorEngine.js**: (same as previous version — starter grid, furniture CRUD, walkability checks)

**modules/socialEngine.js**: (same as previous version — player CRUD, chair claiming, chat filter, friend list, access control)

See the original integration guide for the full stub code. The only difference: `createPlayer` receives a CloudFront URL in `avatarUrl`, which it stores as-is.

### 3.11 Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/index.js"]
```

**Key dependencies in `package.json`**: `ws`, `jsonwebtoken`, `jwks-rsa`, `@aws-sdk/client-lambda`.

---

## Phase 4: Test Client

### 4.1 What the Client Does

- Cognito sign-up/sign-in
- **Character creator screen**: shows dropdowns/pickers for hair style, hair color, skin tone, outfit, outfit color, accessory (loaded from `manifest.json`'s `characterOptions`). On submit, sends `create_character` message. Shows loading indicator for 10-30 seconds while AI generates.
- Connect WebSocket with JWT token
- Fetch `manifest.json` from CloudFront
- Render 12×12 grid using tile sprites from the manifest
- Render furniture using PNGs from the manifest
- Render players using their AI-generated sprite sheets (256×128, 8×4 grid)
- Arrow keys → send `move` messages
- Full walk cycle animation with the sprite sheet
- Click chair → send `sit` → sprite switches to sit column
- Text input → send `chat` → speech bubbles

### 4.2 Sprite Sheet Renderer (Production Code)

This renderer handles the 8×4 sheet format. It reads layout info from the manifest's `spriteSheet` block.

```javascript
const CELL = 32;

// From manifest.spriteSheet.rowMap
const DIR_ROW = { down: 0, left: 1, up: 2, right: 3 };

// From manifest.spriteSheet.colMap
const POSE_COL = {
  idle: 0, stepA: 1, stepB: 2, sit: 3,
  wave: 4, sleep: 5, eat: 6, laugh: 7
};

class PlayerSprite {
  constructor(avatarUrl) {
    this.image = new Image();
    this.image.src = avatarUrl;
    this.loaded = false;
    this.image.onload = () => { this.loaded = true; };

    // Walk animation state
    this.walkCycle = ['idle', 'stepA', 'idle', 'stepB'];
    this.walkIndex = 0;
    this.currentPose = 'idle';
    this.walkTimer = null;
  }

  onMove() {
    this.walkIndex = (this.walkIndex + 1) % this.walkCycle.length;
    this.currentPose = this.walkCycle[this.walkIndex];
    clearTimeout(this.walkTimer);
    this.walkTimer = setTimeout(() => {
      this.currentPose = 'idle';
      this.walkIndex = 0;
    }, 300);
  }

  getCol(serverPose) {
    // serverPose comes from server state: "standing", "sitting"
    if (serverPose === 'sitting') return POSE_COL.sit;
    return POSE_COL[this.currentPose] || POSE_COL.idle;
  }
}

const spriteCache = new Map();

function getOrCreateSprite(playerId, avatarUrl) {
  if (!spriteCache.has(playerId)) {
    spriteCache.set(playerId, new PlayerSprite(avatarUrl));
  }
  return spriteCache.get(playerId);
}

function drawPlayer(ctx, player, tileSize) {
  const sprite = getOrCreateSprite(player.playerId, player.avatarUrl);
  if (!sprite.loaded) {
    // Loading fallback
    ctx.fillStyle = '#999';
    ctx.fillRect(player.x * tileSize + 8, player.y * tileSize + 8, tileSize - 16, tileSize - 16);
    return;
  }

  const row = DIR_ROW[player.direction] || 0;
  const col = sprite.getCol(player.pose);

  ctx.drawImage(
    sprite.image,
    col * CELL, row * CELL, CELL, CELL,      // source rect from 256x128 sheet
    player.x * tileSize, player.y * tileSize, // destination
    tileSize, tileSize                         // draw size
  );

  // Name label
  ctx.fillStyle = '#000';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    player.displayName || player.playerId,
    player.x * tileSize + tileSize / 2,
    player.y * tileSize - 4
  );
}

function onPlayerMoved(playerId) {
  const sprite = spriteCache.get(playerId);
  if (sprite) sprite.onMove();
}
```

### 4.3 Character Creator UI

The client loads `manifest.characterOptions` and renders dropdowns/pickers:

```javascript
// After loading manifest.json:
const options = manifest.characterOptions;

// Build UI with:
// - hairStyles dropdown: options.hairStyles
// - hairColors color picker or dropdown: options.hairColors
// - skinTones selector: options.skinTones
// - outfits dropdown: options.outfits
// - outfitColors color picker or dropdown: options.outfitColors
// - accessories dropdown: options.accessories

// On submit:
ws.send(JSON.stringify({
  type: 'create_character',
  payload: {
    hairStyle: selectedHairStyle,
    hairColor: selectedHairColor,
    skinTone: selectedSkinTone,
    outfit: selectedOutfit,
    outfitColor: selectedOutfitColor,
    accessory: selectedAccessory,
  }
}));

// Show loading spinner...
// Wait for character_generating → character_created events
// On character_created: download avatarUrl, proceed to room
```

### 4.4 Handling Generation Latency

AI generation is 10-30 seconds, not instant. The client flow:

1. Player submits character choices
2. Client shows "Creating your character..." with a loading animation
3. Server sends `character_generating` immediately (acknowledgment)
4. Server invokes Lambda (blocks for 10-30s)
5. Server sends `character_created` with `avatarUrl`
6. Client preloads the sprite sheet image
7. Once loaded, transition to the game

Consider adding a fun preview during the wait — e.g., a silhouette placeholder or a loading animation themed around pixel art.

---

## Phase 5: Integration Testing

### 5.1 Test 0: Infrastructure Smoke

| # | Test | How | Pass Criteria |
|---|------|-----|---------------|
| 0.1 | CloudFront serves manifest | `curl https://d1234.cloudfront.net/manifest.json` | 200, JSON with `characterOptions` + `spriteSheet` blocks |
| 0.2 | CloudFront serves furniture PNGs | `curl -I https://d1234.cloudfront.net/furniture/chair_wood_01.png` | 200, image/png |
| 0.3 | CloudFront serves tile PNGs | `curl -I https://d1234.cloudfront.net/tiles/floor_wood.png` | 200, image/png |
| 0.4 | Lambda generates avatar | Invoke Lambda directly (see 2.9) | Returns CloudFront URL, PNG is 256×128 |
| 0.5 | Generated avatar served via CloudFront | `curl -I https://d1234.cloudfront.net/avatars/test001.png` | 200, image/png |
| 0.6 | ALB health check | `curl https://alb-dns/health` | 200, "ok" |
| 0.7 | Cognito sign-up/sign-in | AWS CLI or test client | User created, JWT returned |
| 0.8 | WebSocket connects with valid JWT | `wscat -c "wss://alb-dns/ws?token=VALID_JWT"` | Connection stays open |
| 0.9 | WebSocket rejects invalid JWT | `wscat -c "wss://alb-dns/ws?token=garbage"` | Closed with 4001 |

### 5.2 Test 1: Character Creation → Single Player Loop

```
1. Sign up via Cognito → get JWT
2. Connect WebSocket with JWT
3. Send: { type: "create_character", payload: {
     hairStyle: "Short", hairColor: "Red", skinTone: "Medium",
     outfit: "Hoodie", outfitColor: "Blue", accessory: "Glasses" } }
4. Expect: character_generating { message: "..." }
5. Wait 10-30 seconds...
6. Expect: character_created { avatarUrl: "https://d1234.cloudfront.net/avatars/{playerId}.png" }
   → Download that URL, verify it's a 256x128 PNG
   → Verify it has 8 columns and 4 rows of character poses
   → Verify transparent background
7. Send: { type: "join_room", payload: { roomId: "room_player1" } }
8. Expect: room_state with grid, starter furniture, yourself as only player
   → Verify your player has the avatarUrl from step 6
9. Send: { type: "move", payload: { x: 6, y: 9, direction: "up" } }
10. Expect: player_moved
    → Client-side: walk cycle animates through idle → stepA → idle → stepB
11. Send: { type: "move", payload: { x: 0, y: 0, direction: "up" } }
12. Expect: error (wall tile)
13. Send: { type: "chat", payload: { text: "hello world" } }
14. Expect: chat_message
```

### 5.3 Test 2: Two Players, Both AI-Generated

```
Client A:
1. Sign up, create character (Short Red hair, Blue Hoodie)
2. Wait for character_created
3. Join room "room_test"
4. Expect: room_state (alone)

Client B:
5. Sign up, create character (Long Black hair, Green Dress)
6. Wait for character_created
7. Join room "room_test"
8. Expect: room_state (sees Client A)
   → Client B downloads A's sprite sheet — should show a red-haired character

Client A:
9. Expect: player_joined (Client B)
   → Client A downloads B's sprite sheet — should show a black-haired character
   → Verify: A and B look visually different (different AI generations)

10. Both move, chat, verify all broadcasts work as before
```

### 5.4–5.8: Remaining Tests

Tests 3 through 7 (furniture CRUD, chair sitting conflict, disconnect cleanup, access control, load test) are **identical** to the previous guide. The avatar system doesn't affect any of these. See the original integration guide for full test scripts.

---

## Phase 6: Improving Asset Quality

Unlike the old layer approach where "improvement" meant swapping PNG files, with AI generation improvement means **refining prompts and post-processing**.

### Prompt Tuning

If characters look inconsistent or off-style, iterate on the prompt template. Common issues and fixes:

| Issue | Fix |
|-------|-----|
| Cells not aligned properly | Add "rigid grid layout, each cell exactly the same size" to prompt |
| Characters vary between cells | Add "identical character in every cell, exact same proportions and colors" |
| Style inconsistency | Use a more specific style reference, or switch to a model fine-tuned for pixel art |
| White background bleeding | Adjust the `threshold` in `remove_white_bg()` or switch to a model that supports transparent backgrounds |
| Wrong pose in a cell | Make the cell description more explicit, or regenerate and pick the best result |

### Generation Retries

AI is non-deterministic. Sometimes a generation looks bad. Add retry logic:

```python
MAX_RETRIES = 3
for attempt in range(MAX_RETRIES):
    raw_img = generate_image(prompt)
    cells = split_grid(raw_img)
    # Basic quality check: are all cells non-empty? Is the color palette consistent?
    if passes_quality_check(cells):
        break
# If all retries fail, use the best attempt
```

### Better Models

The pipeline is provider-agnostic. The Lambda's `generate_image()` function is the only place that talks to the AI API. To switch from DALL-E to Stability AI to a fine-tuned pixel art model on Replicate, you change one function. Everything else — the splitting, flipping, assembly, S3 upload — stays identical.

For best pixel art results, consider fine-tuning a model on actual Stardew Valley sprite sheets (or similar CC-licensed pixel art) and hosting it on Replicate. This gives much more consistent grid layouts than general-purpose models.

### Furniture and Tile Regeneration

Since furniture and tiles are dev-time assets, regenerating them is just re-running the gen script with a better prompt. No infrastructure changes. Upload the new PNGs, invalidate CloudFront cache, done.

---

## Deployment Checklist

```
[ ] VPC + subnets + security groups created
[ ] DynamoDB tables created (Rooms, Players, Interactions)
[ ] Cognito User Pool + App Client created
[ ] S3 bucket created, OAC configured
[ ] AI-generated furniture PNGs uploaded to S3 (/furniture/)
[ ] AI-generated tile PNGs uploaded to S3 (/tiles/)
[ ] manifest.json (with characterOptions + spriteSheet blocks) uploaded to S3
[ ] CloudFront distribution created, pointing at S3
[ ] CloudFront serves manifest.json (verified)
[ ] CloudFront serves furniture and tile PNGs (verified)
[ ] Avatar Lambda deployed with:
    [ ] IMAGE_GEN_API_KEY set
    [ ] S3 write permissions for /avatars/*
    [ ] Outbound internet access (for AI API calls)
    [ ] 60-second timeout configured
[ ] Lambda generates a test avatar (invoke directly, verify 256x128 PNG)
[ ] Generated avatar accessible via CloudFront
[ ] ECR repo created, Docker image pushed
[ ] ECS cluster + task definition + service created (with AVATAR_LAMBDA_ARN)
[ ] Fargate task role includes lambda:InvokeFunction
[ ] ALB created, target group healthy, idle timeout = 3600
[ ] ALB health check returns 200
[ ] WebSocket connects with valid Cognito JWT
[ ] WebSocket rejects invalid token
[ ] Character creation works end-to-end:
    [ ] Client sends create_character with choices
    [ ] Server builds description, invokes Lambda
    [ ] Lambda calls AI API, post-processes, writes to S3
    [ ] Client receives avatarUrl, loads sprite sheet
    [ ] Sprite sheet renders correctly (walk cycle, sit, direction changes)
[ ] Test 1 passes (single player loop with AI-generated sprite)
[ ] Test 2 passes (two players, both AI-generated, visually different)
[ ] Test 3 passes (furniture CRUD)
[ ] Test 4 passes (chair conflict, sitting pose correct)
[ ] Test 5 passes (disconnect cleanup)
[ ] Test 6 passes (access control)
[ ] Test 7 passes (10 concurrent connections)
```

---

## Key Decisions and Tradeoffs

**Why AI-generate everything instead of hand-drawing or using layers?**
No artist dependency. Infinite character variety instead of preset combinations. Furniture and tiles can be regenerated by anyone who can write a prompt. The tradeoff is less control over exact pixel placement and a 10-30 second character creation time. For a social hangout game (not a competitive shooter), that tradeoff is fine.

**Why structured character options instead of free-form text?**
Free-form prompts produce wildly inconsistent results — "a dragon wearing a tuxedo" next to "a normal person in a t-shirt" breaks the game's visual coherence. Structured options (pick hair, pick outfit) give you consistent results because you control the prompt template. Players still get plenty of variety through the combinations.

**Why 8×4 instead of 4×4?**
The extra columns (wave, sleep, eat, laugh) cost nothing to generate — they're in the same AI image call. Having them in the sheet means v2 emotes are a client-only change: map a new message type to a new column index, done. No asset regeneration needed.

**Why split+flip post-processing instead of generating all 32 cells directly?**
AI models struggle with large grids. A 4×4 grid (16 cells) is near the limit of what current models handle well. An 8×4 grid (32 cells) would have severe quality degradation in the later cells. The flip trick gets you 32 cells from 16 AI-generated ones with zero quality loss, and the left-right flip is physically correct for a symmetric character.

**Why generate furniture at dev-time instead of runtime?**
Furniture is shared across all players. Generating it per-request would be wasteful and slow. Generate once, curate (touch up any AI artifacts), and ship as static assets. If you want to add new furniture later, generate a new batch and upload.

**What about the 10-30 second generation time?**
This only happens once per player, during character creation. After that, the sprite sheet is cached in S3/CloudFront and loads instantly for everyone. The loading UX during creation is a solved problem — show a fun animation, preview silhouette, or pixel art loading screen. Players are used to waiting during character creation in games.

**What about API costs?**
DALL-E 3 HD is ~$0.08 per image. At 100 players, that's $8 total for all character generation. Furniture + tiles are maybe $5 for the initial batch. This is not a cost concern at this scale. At 100K players, you'd budget $8K for character gen and consider a cheaper model or caching strategy.

**What if the AI generates garbage?**
Add validation in the Lambda: check that the output image is the expected dimensions, that cells aren't empty/white, and that there's reasonable color variation between cells. If validation fails, retry (up to 3 times). If all retries fail, fall back to a pre-generated default sprite sheet so the player can still play. They can regenerate their character later.

**Why stub B's and C's modules?**
Same as before — the server skeleton and message routing are the integration point. The stubs define the contract. Nothing about AI-generated assets changes this.
