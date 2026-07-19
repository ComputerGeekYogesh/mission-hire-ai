/** Headphone output detection — blocks built-in laptop speakers, allows USB/BT headsets. */

/** Explicit headset naming in OS device label. */
export const STRICT_HEADPHONE_KEYWORD_RE =
  /\b(headphones?|headsets?|earphones?|earbuds?)\b/i;

/** Built-in PC / monitor speakers — never acceptable alone. */
export const BUILTIN_PC_SPEAKER_PATTERNS = [
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

/** USB / Bluetooth / external audio indicators. */
export const EXTERNAL_AUDIO_PATTERNS = [
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

/** Known headset brands (USB dongles often labeled "Speakers (Brand)"). */
export const HEADSET_BRAND_RE =
  /\b(apple|airpods?|sony|bose|jbl|sennheiser|jabra|plantronics|logitech|hyperx|razer|steelseries|corsair|audio-technica|beats|anker|skullcandy|soundcore|edifier|boat|boult|noise|oneplus|poly|wh-1000|redragon|fantech|cosmic byte)\b/i;

/** Onboard laptop audio chips — not private headphones (Linux/Windows HDA). */
export const ONBOARD_AUDIO_HARDWARE_RE =
  /\b(hd audio controller|family\s+\d+h\/\d+h|family\s+\d+h\b|acp\d|hda intel|analog stereo|pci audio|snd_hda|alsa)\b/i;

const ONBOARD_VENDOR_IN_PAREN_RE =
  /realtek|conexant|synaptics|intel|high definition audio|display|nvidia|amd|family\s+\d+h|hd audio|audio controller|analog|pci|acp|snd_hda/i;

export function hasExternalHeadphoneIndicator(label = '') {
  const trimmed = String(label || '').trim();
  return (
    EXTERNAL_AUDIO_PATTERNS.some((p) => p.test(trimmed)) || HEADSET_BRAND_RE.test(trimmed)
  );
}

/** Linux/Windows combo jack label — audio leaks to speakers when nothing is plugged in. */
export function isOnboardAnalogComboJack(label = '') {
  const trimmed = String(label || '').trim();
  if (!trimmed || hasExternalHeadphoneIndicator(trimmed)) return false;
  if (!/speaker\s*\+\s*headphones?/i.test(trimmed)) return false;
  return ONBOARD_AUDIO_HARDWARE_RE.test(trimmed) || isOnboardAudioHardware(trimmed);
}

export function isOnboardAudioHardware(label = '') {
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

export function isStrictHeadphoneDevice(label = '') {
  const trimmed = String(label || '').trim();
  if (trimmed.length < 2 || trimmed === '(unnamed output)') return false;
  return STRICT_HEADPHONE_KEYWORD_RE.test(trimmed);
}

/**
 * Built-in laptop/monitor speakers (Realtek main output, HDMI, etc.).
 * USB/BT devices and "2nd output" analog jack are NOT built-in.
 */
export function isBuiltinPcSpeaker(label = '') {
  const trimmed = String(label || '').trim();
  if (!trimmed) return false;
  if (hasExternalHeadphoneIndicator(trimmed)) return false;
  // 3.5mm combo jack — OS uses one name with or without plug; test tone verifies private audio.
  if (/speaker\s*\+\s*headphones?/i.test(trimmed)) return false;
  if (isOnboardAudioHardware(trimmed)) return true;
  if (isStrictHeadphoneDevice(trimmed)) return false;

  if (BUILTIN_PC_SPEAKER_PATTERNS.some((p) => p.test(trimmed))) return true;

  // Generic "Speakers (Realtek...)" without USB/headphone/2nd output
  if (/^speakers?\s*\(/i.test(trimmed) && /realtek/i.test(trimmed)) return true;

  return false;
}

/**
 * USB/BT headset dongles Windows often names "Speakers (USB Audio Device)" or "Speakers (Logitech)".
 */
export function isExternalHeadphoneSink(label = '') {
  const trimmed = String(label || '').trim();
  if (!trimmed || isBuiltinPcSpeaker(trimmed)) return false;
  if (EXTERNAL_AUDIO_PATTERNS.some((p) => p.test(trimmed))) return true;
  if (HEADSET_BRAND_RE.test(trimmed)) return true;

  // "Speakers (Some Vendor)" where vendor is not Realtek/Intel onboard
  const paren = trimmed.match(/\(([^)]+)\)/);
  if (paren?.[1]) {
    const inner = paren[1];
    if (inner.length > 2 && !ONBOARD_VENDOR_IN_PAREN_RE.test(inner)) {
      return /^speakers?\s*\(/i.test(trimmed) || /^default\s*-\s*speakers?\s*\(/i.test(trimmed);
    }
  }

  return false;
}

/**
 * Accept for interview: explicit headset name OR external USB/BT sink (not built-in speakers).
 */
export function isAcceptableHeadphoneOutput(label = '') {
  const trimmed = String(label || '').trim();
  if (trimmed.length < 2 || trimmed === '(unnamed output)') return false;
  if (hasExternalHeadphoneIndicator(trimmed)) return true;
  // Linux/Windows 3.5mm jack — same label when plugged or not; user confirms via test tone.
  if (/speaker\s*\+\s*headphones?/i.test(trimmed)) return true;
  if (isBuiltinPcSpeaker(trimmed)) return false;
  if (isStrictHeadphoneDevice(trimmed) && !isOnboardAudioHardware(trimmed)) return true;
  if (isExternalHeadphoneSink(trimmed)) return true;
  return false;
}

export function classifyHeadphoneLabel(label = '') {
  if (isAcceptableHeadphoneOutput(label)) return 'accepted';
  if (isBuiltinPcSpeaker(label)) return 'rejected';
  return 'rejected';
}

export function filterHeadphoneOutputs(outputs = []) {
  return (outputs || []).filter(
    (d) => d?.kind === 'audiooutput' && isAcceptableHeadphoneOutput(d.label)
  );
}

/** @deprecated alias */
export function filterStrictHeadphoneOutputs(outputs = []) {
  return filterHeadphoneOutputs(outputs);
}
