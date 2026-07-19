/**
 * Browser headphone output detection + test tone routing.
 * Mirrors modules/candidate-interview/lib/headphone-device-label.js
 */
window.InterviewHeadphoneDetect = (function () {
  const STRICT_HEADPHONE_KEYWORD_RE =
    /\b(headphones?|headsets?|earphones?|earbuds?)\b/i;

  const BUILTIN_PC_SPEAKER_PATTERNS = [
    /^default\s*-\s*speakers?\s*\(\s*realtek/i,
    /^communications\s*-\s*speakers?\s*\(\s*realtek/i,
    /^speakers?\s*\(\s*realtek(\s|r|\)|$)/i,
    /^speaker\s*\(\s*realtek/i,
    /realtek hd audio output$/i,
    /conexant/i,
    /\bhigh definition audio device\b/i,
    /\bintel\s*\(\s*display/i,
    /\bhdmi\b/i,
    /display audio/i,
    /\bmonitor\b/i,
    /nvidia hd/i,
    /amd hdmi/i,
    /tv audio/i,
    /\barc\b/i,
  ];

  const EXTERNAL_AUDIO_PATTERNS = [
    /\busb\b/i,
    /usb-c/i,
    /type-c/i,
    /bluetooth/i,
    /\bbt\b/i,
    /wireless/i,
    /hands.?free/i,
    /handsfree/i,
    /\bag audio\b/i,
    /a2dp/i,
    /pnP sound device/i,
    /usb audio device/i,
    /usb pnp/i,
    /2nd output/i,
    /front panel/i,
    /combo jack/i,
    /line out/i,
  ];

  const HEADSET_BRAND_RE =
    /\b(apple|airpods?|sony|bose|jbl|sennheiser|jabra|plantronics|logitech|hyperx|razer|steelseries|corsair|audio-technica|beats|anker|skullcandy|soundcore|edifier|boat|boult|noise|oneplus|poly|wh-1000|redragon|fantech|cosmic byte)\b/i;

  const ONBOARD_AUDIO_HARDWARE_RE =
    /\b(hd audio controller|family\s+\d+h\/\d+h|family\s+\d+h\b|acp\d|hda intel|analog stereo|pci audio|snd_hda|alsa)\b/i;

  const ONBOARD_VENDOR_IN_PAREN_RE =
    /realtek|conexant|synaptics|intel|high definition audio|display|nvidia|amd|family\s+\d+h|hd audio|audio controller|analog|pci|acp|snd_hda/i;

  function hasExternalHeadphoneIndicator(label = '') {
    const trimmed = String(label || '').trim();
    return (
      EXTERNAL_AUDIO_PATTERNS.some((p) => p.test(trimmed)) || HEADSET_BRAND_RE.test(trimmed)
    );
  }

  function isOnboardAudioHardware(label = '') {
    const trimmed = String(label || '').trim();
    if (!trimmed || hasExternalHeadphoneIndicator(trimmed)) return false;
    if (ONBOARD_AUDIO_HARDWARE_RE.test(trimmed)) return true;
    if (BUILTIN_PC_SPEAKER_PATTERNS.some((p) => p.test(trimmed))) return true;
    if (/^speakers?\s*\(/i.test(trimmed) && /realtek/i.test(trimmed)) return true;
    const paren = trimmed.match(/\(([^)]+)\)/);
    if (paren?.[1] && ONBOARD_VENDOR_IN_PAREN_RE.test(paren[1])) {
      return /^speakers?\b/i.test(trimmed) || /^default\s*-\s*speakers?\b/i.test(trimmed);
    }
    return false;
  }

  function isOnboardAnalogComboJack(label = '') {
    const trimmed = String(label || '').trim();
    if (!trimmed || hasExternalHeadphoneIndicator(trimmed)) return false;
    if (!/speaker\s*\+\s*headphones?/i.test(trimmed)) return false;
    return ONBOARD_AUDIO_HARDWARE_RE.test(trimmed) || isOnboardAudioHardware(trimmed);
  }

  function isStrictHeadphoneDevice(label = '') {
    const trimmed = String(label || '').trim();
    if (trimmed.length < 2 || trimmed === '(unnamed output)') return false;
    return STRICT_HEADPHONE_KEYWORD_RE.test(trimmed);
  }

  function isBuiltinPcSpeaker(label = '') {
    const trimmed = String(label || '').trim();
    if (!trimmed) return false;
    if (hasExternalHeadphoneIndicator(trimmed)) return false;
    if (/speaker\s*\+\s*headphones?/i.test(trimmed)) return false;
    if (isOnboardAudioHardware(trimmed)) return true;
    if (isStrictHeadphoneDevice(trimmed)) return false;
    if (BUILTIN_PC_SPEAKER_PATTERNS.some((p) => p.test(trimmed))) return true;
    if (/^speakers?\s*\(/i.test(trimmed) && /realtek/i.test(trimmed)) return true;
    return false;
  }

  function isExternalHeadphoneSink(label = '') {
    const trimmed = String(label || '').trim();
    if (!trimmed || isBuiltinPcSpeaker(trimmed)) return false;
    if (EXTERNAL_AUDIO_PATTERNS.some((p) => p.test(trimmed))) return true;
    if (HEADSET_BRAND_RE.test(trimmed)) return true;
    const paren = trimmed.match(/\(([^)]+)\)/);
    if (paren?.[1]) {
      const inner = paren[1];
      if (inner.length > 2 && !ONBOARD_VENDOR_IN_PAREN_RE.test(inner)) {
        return /^speakers?\s*\(/i.test(trimmed) || /^default\s*-\s*speakers?\s*\(/i.test(trimmed);
      }
    }
    return false;
  }

  function isAcceptableHeadphoneOutput(label = '') {
    const trimmed = String(label || '').trim();
    if (trimmed.length < 2 || trimmed === '(unnamed output)') return false;
    if (hasExternalHeadphoneIndicator(trimmed)) return true;
    if (/speaker\s*\+\s*headphones?/i.test(trimmed)) return true;
    if (isBuiltinPcSpeaker(trimmed)) return false;
    if (isStrictHeadphoneDevice(trimmed) && !isOnboardAudioHardware(trimmed)) return true;
    if (isExternalHeadphoneSink(trimmed)) return true;
    return false;
  }

  function listAudioOutputs(devices) {
    return (devices || []).filter((d) => d.kind === 'audiooutput');
  }

  function filterHeadphoneOutputs(outputs) {
    return listAudioOutputs(outputs).filter((d) => isAcceptableHeadphoneOutput(d.label));
  }

  async function ensureMicPermissionForLabels(existingStream) {
    const live =
      existingStream?.getAudioTracks?.().some((t) => t.readyState === 'live' && t.enabled) ||
      false;
    if (live) return existingStream;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn('[InterviewHeadphoneDetect] Mic permission needed for device labels', e);
      return null;
    }
  }

  async function enumerateAudioOutputs(existingStream) {
    await ensureMicPermissionForLabels(existingStream);
    const devices = await navigator.mediaDevices.enumerateDevices();
    return listAudioOutputs(devices);
  }

  async function enumerateHeadphoneOutputs(existingStream) {
    await ensureMicPermissionForLabels(existingStream);
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = listAudioOutputs(devices);
    const inputs = (devices || []).filter((d) => d.kind === 'audioinput');

    const direct = filterHeadphoneOutputs(outputs);
    const seen = new Set(direct.map((d) => d.deviceId));

    const headsetInputGroups = new Set();
    for (const inp of inputs) {
      const label = inp.label || '';
      if (
        isAcceptableHeadphoneOutput(label) ||
        (/\busb\b/i.test(label) && !isBuiltinPcSpeaker(label)) ||
        /headset|headphone|earphone|earbud|airpods?/i.test(label)
      ) {
        if (inp.groupId) headsetInputGroups.add(inp.groupId);
      }
    }

    const paired = outputs.filter(
      (o) =>
        o.groupId &&
        headsetInputGroups.has(o.groupId) &&
        isAcceptableHeadphoneOutput(o.label) &&
        !seen.has(o.deviceId)
    );

    return [...direct, ...paired];
  }

  function pickHeadphoneOutput(devicesOrOutputs, preferredDeviceId) {
    const headphoneOnly = filterHeadphoneOutputs(
      devicesOrOutputs?.length && devicesOrOutputs[0]?.kind
        ? devicesOrOutputs
        : listAudioOutputs(devicesOrOutputs)
    );

    if (!headphoneOnly.length) {
      return { device: null, confidence: 'none', detected: false };
    }

    const preferUsb = (list) =>
      list.find((d) => /\busb\b/i.test(d.label || '')) ||
      list.find((d) => /speaker\s*\+\s*headphones?/i.test(d.label || '')) ||
      list.find((d) => isStrictHeadphoneDevice(d.label)) ||
      list[0];

    if (preferredDeviceId) {
      const sel = headphoneOnly.find((d) => d.deviceId === preferredDeviceId);
      if (sel) return { device: sel, confidence: 'high', detected: true };
    }

    return { device: preferUsb(headphoneOnly), confidence: 'high', detected: true };
  }

  function createToneWavBlob(frequencyHz, durationSec, volume) {
    const sampleRate = 44100;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < numSamples; i += 1) {
      const t = i / sampleRate;
      const sample = Math.sin(2 * Math.PI * frequencyHz * t) * volume;
      view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, sample * 32767)), true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  function sampleMaxMicRms(analyser, durationMs) {
    return new Promise((resolve) => {
      const data = new Float32Array(analyser.fftSize);
      let maxRms = 0;
      const start = performance.now();

      function tick() {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (rms > maxRms) maxRms = rms;
        if (performance.now() - start < durationMs) {
          requestAnimationFrame(tick);
        } else {
          resolve(maxRms);
        }
      }

      requestAnimationFrame(tick);
    });
  }

  async function playToneOnDevice(
    deviceId,
    { frequencyHz = 440, durationSec = 0.9, volume = 0.35, audioVolume = 0.85 } = {}
  ) {
    const url = URL.createObjectURL(createToneWavBlob(frequencyHz, durationSec, volume));
    const audio = new Audio(url);
    audio.volume = audioVolume;

    if (typeof audio.setSinkId !== 'function') {
      URL.revokeObjectURL(url);
      throw new Error('This browser cannot route audio to a specific device. Use Chrome or Edge.');
    }

    await audio.setSinkId(deviceId);
    const ended = new Promise((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('Could not play test tone on the selected device.'));
    });
    await audio.play();
    await ended;
    URL.revokeObjectURL(url);
  }

  /**
   * Play tone through the selected output and measure microphone pickup.
   * Loud speaker playback fails — user must have private headphones (in-ear).
   */
  async function verifyPrivateHeadphoneOutput(deviceId, micStream, options = {}) {
    if (!deviceId) throw new Error('No headphone output device selected');

    const {
      frequencyHz = 440,
      durationSec = 0.9,
      volume = 0.35,
      audioVolume = 0.85,
      leakDeltaThreshold = 0.018,
      absoluteLeakThreshold = 0.032,
      baselineMs = 350,
    } = options;

    const track = micStream?.getAudioTracks?.()?.[0];
    if (!track || track.readyState !== 'live') {
      throw new Error('Microphone is required for headphone verification.');
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('AudioContext is not supported in this browser.');
    }

    const ctx = new AudioCtx();
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      const micSource = ctx.createMediaStreamSource(new MediaStream([track.clone()]));
      micSource.connect(analyser);

      const baseline = await sampleMaxMicRms(analyser, baselineMs);
      const tonePromise = playToneOnDevice(deviceId, {
        frequencyHz,
        durationSec,
        volume,
        audioVolume,
      });
      const duringPromise = sampleMaxMicRms(
        analyser,
        Math.floor(durationSec * 1000) + 300
      );
      await tonePromise;
      const during = await duringPromise;

      const delta = Math.max(0, during - baseline);
      const passed = delta < leakDeltaThreshold && during < absoluteLeakThreshold;

      return {
        passed,
        baseline,
        during,
        delta,
        reason: passed
          ? null
          : 'Audio is playing through speakers, not private headphones. Plug in your headset, stay silent, and try again.',
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async function playTestTone(deviceId) {
    await playToneOnDevice(deviceId, { frequencyHz: 440, durationSec: 1, volume: 0.35, audioVolume: 0.85 });
  }

  function formatOutputLabel(device) {
    const label = device?.label?.trim();
    if (label) return label;
    return '(unnamed — reconnect headphones after allowing microphone access)';
  }

  return {
    isStrictHeadphoneDevice,
    isAcceptableHeadphoneOutput,
    isBuiltinPcSpeaker,
    isExternalHeadphoneSink,
    isOnboardAnalogComboJack,
    listAudioOutputs,
    filterHeadphoneOutputs,
    ensureMicPermissionForLabels,
    enumerateAudioOutputs,
    enumerateHeadphoneOutputs,
    pickHeadphoneOutput,
    playTestTone,
    playToneOnDevice,
    verifyPrivateHeadphoneOutput,
    formatOutputLabel,
    createToneWavBlob,
  };
})();
