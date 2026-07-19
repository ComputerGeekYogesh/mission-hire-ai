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
    const apiKey = parsed.OPENAI_API_KEY ?? parsed.openai_api_key;
    if (apiKey) return apiKey;
  } catch {
    // plain string secret
  }

  return secretString;
}

export async function bootstrapOpenAIKey() {
  if (bootstrapped || process.env.OPENAI_API_KEY) {
    return;
  }

  const secretName = process.env.AWS_SECRET_NAME;
  const region = process.env.AWS_REGION;

  if (!secretName) {
    throw new Error('AWS_SECRET_NAME is required');
  }
  if (!region) {
    throw new Error('AWS_REGION is required');
  }

  const client = new SecretsManagerClient({ region });

  try {
    const { SecretString } = await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    const apiKey = parseSecretValue(SecretString);
    if (!apiKey) {
      throw new Error('OpenAI API key not found in secret');
    }

    process.env.OPENAI_API_KEY = apiKey;
    bootstrapped = true;
    console.log('OpenAI key loaded from AWS Secrets Manager');
  } catch (error) {
    const message = error?.name === 'AccessDeniedException'
      ? `Access denied fetching secret "${secretName}" in ${region}. Check IAM policy on the EC2 role.`
      : `Failed to load OpenAI key from Secrets Manager: ${error.message}`;
    throw new Error(message);
  }
}
