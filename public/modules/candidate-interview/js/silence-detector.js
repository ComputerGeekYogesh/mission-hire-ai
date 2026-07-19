/**
 * Web Audio RMS-based silence detection for end-of-answer.
 * Creates a fresh AudioContext on each start() — never reuse after close().
 */
class SilenceDetector {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.silenceThreshold = options.silenceThreshold ?? 0.01;
    this.silenceDuration = options.silenceDuration ?? 2500;
    this.minRecordingDuration = options.minRecordingDuration ?? 3000;
    this.onSilence = options.onSilence ?? (() => {});
    this.onLevel = options.onLevel ?? null;
    this.onStartFailed = options.onStartFailed ?? null;
    /** Optional shared AudioContext (resumed on user gesture elsewhere). */
    this.sharedAudioContext = options.audioContext ?? null;
    /** Poll byte-frequency average on an interval (for pre/post-answer silence). */
    this.frequencyMonitor = options.frequencyMonitor === true;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.onFrequencyLevel = options.onFrequencyLevel ?? null;
    /** When true, only reports audio levels — never auto-fires onSilence or stops. */
    this.levelMonitorOnly = options.levelMonitorOnly === true;

    this._silenceStart = null;
    this._recordingStart = Date.now();
    this._animFrame = null;
    this._pollInterval = null;
    this._freqData = null;
    this._fired = false;
    this._ownsAudioContext = false;
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
  }

  async start() {
    if (!this.stream) return false;
    this._stopped = false;
    this._fired = false;
    this._recordingStart = Date.now();
    this._silenceStart = null;

    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        this.onStartFailed?.('AudioContext unsupported');
        return false;
      }
      if (this.sharedAudioContext && this.sharedAudioContext.state !== 'closed') {
        this.audioContext = this.sharedAudioContext;
        this._ownsAudioContext = false;
      } else {
        this.audioContext = new Ctor();
        this._ownsAudioContext = true;
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      if (this.audioContext.state !== 'running') {
        console.warn('[SilenceDetector] AudioContext not running:', this.audioContext.state);
        this._teardownNodes();
        this.onStartFailed?.(this.audioContext.state);
        return false;
      }
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.frequencyMonitor ? 512 : 256;
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.source.connect(this.analyser);
      if (this.frequencyMonitor) {
        this._freqData = new Uint8Array(this.analyser.frequencyBinCount);
      }
    } catch (e) {
      console.warn('[SilenceDetector] AudioContext failed:', e.message);
      this._teardownNodes();
      this.onStartFailed?.(e.message);
      return false;
    }

    const buffer = new Float32Array(this.analyser.fftSize);

    if (this.frequencyMonitor && this.onFrequencyLevel) {
      const poll = () => {
        if (this._stopped || !this.analyser) return;
        this.analyser.getByteFrequencyData(this._freqData);
        const avgLevel =
          this._freqData.reduce((s, v) => s + v, 0) / Math.max(1, this._freqData.length);
        if (this.onLevel) this.onLevel(Math.min(1, avgLevel / 255));
        this.onFrequencyLevel(avgLevel);
      };
      poll();
      this._pollInterval = setInterval(poll, this.pollIntervalMs);
    }

    const check = () => {
      if (this._stopped || !this.analyser || this._fired) return;

      this.analyser.getFloatTimeDomainData(buffer);
      const rms = Math.sqrt(buffer.reduce((s, v) => s + v * v, 0) / buffer.length);
      if (this.onLevel) this.onLevel(Math.min(1, rms / 0.15));

      const elapsed = Date.now() - this._recordingStart;

      if (!this.levelMonitorOnly) {
        if (elapsed < this.minRecordingDuration) {
          this._silenceStart = null;
        } else if (rms < this.silenceThreshold) {
          if (!this._silenceStart) this._silenceStart = Date.now();
          else if (Date.now() - this._silenceStart >= this.silenceDuration) {
            this._fired = true;
            this.stop();
            this.onSilence();
            return;
          }
        } else {
          this._silenceStart = null;
        }
      }

      this._animFrame = requestAnimationFrame(check);
    };

    if (!this.frequencyMonitor || !this.onFrequencyLevel) {
      this._animFrame = requestAnimationFrame(check);
    }
    return true;
  }

  _teardownNodes() {
    try {
      this.source?.disconnect();
    } catch (_) {}
    if (this._ownsAudioContext) {
      try {
        if (this.audioContext?.state !== 'closed') {
          this.audioContext.close();
        }
      } catch (_) {}
    }
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
  }

  reset() {
    if (this._fired || this._stopped) return false;
    this._silenceStart = null;
    return true;
  }

  stop() {
    this._stopped = true;
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    this._teardownNodes();
  }
}

window.SilenceDetector = SilenceDetector;
