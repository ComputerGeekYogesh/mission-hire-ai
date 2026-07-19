/**
 * Camera/microphone verification for the preflight page.
 * Distinguishes permission denied, device in use, no device, and dead-track failures.
 *
 * Note: NotReadableError / TrackStartError strongly suggest another process holds the
 * device, but some drivers use it for other transient faults — hence auto-retry once.
 */

export const VERIFICATION_STATE = {
  CHECKING: 'checking',
  SUCCESS: 'success',
  ERROR_PERMISSION_DENIED: 'error_permission_denied',
  ERROR_DEVICE_IN_USE: 'error_device_in_use',
  ERROR_NO_DEVICE: 'error_no_device',
  ERROR_CONSTRAINTS: 'error_constraints',
  ERROR_GENERIC: 'error_generic',
};

/** @typedef {typeof VERIFICATION_STATE[keyof typeof VERIFICATION_STATE]} VerificationState */

const ERROR_COPY = {
  [VERIFICATION_STATE.ERROR_PERMISSION_DENIED]: {
    title: 'Camera or microphone access blocked',
    body:
      'Please allow camera and microphone access in your browser settings, then click Retry. ' +
      'You may need to click the lock or camera icon in the address bar and set both to Allow.',
    hint: null,
  },
  [VERIFICATION_STATE.ERROR_DEVICE_IN_USE]: {
    title: 'Camera or microphone unavailable',
    body:
      "We couldn't access your camera/microphone. This usually means another app " +
      '(e.g. Zoom, Teams, OBS, or another browser tab) is currently using it. ' +
      'Please close other apps using your camera/mic, then click Retry.',
    hint: 'platform',
  },
  [VERIFICATION_STATE.ERROR_NO_DEVICE]: {
    title: 'No camera or microphone detected',
    body:
      'No camera or microphone was found on this device. Connect a camera and microphone, then click Retry.',
    hint: null,
  },
  [VERIFICATION_STATE.ERROR_CONSTRAINTS]: {
    title: 'Device not compatible',
    body:
      'Your camera or microphone does not support the required settings. Try a different device or browser, then click Retry.',
    hint: null,
  },
  [VERIFICATION_STATE.ERROR_GENERIC]: {
    title: 'Could not access camera or microphone',
    body: 'Something went wrong while starting your camera or microphone. Please click Retry.',
    hint: null,
  },
};

/**
 * Map getUserMedia DOMException.name to verification state.
 * @param {DOMException|Error|null|undefined} error
 * @returns {VerificationState}
 */
export function classifyMediaError(error) {
  const name = error?.name || '';
  const message = String(error?.message || '').toLowerCase();

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return VERIFICATION_STATE.ERROR_PERMISSION_DENIED;
    case 'NotReadableError':
    case 'TrackStartError':
      return VERIFICATION_STATE.ERROR_DEVICE_IN_USE;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return VERIFICATION_STATE.ERROR_NO_DEVICE;
    case 'OverconstrainedError':
      return VERIFICATION_STATE.ERROR_CONSTRAINTS;
    case 'AbortError':
      return VERIFICATION_STATE.ERROR_GENERIC;
    default:
      break;
  }

  // Some browsers/drivers omit error.name — infer from message text.
  if (
    /not readable|could not start|device in use|already in use|busy|in use by another|track start/i.test(
      message
    )
  ) {
    return VERIFICATION_STATE.ERROR_DEVICE_IN_USE;
  }
  if (/not allowed|permission|denied/i.test(message)) {
    return VERIFICATION_STATE.ERROR_PERMISSION_DENIED;
  }
  if (/not found|no device|devicesnotfound/i.test(message)) {
    return VERIFICATION_STATE.ERROR_NO_DEVICE;
  }

  return VERIFICATION_STATE.ERROR_GENERIC;
}

/**
 * Platform-specific settings guidance (not app guessing).
 * @returns {string}
 */
