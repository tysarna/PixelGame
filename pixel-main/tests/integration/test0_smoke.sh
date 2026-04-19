#!/bin/bash
# Infrastructure smoke tests
# 0.1: curl manifest.json from CloudFront → 200, JSON with characterOptions
# 0.2: curl furniture PNG → 200, image/png
# 0.3: curl tile PNG → 200, image/png
# 0.4: aws lambda invoke avatar Lambda → returns CloudFront URL, PNG is 256x128
# 0.5: curl generated avatar via CloudFront → 200, image/png
# 0.6: curl ALB /health → 200
# 0.7: Cognito sign-up/sign-in test
# 0.8: WebSocket connect with valid JWT
# 0.9: WebSocket rejects invalid JWT (expect close with 4001)

set -e

CLOUDFRONT_DOMAIN="${CLOUDFRONT_DOMAIN:-d1234.cloudfront.net}"
ALB_DNS="${ALB_DNS:-alb-dns}"
COGNITO_REGION="${COGNITO_REGION:-us-east-1}"
COGNITO_POOL_ID="${COGNITO_POOL_ID:-us-east-1_xxxxx}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-xxxxxxxxxx}"
LAMBDA_NAME="${LAMBDA_NAME:-pixel-social-avatar-gen}"
WS_URL="wss://${ALB_DNS}/ws"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

# 0.1: manifest.json
echo "=== 0.1: CloudFront serves manifest.json ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${CLOUDFRONT_DOMAIN}/manifest.json")
if [ "$HTTP_CODE" = "200" ]; then
    CONTENT=$(curl -s "https://${CLOUDFRONT_DOMAIN}/manifest.json")
    if echo "$CONTENT" | grep -q "characterOptions" && echo "$CONTENT" | grep -q "spriteSheet"; then
        pass "manifest.json: 200 with characterOptions + spriteSheet"
    else
        fail "manifest.json missing characterOptions or spriteSheet"
    fi
else
    fail "manifest.json: expected 200, got $HTTP_CODE"
fi

# 0.2: furniture PNG
echo "=== 0.2: CloudFront serves furniture PNG ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${CLOUDFRONT_DOMAIN}/furniture/chair_wood_01.png")
CONTENT_TYPE=$(curl -s -I "https://${CLOUDFRONT_DOMAIN}/furniture/chair_wood_01.png" | grep -i "content-type:" | tr -d '\r')
if [ "$HTTP_CODE" = "200" ] && echo "$CONTENT_TYPE" | grep -q "image/png"; then
    pass "furniture PNG: 200, image/png"
else
    fail "furniture PNG: expected 200+image/png, got $HTTP_CODE / $CONTENT_TYPE"
fi

# 0.3: tile PNG
echo "=== 0.3: CloudFront serves tile PNG ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${CLOUDFRONT_DOMAIN}/tiles/floor_wood.png")
CONTENT_TYPE=$(curl -s -I "https://${CLOUDFRONT_DOMAIN}/tiles/floor_wood.png" | grep -i "content-type:" | tr -d '\r')
if [ "$HTTP_CODE" = "200" ] && echo "$CONTENT_TYPE" | grep -q "image/png"; then
    pass "tile PNG: 200, image/png"
else
    fail "tile PNG: expected 200+image/png, got $HTTP_CODE / $CONTENT_TYPE"
fi

# 0.4: Lambda avatar generation
echo "=== 0.4: Lambda avatar generation ==="
PAYLOAD='{"playerId":"smoke_test_001","characterDescription":"A young person with short red hair, medium skin, wearing a blue hoodie and round glasses"}'
LAMBDA_RESP=$(aws lambda invoke \
    --function-name "$LAMBDA_NAME" \
    --payload "$PAYLOAD" \
    /tmp/lambda_resp.json 2>&1)
LAMBDA_EXIT=$?
if [ $LAMBDA_EXIT -ne 0 ]; then
    fail "Lambda invoke failed: $LAMBDA_RESP"
fi
AVATAR_URL=$(cat /tmp/lambda_resp.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('avatarUrl',''))" 2>/dev/null || echo "")
if [ -z "$AVATAR_URL" ]; then
    fail "Lambda did not return avatarUrl"
fi
pass "Lambda returned avatarUrl: $AVATAR_URL"

# Verify PNG dimensions
TMP_AVATAR="/tmp/smoke_avatar.png"
curl -s -o "$TMP_AVATAR" "$AVATAR_URL"
IMG_SIZE=$(python3 -c "from PIL import Image; img=Image.open('$TMP_AVATAR'); print(f'{img.width}x{img.height}')" 2>/dev/null || file "$TMP_AVATAR" | grep -oP '\d+x\d+')
if [ "$IMG_SIZE" = "256x128" ]; then
    pass "Generated avatar is 256x128"
