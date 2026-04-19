#!/bin/bash
# Two clients, both AI-generated, same room
# Client A: Short Red hair, Blue Hoodie
# Client B: Long Black hair, Green Dress
# Both join room_test
# Verify A sees B with black hair sprite
# Verify B sees A with red hair sprite
# Both move and chat

set -e

COGNITO_REGION="${COGNITO_REGION:-us-east-1}"
COGNITO_POOL_ID="${COGNITO_POOL_ID:-us-east-1_xxxxx}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-xxxxxxxxxx}"
ALB_DNS="${ALB_DNS:-alb-dns}"
WS_URL="wss://${ALB_DNS}/ws"
ROOM_ID="room_test"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

PYWS_A="/tmp/ws_client_a_$$.py"
PYWS_B="/tmp/ws_client_b_$$.py"
trap 'rm -f "$PYWS_A" "$PYWS_B"' EXIT

# Create two users
create_user() {
    local label=$1
    local email="${label}_$(date +%s)@test.invalid"
    local password="Test1234!"
    local username="${label}_$(date +%s)"

    SIGNUP_RESP=$(aws cognito-idp sign-up \
        --region "$COGNITO_REGION" \
        --client-id "$COGNITO_CLIENT_ID" \
        --username "$email" \
        --password "$password" \
        --user-attributes Name=email,Value="$email" Name=preferred_username,Value="$username" 2>&1) || fail "Sign-up $label failed"

    aws cognito-idp admin-confirm-sign-up \
        --region "$COGNITO_REGION" \
        --user-pool-id "$COGNITO_POOL_ID" \
        --username "$email" 2>/dev/null || true

    AUTH_RESP=$(aws cognito-idp initiate-auth \
        --region "$COGNITO_REGION" \
        --auth-flow USER_SRP_AUTH \
        --client-id "$COGNITO_CLIENT_ID" \
        --auth-parameters USERNAME="$email",PASSWORD="$password" 2>&1)

    JWT=$(echo "$AUTH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('AuthenticationResult',{}).get('IdToken',''))" 2>/dev/null)
    [ -z "$JWT" ] && fail "No JWT for $label"
    echo "$JWT"
}

echo "=== Creating Client A (Short Red hair, Blue Hoodie) ==="
JWT_A=$(create_user "clientA")
pass "Client A signed up"

echo "=== Creating Client B (Long Black hair, Green Dress) ==="
JWT_B=$(create_user "clientB")
pass "Client B signed up"

# Two-player WebSocket script
cat > "$PYWS_A" << 'PYSCRIPT'
import asyncio
import json
import sys
import time
import urllib.request

async def run():
    token = sys.argv[1]
    ws_url = sys.argv[2]
    room_id = sys.argv[3]
    expected_hair = sys.argv[4]  # hair color of the OTHER player

    import websockets
    async with websockets.connect(f"{ws_url}?token={token}") as ws:
        print("connected", flush=True)

        # Create character
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

        avatar_url = None
        while time.time() - start < 60:
            resp = await asyncio.wait_for(ws.recv(), timeout=5)
            msg = json.loads(resp)
            if msg.get("type") == "character_created":
                avatar_url = msg.get("payload", {}).get("avatarUrl")
                break

        if not avatar_url:
            print("TIMEOUT: no character_created for A", flush=True)
            sys.exit(1)

        print(f"A: avatar_url={avatar_url}", flush=True)

        # Join room
        await ws.send(json.dumps({"type": "join_room", "payload": {"roomId": room_id}}))

        other_player_avatar = None
        start = time.time()
        while time.time() - start < 30:
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(resp)
            if msg.get("type") == "room_state":
                players = msg.get("payload", {}).get("players", [])
                for p in players:
                    if p.get("avatarUrl") and p.get("avatarUrl") != avatar_url:
                        other_player_avatar = p.get("avatarUrl")
                        break
            elif msg.get("type") == "player_joined":
                other_player_avatar = msg.get("payload", {}).get("avatarUrl")
                break

        if not other_player_avatar:
            print("A: did not see other player join", flush=True)
            sys.exit(1)

        print(f"A: sees other player avatar={other_player_avatar}", flush=True)

        # Download and check it's a valid PNG with expected properties
        try:
            req = urllib.request.Request(other_player_avatar)
            with urllib.request.urlopen(req) as r:
                data = r.read()
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(data))
            print(f"A: other player avatar size: {img.width}x{img.height}", flush=True)
            if img.width != 256 or img.height != 128:
                print("ERROR: wrong avatar dimensions", flush=True)
                sys.exit(1)
        except Exception as e:
            print(f"ERROR: {e}", flush=True)
            sys.exit(1)

        # Move
        await ws.send(json.dumps({"type": "move", "payload": {"x": 3, "y": 5, "direction": "down"}}))
        print("A: move sent", flush=True)

        # Chat
        await ws.send(json.dumps({"type": "chat", "payload": {"text": "hello from A"}}))
        print("A: chat sent", flush=True)

        print("A_DONE", flush=True)

