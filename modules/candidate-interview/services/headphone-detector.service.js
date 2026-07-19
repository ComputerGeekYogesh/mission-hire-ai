import { HEADPHONE_STATUS } from '../constants.js';
import { isAcceptableHeadphoneOutput } from '../lib/headphone-device-label.js';

const detectors = [];

export function registerHeadphoneDetector(fn) {
  if (typeof fn === 'function') detectors.push(fn);
}

function parseBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * Strict headphone verification — test tone + explicit headphone-class device label only.
 */
export async function detectHeadphones(clientPayload = {}) {
  for (const detector of detectors) {
    try {
      const result = await detector(clientPayload);
      if (result?.status && result.status !== HEADPHONE_STATUS.UNKNOWN) return result;
    } catch (err) {
      console.warn('[headphone-detector]', err.message);
    }
  }

  const hardware = parseBool(clientPayload?.headphones_hardware_detected);
  const verified = parseBool(clientPayload?.headphones_verified);
  const testTonePassed = parseBool(clientPayload?.headphones_test_tone_passed);
  const leakagePassed = parseBool(clientPayload?.headphones_leakage_passed);
  const deviceLabel = String(clientPayload?.device_label || '').trim();
  const deviceId = String(clientPayload?.device_id || '').trim();
  const method = String(clientPayload?.headphones_detection_method || '').trim();

  if (method === 'skipped') {
    return {
      status: HEADPHONE_STATUS.NOT_DETECTED,
      confidence: 0,
      source: 'skipped_rejected',
      detection_method: 'skipped',
      message:
        'Headphones are mandatory. Connect wired or Bluetooth headphones with a device name containing Headphones, Headset, Earphone, or Earbuds.',
    };
  }

  if (!hardware || !verified || !testTonePassed || !leakagePassed) {
    return {
      status: HEADPHONE_STATUS.NOT_DETECTED,
      confidence: 0,
      source: 'not_verified',
      message:
        'Headphones are required. Select a headphone device, pass the test tone speaker check, and confirm before continuing.',
    };
  }

  if (!deviceLabel || !isAcceptableHeadphoneOutput(deviceLabel)) {
    return {
      status: HEADPHONE_STATUS.NOT_DETECTED,
      confidence: 0,
      source: 'invalid_device_label',
      device_label: deviceLabel,
      message:
        'Selected output is not a headphone device. Built-in speakers and generic audio outputs are not allowed.',
    };
  }

  if (method !== 'test_tone_confirmed') {
    return {
      status: HEADPHONE_STATUS.NOT_DETECTED,
      confidence: 0,
      source: 'invalid_method',
      message: 'Complete headphone verification with the test tone before continuing.',
    };
  }

  return {
    status: HEADPHONE_STATUS.DETECTED,
    confidence: 1,
    source: 'test_tone_confirmed',
    detection_method: 'test_tone_confirmed',
    device_label: deviceLabel,
    device_id: deviceId || null,
  };
}

/** Headphones are always mandatory — no skip/waiver. */
export function isHeadphoneRequirementWaived(_session) {
  return false;
}

export function assertHeadphonesDetected(status, result = {}) {
  if (status !== HEADPHONE_STATUS.DETECTED) {
    const err = new Error(
      result.message ||
        'Headphones are mandatory. Connect a headset/earphones and complete the headphone check before continuing.'
    );
    err.status = 403;
    throw err;
  }
}
