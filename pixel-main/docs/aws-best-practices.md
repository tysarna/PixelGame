# AWS Best Practices — Pixel Social

Small-team (1-3 dev) recommendations for the current architecture. Reviewed 2026-03-27.

---

## 1. WebSocket on ECS Fargate + ALB

### Connection Draining on Deploy

- **Set deregistration delay** in CDK target group: `deregistrationDelay: Duration.seconds(120)`
- **Graceful shutdown**: Listen for `SIGTERM` in `index.js` (ECS sends before kill). On SIGTERM: stop accepting new connections, send `{ type: 'server_restarting' }` to all clients, let process drain. Set `stopTimeout: Duration.seconds(120)` on container to match.
- **Client reconnect**: Exponential backoff (1s, 2s, 4s, max 10s). On reconnect, re-auth and re-join last room.
- Current rolling deploy (`minHealthyPercent: 100, maxHealthyPercent: 200`) is correct — new task spins up before old one drains.

### ALB Idle Timeout + Heartbeat

**ALB default is 60s.** If no data flows for 60s, ALB silently closes the connection.

- Set ALB idle timeout: `alb.setAttribute('idle_timeout.timeout_seconds', '3600')` (max 1 hour)
- Implement server ping/pong every 30s; if no pong within 10s, terminate connection
- Also send application-level `{ type: 'ping' }` for proxies that strip WS frames
- Consider connecting WS directly to ALB (not through CloudFront) to avoid CloudFront's own WS idle timeout quirks

### Scaling Beyond 1 Task

**Not needed until ~2,000-5,000 concurrent connections.** At 512 CPU / 1024 MB, Node.js handles this fine.

When the time comes:
1. **First**: bump to 1024 CPU / 2048 MB
2. **Then**: add ElastiCache Redis (t4g.micro, ~$12/month) for pub/sub across tasks. Each task subscribes to Redis channels per room. `broadcastToRoom` publishes to Redis; subscriber forwards to local connections.
3. Player state moves from in-memory Maps to Redis or DynamoDB

---

## 2. DynamoDB

### Single-Table Design (Recommended)

| PK | SK | Use |
|---|---|---|
| `ROOM#<roomId>` | `META` | Room metadata (template, dimensions, ownerId) |
| `ROOM#<roomId>` | `FURN#<instanceId>` | Furniture placement |
| `ROOM#<roomId>` | `SEAT#<x>_<y>` | Seat claim (with TTL) |
| `PLAYER#<playerId>` | `PROFILE` | Player profile |
| `PLAYER#<playerId>` | `FRIEND#<friendId>` | Friend relationship |

One `Query(PK=ROOM#roomId)` fetches room metadata + furniture + seat state in a single read.

### Concurrent Writes

- **Single task (now)**: Node.js event loop serializes requests. Check occupied tiles in an in-memory Map before writing. Safe.
- **Multi-task (future)**: Use `TransactWriteItems` — put furniture item + put tile lock `SK=TILE#<x>_<y>`, both with `condition_expression: attribute_not_exists(PK)`. Either both succeed or both roll back.

### TTL for Stale Seat Claims

- Enable DynamoDB TTL on attribute `expiresAt`
- Set `expiresAt = now + 3600` when claiming a seat
- Refresh TTL on heartbeat every 5 minutes
- On WS close, actively delete seat claim from DynamoDB. TTL is the backup for server crashes.

### Capacity

**Stay on-demand (PAY_PER_REQUEST).** At 100 concurrent players for 8 hours, writes cost ~$13/month. Provisioned only saves money at sustained >25 WCU/RCU with predictable patterns.

---

## 3. Lambda (Avatar Generation)

### Quick Wins

- **Increase memory to 2048 MB** (1 line in CDK). Doubles CPU allocation, reduces cold start and processing time significantly.
- **Move clients to module level** — `genai.Client()` and `boto3.client('s3')` should be initialized outside the handler. Saves ~500ms on warm invocations.
- **Add retry logic** for Gemini API: 3 attempts with exponential backoff (2^attempt seconds).

