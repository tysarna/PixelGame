import { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_REGION, authState } from './state.js';

export async function cognitoRequest(action, body) {
  const resp = await fetch(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.__type || `Cognito error`);
  return data;
}

export async function signUp(email, password, displayName) {
  await cognitoRequest('SignUp', {
    ClientId: COGNITO_CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'name', Value: displayName },
      { Name: 'preferred_username', Value: displayName },
    ],
  });
  return { success: true, needsConfirmation: true };
}

export async function signIn(email, password) {
  const data = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const tokens = data.AuthenticationResult;
  if (!tokens) throw new Error('Auth challenge not supported');
  const decoded = JSON.parse(atob(tokens.IdToken.split('.')[1]));
  authState.email = email;
  authState.password = password;
  authState.displayName = decoded.name || decoded['cognito:username'] || email.split('@')[0];
  authState.jwt = tokens.IdToken;
  authState.playerId = decoded.sub;
  return { success: true };
}

export function getAuthHeaders() {
  return { Authorization: authState.jwt };
}
