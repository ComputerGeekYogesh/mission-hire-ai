/**
 * Returns true for phones and tablets; false for desktop/laptop computers.
 * Exported on window for reuse across assessment invite pages.
 */
function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;

  // User-Agent Client Hints (Chromium): explicit mobile flag when supported.
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
    return navigator.userAgentData.mobile;
  }

  const ua = navigator.userAgent || '';

  // Phones, tablets, and legacy mobile browsers (includes iPad, Android tablets, iPhone, etc.).
  const MOBILE_UA_PATTERN = /Android|iPhone|iPad|iPod|webOS|BlackBerry|Windows Phone|Mobile/i;
  if (MOBILE_UA_PATTERN.test(ua)) return true;

  // iPadOS 13+ may report as Macintosh without "iPad" — treat touch Mac UA as tablet.
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;

  return false;
}

if (typeof window !== 'undefined') {
  window.isMobileDevice = isMobileDevice;
}
