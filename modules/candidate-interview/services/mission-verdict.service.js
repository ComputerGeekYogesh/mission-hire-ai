import { getOpenAI } from '../../../config/openaiClient.js';
import { violationLabel } from '../lib/proctoring-violation-messages.js';
import { proctorAudioKey } from '../lib/proctoring-flag-naming.js';

const EMPTY_MISSION = { mission_verdict: null, mission_recommendations: [], verification: null };

const MISSION_VERDICT_SYSTEM_PROMPT = `You are Mission Hire, an expert AI video interview analyst for recruiters and hiring managers. You write concise, professional hiring summaries after a candidate completes a browser-based video interview.

You will receive structured data from a completed VIDEO INTERVIEW for a job applicant. This is a recruitment screening — not an internal employee skill assessment or L&D evaluation.

Rules:
- Write in clear English. No markdown. Do not use bullet characters inside the verdict paragraph.
- mission_verdict: 2–4 short paragraphs (about 120–400 words total). Summarize demonstrated competency, strongest signals, knowledge gaps, communication clarity, and overall interview outcome for hiring (e.g. strong fit, partial fit, below bar, not recommended to proceed). Ground everything in the provided scores and feedback.
- mission_recommendations: array of strings — minimum 3, at most 12. Each item one actionable sentence for recruiters/hiring managers (next interview round, technical deep-dive, reference checks, areas to probe further, reasons to hold or reject). No numbering inside strings.
- If many questions lack scores or feedback, acknowledge uncertainty and recommend a follow-up interview or human review.
- Do not invent answers not supported by the excerpts.
- Use hiring/interview language: candidate, role fit, proceed to next round, do not recommend moving forward, technical depth, communication under pressure.
- FORBIDDEN internal-assessment language — never use phrases such as: "internal skill assessment", "employee development", "L&D", "training modules", "upselling", "existing team member", "already on staff", "re-assessment for employees", or wording that treats the participant as a current employee rather than a job applicant.
- CRITICAL: If INTERVIEW STATUS shows interview_termination=false and completion_type=completed, the candidate FINISHED the interview normally. You MUST NOT write that the interview was "terminated", "ended early due to proctoring", or "invalidated due to integrity violations". Proctoring flags on a completed interview are monitoring notes only — mention them as minor risks at most, never as termination.
- Only describe proctoring termination if INTERVIEW STATUS explicitly says interview_termination=true or completion_type=terminated_due_to_proctoring_violation.

Output: return ONLY valid JSON:
{"mission_verdict":"<string>","mission_recommendations":["<string>"]}`;

const MISSION_PROCTORING_TERMINATION_PROMPT = `You are Mission Hire, an interview integrity assistant for recruiters reviewing a browser video INTERVIEW session that was TERMINATED due to proctoring or integrity violations.

This is a recruitment video interview — not an internal employee assessment.

Rules:
- Write in clear English. No markdown. No bullet characters inside the verdict paragraph.
- mission_verdict: 2–4 paragraphs (120–350 words). Must clearly state:
  1) The interview was terminated (not completed) due to repeated suspicious activity after formal warnings.
  2) Which types of suspicious activity were detected (from the provided flag list).
  3) How many warnings were issued before termination.
  4) That any partial question scores are incomplete and must NOT be treated as a full hiring evaluation.
  5) Recommended recruiter next step (review recording/flags, consider re-inviting candidate under supervised conditions or disqualify based on policy).
- mission_recommendations: 3–8 actionable strings focused on integrity review for hiring teams (review recording, review snapshots, audit flag timeline, re-interview policy). Include hiring-appropriate next steps.
- Ground everything in the provided proctoring data. Do not invent violations.

Output: return ONLY valid JSON:
{"mission_verdict":"<string>","mission_recommendations":["<string>"]}`;

function truncate(text, max = 800) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function parseMetadata(session) {
  try {
    return typeof session.metadata_json === 'string'
      ? JSON.parse(session.metadata_json)
      : session.metadata_json || {};
  } catch {
    return {};
  }
}

function humanizeFlagType(flagType) {
  try {
    return violationLabel(flagType);
  } catch {
    return proctorAudioKey(flagType).replace(/_/g, ' ');
  }
}