export function platformPrivacyHint() {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent || '';
  if (/Mac|iPhone|iPad/i.test(ua)) {
    return 'On Mac, check the green camera indicator in the menu bar and quit apps using the camera or microphone.';
  }
  if (/Win/i.test(ua)) {
    return 'On Windows, open Settings → Privacy & security → Camera and Microphone to see which apps have access.';
  }
  return 'Close other applications or browser tabs that may be using your camera or microphone.';
}

/**
 * @param {VerificationState} state
 * @returns {{ title: string, body: string, hint: string|null }}
 */
export function getMessageForState(state) {
  const copy = ERROR_COPY[state] || ERROR_COPY[VERIFICATION_STATE.ERROR_GENERIC];
  const hint = copy.hint === 'platform' ? platformPrivacyHint() : copy.hint;
  return { title: copy.title, body: copy.body, hint };
}

/**
 * @param {MediaStream|null|undefined} stream
 */
export function stopMediaStream(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
  } catch (_) {}
}

/**
 * @param {MediaStream} stream
 * @returns {{ ok: boolean, state?: VerificationState, reason?: string }}
 */
export function validateStreamTracks(stream) {
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];

  if (!videoTrack || !audioTrack) {
    return {
      ok: false,
      state: VERIFICATION_STATE.ERROR_NO_DEVICE,
      reason: 'missing_track',
    };
  }

  if (videoTrack.readyState === 'ended' || audioTrack.readyState === 'ended') {
    return {
      ok: false,
      state: VERIFICATION_STATE.ERROR_DEVICE_IN_USE,
      reason: 'dead_track',
    };
  }

  if (videoTrack.readyState !== 'live' || audioTrack.readyState !== 'live') {
    return {
      ok: false,
      state: VERIFICATION_STATE.ERROR_DEVICE_IN_USE,
      reason: 'track_not_live',
    };
  }

  return { ok: true };
}

/**
 * Wait until the video element receives frames or timeout.
 * @param {HTMLVideoElement} videoEl
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ ok: boolean }>}
 */
export function waitForVideoFrames(videoEl, timeoutMs = 3000) {
  const HAVE_CURRENT_DATA =
    typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.HAVE_CURRENT_DATA : 2;

  return new Promise((resolve) => {
    if (!videoEl) {
      resolve({ ok: false });
      return;
    }

    const hasFrames = () =>
      videoEl.readyState >= HAVE_CURRENT_DATA && videoEl.videoWidth > 0;

    if (hasFrames()) {
      resolve({ ok: true });
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      videoEl.onloadedmetadata = null;
      videoEl.onplaying = null;
      clearTimeout(timer);
      resolve({ ok });
    };

    videoEl.onloadedmetadata = () => {
      if (hasFrames()) finish(true);
    };
    videoEl.onplaying = () => {
      if (hasFrames()) finish(true);
    };

    const timer = setTimeout(() => finish(hasFrames()), timeoutMs);
  });
}

/**
 * Soft check — silence does not fail verification.
 * @param {MediaStream} stream
 * @param {{ durationMs?: number, AudioContextCtor?: typeof AudioContext }} [options]
 * @returns {Promise<{ hasSignal: boolean, peak: number }>}
 */
export async function sampleAudioLevel(stream, options = {}) {
  const durationMs = options.durationMs ?? 450;
  const AudioContextCtor = options.AudioContextCtor || globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor || !stream?.getAudioTracks?.().length) {
    return { hasSignal: false, peak: 0 };
  }

  let ctx = null;
  let source = null;
  try {
    ctx = new AudioContextCtor();
    if (ctx.state === 'suspended') await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);

    const start = Date.now();
    let peak = 0;
    while (Date.now() - start < durationMs) {
      analyser.getFloatTimeDomainData(buffer);
      for (let i = 0; i < buffer.length; i += 1) {
        const v = Math.abs(buffer[i]);
        if (v > peak) peak = v;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    return { hasSignal: peak > 0.008, peak };
  } catch (_) {
    return { hasSignal: false, peak: 0 };
  } finally {
    try {
      source?.disconnect();
    } catch (_) {}
    try {
      if (ctx?.state !== 'closed') await ctx.close();
    } catch (_) {}
  }
}

