/**
 * Detects partial/full webcam obstruction via frame brightness, uniformity, and edge analysis.
 * Works when the face is not visible (finger, hand, tape, paper, lens cover, etc.).
 */
(function (global) {
  const SCAN_MS = 500;
  const COOLDOWN_MS = 22_000;
  const STREAK_REQUIRED = 4;
  const MIN_CONFIDENCE = 62;
  const BASELINE_SAMPLES_NEEDED = 12;
  const SAMPLE_W = 80;
  const SAMPLE_H = 60;

  let videoEl = null;
  let scanTimer = null;
  let onObstruction = null;
  let getFaceDetected = null;
  let canvas = null;
  let ctx = null;
  let baseline = null;
  const baselineRing = [];
  let obstructStreak = 0;
  let lastAlertAt = 0;
  let lastSample = null;
  let lastConfidence = 0;

  function ensureCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = SAMPLE_W;
      canvas.height = SAMPLE_H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  function zoneMean(luma, w, h, x0, y0, x1, y1) {
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        sum += luma[y * w + x];
        count += 1;
      }
    }
    return count ? sum / count : 0;
  }

  function analyzeFrame(video) {
    if (!video?.videoWidth || video.readyState < 2) return null;
    ensureCanvas();
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    const n = SAMPLE_W * SAMPLE_H;
    const luma = new Float32Array(n);
    let sumL = 0;
    let sumL2 = 0;

    for (let i = 0; i < n; i += 1) {
      const o = i * 4;
      const L = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      luma[i] = L;
      sumL += L;
      sumL2 += L * L;
    }

    const meanL = sumL / n;
    const stdL = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL));

    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 1; y < SAMPLE_H - 1; y += 1) {
      for (let x = 1; x < SAMPLE_W - 1; x += 1) {
        const i = y * SAMPLE_W + x;
        const gx = luma[i + 1] - luma[i - 1];
        const gy = luma[i + SAMPLE_W] - luma[i - SAMPLE_W];
        edgeSum += Math.hypot(gx, gy);
        edgeCount += 1;
      }
    }
    const edgeScore = edgeCount ? edgeSum / edgeCount : 0;

    let uniformCount = 0;
    for (let i = 0; i < n; i += 1) {
      if (Math.abs(luma[i] - meanL) < 18) uniformCount += 1;
    }
    const uniformRatio = uniformCount / n;

    const cw = Math.floor(SAMPLE_W * 0.34);
    const ch = Math.floor(SAMPLE_H * 0.34);
    const cx0 = Math.floor((SAMPLE_W - cw) / 2);
    const cy0 = Math.floor((SAMPLE_H - ch) / 2);
    const margin = Math.floor(SAMPLE_W * 0.08);
    const centerL = zoneMean(luma, SAMPLE_W, SAMPLE_H, cx0, cy0, cx0 + cw, cy0 + ch);
    const cornerL =
      (zoneMean(luma, SAMPLE_W, SAMPLE_H, margin, margin, margin + cw, margin + ch) +
        zoneMean(luma, SAMPLE_W, SAMPLE_H, SAMPLE_W - margin - cw, margin, SAMPLE_W - margin, margin + ch) +
        zoneMean(luma, SAMPLE_W, SAMPLE_H, margin, SAMPLE_H - margin - ch, margin + cw, SAMPLE_H - margin) +
        zoneMean(
          luma,
          SAMPLE_W,
          SAMPLE_H,
          SAMPLE_W - margin - cw,
          SAMPLE_H - margin - ch,
          SAMPLE_W - margin,
          SAMPLE_H - margin
        )) /
      4;
    const centerBlocked = centerL < cornerL * 0.55 && cornerL > 32;

    return {
      meanL,
      stdL,
      edgeScore,
      uniformRatio,
      centerBlocked,
      valid: true,
    };
  }

  function scoreObstruction(metrics, faceDetected) {
    const signals = [];
    let confidence = 0;

    if (metrics.meanL < 20) {
      confidence += 42;
      signals.push('black_feed');
    } else if (baseline && metrics.meanL < baseline.meanL * 0.35) {
      confidence += 36;
      signals.push('dark_feed');
    } else if (metrics.meanL < 30) {
      confidence += 24;
      signals.push('very_dark');
    }

    if (metrics.stdL < 11 && metrics.uniformRatio > 0.8) {
      confidence += 32;
      signals.push('uniform_cover');
    } else if (metrics.stdL < 14 && metrics.uniformRatio > 0.72) {
      confidence += 22;
      signals.push('low_variance');
    }

    if (baseline && metrics.edgeScore < baseline.edgeScore * 0.2) {
      confidence += 30;
      signals.push('blurred_or_covered');
    } else if (baseline && metrics.edgeScore < baseline.edgeScore * 0.32) {
      confidence += 18;
      signals.push('reduced_detail');
    }

    if (metrics.centerBlocked) {
      confidence += 24;
      signals.push('center_obstruction');
    }

    if (
      !faceDetected &&
      (metrics.meanL < 38 ||
        metrics.stdL < 16 ||
        metrics.uniformRatio > 0.68 ||
        (baseline && metrics.edgeScore < baseline.edgeScore * 0.38))
    ) {
      confidence += 20;
      signals.push('face_lost_with_visual_anomaly');
    }

    if (baseline && baseline.meanL - metrics.meanL > 42) {
      confidence += 16;
      signals.push('abrupt_brightness_drop');
    }

    return {
      confidence: Math.min(100, confidence),
      signals,
      obstructed: confidence >= MIN_CONFIDENCE,
    };
  }

  function updateBaseline(metrics, faceDetected, confidence) {
    if (baseline || !faceDetected || confidence >= 40 || metrics.meanL < 42) return;
    baselineRing.push({
      meanL: metrics.meanL,
      stdL: metrics.stdL,
      edgeScore: metrics.edgeScore,
    });
    if (baselineRing.length > 24) baselineRing.shift();
    if (baselineRing.length < BASELINE_SAMPLES_NEEDED) return;

    baseline = baselineRing.reduce(
      (acc, s) => ({
        meanL: acc.meanL + s.meanL,
        stdL: acc.stdL + s.stdL,
        edgeScore: acc.edgeScore + s.edgeScore,
      }),
      { meanL: 0, stdL: 0, edgeScore: 0 }
    );
    const count = baselineRing.length;
    baseline = {
      meanL: baseline.meanL / count,
      stdL: baseline.stdL / count,
      edgeScore: baseline.edgeScore / count,
    };
  }

  function proctorLog(message, extra) {
    console.log(`[PROCTORING] ${message}`);
    if (extra != null) console.log(`[PROCTORING] ${extra}`);
  }

  function scanOnce() {
    if (!videoEl || !videoEl.videoWidth) return;

    const faceDetected = typeof getFaceDetected === 'function' ? !!getFaceDetected() : false;
    const metrics = analyzeFrame(videoEl);
    if (!metrics?.valid) return;

    const scored = scoreObstruction(metrics, faceDetected);
    lastConfidence = scored.confidence;
    lastSample = {
      ...metrics,
      confidence: scored.confidence,
      signals: scored.signals,
      face_detected: faceDetected,
      obstruct_streak: obstructStreak,
      baseline_ready: !!baseline,
      at: new Date().toISOString(),
    };

    updateBaseline(metrics, faceDetected, scored.confidence);

    if (scored.obstructed) obstructStreak += 1;
    else obstructStreak = Math.max(0, obstructStreak - 1);

    lastSample.obstruct_streak = obstructStreak;

    if (
      obstructStreak < STREAK_REQUIRED ||
      scored.confidence < MIN_CONFIDENCE ||
      Date.now() - lastAlertAt < COOLDOWN_MS
    ) {
      return;
    }

    lastAlertAt = Date.now();
    obstructStreak = 0;

    proctorLog('Webcam obstruction detected');
    proctorLog(`Obstruction confidence: ${scored.confidence}%`);
    proctorLog('Warning triggered');

    if (typeof onObstruction === 'function') {
      onObstruction({
        message: `Webcam obstruction detected (${scored.confidence}% confidence)`,
        confidence: scored.confidence,
        signals: scored.signals,
        metrics,
        payload: lastSample,
      });
    }
  }

  const WebcamObstructionDetect = {
    start(video, callback, options = {}) {
      videoEl = video || null;
      onObstruction = typeof callback === 'function' ? callback : null;
      getFaceDetected = options.getFaceDetected || null;
      if (!videoEl || scanTimer) return;
      baseline = null;
      baselineRing.length = 0;
      obstructStreak = 0;
      lastSample = null;
      lastConfidence = 0;
      scanTimer = setInterval(scanOnce, SCAN_MS);
    },

    stop() {
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
      videoEl = null;
      onObstruction = null;
      getFaceDetected = null;
      baseline = null;
      baselineRing.length = 0;
      obstructStreak = 0;
      lastSample = null;
      lastConfidence = 0;
    },

    getLastSample() {
      return lastSample;
    },

    getTelemetrySnapshot() {
      if (!lastSample) return {};
      return {
        webcam_obstruction_confidence: lastSample.confidence,
        webcam_obstruction_streak: lastSample.obstruct_streak,
        webcam_obstruction_signals: lastSample.signals,
        webcam_obstruction_mean_luma: Number(lastSample.meanL?.toFixed(1)),
        webcam_obstruction_edge_score: Number(lastSample.edgeScore?.toFixed(2)),
        webcam_obstruction_baseline_ready: lastSample.baseline_ready,
      };
    },
  };

  global.InterviewWebcamObstructionDetect = WebcamObstructionDetect;
})(window);
