/**
 * In-call network monitor for browser video assessments (HTTP probes + navigator.onLine).
 * Full-screen reconnect overlay — same pattern as auto-submit overlay.
 */
window.CallConnectivityMonitor = (function () {
  const STATES = {
    GOOD: 'good',
    RECONNECTING: 'reconnecting',
    LOST: 'lost',
    RESTORED: 'restored',
  };

  const PROBE_INTERVAL_MS = 2000;
  const PROBE_TIMEOUT_MS = 5000;
  const RTT_SLOW_MS = 2500;
  const BAD_STREAK_TO_SHOW = 1;
  const GOOD_STREAK_TO_HIDE = 1;
  const SHOW_DEBOUNCE_MS = 800;
  const RESTORED_VISIBLE_MS = 1500;
  const MAX_SILENT_PROBES = 8;

  class Monitor {
    constructor(options = {}) {
      this.token = options.token || window.INTERVIEW_TOKEN || '';
      this.isCallActive =
        typeof options.isCallActive === 'function' ? options.isCallActive : () => true;
      this.getUploadHealth =
        typeof options.getUploadHealth === 'function'
          ? options.getUploadHealth
          : () => ({ failedChunks: 0 });
      this.onManualRetry =
        typeof options.onManualRetry === 'function' ? options.onManualRetry : null;

      this.overlayEl =
        options.overlayEl || document.getElementById('network-reconnect-overlay');
      this.spinnerEl =
        options.spinnerEl || document.getElementById('network-reconnect-spinner');
      this.titleEl =
        options.titleEl || document.getElementById('network-reconnect-title');
      this.messageEl =
        options.messageEl || document.getElementById('network-reconnect-message');
      this.dotsEl = options.dotsEl || document.getElementById('network-reconnect-dots');
      this.retryEl = options.retryEl || document.getElementById('network-reconnect-retry');
      this.restoredEl =
        options.restoredEl || document.getElementById('network-reconnect-restored');

      this._probeTimer = null;
      this._showTimer = null;
      this._hideTimer = null;
      this._dotsTimer = null;
      this._running = false;
      this._probeInFlight = false;
      this._displayState = STATES.GOOD;
      this._badStreak = 0;
      this._goodStreak = 0;
      this._silentFailCount = 0;
      this._lostMode = false;
      this._overlayVisible = false;

      this._onOnline = () => {
        this._badStreak = 0;
        void this._runProbe(true);
      };
      this._onOffline = () => {
        this._goodStreak = 0;
        this._badStreak = BAD_STREAK_TO_SHOW;
        if (this._showTimer) {
          clearTimeout(this._showTimer);
          this._showTimer = null;
        }
        this._showOverlay(STATES.RECONNECTING, RECONNECTING_UI());
      };
      this._onRetryClick = () => void this._manualRetry();
    }

    getState() {
      return this._displayState;
    }

    start() {
      if (this._running || !this.token) return;
      this._running = true;
      this._resetCounters();
      this._hideOverlayImmediate();

      window.addEventListener('online', this._onOnline);
      window.addEventListener('offline', this._onOffline);
      this.retryEl?.addEventListener('click', this._onRetryClick);

      void this._runProbe(true);
      this._probeTimer = setInterval(() => {
        if (this._running && this.isCallActive()) void this._runProbe(false);
      }, PROBE_INTERVAL_MS);
    }

    stop() {
      this._running = false;
      clearInterval(this._probeTimer);
      this._probeTimer = null;
      this._clearTimers();
      window.removeEventListener('online', this._onOnline);
      window.removeEventListener('offline', this._onOffline);
      this.retryEl?.removeEventListener('click', this._onRetryClick);
      this._stopDots();
      this._hideOverlayImmediate();
      this._displayState = STATES.GOOD;
    }

    _resetCounters() {
      this._badStreak = 0;
      this._goodStreak = 0;
      this._silentFailCount = 0;
      this._lostMode = false;
    }

    _clearTimers() {
      if (this._showTimer) {
        clearTimeout(this._showTimer);
        this._showTimer = null;
      }
      if (this._hideTimer) {
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
      }
    }

    async _runProbe(urgent) {
      if (!this._running || !this.isCallActive() || this._probeInFlight) return;
      if (this._displayState === STATES.RESTORED) return;

      this._probeInFlight = true;
      try {
        const sample = await this._probeOnce();
        this._handleSample(sample, urgent);
      } finally {
        this._probeInFlight = false;
      }
    }

    async _probeOnce() {
      const uploadFailures = Number(this.getUploadHealth()?.failedChunks) || 0;

      if (!navigator.onLine) {
        return { ok: false, offline: true, rtt: null, uploadFailures };
      }

      const start = performance.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      try {
        const res = await fetch(
          `/interview/${encodeURIComponent(this.token)}/connectivity/ping?_=${Date.now()}`,
          {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          }
        );
        const rtt = performance.now() - start;
        if (!res.ok) {
          return { ok: false, offline: false, rtt, uploadFailures };
        }
        await res.json().catch(() => ({}));
        const slow = rtt > RTT_SLOW_MS;
        const uploadBad = uploadFailures > 0;
        return {
          ok: !slow && !uploadBad,
          offline: false,
          rtt,
          uploadFailures,
          degraded: slow || uploadBad,
        };
      } catch (_) {
        return {
          ok: false,
          offline: !navigator.onLine,
          rtt: null,
          uploadFailures,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    _handleSample(sample, urgent) {
      if (!this._running || !this.isCallActive()) return;
      if (this._displayState === STATES.RESTORED) return;

      const isBad = !sample.ok || sample.offline;

      if (isBad) {
        this._goodStreak = 0;
        this._badStreak += 1;
        this._silentFailCount += 1;

        if (this._lostMode || this._silentFailCount >= MAX_SILENT_PROBES) {
          this._lostMode = true;
          this._showOverlay(STATES.LOST);
          return;
        }

        const threshold = urgent || sample.offline ? 1 : BAD_STREAK_TO_SHOW;
        if (this._badStreak >= threshold) {
          this._scheduleShow(RECONNECTING_UI());
        }
        return;
      }

      this._badStreak = 0;
      this._goodStreak += 1;
      this._silentFailCount = 0;
      this._lostMode = false;

      if (this._showTimer) {
        clearTimeout(this._showTimer);
        this._showTimer = null;
      }

      if (this._overlayVisible && this._goodStreak >= GOOD_STREAK_TO_HIDE) {
        this._showRestoredThenHide();
      }
    }

    _scheduleShow(ui) {
      if (this._overlayVisible && this._displayState !== STATES.LOST) return;
      if (this._showTimer) return;

      this._showTimer = setTimeout(() => {
        this._showTimer = null;
        if (!this._running || !this.isCallActive()) return;
        if (this._badStreak < 1) return;
        this._showOverlay(STATES.RECONNECTING, ui);
      }, SHOW_DEBOUNCE_MS);
    }

    _showOverlay(state, ui = RECONNECTING_UI()) {
      if (!this.overlayEl) return;

      this._clearTimers();
      this._displayState = state;
      this._overlayVisible = true;

      this.overlayEl.classList.remove('is-restored', 'is-lost');
      this.spinnerEl?.classList.remove('d-none');
      this.restoredEl?.classList.add('d-none');
      this.titleEl.textContent = ui.title;
      this.messageEl.textContent = ui.message;
      this.dotsEl.textContent = '';

      if (state === STATES.LOST) {
        this.overlayEl.classList.add('is-lost');
        this.retryEl?.classList.remove('d-none');
      } else {
        this.retryEl?.classList.add('d-none');
      }

      this.overlayEl.classList.remove('d-none');
      this._startDots();
    }

    _showRestoredThenHide() {
      if (!this.overlayEl) return;

      this._clearTimers();
      this._stopDots();
      this._displayState = STATES.RESTORED;

      this.overlayEl.classList.remove('is-lost');
      this.overlayEl.classList.add('is-restored');
      this.spinnerEl?.classList.add('d-none');
      this.retryEl?.classList.add('d-none');
      this.titleEl.textContent = '';
      this.messageEl.textContent = '';
      this.restoredEl?.classList.remove('d-none');
      this.overlayEl.classList.remove('d-none');

      this._hideTimer = setTimeout(() => {
        this._hideTimer = null;
        this._hideOverlayImmediate();
        this._displayState = STATES.GOOD;
        this._resetCounters();
      }, RESTORED_VISIBLE_MS);
    }

    _hideOverlayImmediate() {
      this._clearTimers();
      this._stopDots();
      this._overlayVisible = false;
      this.overlayEl?.classList.add('d-none');
      this.overlayEl?.classList.remove('is-restored', 'is-lost');
      this.spinnerEl?.classList.remove('d-none');
      this.restoredEl?.classList.add('d-none');
      this.retryEl?.classList.add('d-none');
    }

    _startDots() {
      this._stopDots();
      let phase = 0;
      this._dotsTimer = setInterval(() => {
        phase = (phase + 1) % 4;
        if (this.dotsEl) this.dotsEl.textContent = '.'.repeat(phase);
      }, 450);
    }

    _stopDots() {
      if (this._dotsTimer) {
        clearInterval(this._dotsTimer);
        this._dotsTimer = null;
      }
      if (this.dotsEl) this.dotsEl.textContent = '';
    }

    async _manualRetry() {
      if (!this._running || !this.isCallActive()) return;
      this._resetCounters();
      this._lostMode = false;
      this._showOverlay(STATES.RECONNECTING, RECONNECTING_UI());

      try {
        await this.onManualRetry?.();
      } catch (_) {}

      await this._runProbe(true);
    }
  }

  function RECONNECTING_UI() {
    return {
      title: 'Internet connectivity issue detected',
      message: 'Reconnecting',
    };
  }

  return {
    STATES,
    create(options) {
      return new Monitor(options);
    },
  };
})();
