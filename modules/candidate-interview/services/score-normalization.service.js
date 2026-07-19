/** Per-question AI scores use a 0–10 scale (matches question-engine + webhook total_score). */
export const SCORE_SCALE = Number(process.env.INTERVIEW_SCORE_SCALE || 10);

/** Minimum average score (on SCORE_SCALE) to mark assessment Passed — 60%. */
export const PASS_SCORE_THRESHOLD = Number(
  process.env.INTERVIEW_PASS_SCORE_THRESHOLD || SCORE_SCALE * 0.6
);

export function formatScoreDisplay(value, scale = SCORE_SCALE) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return String(Math.round(Math.max(0, Math.min(scale, num))));
}

export function normalizeScore(rawScore, scale = SCORE_SCALE) {
  const raw = Number(rawScore);
  if (!Number.isFinite(raw)) return 0;
  return Math.round(Math.max(0, Math.min(scale, raw)));
}

export function safeSkillScore(score, scale = SCORE_SCALE) {
  if (score === null || score === undefined) return null;
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  return Math.round(Math.max(0, Math.min(scale, num)));
}

export function normalizeQuestionScore(rawScore, label = 'question') {
  const raw = Number(rawScore);
  if (!Number.isFinite(raw)) return 0;
  const clamped = Math.round(Math.max(0, Math.min(SCORE_SCALE, raw)));
  logScoreCalculation(raw, clamped, SCORE_SCALE, label);
  return clamped;
}

export function calculateTotalScore(skillScores, scale = SCORE_SCALE) {
  const validScores = skillScores.filter((s) => s !== null && s !== undefined);

  if (validScores.length === 0) return 0;

  const adjusted =
    validScores.length >= 3
      ? [...validScores].sort((a, b) => a - b).slice(1)
      : validScores;

  const average = adjusted.reduce((a, b) => a + b, 0) / adjusted.length;

  return Math.round(Math.max(0, Math.min(scale, average)));
}

export function logScoreCalculation(raw, normalized, scale, label) {
  const rawNum = Number(raw) || 0;
  const normNum = Number(normalized) || 0;
  console.log(
    `[Scoring] ${label}:`,
    'raw =',
    rawNum,
    '| normalized =',
    normNum,
    '| scale =',
    scale,
    '| raw% =',
    ((rawNum / scale) * 100).toFixed(1) + '%',
    '| normalized% =',
    ((normNum / scale) * 100).toFixed(1) + '%'
  );
}

/**
 * Group per-question scores by skill/category and return one average per skill.
 */
export function averageScoresBySkill(responses = []) {
  const bySkill = new Map();

  for (const row of responses) {
    if (row.score == null || row.score === '') continue;
    const skill = String(row.skill || row.category || 'general').trim() || 'general';
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(Number(row.score));
  }

  const skillAverages = [];
  for (const [skill, scores] of bySkill.entries()) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    skillAverages.push({ skill, average: avg, count: scores.length });
  }

  return skillAverages;
}

/**
 * Compute fair total score — prefers skill-level averages; drops lowest skill when 3+ skills.
 */
export function calculateTotalScoreFromResponses(responses = [], scale = SCORE_SCALE) {
  const scored = responses.filter((r) => r.score != null && r.score !== '');
  if (!scored.length) return 0;

  const skillGroups = averageScoresBySkill(scored);

  if (skillGroups.length >= 2) {
    const skillAvgs = skillGroups.map((g) => g.average);
    const total = calculateTotalScore(skillAvgs, scale);
    logScoreCalculation(
      skillAvgs.reduce((a, b) => a + b, 0) / skillAvgs.length,
      total,
      scale,
      'total_score (skill averages)'
    );
    return total;
  }

  const questionScores = scored.map((r) => Number(r.score) || 0);
  const total = calculateTotalScore(questionScores, scale);
  logScoreCalculation(
    questionScores.reduce((a, b) => a + b, 0) / questionScores.length,
    total,
    scale,
    'total_score (question average)'
  );
  return total;
}
