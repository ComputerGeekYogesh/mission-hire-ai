/**
 * Brief AI answers for interview-relevant general questions mid-assessment.
 */
function parseMeta(session) {
  try {
    return typeof session?.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session?.metadata_json || {};
  } catch {
    return {};
  }
}

/**
 * Answer a candidate's mid-interview question when it is relevant to the assessment context.
 * Keeps responses short (1-2 sentences) and refuses unrelated trivia.
 */
export async function answerRelevantGeneralQuestion(
  session,
  { spokenText, questionText, questionIndex, totalQuestions }
) {
  const meta = parseMeta(session);
  const job = meta.job || {};
  const jobTitle = session?.job_title || job.title || '';
  const jobDesc = (job.description || '').slice(0, 600);
  const department = job.department || '';

  const fallback =
    "That's a fair question. I don't have every detail about the role here, but your recruiter can share more after this assessment. Let's continue with the interview question when you're ready.";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: `You are a professional video assessment interviewer assistant.

Current interview question (Question ${questionIndex || '?'} of ${totalQuestions || '?'}):
"${questionText || '(unknown)'}"

Candidate asked:
"${spokenText}"

Role context:
- Job title: ${jobTitle || 'not specified'}
- Department: ${department || 'not specified'}
- Job summary: ${jobDesc || 'not available'}

Rules:
- Answer ONLY if the question is relevant to the interview, role, assessment process, or clarifying expectations.
- Give a concise, helpful answer in 1-2 sentences maximum.
- Do NOT answer trivia, news, weather, jokes, or unrelated general knowledge.
- Do NOT give hints for answering the interview question.
- If you cannot answer from context, say you will focus on the assessment and they can follow up with the hiring team later.
- Do not mention that you are an AI.

Reply with plain text only, no markdown.`,
          },
        ],
      }),
    });

    if (!response.ok) return fallback;

    const data = await response.json();
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim();
    return text && text.length >= 12 ? text.replace(/^["']|["']$/g, '') : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isAssessmentMetaQuery(reasoning = '', scopeCategory = '') {
  const r = `${reasoning} ${scopeCategory}`.toLowerCase();
  return (
    r.includes('assessment_meta') ||
    r.includes('duration') ||
    r.includes('how long') ||
    r.includes('question_count') ||
    r.includes('how many') ||
    r.includes('format') ||
    r.includes('instruction')
  );
}
