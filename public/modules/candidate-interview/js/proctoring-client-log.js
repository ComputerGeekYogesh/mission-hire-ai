/**
 * Browser console logging for proctoring audio / escalation debugging.
 */
window.ProctoringClientLog = (function () {
  function log(message, meta) {
    console.log(`[PROCTORING] ${message}`);
    if (meta && typeof meta === 'object') {
      if (meta.activity != null) console.log(`[PROCTORING] Activity: ${meta.activity}`);
      if (meta.warning_count != null) console.log(`[PROCTORING] Warning Count: ${meta.warning_count}`);
      if (meta.action != null) console.log(`[PROCTORING] Action: ${meta.action}`);
      if (meta.error != null) console.log(`[PROCTORING] Error: ${meta.error}`);
      if (meta.detail != null) console.log(`[PROCTORING] ${meta.detail}`);
    }
  }

  function activityKey(flagType) {
    const s = String(flagType || 'unknown')
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (s.startsWith('suspicious_activity_')) return s.slice('suspicious_activity_'.length);
    return s.replace(/^suspicious_activity_?/, '');
  }

  return { log, activityKey };

})();