function buildVerificationSummary(flags = [], proctoringReport = null, { proctoringTerminated = false } = {}) {
  const violations = proctoringReport?.violations || proctoringReport?.timeline || [];
  const merged = flags.length ? flags : violations;

  if (!merged.length) {
    return {
      flag_count: 0,
      high_severity_count: 0,
      summary: proctoringTerminated
        ? 'Interview terminated due to proctoring violations; no individual flags recorded.'
        : 'No proctoring flags recorded during the completed interview.',
    };
  }

  const high = merged.filter((f) => f.severity === 'high').length;
  const types = [...new Set(merged.map((f) => f.flag_type || f.type))];
  const labeled = types.slice(0, 10).map(humanizeFlagType);

  return {
    flag_count: merged.length,
    high_severity_count: high,
    flag_types: types,
    flag_types_labeled: labeled,
    warning_count: proctoringReport?.warning_count ?? 0,
    summary: merged
      .slice(0, 10)
      .map((f) => {
        const type = f.flag_type || f.type;
        const label = humanizeFlagType(type);
        return `${label}${f.severity ? ` (${f.severity})` : ''}${f.message ? `: ${f.message}` : ''}`;
      })
      .join('; '),
  };
}

function buildProctoringVerdictTemplate({
  session,
  assessment,
  verification,
  proctoringReport = {},
  integrityReport = null,
}) {
  const name = session.candidate_name || 'The candidate';
  const warningCount = verification.warning_count ?? proctoringReport.warning_count ?? 0;
  const violationLabels = verification.flag_types_labeled?.length
    ? verification.flag_types_labeled.join(', ')
    : 'proctoring guideline violations';
  const answered = assessment?.total_questions ?? 0;
  const partialNote =
    answered > 0
      ? `${name} answered ${answered} question(s) before termination; those scores are partial and must not be used as a complete hiring evaluation.`
      : 'No scored answers were recorded before termination.';

  const integrityNote = integrityReport?.integrity_score
    ? ` The integrity risk score at termination was ${integrityReport.integrity_score} (${integrityReport.risk_level || 'elevated'}).`
    : '';

  const verdict = [
    `This browser video interview was terminated before completion due to repeated suspicious activity detected during proctoring monitoring.${integrityNote} Recruiters should treat this as an integrity outcome — not a full evaluation of ${name}'s skills for the role.`,
    `After ${warningCount} formal warning${warningCount === 1 ? '' : 's'}, the session was ended because suspicious activity continued. Detected issues included: ${violationLabels}. In total, ${verification.flag_count} proctoring event(s) were logged (${verification.high_severity_count} high severity).`,
    partialNote,
    'Review the session recording, proctoring flag timeline, and snapshots before deciding whether to re-invite the candidate under supervised conditions or close the application based on your hiring policy.',
  ].join('\n\n');

  const recommendations = [
    'Review the full session recording and proctoring flag timeline before any hiring decision.',
    'Examine captured snapshots and telemetry for the specific suspicious activities that triggered termination.',
    'Document the outcome as "Interview Invalidated — Integrity Violation" rather than a skill-based pass/fail grade.',
    'If policy allows, consider a supervised re-interview with explicit integrity guidelines communicated upfront.',
  ];

  if (verification.high_severity_count > 0) {
    recommendations.push(
      'Prioritize review of high-severity flags (e.g. identity, virtual camera, or coaching indicators) before advancing this candidate.'
    );
  }

  return {
    mission_verdict: verdict,
    mission_recommendations: recommendations.slice(0, 8),
    verification,
  };
}

const FALSE_TERMINATION_RE =
  /\b(interview\s+was\s+)?terminat(ed|ion)\b.*\b(proctor|integrity|violation|suspicious)/i;
const FALSE_TERMINATION_RE2 =
  /\b(proctoring\s+violation|terminated\s+due\s+to\s+proctoring|interview\s+invalidated)\b/i;

/** Detect stale internal-assessment / employee L&D language in interview verdicts. */
const ASSESSMENT_LANGUAGE_RES = [
  /\binternal\s+skill\s+assessment\b/i,
  /\bemployee\s+development\b/i,
  /\b(existing\s+)?team\s+member\b/i,
  /\balready\s+(on\s+staff|employed|hired)\b/i,
  /\bL&D\b/i,
  /\btraining\s+modules?\b/i,
  /\bupskilling\b/i,
  /\bre-assessment\b/i,
  /\bskill\s+assessment\b/i,
  /\bnot\s+(a\s+)?recruitment\b/i,
  /\bnot\s+hiring\b/i,
  /\bguide\s+training\s+and\s+development\b/i,
  /\bfollow-up\s+coaching\s+session\b/i,
];

