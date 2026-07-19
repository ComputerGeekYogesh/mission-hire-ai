/**
 * Client-side mobile phone detection in camera frame (COCO-SSD, lazy-loaded).
 */
(function (global) {
  const PHONE_SCAN_MS = 3000;
  const MIN_CONFIDENCE = 0.35;
  const COOLDOWN_MS = 12000;

  let modelPromise = null;
  let scanTimer = null;
  let lastReportAt = 0;
  let onPhoneDetected = null;
  let videoEl = null;

  function loadModel() {
    if (modelPromise) return modelPromise;
    modelPromise = (async () => {
      if (!global.cocoSsd) {
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
        await loadScript(
          'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js'
        );
      }
      return global.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    })();
    return modelPromise;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        s.dataset.loaded = '1';
        resolve();
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function scanOnce() {
    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return;
    const now = Date.now();
    if (now - lastReportAt < COOLDOWN_MS) return;

    try {
      const model = await loadModel();
      const preds = await model.detect(videoEl);
      const phone = preds.find(
        (p) =>
          p.class === 'cell phone' &&
          Number(p.score) >= MIN_CONFIDENCE &&
          p.bbox &&
          p.bbox[2] > 24 &&
          p.bbox[3] > 24
      );
      if (!phone) return;

      lastReportAt = now;
      const scorePct = Math.round(Number(phone.score) * 100);
      const detail = {
        class: phone.class,
        score: Number(phone.score.toFixed(3)),
        bbox: phone.bbox,
        at: new Date().toISOString(),
      };
      if (typeof onPhoneDetected === 'function') {
        onPhoneDetected({
          message: `Mobile phone detected in camera frame (${scorePct}% confidence)`,
          payload: detail,
        });
      }
    } catch (err) {
      console.warn('[phone-detector]', err?.message || err);
    }
  }

  const PhoneDetector = {
    start(video, callback) {
      videoEl = video || null;
      onPhoneDetected = typeof callback === 'function' ? callback : null;
      if (!videoEl || scanTimer) return;
      void loadModel().catch(() => {});
      scanTimer = setInterval(() => {
        void scanOnce();
      }, PHONE_SCAN_MS);
    },

    stop() {
      if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
      }
      videoEl = null;
      onPhoneDetected = null;
    },
  };

  global.InterviewPhoneDetector = PhoneDetector;
})(window);
