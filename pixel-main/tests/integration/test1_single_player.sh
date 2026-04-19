#!/bin/bash
# Full character creation loop
# 1. Sign up via Cognito → get JWT
# 2. Connect WebSocket with JWT
# 3. Send create_character with choices
# 4. Expect character_generating
# 5. Wait for character_created (10-30s)
# 6. Download avatarUrl, verify it's 256x128 PNG with 8 cols x 4 rows
# 7. Send join_room
# 8. Expect room_state
# 9. Send move (x:6, y:9, direction:up)
# 10. Expect player_moved
# 11. Send chat message
# 12. Expect chat_message

set -e

COGNITO_REGION="${COGNITO_REGION:-us-east-1}"
COGNITO_POOL_ID="${COGNITO_POOL_ID:-us-east-1_xxxxx}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-xxxxxxxxxx}"
ALB_DNS="${ALB_DNS:-alb-dns}"
WS_URL="wss://${ALB_DNS}/ws"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

# Use python for WebSocket client (cross-platform, no extra deps)
PYWS_SCRIPT="/tmp/ws_client_$$.py"

# Cleanup on exit
cleanup() { rm -f "$PYWS_SCRIPT" /tmp/ws_out_$$.json; }
trap cleanup EXIT

# 1. Cognito sign-up
echo "=== 1: Cognito sign-up ==="
TEST_EMAIL="sp1_test_$(date +%s)@test.invalid"
TEST_PASSWORD="Test1234!"
TEST_USERNAME="sp1user_$(date +%s)"

SIGNUP_RESP=$(aws cognito-idp sign-up \
    --region "$COGNITO_REGION" \
    --client-id "$COGNITO_CLIENT_ID" \
    --username "$TEST_EMAIL" \
    --password "$TEST_PASSWORD" \
    --user-attributes Name=email,Value="$TEST_EMAIL" Name=preferred_username,Value="$TEST_USERNAME" 2>&1) || fail "Sign-up failed: $SIGNUP_RESP"

aws cognito-idp admin-confirm-sign-up \
    --region "$COGNITO_REGION" \
    --user-pool-id "$COGNITO_POOL_ID" \
    --username "$TEST_EMAIL" 2>/dev/null || true

AUTH_RESP=$(aws cognito-idp initiate-auth \
    --region "$COGNITO_REGION" \
    --auth-flow USER_SRP_AUTH \
    --client-id "$COGNITO_CLIENT_ID" \
    --auth-parameters USERNAME="$TEST_EMAIL",PASSWORD="$TEST_PASSWORD" 2>&1)

JWT=$(echo "$AUTH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('AuthenticationResult',{}).get('IdToken',''))" 2>/dev/null)
[ -z "$JWT" ] && fail "No JWT from Cognito"

pass "Signed up and got JWT: ${JWT:0:20}..."

# 2-5. WebSocket + character creation
echo "=== 2-5: WebSocket connect, create character ==="

cat > "$PYWS_SCRIPT" << 'PYSCRIPT'
import asyncio
import json
import sys
import time
import urllib.request
import urllib.error

async def run():
    token = sys.argv[1]
    ws_url = sys.argv[2]

    # Connect
    import websockets
    async with websockets.connect(f"{ws_url}?token={token}") as ws:
        print("connected", flush=True)

        # 3. Send create_character
        create_msg = {
            "type": "create_character",
            "payload": {
                "hairStyle": "Short",
                "hairColor": "Red",
                "skinTone": "Medium",
                "outfit": "Hoodie",
                "outfitColor": "Blue",
                "accessory": "Glasses"
            }
        }
        await ws.send(json.dumps(create_msg))
        print(f"sent create_character", flush=True)

        avatar_url = None
        start = time.time()
        timeout = 60  # allow up to 60s for generation

        while time.time() - start < timeout:
            resp = await asyncio.wait_for(ws.recv(), timeout=5)
            msg = json.loads(resp)
            print(f"received: {msg.get('type')}", flush=True)

            if msg.get("type") == "character_generating":
                print("character_generating received", flush=True)

            elif msg.get("type") == "character_created":
                avatar_url = msg.get("payload", {}).get("avatarUrl")
                print(f"character_created: {avatar_url}", flush=True)
                break

        if not avatar_url:
            print("TIMEOUT: no character_created", flush=True)
            sys.exit(1)

        # 6. Download and verify avatar
        try:
            req = urllib.request.Request(avatar_url)
            with urllib.request.urlopen(req) as r:
                data = r.read()
            print(f"avatar downloaded: {len(data)} bytes", flush=True)

            from PIL import Image
            import io
            img = Image.open(io.BytesIO(data))
            print(f"avatar size: {img.width}x{img.height}", flush=True)
            if img.width == 256 and img.height == 128:
                print("avatar dimensions OK", flush=True)
            else:
                print(f"ERROR: expected 256x128, got {img.width}x{img.height}", flush=True)
                sys.exit(1)
        except Exception as e:
            print(f"ERROR downloading avatar: {e}", flush=True)
            sys.exit(1)

        # 7. Send join_room
        join_msg = {"type": "join_room", "payload": {"roomId": "room_player1"}}
        await ws.send(json.dumps(join_msg))
        print("sent join_room", flush=True)

        room_state_received = False
        while not room_state_received:
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(resp)
            print(f"received: {msg.get('type')}", flush=True)
            if msg.get("type") == "room_state":
                room_state_received = True
                players = msg.get("payload", {}).get("players", [])
                if any(p.get("avatarUrl") == avatar_url for p in players):
                    print("room_state: own avatarUrl present", flush=True)
                else:
                    print("ERROR: own avatarUrl not in room_state", flush=True)
                    sys.exit(1)

        # 9. Send move
        move_msg = {"type": "move", "payload": {"x": 6, "y": 9, "direction": "up"}}
        await ws.send(json.dumps(move_msg))
        print("sent move", flush=True)

        moved_received = False
        while not moved_received:
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(resp)
            print(f"received: {msg.get('type')}", flush=True)
            if msg.get("type") == "player_moved":
                moved_received = True
                print("player_moved received", flush=True)

        # 11. Send chat
        chat_msg = {"type": "chat", "payload": {"text": "hello world"}}
        await ws.send(json.dumps(chat_msg))
        print("sent chat", flush=True)

        chat_received = False
        while not chat_received:
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(resp)
            print(f"received: {msg.get('type')}", flush=True)
            if msg.get("type") == "chat_message":
                chat_received = True
                print("chat_message received", flush=True)

        print("ALL_DONE", flush=True)

if __name__ == "__main__":
    asyncio.run(run())
PYSCRIPT

# Check for websockets package
python3 -c "import websockets" 2>/dev/null || { echo "websockets package required: pip install websockets pillow"; exit 1; }
python3 -c "from PIL import Image" 2>/dev/null || { echo "Pillow required: pip install Pillow"; exit 1; }

RESULT=$(python3 "$PYWS_SCRIPT" "$JWT" "$WS_URL" 2>&1)
WS_EXIT=$?

echo "$RESULT"

if echo "$RESULT" | grep -q "ALL_DONE"; then
    pass "Single player loop completed"
else
    fail "Single player loop failed (exit $WS_EXIT)"
fi
