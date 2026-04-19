# Deployment Checklist

## Infrastructure
- [ ] VPC + subnets + security groups created
- [ ] DynamoDB tables created (Rooms, Players, Interactions)
- [ ] Cognito User Pool + App Client created
- [ ] S3 bucket created, OAC configured
- [ ] AI-generated furniture PNGs uploaded to S3 (/furniture/)
- [ ] AI-generated tile PNGs uploaded to S3 (/tiles/)
- [ ] manifest.json (with characterOptions + spriteSheet blocks) uploaded to S3
- [ ] CloudFront distribution created, pointing at S3
- [ ] CloudFront serves manifest.json (verified)
- [ ] CloudFront serves furniture and tile PNGs (verified)

## Avatar Lambda
- [ ] Avatar Lambda deployed with IMAGE_GEN_API_KEY set
- [ ] Lambda has S3 write permissions for /avatars/*
- [ ] Lambda has outbound internet access (for AI API calls)
- [ ] Lambda timeout configured to 60 seconds
- [ ] Lambda generates a test avatar (invoke directly, verify 256x128 PNG)
- [ ] Generated avatar accessible via CloudFront

## Game Server (ECS Fargate)
- [ ] ECR repo created, Docker image pushed
- [ ] ECS cluster + task definition + service created (with AVATAR_LAMBDA_ARN)
- [ ] Fargate task role includes lambda:InvokeFunction
- [ ] ALB created, target group healthy, idle timeout = 3600
- [ ] ALB health check returns 200

## WebSocket Auth
- [ ] WebSocket connects with valid Cognito JWT
- [ ] WebSocket rejects invalid token (close with 4001)

## End-to-End Character Creation
- [ ] Client sends create_character with choices
- [ ] Server builds description, invokes Lambda
- [ ] Lambda calls AI API, post-processes, writes to S3
- [ ] Client receives avatarUrl, loads sprite sheet
- [ ] Sprite sheet renders correctly (walk cycle, sit, direction changes)

## Integration Tests
- [ ] Test 0 passes (infrastructure smoke tests)
- [ ] Test 1 passes (single player loop with AI-generated sprite)
- [ ] Test 2 passes (two players, both AI-generated, visually different)
- [ ] Test 3 passes (furniture CRUD)
- [ ] Test 4 passes (chair conflict, sitting pose correct)
- [ ] Test 5 passes (disconnect cleanup)
- [ ] Test 6 passes (access control)
- [ ] Test 7 passes (10 concurrent connections)
