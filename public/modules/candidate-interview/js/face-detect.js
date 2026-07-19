/**
 * Stabilizes MediaPipe face_mesh results to reduce false "no face" alerts.
 */
window.InterviewFaceDetect = (function () {
  const DEFAULTS = {
    presentStreakRequired: 2,
    absentStreakRequired: 4,
    treatMultiAsAbsent: true,
  };

  function createStabilizer(options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    let presentStreak = 0;
    let absentStreak = 0;
    let stableDetected = false;
    let stableCount = 0;

    function update(results) {
      const rawCount = results?.multiFaceLandmarks?.length || 0;
      let instantOk = rawCount === 1;
      if (cfg.treatMultiAsAbsent && rawCount > 1) instantOk = false;

      if (instantOk) {
        presentStreak += 1;
        absentStreak = 0;
        if (!stableDetected && presentStreak >= cfg.presentStreakRequired) {
          stableDetected = true;
        }
      } else if (rawCount === 0) {
        absentStreak += 1;
        presentStreak = 0;
        if (stableDetected && absentStreak >= cfg.absentStreakRequired) {
          stableDetected = false;
        }
      } else {
        presentStreak = 0;
        absentStreak += 1;
        if (stableDetected && absentStreak >= cfg.absentStreakRequired) {
          stableDetected = false;
        }
      }

      stableCount = stableDetected ? 1 : rawCount > 1 ? rawCount : 0;
      return {
        rawCount,
        faceDetected: stableDetected,
        faceCount: stableCount,
        multipleFaces: rawCount > 1,
      };
    }

    function reset() {
      presentStreak = 0;
      absentStreak = 0;
      stableDetected = false;
      stableCount = 0;
    }

    return { update, reset };
  }

  return { createStabilizer };
})();
