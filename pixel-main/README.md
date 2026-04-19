# Pixel Social Rooms — AI-Generated Multiplayer Game

A multiplayer social rooms game where every visual asset — characters, furniture, tiles — is AI-generated. Built on AWS with ECS Fargate, Cognito, DynamoDB, and a Python Lambda for avatar generation.

## Architecture

```
Browser Client (HTML/Canvas)
│
├── HTTPS GET → CloudFront → S3 (static assets + AI avatars)
└── WebSocket → ALB → ECS Fargate (game server)
                      │
                      ├── Cognito (JWT validation)
                      ├── DynamoDB (Rooms, Players, Interactions)
                      └── Lambda (avatar gen: AI API → post-process → S3)
```

## Repository Structure

```
pixel-social/
├── infra/                   # AWS CDK TypeScript — all cloud infrastructure
│   ├── lib/pixel-social-stack.ts   # Main stack
│   ├── bin/infra.ts          # Stack instantiation
│   └── package.json
│
├── lambda/                   # Avatar generation Lambda (Python 3.12)
│   ├── avatar_lambda.py      # Main handler: AI gen → grid split → flip → S3
│   └── requirements.txt       # Pillow, boto3, requests
│
├── scripts/                  # Dev-time AI asset generation
│   ├── generate_furniture.py # AI-generate furniture sprites (one-shot)
│   └── generate_tiles.py     # AI-generate floor/wall/door tiles (one-shot)
│
├── game-server/              # Node.js 20 WebSocket game server
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js          # HTTP + WebSocketServer on /ws
│       ├── auth.js           # Cognito JWT validation
│       ├── avatar.js         # Lambda invocation
│       ├── prompt.js         # buildCharacterDescription()
│       ├── state.js          # In-memory room/connection state
│       ├── broadcast.js       # Room-scoped broadcast
│       ├── router.js         # Message type → handler dispatch
│       ├── handlers/
│       │   ├── character.js  # create_character → character_generating → character_created
│       │   ├── room.js       # join_room, leave_room, move
│       │   ├── furniture.js  # Stub to B's module
│       │   └── social.js     # sit, stand, chat (proxies to C's module)
│       └── modules/
│           ├── decorEngine.js   # Stub for B's furniture module
│           └── socialEngine.js  # Stub for C's social module
│
├── client/                   # Test client
│   ├── index.html            # Single-file HTML/Canvas client
│   └── manifest.json         # Asset manifest (sprites, tiles, character options)
│
├── tests/integration/         # Integration test scripts
│   ├── test0_smoke.sh        # Infrastructure smoke tests
│   ├── test1_single_player.sh
│   ├── test2_two_players.sh
│   └── test5_disconnect_cleanup.sh
│
├── DEPLOYMENT_CHECKLIST.md   # Full deployment checklist from spec
└── docs/
    └── pixel-social-AD-guide-v2.md  # Full technical specification
```

## Stacks & Services

### CDK Stack: `PixelSocialStack`
Deployed via `cdk deploy PixelSocialStack`.

| Service | CDK Resource | Purpose |
|---------|--------------|---------|
| VPC | `ec2.Vpc` | 10.0.0.0/16, 2 public + 2 private subnets, 1 NAT GW |
| DynamoDB — Rooms | `dynamodb.Table` | roomId → occupants mapping |
| DynamoDB — Players | `dynamodb.Table` | playerId → avatarUrl, displayName |
| DynamoDB — Interactions | `dynamodb.Table` | roomId + chairId → seat claims |
| Cognito User Pool | `cognito.UserPool` | Email sign-in, SRP auth, no client secret |
| Cognito App Client | `cognito.UserPoolClient` | Public SPA client for browser |
| S3 Bucket | `s3.Bucket` | pixel-social-assets, block public, OAC |
| CloudFront Distribution | `cloudfront.Distribution` | HTTPS, OAC → S3, 3 cache behaviors |
| ECS Cluster | `ecs.Cluster` | Fargate-only, pixel-social-cluster |
| ECS Task Definition | `ecs.FargateTaskDefinition` | 512 CPU / 1024 MB, port 3000 |
| ECS Service | `ecs.FargateService` | 1 desired task, no scaling (v1) |
| ALB | `elbv2.ApplicationLoadBalancer` | Internet-facing, HTTP 80, 3600s idle |
| Target Group | `elbv2.ApplicationTargetGroup` | /health HTTP 200, IP type |
| Avatar Lambda | `lambda.DockerImageFunction` | Python 3.12 Docker, 1024 MB, 120s, NOT in VPC |

