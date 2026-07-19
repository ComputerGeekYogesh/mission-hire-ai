/**
 * Loads preflight-media-check (ES module) then classic preflight.js.
 * Classic scripts cannot import modules; this bridge sets window.PreflightMediaCheck first.
 */
import {
  VERIFICATION_STATE,
  classifyMediaError,
  platformPrivacyHint,
  getMessageForState,
  stopMediaStream,
  validateStreamTracks,
  waitForVideoFrames,
  sampleAudioLevel,
  verifyInputDevicesExist,
  verifyCameraMic,
} from './preflight-media-check.js';

window.PreflightMediaCheck = {
  VERIFICATION_STATE,
  classifyMediaError,
  platformPrivacyHint,
  getMessageForState,
  stopMediaStream,
  validateStreamTracks,
  waitForVideoFrames,
  sampleAudioLevel,
  verifyInputDevicesExist,
  verifyCameraMic,
};

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-preflight-classic="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.preflightClassic = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(s);
  });
}

loadClassicScript('/modules/candidate-interview/js/preflight.js').catch((err) => {
  console.error('[PreflightInit]', err);
  const msg = document.getElementById('preflight-msg');
  const panel = document.getElementById('preflight-media-error');
  const title = document.getElementById('preflight-media-error-title');
  const body = document.getElementById('preflight-media-error-body');
  if (title) title.textContent = 'Device check failed to start';
  if (body) {
    body.textContent =
      'The verification module could not load. Please refresh the page. If this continues, try a different browser.';
  }
  panel?.classList.remove('d-none');
  if (msg) msg.textContent = err.message || 'Preflight failed to initialize.';
});