function verdictClaimsProctoringTermination(verdict) {
  const text = String(verdict || '');
  return FALSE_TERMINATION_RE.test(text) || FALSE_TERMINATION_RE2.test(text);
}

export function missionVerdictImpliesProctoringTermination(verdict) {
  return verdictClaimsProctoringTermination(verdict);
}

export function missionVerdictUsesHiringLanguage(verdict) {
  const text = String(verdict || '');
  return !ASSESSMENT_LANGUAGE_RES.some((re) => re.test(text));
}

export function missionVerdictUsesAssessmentLanguage(verdict) {
  const text = String(verdict || '');
  return ASSESSMENT_LANGUAGE_RES.some((re) => re.test(text));
}

export function missionVerdictNeedsRegeneration(verdict, { proctoringTerminated = false } = {}) {
  if (!verdict) return false;
  if (!proctoringTerminated && verdictClaimsProctoringTermination(verdict)) return true;
  if (!proctoringTerminated && missionVerdictUsesAssessmentLanguage(verdict)) return true;
  return false;
}

function sanitizeRecommendations(recommendations = []) {
  const ASSESSMENT_REC_RES = [
    /\btraining\s+modules?\b/i,
    /\bemployee\b/i,
    /\bupskilling\b/i,
    /\bre-assessment\b/i,
    /\bL&D\b/i,
    /\bcoaching\s+session\b/i,
  ];

  return recommendations
    .map((item) =>
      String(item || '')
        .replace(/\bemployee('s)?\b/gi, 'candidate$1')
        .replace(/\bfollow-up coaching session\b/gi, 'follow-up interview')
        .replace(/\bre-assessment\b/gi, 're-interview')
        .trim()
    )
    .filter((item) => item && !ASSESSMENT_REC_RES.some((re) => re.test(item)));
}

function buildInterviewVerdictTemplate({ session, assessment, qaRows = [] }) {
  const name = session?.candidate_name || 'The candidate';
  const avg = assessment?.average_score_display ?? assessment?.average_score ?? 'N/A';
  const result = assessment?.result_status ?? 'Completed';
  const feedback = assessment?.feedback_status ?? '';
  const answered = assessment?.total_questions ?? qaRows.length ?? 0;
  const jobTitle = session?.job_title || 'the role';

  const skillNotes = qaRows.slice(0, 5).map((row, i) => {
    const score = row.score != null ? Number(row.score) : null;
    const skill = row.category || 'general';
    if (score == null) return null;
    return `Question ${i + 1} (${skill}): score ${score}/10`;
  }).filter(Boolean);

  const verdictParts = [
    `${name} completed the browser video interview for ${jobTitle}. Overall result: ${result}. Average score: ${avg}/10.${feedback ? ` Interview band: ${feedback}.` : ''}`,
    skillNotes.length
      ? `Per-question scores highlight the following areas: ${skillNotes.join('; ')}.`
      : `${answered} question(s) were answered during this interview.`,
    result === 'Passed'
      ? `Based on demonstrated competency and communication, the candidate shows sufficient fit to consider for the next stage of the hiring process for ${jobTitle}.`
      : `Based on the scores and answer quality, the candidate did not meet the bar for ${jobTitle} at this stage. Consider whether a follow-up interview or human review is warranted before closing the application.`,
  ];

  const recommendations = [
    'Review per-question AI feedback alongside the session recording before finalizing a hiring decision.',
    'Compare scores against role requirements and share highlights with the hiring manager.',
    result === 'Passed'
      ? 'Schedule the next interview round or technical deep-dive for areas that scored below expectations.'
      : 'Document reasons for not advancing and consider whether a different role or future pipeline may be a better fit.',
  ];

  if (Number(avg) < 6) {
    recommendations.unshift(
      'Probe technical depth in a follow-up interview on the lowest-scoring topics before making a final offer decision.'
    );
  }

  return {
    mission_verdict: verdictParts.join(' '),
    mission_recommendations: recommendations.slice(0, 8),
  };
}

function sanitizeCompletedInterviewVerdict(verdict, { session, assessment, qaRows = [] } = {}) {
  const usesAssessmentLanguage = missionVerdictUsesAssessmentLanguage(verdict);
  const claimsTermination = verdictClaimsProctoringTermination(verdict);

  if (!verdict || (!usesAssessmentLanguage && !claimsTermination)) {
    return { verdict, sanitized: false, reason: null };
  }

  if (usesAssessmentLanguage) {
    console.warn(
      '[mission-verdict] Removed internal-assessment language from interview verdict'
    );
    const template = buildInterviewVerdictTemplate({ session, assessment, qaRows });
    return { verdict: template.mission_verdict, sanitized: true, reason: 'assessment_language' };
  }

  const name = session?.candidate_name || 'The candidate';
  const avg = assessment?.average_score_display ?? assessment?.average_score ?? 'N/A';
  const result = assessment?.result_status ?? 'Completed';
  const feedback = assessment?.feedback_status ?? '';

  console.warn(
    '[mission-verdict] Removed false proctoring-termination language from completed-interview verdict'
  );

  const replacement = [
    `${name} completed the browser video interview normally (interview_termination=false).`,
    `Overall result: ${result}. Average score: ${avg}/10. ${feedback ? `Interview band: ${feedback}.` : ''}`,
    `This verdict is based on question scores and answer quality only. Any proctoring monitoring events during the session did not terminate the interview.`,
  ].join(' ');

  return { verdict: replacement, sanitized: true, reason: 'false_termination' };
}

export async function generateMissionVerdictForProctoringTermination({
  session,
  assessment,
  flags = [],
  proctoringReport = null,
  integrityReport = null,
  qaRows = [],
}) {
  const verification = buildVerificationSummary(flags, proctoringReport, { proctoringTerminated: true });
  const template = buildProctoringVerdictTemplate({
    session,
    assessment,
    verification,
    proctoringReport,
    integrityReport,
  });

  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn('[mission-verdict] OPENAI_API_KEY missing; using template proctoring verdict');
    return template;
  }

  const meta = parseMetadata(session);
  const apiQuestions = meta.interview?.questions || [];

  let perQuestion = '';
  qaRows.slice(0, 15).forEach((row, i) => {
    const apiQ = apiQuestions[i];
    const skill = apiQ?.skill || row.category || 'general';
    perQuestion += `Q${i + 1} (partial — before termination):
  skill: ${skill}
  question: ${truncate(row.question_text, 500)}
  score: ${row.score != null ? Number(row.score) : 'not scored'}
  answer_excerpt: ${truncate(row.response_text, 300)}

`;
  });

  const userContent = `INTERVIEW TERMINATED — PROCTORING / INTEGRITY VIOLATION

IMPORTANT: This is a recruitment video interview integrity outcome. Recommend appropriate hiring-team next steps.

CANDIDATE
- name: ${session.candidate_name || ''}
- email: ${session.candidate_email || ''}
- role: ${session.job_title || ''}

TERMINATION
- outcome: Interview Invalidated - Integrity Violation
- completion_type: terminated_due_to_proctoring_violation
- warnings_before_termination: ${verification.warning_count ?? proctoringReport?.warning_count ?? 0}
- proctoring_risk_score: ${proctoringReport?.risk_score ?? 'n/a'}
- integrity_score: ${integrityReport?.integrity_score ?? 'n/a'}
- integrity_risk_level: ${integrityReport?.risk_level ?? 'n/a'}

SUSPICIOUS ACTIVITY DETECTED
- flag_count: ${verification.flag_count}
- high_severity_count: ${verification.high_severity_count}
- violation_types: ${(verification.flag_types_labeled || []).join(', ') || 'see summary'}
- details: ${verification.summary}

PARTIAL RESPONSES (if any — not valid for full hiring evaluation)
- questions_answered_before_termination: ${assessment?.total_questions ?? 0}
${perQuestion || '(none)'}`;

  const openai = getOpenAI();

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: MISSION_PROCTORING_TERMINATION_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.25,
      response_format: { type: 'json_object' },
      max_tokens: 1200,
    });

    const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    let verdict = typeof parsed.mission_verdict === 'string' ? parsed.mission_verdict.trim() : '';
    const rec = Array.isArray(parsed.mission_recommendations)
      ? parsed.mission_recommendations.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (missionVerdictUsesAssessmentLanguage(verdict)) {
      console.warn('[mission-verdict] Proctoring verdict contained assessment language; using template');
      return template;
    }

    if (!verdict) return template;

    return {
      mission_verdict: verdict,
      mission_recommendations: rec.length ? rec.slice(0, 12) : template.mission_recommendations,
      verification,
    };
  } catch (e) {
    console.error('[mission-verdict] proctoring termination verdict failed:', e?.message || e);
    return template;
  }
}

