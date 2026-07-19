import OpenAI from 'openai';

let client;

export function getOpenAI() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key not bootstrapped. Ensure bootstrapOpenAIKey() runs at startup.');
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

export function getOpenAIApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not bootstrapped. Ensure bootstrapOpenAIKey() runs at startup.');
  }
  return apiKey;
}