/**
 * Secondary check after permission grant — confirms inputs exist.
 * @param {() => Promise<MediaDeviceInfo[]>} enumerateDevices
 */
export async function verifyInputDevicesExist(enumerateDevices) {
  const devices = await enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  const audioInputs = devices.filter((d) => d.kind === 'audioinput');
  return {
    hasVideo: videoInputs.length > 0,
    hasAudio: audioInputs.length > 0,
    labeledVideo: videoInputs.some((d) => Boolean(d.label)),
    labeledAudio: audioInputs.some((d) => Boolean(d.label)),
    videoInputs,
    audioInputs,
  };
}

function shouldAutoRetry(state) {
  return (
    state === VERIFICATION_STATE.ERROR_DEVICE_IN_USE ||
    state === VERIFICATION_STATE.ERROR_GENERIC
  );
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Full camera/mic verification with optional single auto-retry.
 * @param {{
 *   getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
 *   enumerateDevices?: () => Promise<MediaDeviceInfo[]>,
 *   videoEl?: HTMLVideoElement|null,
 *   autoRetryOnce?: boolean,
 *   autoRetryDelayMs?: number,
 *   frameTimeoutMs?: number,
 *   checkAudioSoft?: boolean,
 *   AudioContextCtor?: typeof AudioContext,
 * }} [options]
 */
export async function verifyCameraMic(options = {}) {
  const getUserMedia =
    options.getUserMedia ||
    ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
  const enumerateDevices =
    options.enumerateDevices ||
    (() => navigator.mediaDevices.enumerateDevices());
  const videoEl = options.videoEl || null;
  const autoRetryOnce = options.autoRetryOnce !== false;
  const autoRetryDelayMs = options.autoRetryDelayMs ?? 2000;
  const frameTimeoutMs = options.frameTimeoutMs ?? 3000;
  const checkAudioSoft = options.checkAudioSoft !== false;

  const runAttempt = async () => {
    let stream = null;
    try {
      stream = await getUserMedia({ video: true, audio: true });

      const trackCheck = validateStreamTracks(stream);
      if (!trackCheck.ok) {
        stopMediaStream(stream);
        return {
          ok: false,
          state: trackCheck.state,
          reason: trackCheck.reason,
        };
      }

      if (videoEl) {
        videoEl.srcObject = stream;
        try {
          await videoEl.play();
        } catch (_) {}
        const frames = await waitForVideoFrames(videoEl, frameTimeoutMs);
        if (!frames.ok) {
          stopMediaStream(stream);
          if (videoEl.srcObject === stream) videoEl.srcObject = null;
          return {
            ok: false,
            state: VERIFICATION_STATE.ERROR_DEVICE_IN_USE,
            reason: 'no_video_frames',
          };
        }
      }

      let audioWarning = null;
      if (checkAudioSoft) {
        const audioSample = await sampleAudioLevel(stream, {
          AudioContextCtor: options.AudioContextCtor,
        });
        if (!audioSample.hasSignal) {
          audioWarning =
            'Your microphone is connected but very quiet — check that it is not muted and try speaking during the check.';
        }
      }

      const devices = await verifyInputDevicesExist(enumerateDevices);
      if (!devices.hasVideo || !devices.hasAudio) {
        stopMediaStream(stream);
        if (videoEl?.srcObject === stream) videoEl.srcObject = null;
        return {
          ok: false,
          state: VERIFICATION_STATE.ERROR_NO_DEVICE,
          reason: 'enumerate_no_inputs',
          devices,
        };
      }

      return {
        ok: true,
        state: VERIFICATION_STATE.SUCCESS,
        stream,
        audioWarning,
        devices,
      };
    } catch (error) {
      stopMediaStream(stream);
      if (videoEl?.srcObject === stream) videoEl.srcObject = null;
      return {
        ok: false,
        state: classifyMediaError(error),
        error,
      };
    }
  };

  let result = await runAttempt();
  if (!result.ok && autoRetryOnce && shouldAutoRetry(result.state)) {
    await delay(autoRetryDelayMs);
    result = await runAttempt();
    result.autoRetried = true;
  }

  return result;
}

export default {
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