### CloudFormation Outputs (use `aws cloudformation list-exports`)
- `pixel-social-vpc-id`
- `pixel-social-alb-dns` — WebSocket endpoint
- `pixel-social-cognito-pool-id`
- `pixel-social-cognito-client-id`
- `pixel-social-rooms-table`
- `pixel-social-players-table`
- `pixel-social-interactions-table`
- `pixel-social-avatar-lambda-arn`
- `pixel-social-cf-domain` — Asset CDN domain
- `pixel-social-s3-bucket`

## AWS Console Links

| Resource | URL |
|----------|-----|
| **CloudWatch: Avatar Gen Logs** | [Log Group](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fpixel-social-avatar-gen) |
| **CloudWatch: List Avatars Logs** | [Log Group](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fpixel-social-list-avatars) |
| **CloudWatch: Game Server (ECS)** | [Log Group](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Fecs$252Fpixel-social) |
| **CloudWatch: Log Insights** | [Query Editor](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:logs-insights) |
| **Lambda Functions** | [Console](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions) |
| **S3 Bucket (assets)** | [pixel-social-assets](https://us-east-1.console.aws.amazon.com/s3/buckets/pixel-social-assets) |
| **CloudFront** | [Distributions](https://us-east-1.console.aws.amazon.com/cloudfront/home#/distributions) |
| **ECS Cluster** | [Services](https://us-east-1.console.aws.amazon.com/ecs/v2/clusters/pixel-social-cluster/services) |
| **Cognito User Pool** | [us-east-1_T4Gej0pzm](https://us-east-1.console.aws.amazon.com/cognito/v2/idp/user-pools/us-east-1_T4Gej0pzm) |

## Live URLs

- **App**: https://dc9iwjwlk784c.cloudfront.net
- **List Avatars API**: https://snvjkgz4ls5dgo5bgvxypiwo4a0ajktj.lambda-url.us-east-1.on.aws/
- **Generate Avatar API**: https://3rzuvtfxxly4tzdvznfipkb2qe0tlmyi.lambda-url.us-east-1.on.aws/
- **WebSocket (ALB)**: wss://PixelS-Pixel-Av5cnPVBHFIm-2101309226.us-east-1.elb.amazonaws.com/ws

## Quick Debug Commands

```bash
# Tail Lambda logs (last 5 min)
aws logs tail /aws/lambda/pixel-social-avatar-gen --since 5m --format short
aws logs tail /aws/lambda/pixel-social-list-avatars --since 5m --format short
aws logs tail /ecs/pixel-social --since 5m --format short

# Log Insights: avatar gen errors in last hour
aws logs start-query \
  --log-group-name /aws/lambda/pixel-social-avatar-gen \
  --start-time $(python3 -c "import time; print(int(time.time()-3600))") \
  --end-time $(python3 -c "import time; print(int(time.time()))") \
  --query-string 'filter @message like /ERROR|Exception|Traceback/ | sort @timestamp desc | limit 20'

# Check Lambda config
aws lambda get-function-configuration --function-name pixel-social-avatar-gen \
  --query '{PackageType:PackageType,Timeout:Timeout,Memory:MemorySize}' --output table
aws lambda get-function-configuration --function-name pixel-social-list-avatars \
  --query '{Timeout:Timeout,Memory:MemorySize}' --output table

# List avatars in S3
aws s3 ls s3://pixel-social-assets/avatars/

# Test CORS preflight on generate API
curl -sI -X OPTIONS -H "Origin: https://dc9iwjwlk784c.cloudfront.net" \
  -H "Access-Control-Request-Method: POST" \
  https://3rzuvtfxxly4tzdvznfipkb2qe0tlmyi.lambda-url.us-east-1.on.aws/
```

## Deploy Commands

```bash
# Upload client to S3
aws s3 sync client/ s3://pixel-social-assets/ --exclude "*.DS_Store" --exclude "test_*"

# Deploy infra (CDK) — also rebuilds avatar Lambda Docker image
cd infra && npm run build && npx cdk deploy

# Rebuild & push game server
docker --context desktop-linux build -t pixel-social-server:latest . && \
  docker tag pixel-social-server:latest 911319296449.dkr.ecr.us-east-1.amazonaws.com/pixel-social-server:latest && \
  docker push 911319296449.dkr.ecr.us-east-1.amazonaws.com/pixel-social-server:latest && \
  aws ecs update-service --cluster pixel-social-cluster \
    --service PixelSocialStack-PixelSocialServiceF69AC5DC-eWEHoEaRCDCI --force-new-deployment

# Test Lambda locally
cd lambda && python avatar_lambda.py "blue spiky hair, red hoodie"
```

## Setup

## Character Sprite Sheet Contract

The Lambda produces an **8×4 sprite sheet** (256×128 px, 32×32 per cell):

```
         idle(0)  stepA(1)  stepB(2)  sit(3)  wave(4)  sleep(5)  eat(6)  laugh(7)
Row 0(down)   stand     walk-A    walk-B    sit      wave     sleep    eat     laugh
Row 1(left)   stand     walk-A    walk-B    sit      wave     sleep    eat     laugh
Row 2(up)     stand     walk-A    walk-B    sit      wave     sleep    eat     laugh
Row 3(right)  stand     walk-A    walk-B    sit      wave     sleep    eat     laugh
```

AI generates 4×4 (16 cells). Post-processing derives the remaining 16 via horizontal flips:
- Right-facing row = flip of left row
- Down/Up stepB = flip of stepA (front/back views are symmetric)
- Left stepB = explicit opposite-leg generation (AI Row 4, Cell 1)
- sleep/eat/laugh = direction-independent, same cell for all rows

## Running the Test Client

```bash
cd client
# Edit index.html: set window.ALB_DNS to your ALB DNS name
python3 -m http.server 8080
# Open http://localhost:8080/?test=1 for mock data mode (no backend)
```

## Environment Variables Required by Game Server

These are injected by ECS task definition automatically via CDK outputs:

| Variable | Source |
|---------|--------|
| `COGNITO_USER_POOL_ID` | CDK output |
| `COGNITO_CLIENT_ID` | CDK output |
| `COGNITO_REGION` | CDK region |
| `DYNAMODB_REGION` | CDK region |
| `TABLE_ROOMS` | CDK output |
| `TABLE_PLAYERS` | CDK output |
| `TABLE_INTERACTIONS` | CDK output |
| `AVATAR_LAMBDA_ARN` | CDK output |
| `CLOUDFRONT_DOMAIN` | CDK output |

## Environment Variables Required by Avatar Lambda

Set via CDK (`infra/lib/pixel-social-stack.ts`). Secrets set manually after deploy:

| Variable | Value |
|----------|-------|
| `GOOGLE_API_KEY` | Gemini API key (set manually, not in CDK) |
| `IMAGE_GEN_MODEL` | `gemini-2.0-flash-exp` (or `gemini-3-pro-image-preview`) |
| `REMBG_API_KEY` | remove.bg API key (set in Lambda .env) |
| `REMBG_API_URL` | `https://api.remove.bg/v1.0/removebg` |
| `S3_BUCKET` | CDK output |
| `CLOUDFRONT_DOMAIN` | CDK output |
