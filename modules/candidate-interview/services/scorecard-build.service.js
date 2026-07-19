import {
  averageScoresBySkill,
  SCORE_SCALE,
  formatScoreDisplay,
} from './score-normalization.service.js';

/**
 * Per-skill average scores for admin scorecard (0–SCORE_SCALE).
 */
export function buildSkillBreakdown(qaDetail = []) {
  const responses = (qaDetail || [])
    .filter((r) => r.response_id && r.score != null && r.score !== '')
    .map((r) => ({
      skill: r.category,
      category: r.category,
      score: Number(r.score),
    }));

  const groups = averageScoresBySkill(responses);

  return groups.map((g) => {
    const avg = Math.round(Number(g.average));
    return {
      skill: g.skill,
      average: avg,
      average_display: formatScoreDisplay(avg, SCORE_SCALE),
      count: g.count,
      scale: SCORE_SCALE,
    };
  });
}
