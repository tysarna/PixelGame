# Teammate Deploy & Development Guide

This guide explains how to get AWS access, develop locally, and deploy changes to the Pixel Social game server.

---

## 1. Getting AWS Access

You have an IAM user (`pixel-dev-b`) with **AdministratorAccess** on account `911319296449`. Credentials are shared out-of-band (see message from project owner — do NOT commit them).

### Your setup

```bash
# 1. Configure your credentials
aws configure --profile pixel-deploy
# AWS Access Key ID:     <from owner>
# AWS Secret Access Key: <from owner>
# Default region:        us-east-1
# Default output format: json

# 2. Test it works
aws sts get-caller-identity --profile pixel-deploy
# Should show: "Arn": "arn:aws:iam::911319296449:user/teammate-b"
```

From now on, use `--profile pixel-deploy` (or `export AWS_PROFILE=pixel-deploy`) for all commands.

---

## 2. Local Development

### Prerequisites

- Node.js 20+
- Docker Desktop (with buildx)
- AWS CLI v2
- `wscat` (`npm install -g wscat`)

### Run the game server locally

```bash
cd game-server
npm install
npm start
# Server starts on ws://localhost:3000
```

The server needs these env vars to talk to AWS (set them or use your profile):

```bash
export AWS_PROFILE=pixel-deploy
export TABLE_ROOMS=Rooms
export TABLE_PLAYERS=Players
export TABLE_INTERACTIONS=Interactions
export COGNITO_USER_POOL_ID=us-east-1_T4Gej0pzm
export COGNITO_CLIENT_ID=5hh6ocl6llo47181epra7ombli
export COGNITO_REGION=us-east-1
export CLOUDFRONT_DOMAIN=dc9iwjwlk784c.cloudfront.net
```

### Test with wscat

```bash
# Get a JWT by signing in via the client or AWS CLI
wscat -c "ws://localhost:3000/ws?token=<JWT>"

# Join a room
> {"type":"join_room","payload":{"roomId":"test","avatarUrl":""}}

# Place furniture
> {"type":"place_furniture","payload":{"roomId":"test","itemId":"chair_wood_01","x":5,"y":5}}

# Move furniture (use instanceId from the furniture_placed response)
> {"type":"move_furniture","payload":{"roomId":"test","instanceId":"<uuid>","x":6,"y":6}}

# Remove furniture
> {"type":"remove_furniture","payload":{"roomId":"test","instanceId":"<uuid>"}}
```

### Check DynamoDB state

```bash
# List all furniture in a room
aws dynamodb query \
  --table-name Interactions \
  --key-condition-expression 'PK = :pk AND begins_with(SK, :prefix)' \
  --expression-attribute-values '{":pk":{"S":"ROOM#test"},":prefix":{"S":"FURNITURE#"}}' \
  --profile pixel-deploy
```

---

## 3. Deploy

### Build & push the Docker image

```bash
cd game-server

# Login to ECR
aws ecr get-login-password --region us-east-1 --profile pixel-deploy | \
  docker login --username AWS --password-stdin 911319296449.dkr.ecr.us-east-1.amazonaws.com

# IMPORTANT: always use --platform linux/amd64 (ECS Fargate is x86_64)
docker buildx build --platform linux/amd64 \
  -t 911319296449.dkr.ecr.us-east-1.amazonaws.com/pixel-social-server:latest .

docker push 911319296449.dkr.ecr.us-east-1.amazonaws.com/pixel-social-server:latest
```

### Trigger ECS redeployment

```bash
aws ecs update-service \
  --cluster pixel-social-cluster \
  --service PixelSocialStack-PixelSocialServiceF69AC5DC-eWEHoEaRCDCI \
  --force-new-deployment \
  --profile pixel-deploy
```

### Monitor deployment

```bash
# Watch until stable (~2-3 min)
aws ecs wait services-stable \
  --cluster pixel-social-cluster \
  --services PixelSocialStack-PixelSocialServiceF69AC5DC-eWEHoEaRCDCI \
  --profile pixel-deploy

# Check service status
aws ecs describe-services \
  --cluster pixel-social-cluster \
  --services PixelSocialStack-PixelSocialServiceF69AC5DC-eWEHoEaRCDCI \
  --query 'services[0].{desired:desiredCount,running:runningCount,deployments:deployments[*].{status:status,running:runningCount}}' \
  --profile pixel-deploy
```

### Check logs after deploy

```bash
aws logs filter-log-events \
  --log-group-name /ecs/pixel-social \
  --start-time $(date -v-10M +%s000) \
  --filter-pattern "ERROR" \
  --profile pixel-deploy
```

---

## 4. Architecture Quick Reference

```
Browser → CloudFront (dc9iwjwlk784c.cloudfront.net)
       → ALB:80/ws → ECS Fargate (game-server) → DynamoDB
                                                 → Lambda (avatar gen)
```

### Files you own (Person B — decorEngine)

```
game-server/src/modules/decorEngine.js   ← your implementation
game-server/manifest.json                ← furniture metadata (copy of client/manifest.json)
```

### Files you should NOT modify

```
game-server/src/index.js        — WS server, auth, connection lifecycle
game-server/src/router.js       — message dispatch
game-server/src/state.js        — in-memory state
game-server/src/broadcast.js    — send/broadcast helpers
game-server/src/handlers/*      — thin proxies to your module
```

### DynamoDB records you own

Table: `Interactions`

| PK | SK | Purpose |
|----|-----|---------|
| `ROOM#<roomId>` | `FURNITURE#<instanceId>` | Furniture placement record |
| `ROOM#<roomId>` | `TILE#<x>_<y>` | Tile lock (collision prevention) |

---

## 5. Important Notes

- **manifest.json**: If furniture items are added/changed in `client/manifest.json`, you must copy it to `game-server/manifest.json` before building Docker
- **Apple Silicon**: Always use `--platform linux/amd64` for Docker builds — ECS Fargate is x86_64
- **Room ownership**: `roomId` equals the owner's Cognito sub (playerId). Only room owners can place/move/remove furniture
- **Security**: Never commit `.env` files or AWS credentials. Use profiles and role assumption only
- **Credential rotation**: Access keys should be rotated every 90 days. The owner can regenerate them via `aws iam create-access-key`
