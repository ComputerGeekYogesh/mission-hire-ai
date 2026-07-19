import dotenv from 'dotenv';
import { bootstrapOpenAIKey } from './config/openaiSecret.js';

dotenv.config();

try {
  await bootstrapOpenAIKey();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

await import('./server.js');