export async function generateMissionVerdictForVideoAssessment({
  session,
  assessment,
  qaRows = [],
  flags = [],
  proctoringReport = null,
  integrityReport = null,
  proctoringTerminated = false,
}) {
  const verification = buildVerificationSummary(flags, proctoringReport, {
    proctoringTerminated: Boolean(proctoringTerminated),
  });

  if (proctoringTerminated || assessment?.completion_type === 'terminated_due_to_proctoring_violation') {
    return generateMissionVerdictForProctoringTermination({
      session,
      assessment,
      flags,
      proctoringReport,
      integrityReport,
      qaRows,
    });
  }

  if (!qaRows?.length) {
    return { ...EMPTY_MISSION, verification };
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn('[mission-verdict] OPENAI_API_KEY missing; skipping verdict generation');
    return { ...EMPTY_MISSION, verification };
  }

  const meta = parseMetadata(session);
  const apiQuestions = meta.interview?.questions || [];

  let perQuestion = '';
  qaRows.slice(0, 35).forEach((row, i) => {
    const apiQ = apiQuestions[i];
    const skill = apiQ?.skill || row.category || 'general';
    perQuestion += `Q${i + 1}:
  skill: ${skill}
  question: ${truncate(row.question_text, 700)}
  score: ${Number(row.score ?? 0)}
  ai_feedback: ${truncate(row.ai_feedback, 800)}
  answer_excerpt: ${truncate(row.response_text, 450)}

`;
  });

  const userContent = `Interview type: VIDEO INTERVIEW (browser)

CONTEXT (authoritative)
- platform_purpose: recruitment video interview for job candidates
- hiring_decision: true — summarize fit for the role and recommend next hiring steps

INTERVIEW STATUS (authoritative — do not contradict)
- interview_termination: false
- completion_type: ${assessment?.completion_type || 'completed'}
- session_completed_normally: true
- The candidate finished all required steps. Do NOT state the interview was terminated due to proctoring.

CANDIDATE
- name: ${session.candidate_name || ''}
- email: ${session.candidate_email || ''}
- role_applied: ${session.job_title || ''}

OUTCOME (hiring evaluation)
- result_status: ${assessment?.result_status ?? ''}
- feedback_status: ${assessment?.feedback_status ?? ''}
- average_score: ${assessment?.average_score_display ?? assessment?.average_score ?? 0} (scale 0–10)
- total_questions_answered: ${assessment?.total_questions ?? qaRows.length}

PROCTORING NOTES (monitoring only — NOT termination; interview completed normally)
- flag_count: ${verification.flag_count}
- high_severity: ${verification.high_severity_count}
- summary: ${verification.summary}
- instruction: If flag_count > 0, you may mention minor integrity/monitoring concerns as optional risks. Never describe these as interview termination.

PER_QUESTION
${perQuestion}`;

  const openai = getOpenAI();

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: MISSION_VERDICT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 1400,
    });

    const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    const rawVerdict = typeof parsed.mission_verdict === 'string' ? parsed.mission_verdict.trim() : '';
    const { verdict, sanitized, reason } = sanitizeCompletedInterviewVerdict(rawVerdict, {
      session,
      assessment,
      qaRows,
    });
    let rec = Array.isArray(parsed.mission_recommendations)
      ? parsed.mission_recommendations.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (sanitized && reason === 'assessment_language') {
      const template = buildInterviewVerdictTemplate({ session, assessment, qaRows });
      rec = rec.length ? sanitizeRecommendations(rec) : template.mission_recommendations;
      if (!rec.length) rec = template.mission_recommendations;
    } else {
      rec = sanitizeRecommendations(rec);
    }

    if (sanitized) {
      console.warn(`[mission-verdict] Sanitized completed-interview verdict (reason=${reason})`);
    }

    return {
      mission_verdict: verdict || null,
      mission_recommendations: (rec.length ? rec : buildInterviewVerdictTemplate({ session, assessment, qaRows }).mission_recommendations).slice(0, 12),
      verification,
      verdict_sanitized: sanitized,
    };
  } catch (e) {
    console.error('[mission-verdict] generation failed:', e?.message || e);
    return { ...EMPTY_MISSION, verification };
  }
}

export { MISSION_VERDICT_SYSTEM_PROMPT, MISSION_PROCTORING_TERMINATION_PROMPT };
