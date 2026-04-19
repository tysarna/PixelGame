import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin, LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { SubnetType, NatProvider } from 'aws-cdk-lib/aws-ec2';

export class PixelSocialStack extends Stack {
  public readonly vpcId: string;
  public readonly albDnsName: string;
  public readonly cognitoUserPoolId: string;
  public readonly cognitoClientId: string;
  public readonly roomsTableName: string;
  public readonly playersTableName: string;
  public readonly interactionsTableName: string;
  public readonly avatarLambdaArn: string;
  public readonly cloudFrontDomainName: string;
  public readonly s3BucketName: string;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── VPC ───────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'PixelSocialVPC', {
      vpcName: 'pixel-social-vpc',
      cidr: '10.0.0.0/16',
      maxAzs: 2,
      natGatewayProvider: NatProvider.gateway(),
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Security Group for ALB — inbound 443/80 from everywhere
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');

    // Security Group for Fargate — inbound from ALB only
    const fargateSg = new ec2.SecurityGroup(this, 'FargateSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });
    fargateSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'Traffic from ALB');

    // ─── DynamoDB Tables ───────────────────────────────────────────────────────
    const roomsTable = new dynamodb.Table(this, 'RoomsTable', {
      tableName: 'Rooms',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const playersTable = new dynamodb.Table(this, 'PlayersTable', {
      tableName: 'Players',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const interactionsTable = new dynamodb.Table(this, 'InteractionsTable', {
      tableName: 'Interactions',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // ─── Cognito User Pool ─────────────────────────────────────────────────────
    const autoConfirmFn = new lambda.Function(this, 'AutoConfirmUser', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          event.response.autoConfirmUser = true;
          event.response.autoVerifyEmail = true;
          return event;
        };
      `),
    });

    const userPool = new cognito.UserPool(this, 'PixelSocialUsers', {
      userPoolName: 'pixel-social-users',
      selfSignUpEnabled: true,
      lambdaTriggers: { preSignUp: autoConfirmFn },
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true },
        preferredUsername: { required: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
      },
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'PixelSocialClient', {
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: true },
    });

    // ─── S3 Bucket ─────────────────────────────────────────────────────────────
    const assetBucket = new s3.Bucket(this, 'PixelSocialAssets', {
      bucketName: 'pixel-social-assets',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
    });

    // S3 bucket policy granting CloudFront OAC access
    new s3.BucketPolicy(this, 'AssetBucketPolicy', {
      bucket: assetBucket,
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
            actions: ['s3:GetObject'],
            resources: [`${assetBucket.bucketArn}/*`],
          }),
        ],
      }),
    });

    // ─── ALB (before CloudFront so we can reference it as origin) ────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, 'PixelSocialALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // HTTP listener (dev fallback — use HTTPS listener with ACM cert for prod)
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'PixelSocialTarget', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
    });

    httpListener.addTargetGroups('DefaultTarget', {
      targetGroups: [targetGroup],
    });

    // Enable stickiness
    targetGroup.enableCookieStickiness(Duration.minutes(5));

    // ─── CloudFront Distribution ───────────────────────────────────────────────
    // Custom cache policies with correct TTLs per spec (300s for manifest + avatars)
    const defaultCachePolicy = new cloudfront.CachePolicy(this, 'DefaultCachePolicy', {
      cachePolicyName: 'pixel-social-default',
      minTtl: cdk.Duration.seconds(1),
      maxTtl: cdk.Duration.seconds(86400),
      defaultTtl: cdk.Duration.seconds(86400),
    });

    const shortTtlCachePolicy = new cloudfront.CachePolicy(this, 'ShortTtlCachePolicy', {
      cachePolicyName: 'pixel-social-short-ttl',
      minTtl: cdk.Duration.seconds(1),
      maxTtl: cdk.Duration.seconds(300),
      defaultTtl: cdk.Duration.seconds(300),
    });

    const siteCertificate = acm.Certificate.fromCertificateArn(
      this,
      'PixelSocialSiteCert',
      'arn:aws:acm:us-east-1:911319296449:certificate/160f832f-1e0a-4cc6-a9ef-19e2a8ab4cc3',
    );

    const distribution = new cloudfront.Distribution(this, 'PixelSocialDistribution', {
      defaultRootObject: 'index.html',
      domainNames: ['pixel.infinityopus.com'],
      certificate: siteCertificate,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(assetBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: defaultCachePolicy,
      },
      additionalBehaviors: {
        '/manifest.json': {
          origin: S3BucketOrigin.withOriginAccessControl(assetBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: shortTtlCachePolicy,
        },
        '/avatars/*': {
          origin: S3BucketOrigin.withOriginAccessControl(assetBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: shortTtlCachePolicy,
        },
        '/ws': {
          origin: new LoadBalancerV2Origin(alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: new cloudfront.CachePolicy(this, 'WebSocketCachePolicy', {
            cachePolicyName: 'pixel-social-websocket',
            defaultTtl: Duration.seconds(0),
            maxTtl: Duration.seconds(0),
            minTtl: Duration.seconds(0),
          }),
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
    });

    // ─── ECS Fargate ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'PixelSocialCluster', {
      clusterName: 'pixel-social-cluster',
      vpc,
    });

    const logGroup = new logs.LogGroup(this, 'PixelSocialLogGroup', {
      logGroupName: '/ecs/pixel-social',
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Task execution IAM role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

    // Task role with DynamoDB and Lambda permissions
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const dynamoPolicy = new iam.Policy(this, 'TaskDynamoPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchGetItem', 'dynamodb:TransactWriteItems'],
          resources: [
            roomsTable.tableArn,
            playersTable.tableArn,
            interactionsTable.tableArn,
          ],
        }),
      ],
    });
    taskRole.attachInlinePolicy(dynamoPolicy);

    // Import the existing ECR repository
    const ecrRepo = ecr.Repository.fromRepositoryArn(
      this,
      'PixelSocialECR',
      'arn:aws:ecr:us-east-1:911319296449:repository/pixel-social-server',
    );

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'PixelSocialTask', {
      family: 'pixel-social-server',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    const container = taskDefinition.addContainer('game-server', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_REGION: this.region,
        DYNAMODB_REGION: this.region,
        TABLE_ROOMS: roomsTable.tableName,
        TABLE_PLAYERS: playersTable.tableName,
        TABLE_INTERACTIONS: interactionsTable.tableName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'ecs',
      }),
    });

    // ─── Fargate Service ───────────────────────────────────────────────────────
    const fargateService = new ecs.FargateService(this, 'PixelSocialService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    fargateService.attachToApplicationTargetGroup(targetGroup);

    // Allow Fargate to write to log group
    logGroup.grantWrite(taskExecutionRole);

    // ─── Avatar Generation Lambda (Docker) ─────────────────────────────────────
    // Docker image Lambda — bundles google-genai, httpx, Pillow deps
    // NOT in VPC — needs internet for Gemini + rembg API calls
    const avatarLambda = new lambda.DockerImageFunction(this, 'AvatarLambdaV2', {
      functionName: 'pixel-social-avatar-gen-v2',
      code: lambda.DockerImageCode.fromImageAsset('../lambda', {
        platform: Platform.LINUX_AMD64,
      }),
      memorySize: 1024,
      timeout: Duration.seconds(120),
      environment: {
        S3_BUCKET: assetBucket.bucketName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        IMAGE_GEN_MODEL: 'gemini-3-pro-image-preview',
        // Vertex AI auth — SA key JSON baked into image at /var/task/sa-key.json
        GOOGLE_APPLICATION_CREDENTIALS: '/var/task/sa-key.json',
        GOOGLE_CLOUD_PROJECT: 'nlp-school-488918',
        GOOGLE_CLOUD_LOCATION: 'global',
        // rembg — loaded from infra/.env at synth time (see bin/infra.ts).
        // Not committed to git; set these before running cdk deploy.
        REMBG_API_URL: process.env.REMBG_API_URL ?? '',
        REMBG_API_KEYS: process.env.REMBG_API_KEYS ?? '',
        // Admin Cognito sub(s) that bypass the per-user avatar generation cap. Comma-separated.
        // xinx2023@gmail.com
        ADMIN_PLAYER_IDS: '4488f408-60f1-70b6-3b7a-ffd35ebe5632',
      },
    });

    // Lambda S3 read+write policy (GetObject/HeadObject needed to read gen-count metadata)
    avatarLambda.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [`${assetBucket.bucketArn}/avatars/*`],
      })
    );
    // ListBucket on the bucket itself — so HeadObject on missing keys returns
    // 404 instead of 403, which is what _read_gen_count expects.
    avatarLambda.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [assetBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['avatars/*'] } },
      })
    );

    // Update ECS task env with real Lambda ARN
    container.addEnvironment('AVATAR_LAMBDA_ARN', avatarLambda.functionArn);

    // Lambda invoke policy for task role
    const lambdaInvokePolicy = new iam.Policy(this, 'TaskLambdaInvokePolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [avatarLambda.functionArn],
        }),
      ],
    });
    taskRole.attachInlinePolicy(lambdaInvokePolicy);

    // ─── Outputs ────────────────────────────────────────────────────────────────
    this.vpcId = vpc.vpcId;
    this.albDnsName = alb.loadBalancerDnsName;
    this.cognitoUserPoolId = userPool.userPoolId;
    this.cognitoClientId = userPoolClient.userPoolClientId;
    this.roomsTableName = roomsTable.tableName;
    this.playersTableName = playersTable.tableName;
    this.interactionsTableName = interactionsTable.tableName;
    this.avatarLambdaArn = avatarLambda.functionArn;
    this.cloudFrontDomainName = distribution.distributionDomainName;
    this.s3BucketName = assetBucket.bucketName;

    new CfnOutput(this, 'VpcId', { value: this.vpcId, exportName: 'pixel-social-vpc-id' });
    new CfnOutput(this, 'AlbDnsName', { value: this.albDnsName, exportName: 'pixel-social-alb-dns' });
    new CfnOutput(this, 'CognitoUserPoolId', { value: this.cognitoUserPoolId, exportName: 'pixel-social-cognito-pool-id' });
    new CfnOutput(this, 'CognitoClientId', { value: this.cognitoClientId, exportName: 'pixel-social-cognito-client-id' });
    new CfnOutput(this, 'RoomsTableName', { value: this.roomsTableName, exportName: 'pixel-social-rooms-table' });
    new CfnOutput(this, 'PlayersTableName', { value: this.playersTableName, exportName: 'pixel-social-players-table' });
    new CfnOutput(this, 'InteractionsTableName', { value: this.interactionsTableName, exportName: 'pixel-social-interactions-table' });
    new CfnOutput(this, 'AvatarLambdaArn', { value: this.avatarLambdaArn, exportName: 'pixel-social-avatar-lambda-arn' });
    new CfnOutput(this, 'CloudFrontDomain', { value: this.cloudFrontDomainName, exportName: 'pixel-social-cf-domain' });
    new CfnOutput(this, 'S3BucketName', { value: this.s3BucketName, exportName: 'pixel-social-s3-bucket' });
  }
}
