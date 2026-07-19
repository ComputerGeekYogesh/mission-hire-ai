/**
 * Returns true only for genuine Google Chrome (desktop & mobile).
 * Exported on window for reuse across assessment invite pages.
 */
function isChromeBrowser() {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent || '';

  // Edge keeps Chromium's "Chrome/" token but adds "Edg/" — not Google Chrome.
  if (ua.includes('Edg/')) return false;
  // Opera identifies via "OPR/" instead of listing Opera in the UA.
  if (ua.includes('OPR/')) return false;
  // Brave adds an explicit Brave marker even though it is Chromium-based.
  if (ua.includes('Brave')) return false;
  // Samsung Internet includes "SamsungBrowser" alongside Chromium tokens.
  if (ua.includes('SamsungBrowser')) return false;

  // Desktop/Android Chrome includes "Chrome/"; iOS Chrome uses "CriOS" instead of "Chrome".
  if (!/Chrome|CriOS/.test(ua)) return false;

  // Chrome exposes window.chrome; used as a secondary signal (not sufficient alone).
  if (typeof window === 'undefined' || !window.chrome) return false;

  return true;
}

if (typeof window !== 'undefined') {
  window.isChromeBrowser = isChromeBrowser;
}
