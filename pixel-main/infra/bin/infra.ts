import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PixelSocialStack } from '../lib/pixel-social-stack';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = new cdk.App();

new PixelSocialStack(app, 'PixelSocialStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