### Timeout

**120s is correct.** Gemini 15-60s + rembg 5-15s + S3 <1s = worst case ~75s. Add a game-server-side timeout (90s) so the client gets an error response rather than hanging.

### Error Handling

- Return structured errors: `{"error": {"code": "GEMINI_TIMEOUT", "message": "...", "retryable": true}}`
- **DLQ is not needed** — Lambda is invoked synchronously. Player sees error and can retry from UI.
- Add CloudWatch alarm on Lambda errors > 3 in 5 minutes.

---

## 4. S3 + CloudFront

### Cache Strategy

- **Content-hashed filenames** for tiles/furniture: `tiles/grass_a1b2c3.png` with `Cache-Control: max-age=31536000, immutable`. Never invalidate.
- **Short TTL** for `manifest.json` and `avatars/*` (current 300s is correct).
- **Invalidate only `/index.html` and `/manifest.json`** on deploy, not `/*`:
  ```bash
  aws cloudfront create-invalidation --paths "/index.html" "/manifest.json"
  ```

### CORS

Since `index.html` and assets are served from the same CloudFront distribution, they're same-origin. **CORS is not needed** unless accessing from localhost in dev. If you add a custom domain later, add CORS to S3 bucket and forward `Origin` header in CloudFront.

---

## 5. Cognito Auth

### Token Refresh

- **Current (single-task, in-memory)**: Validate once on connect, trust the connection thereafter. Standard for WS games.
- **Future**: Client sends `{ type: 'refresh_token', payload: { token } }` every 50 minutes using Cognito refresh token flow.
- **Consider**: Set `idTokenValidity: Duration.hours(24)` in CDK for casual game UX.

### JWT in Query String

Acceptable trade-off — WebSocket API doesn't support custom headers during browser upgrade. AWS API Gateway and Firebase use the same approach.

- **Don't enable ALB access logs** (they'd contain the JWT in the URL)
- Server code correctly does not log the URL/token
- Short-lived tokens (1 hour default) limit exposure if leaked

---

## Priority Action Items

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | ALB idle timeout (3600s) + server ping/pong | 1 hour | Prevents silent drops |
| 2 | SIGTERM handler + client reconnect | 2-3 hours | Smooth deploys |
| 3 | Move genai/boto3 to module level | 15 min | Faster warm Lambda |
| 4 | Lambda memory → 2048 MB | 1 line | Faster cold start + processing |
| 5 | Lambda retry for Gemini API | 30 min | Transient failure resilience |
| 6 | Content-hashed asset filenames | 2-3 hours | Correct caching |
| 7 | Single-table DynamoDB schema | 1-2 hours | Ready for persistence |
| 8 | DynamoDB persistence for rooms | 4-8 hours | Persistent state, survives redeploy |
| 9 | TTL seat cleanup | 1 hour | No ghost locks |
| 10 | Conditional writes for furniture | 1 hour | No placement conflicts |

Items 1-5 are quick wins. Items 6-10 align with the persistence TODO comments in `state.js` and `room.js`.

---

## Cost Estimate (50 DAU)

| Service | $/month | Notes |
|---|---|---|
| ECS Fargate (512 CPU, 1GB) | ~$18 | 24/7 |
| NAT Gateway | ~$32 | **Biggest cost** |
| ALB | ~$16 | Fixed + LCU |
| DynamoDB (on-demand) | <$1 | |
| Lambda | <$1 | ~50 invocations |
| S3 + CloudFront | <$1 | Free tier |
| Cognito | Free | <50k MAU |
| **Total** | **~$68** | |

**Cost optimization**: NAT Gateway is $32/month for a small game. If Fargate only needs internet for Cognito JWKS (fetched once + cached), place the task in a public subnet with a public IP + VPC endpoint for DynamoDB. Eliminates NAT Gateway entirely.
