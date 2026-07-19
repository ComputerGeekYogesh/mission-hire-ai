import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFICATION_STATE,
  classifyMediaError,
  getMessageForState,
  validateStreamTracks,
  verifyCameraMic,
  stopMediaStream,
} from '../public/modules/candidate-interview/js/preflight-media-check.js';

function makeTrack({ kind = 'video', readyState = 'live', enabled = true } = {}) {
  return { kind, readyState, enabled, stop: mock.fn() };
}

function makeStream({ videoReadyState = 'live', audioReadyState = 'live' } = {}) {
  const videoTrack = makeTrack({ kind: 'video', readyState: videoReadyState });
  const audioTrack = makeTrack({ kind: 'audio', readyState: audioReadyState });
  return {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
    getTracks: () => [videoTrack, audioTrack],
  };
}

describe('classifyMediaError', () => {
  it('maps NotReadableError to device in use', () => {
    assert.equal(
      classifyMediaError(Object.assign(new Error('Could not start'), { name: 'NotReadableError' })),
      VERIFICATION_STATE.ERROR_DEVICE_IN_USE
    );
  });

  it('maps TrackStartError to device in use', () => {
    assert.equal(
      classifyMediaError(Object.assign(new Error('Track start failed'), { name: 'TrackStartError' })),
      VERIFICATION_STATE.ERROR_DEVICE_IN_USE
    );
  });

  it('maps NotAllowedError to permission denied', () => {
    assert.equal(
      classifyMediaError(Object.assign(new Error('Denied'), { name: 'NotAllowedError' })),
      VERIFICATION_STATE.ERROR_PERMISSION_DENIED
    );
  });

  it('maps NotFoundError to no device', () => {
    assert.equal(
      classifyMediaError(Object.assign(new Error('Missing'), { name: 'NotFoundError' })),
      VERIFICATION_STATE.ERROR_NO_DEVICE
    );
  });

  it('infers device in use from message when name is missing', () => {
    assert.equal(
      classifyMediaError(new Error('Could not start video source')),
      VERIFICATION_STATE.ERROR_DEVICE_IN_USE
    );
  });
});

describe('getMessageForState', () => {
  it('renders distinct copy for device in use vs permission denied', () => {
    const inUse = getMessageForState(VERIFICATION_STATE.ERROR_DEVICE_IN_USE);
    const denied = getMessageForState(VERIFICATION_STATE.ERROR_PERMISSION_DENIED);
    assert.match(inUse.body, /another app/i);
    assert.match(inUse.body, /Zoom|Teams|OBS/i);
    assert.match(denied.body, /allow camera and microphone access/i);
    assert.doesNotMatch(denied.body, /Zoom|Teams|OBS/i);
  });
});

describe('validateStreamTracks', () => {
  it('treats ended tracks as device in use failure', () => {
    const stream = makeStream({ videoReadyState: 'ended', audioReadyState: 'live' });
    const result = validateStreamTracks(stream);
    assert.equal(result.ok, false);
    assert.equal(result.state, VERIFICATION_STATE.ERROR_DEVICE_IN_USE);
    assert.equal(result.reason, 'dead_track');
  });

  it('accepts live video and audio tracks', () => {
    const result = validateStreamTracks(makeStream());
    assert.equal(result.ok, true);
  });
});

describe('verifyCameraMic', () => {
  it('surfaces device-in-use message when getUserMedia rejects NotReadableError', async () => {
    const getUserMedia = mock.fn(async () => {
      throw Object.assign(new Error('Device busy'), { name: 'NotReadableError' });
    });

    const result = await verifyCameraMic({
      getUserMedia,
      enumerateDevices: async () => [],
      autoRetryOnce: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, VERIFICATION_STATE.ERROR_DEVICE_IN_USE);
    assert.equal(getUserMedia.mock.calls.length, 1);
    const copy = getMessageForState(result.state);
    assert.match(copy.body, /another app/i);
  });

  it('surfaces permission denied message for NotAllowedError', async () => {
    const getUserMedia = mock.fn(async () => {
      throw Object.assign(new Error('Denied'), { name: 'NotAllowedError' });
    });

    const result = await verifyCameraMic({
      getUserMedia,
      enumerateDevices: async () => [],
      autoRetryOnce: false,
    });

    assert.equal(result.state, VERIFICATION_STATE.ERROR_PERMISSION_DENIED);
    const copy = getMessageForState(result.state);
    assert.match(copy.body, /browser settings/i);
  });

  it('treats resolved stream with ended track as failure', async () => {
    const getUserMedia = mock.fn(async () => makeStream({ videoReadyState: 'ended' }));

    const result = await verifyCameraMic({
      getUserMedia,
      enumerateDevices: async () => [],
      autoRetryOnce: false,
      checkAudioSoft: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, VERIFICATION_STATE.ERROR_DEVICE_IN_USE);
    assert.equal(result.reason, 'dead_track');
  });

  it('succeeds when stream is live and devices exist', async () => {
    const stream = makeStream();
    const getUserMedia = mock.fn(async () => stream);
    const enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'v1', label: 'Cam' },
      { kind: 'audioinput', deviceId: 'a1', label: 'Mic' },
    ];

    const videoEl = {
      srcObject: null,
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
      play: async () => {},
      onloadedmetadata: null,
      onplaying: null,
    };

    const result = await verifyCameraMic({
      getUserMedia,
      enumerateDevices,
      videoEl,
      autoRetryOnce: false,
      checkAudioSoft: false,
      frameTimeoutMs: 100,
    });

    assert.equal(result.ok, true);
    assert.equal(result.state, VERIFICATION_STATE.SUCCESS);
    assert.equal(result.stream, stream);
    stopMediaStream(stream);
  });

  it('retry can recover from a transient NotReadableError', async () => {
    let calls = 0;
    const getUserMedia = mock.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Busy'), { name: 'NotReadableError' });
      }
      return makeStream();
    });

    const enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'v1', label: 'Cam' },
      { kind: 'audioinput', deviceId: 'a1', label: 'Mic' },
    ];

    const videoEl = {
      srcObject: null,
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
      play: async () => {},
      onloadedmetadata: null,
      onplaying: null,
    };

    const promise = verifyCameraMic({
      getUserMedia,
      enumerateDevices,
      videoEl,
      autoRetryOnce: true,
      autoRetryDelayMs: 0,
      checkAudioSoft: false,
      frameTimeoutMs: 100,
    });

    const result = await promise;

    assert.equal(result.ok, true);
    assert.equal(result.autoRetried, true);
    assert.equal(getUserMedia.mock.calls.length, 2);
    stopMediaStream(result.stream);
  });
});
