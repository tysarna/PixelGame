// avatar.js
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({
  region: process.env.COGNITO_REGION,
  timeout: 300000, // 5 min — avatar gen can take ~60s
});

async function generateAvatar(playerId, characterDescription) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: process.env.AVATAR_LAMBDA_ARN,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ playerId, description: characterDescription }),
  }));

  const result = JSON.parse(Buffer.from(response.Payload));
  if (result.errorMessage) {
    throw new Error(`Avatar Lambda failed: ${result.errorMessage}`);
  }
  if (result.error === 'AVATAR_LIMIT_REACHED') {
    // Non-admin player hit the per-user generation cap. Preserve the existing URL
    // so the client can keep the avatar they already have.
    const err = new Error('AVATAR_LIMIT_REACHED');
    err.code = 'AVATAR_LIMIT_REACHED';
    err.existingAvatarUrl = result.avatarUrl;
    err.genCount = result.genCount;
    throw err;
  }
  if (result.error) {
    throw new Error(`Avatar generation failed: ${result.error}`);
  }
  if (!result.avatarUrl) {
    throw new Error('Avatar Lambda returned no avatarUrl');
  }
  return result.avatarUrl;
}

module.exports = { generateAvatar };