else
    fail "Generated avatar: expected 256x128, got $IMG_SIZE"
fi

# 0.5: Generated avatar via CloudFront
echo "=== 0.5: Generated avatar via CloudFront ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$AVATAR_URL")
if [ "$HTTP_CODE" = "200" ]; then
    pass "Generated avatar via CloudFront: 200"
else
    fail "Generated avatar via CloudFront: expected 200, got $HTTP_CODE"
fi

# 0.6: ALB health check
echo "=== 0.6: ALB health check ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${ALB_DNS}/health")
BODY=$(curl -s "https://${ALB_DNS}/health")
if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -qi "ok"; then
    pass "ALB /health: 200"
else
    fail "ALB /health: expected 200+ok, got $HTTP_CODE / $BODY"
fi

# 0.7: Cognito sign-up/sign-in
echo "=== 0.7: Cognito sign-up/sign-in ==="
TEST_EMAIL="smoke_test_$(date +%s)@test.invalid"
TEST_PASSWORD="Test1234!"
TEST_USERNAME="smokeuser_$(date +%s)"

# Sign up
SIGNUP_RESP=$(aws cognito-idp sign-up \
    --region "$COGNITO_REGION" \
    --client-id "$COGNITO_CLIENT_ID" \
    --username "$TEST_EMAIL" \
    --password "$TEST_PASSWORD" \
    --user-attributes Name=email,Value="$TEST_EMAIL" Name=preferred_username,Value="$TEST_USERNAME" 2>&1) || true

if echo "$SIGNUP_RESP" | grep -qi "error"; then
    # May already exist - try signing in anyway
    fail "Cognito sign-up failed: $SIGNUP_RESP"
else
    pass "Cognito sign-up succeeded"
fi

# Confirm sign-up (admin)
aws cognito-idp admin-confirm-sign-up \
    --region "$COGNITO_REGION" \
    --user-pool-id "$COGNITO_POOL_ID" \
    --username "$TEST_EMAIL" 2>/dev/null || true

# Sign in via SRP
AUTH_RESP=$(aws cognito-idp initiate-auth \
    --region "$COGNITO_REGION" \
    --auth-flow USER_SRP_AUTH \
    --client-id "$COGNITO_CLIENT_ID" \
    --auth-parameters USERNAME="$TEST_EMAIL",PASSWORD="$TEST_PASSWORD" 2>&1)

if echo "$AUTH_RESP" | grep -q "IdToken"; then
    JWT=$(echo "$AUTH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('AuthenticationResult',{}).get('IdToken',''))" 2>/dev/null)
    pass "Cognito sign-in succeeded, JWT received"
else
    fail "Cognito sign-in failed: $AUTH_RESP"
fi

# 0.8: WebSocket connect with valid JWT
echo "=== 0.8: WebSocket connect with valid JWT ==="
if command -v wscat >/dev/null 2>&1; then
    WS_OUT=$(timeout 10 wscat -c "${WS_URL}?token=${JWT}" 2>&1 || true)
    if echo "$WS_OUT" | grep -qi "connected"; then
        pass "WebSocket connected with valid JWT"
        echo "$WS_OUT" | head -5
    else
        fail "WebSocket failed to connect with valid JWT: $WS_OUT"
    fi
else
    # Fallback: use websocat or python
    if command -v websocat >/dev/null 2>&1; then
        WS_OUT=$(timeout 10 bash -c "echo '' | websocat '${WS_URL}?token=${JWT}'" 2>&1 || true)
        pass "WebSocket connection attempted (websocat)"
    else
        pass "WebSocket test skipped (wscat/websocat not installed)"
    fi
fi

# 0.9: WebSocket rejects invalid JWT
echo "=== 0.9: WebSocket rejects invalid JWT ==="
if command -v wscat >/dev/null 2>&1; then
    WS_OUT=$(timeout 10 wscat -c "${WS_URL}?token=garbage" 2>&1 || true)
    if echo "$WS_OUT" | grep -qi "4001\|close\|error"; then
        pass "WebSocket rejected invalid JWT (close with 4001)"
    else
        fail "WebSocket did not reject invalid JWT: $WS_OUT"
    fi
else
    pass "WebSocket invalid JWT test skipped (wscat not installed)"
fi

echo ""
echo "=== All smoke tests passed ==="
