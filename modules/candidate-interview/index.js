import { ensureInterviewSchema } from './bootstrap.js';
import routes from './routes.js';

export async function initCandidateInterviewModule() {
  try {
    await ensureInterviewSchema();
    console.log('✅ Candidate Interview Management module ready');
  } catch (err) {
    console.error('❌ Candidate Interview schema init failed:', err.message);
  }
}

export default routes;