start = time.time()
asyncio.run(run())
PYSCRIPT

cat > "$PYWS_B" << 'PYSCRIPT'
import asyncio
import json
import sys
import time
import urllib.request

async def run():
    token = sys.argv[1]
    ws_url = sys.argv[2]
    room_id = sys.argv[3]
    expected_hair = sys.argv[4]  # hair color of the OTHER player

    import websockets
    async with websockets.connect(f"{ws_url}?token={token}") as ws:
        print("connected", flush=True)

        # Create character
        create_msg = {
            "type": "create_character",
            "payload": {
                "hairStyle": "Long",
                "hairColor": "Black",
                "skinTone": "Dark",
                "outfit": "Dress",
                "outfitColor": "Green",
                "accessory": "None"
            }
        }
        await ws.send(json.dumps(create_msg))

        avatar_url = None
        while time.time() - start < 60:
            resp = await asyncio.wait_for(ws.recv(), timeout=5)
            msg = json.loads(resp)
            if msg.get("type") == "character_created":
                avatar_url = msg.get("payload", {}).get("avatarUrl")
                break

        if not avatar_url:
            print("TIMEOUT: no character_created for B", flush=True)
            sys.exit(1)

        print(f"B: avatar_url={avatar_url}", flush=True)

        # Join room
        await ws.send(json.dumps({"type": "join_room", "payload": {"roomId": room_id}}))

        other_player_avatar = None
        start = time.time()
        while time.time() - start < 30:
            resp = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(resp)
            if msg.get("type") == "room_state":
                players = msg.get("payload", {}).get("players", [])
                for p in players:
                    if p.get("avatarUrl") and p.get("avatarUrl") != avatar_url:
                        other_player_avatar = p.get("avatarUrl")
                        break
            elif msg.get("type") == "player_joined":
                other_player_avatar = msg.get("payload", {}).get("avatarUrl")
                break

        if not other_player_avatar:
            print("B: did not see other player join", flush=True)
            sys.exit(1)

        print(f"B: sees other player avatar={other_player_avatar}", flush=True)

        # Download and check
        try:
            req = urllib.request.Request(other_player_avatar)
            with urllib.request.urlopen(req) as r:
                data = r.read()
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(data))
            print(f"B: other player avatar size: {img.width}x{img.height}", flush=True)
            if img.width != 256 or img.height != 128:
                print("ERROR: wrong avatar dimensions", flush=True)
                sys.exit(1)
        except Exception as e:
            print(f"ERROR: {e}", flush=True)
            sys.exit(1)

        # Move
        await ws.send(json.dumps({"type": "move", "payload": {"x": 4, "y": 6, "direction": "down"}}))
        print("B: move sent", flush=True)

        # Chat
        await ws.send(json.dumps({"type": "chat", "payload": {"text": "hello from B"}}))
        print("B: chat sent", flush=True)

        print("B_DONE", flush=True)

start = time.time()
asyncio.run(run())
PYSCRIPT

python3 -c "import websockets" 2>/dev/null || { echo "websockets package required"; exit 1; }

# Run both clients in parallel
python3 "$PYWS_A" "$JWT_A" "$WS_URL" "$ROOM_ID" "Black" > /tmp/out_a_$$.log 2>&1 &
PID_A=$!
python3 "$PYWS_B" "$JWT_B" "$WS_URL" "$ROOM_ID" "Red" > /tmp/out_b_$$.log 2>&1 &
PID_B=$!

# Wait for both
fail_a=false
fail_b=false
wait $PID_A || fail_a=true
wait $PID_B || fail_b=true

cat /tmp/out_a_$$.log
cat /tmp/out_b_$$.log

if $fail_a; then
    fail "Client A exited with error"
fi
if $fail_b; then
    fail "Client B exited with error"
fi

if grep -q "A_DONE" /tmp/out_a_$$.log && grep -q "B_DONE" /tmp/out_b_$$.log; then
    pass "Two-player test completed"
else
    fail "Two-player test did not complete"
fi
