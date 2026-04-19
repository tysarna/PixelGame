#!/bin/bash
# Player disconnects, verify cleanup
# Join room, disconnect, verify player_removed broadcast

set -e

COGNITO_REGION="${COGNITO_REGION:-us-east-1}"
COGNITO_POOL_ID="${COGNITO_POOL_ID:-us-east-1_xxxxx}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-xxxxxxxxxx}"
ALB_DNS="${ALB_DNS:-alb-dns}"
WS_URL="wss://${ALB_DNS}/ws"
ROOM_ID="room_disconnect_test"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

# Create two users: A stays, B disconnects
create_user() {
    local email=$1
    local password="Test1234!"
    local username=$2

    aws cognito-idp sign-up \
        --region "$COGNITO_REGION" \
        --client-id "$COGNITO_CLIENT_ID" \
        --username "$email" \
        --password "$password" \
        --user-attributes Name=email,Value="$email" Name=preferred_username,Value="$username" 2>/dev/null || true

    aws cognito-idp admin-confirm-sign-up \
        --region "$COGNITO_REGION" \
        --user-pool-id "$COGNITO_POOL_ID" \
        --username "$email" 2>/dev/null || true

    AUTH_RESP=$(aws cognito-idp initiate-auth \
        --region "$COGNITO_REGION" \
        --auth-flow USER_SRP_AUTH \
        --client-id "$COGNITO_CLIENT_ID" \
        --auth-parameters USERNAME="$email",PASSWORD="$password" 2>&1)

    echo "$AUTH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('AuthenticationResult',{}).get('IdToken',''))" 2>/dev/null
}

EMAIL_A="sta_$(date +%s)@test.invalid"
EMAIL_B="stb_$(date +%s)@test.invalid"
JWT_A=$(create_user "$EMAIL_A" "sta_$(date +%s)") || fail "Create user A failed"
JWT_B=$(create_user "$EMAIL_B" "stb_$(date +%s)") || fail "Create user B failed"

PYWS_A="/tmp/ws_a_$$.py"
PYWS_B="/tmp/ws_b_$$.py"
trap 'rm -f "$PYWS_A" "$PYWS_B"' EXIT

cat > "$PYWS_A" << 'PYSCRIPT'
import asyncio
import json
import sys
import time

async def run():
    token = sys.argv[1]
    ws_url = sys.argv[2]
    room_id = sys.argv[3]

    import websockets
    async with websockets.connect(f"{ws_url}?token={token}") as ws:
        print("A: connected", flush=True)

        # Create character
        await ws.send(json.dumps({
            "type": "create_character",
            "payload": {"hairStyle": "Short", "hairColor": "Brown", "skinTone": "Light",
                        "outfit": "T-shirt", "outfitColor": "Red", "accessory": "None"}
        }))

        while True:
            resp = await asyncio.wait_for(ws.recv(), timeout=60)
            msg = json.loads(resp)
            if msg.get("type") == "character_created":
                break

        # Join room
        await ws.send(json.dumps({"type": "join_room", "payload": {"roomId": room_id}}))

        removed_received = False
        start = time.time()
        while time.time() - start < 30:
            resp = await asyncio.wait_for(ws.recv(), timeout=15)
            msg = json.loads(resp)
            if msg.get("type") == "player_removed":
                removed_received = True
                print("A: player_removed received", flush=True)
                break
            elif msg.get("type") == "room_state":
                print("A: room_state received", flush=True)

        if removed_received:
            print("A_DONE", flush=True)
        else:
            print("A: player_removed not received", flush=True)
            sys.exit(1)

asyncio.run(run())
PYSCRIPT

cat > "$PYWS_B" << 'PYSCRIPT'
import asyncio
import json
import sys
import time

async def run():
    token = sys.argv[1]
    ws_url = sys.argv[2]
    room_id = sys.argv[3]

    import websockets
    async with websockets.connect(f"{ws_url}?token={token}") as ws:
        print("B: connected", flush=True)

        # Create character
        await ws.send(json.dumps({
            "type": "create_character",
            "payload": {"hairStyle": "Long", "hairColor": "Blonde", "skinTone": "Medium",
                        "outfit": "Dress", "outfitColor": "Blue", "accessory": "None"}
        }))

        while True:
            resp = await asyncio.wait_for(ws.recv(), timeout=60)
            msg = json.loads(resp)
            if msg.get("type") == "character_created":
                break

        # Join room (same room as A)
        await ws.send(json.dumps({"type": "join_room", "payload": {"roomId": room_id}}))

        # Wait briefly then disconnect
        await asyncio.sleep(5)
        print("B: disconnecting", flush=True)
        # Connection closes on exit

asyncio.run(run())
PYSCRIPT

python3 -c "import websockets" 2>/dev/null || { echo "websockets required"; exit 1; }

# Run A first (stays connected)
python3 "$PYWS_A" "$JWT_A" "$WS_URL" "$ROOM_ID" > /tmp/out_a_$$.log 2>&1 &
PID_A=$!

# Give A time to join, then start B
sleep 2
python3 "$PYWS_B" "$JWT_B" "$WS_URL" "$ROOM_ID" > /tmp/out_b_$$.log 2>&1 &
PID_B=$!

wait $PID_B 2>/dev/null || true
# Wait for A to receive player_removed
sleep 10
kill $PID_A 2>/dev/null || true

cat /tmp/out_a_$$.log
cat /tmp/out_b_$$.log

if grep -q "A_DONE" /tmp/out_a_$$.log; then
    pass "Disconnect cleanup: player_removed received by remaining player"
else
    fail "Disconnect cleanup: player_removed not received"
fi
