import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let bootstrapped = false;

function parseSecretValue(secretString) {
  if (!secretString) {
    throw new Error('Secret value is empty');
  }

  try {
    const parsed = JSON.parse(secretString);
    const apiKey =
      parsed.GEMINI_KEY ??
      parsed.GEMINI_API_KEY ??
      parsed.gemini_key ??
      parsed.gemini_api_key;
    if (apiKey) return apiKey;
  } catch {
    // plain string secret
  }

  return secretString;
}

/** Load GEMINI_KEY from AWS Secrets Manager when not set in .env. */
export async function bootstrapGeminiKey() {
  if (bootstrapped || process.env.GEMINI_KEY?.trim() || process.env.GEMINI_API_KEY?.trim()) {
    return;
  }

  const secretName = process.env.AWS_SECRET_NAME;
  const region = process.env.AWS_REGION;

  if (!secretName || !region) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[env] GEMINI_KEY not set — AI features will be degraded until configured.');
    } else {
      console.warn('[env] GEMINI_KEY not set — AI features disabled.');
    }
    return;
  }

  const client = new SecretsManagerClient({ region });

  try {
    const { SecretString } = await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    const apiKey = parseSecretValue(SecretString);
    if (!apiKey) {
      throw new Error('Gemini API key not found in secret');
    }

    process.env.GEMINI_KEY = apiKey;
    bootstrapped = true;
    console.log('Gemini key loaded from AWS Secrets Manager');
  } catch (error) {
    const message =
      error?.name === 'AccessDeniedException'
        ? `Access denied fetching secret "${secretName}" in ${region}. Check IAM policy on the EC2 role.`
        : `Failed to load Gemini key from Secrets Manager: ${error.message}`;
    throw new Error(message);
  }
}
