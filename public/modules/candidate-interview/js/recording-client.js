/**
 * Fault-tolerant incremental session recording upload for interview sessions.
 * Chunks upload continuously during the call; each chunk is persisted to disk on the server.
 */
window.InterviewRecording = (function () {
  const MIN_UPLOAD_BYTES = 200;
  const CHUNK_UPLOAD_RETRIES = 5;
  const CHUNK_UPLOAD_RETRY_MS = [1000, 2000, 4000, 8000, 16000];
  const UPLOAD_DRAIN_TIMEOUT_MS = 60000;
  const MAX_EMERGENCY_BEACON_BYTES = 4 * 1024 * 1024;
  const DEFAULT_TIMESLICE_MS = 5000;

  function recordingTrace(step, meta = {}) {
    if (!window.INTERVIEW_RECORDING_TRACE) return;
    console.log('[recording-trace]', step, meta);
  }
  const VIDEO_BITS_PER_SECOND = 800_000;
  const AUDIO_BITS_PER_SECOND = 64_000;

  function videoMimeCandidates(includeAudio) {
    if (includeAudio) {
      return [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        '',
      ];
    }
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', ''];
  }

  function buildRecorderOptions(mime) {
    const options = {};
    if (mime && MediaRecorder.isTypeSupported(mime)) {
      options.mimeType = mime;
      options.videoBitsPerSecond = VIDEO_BITS_PER_SECOND;
      options.audioBitsPerSecond = AUDIO_BITS_PER_SECOND;
    }
    return options;
  }

  function pickVideoMime(includeAudio = false) {
    for (const mime of videoMimeCandidates(includeAudio)) {
      if (!mime || MediaRecorder.isTypeSupported(mime)) return mime || 'video/webm';
    }
    return 'video/webm';
  }

  function pickAudioMime() {
    for (const t of ['audio/webm;codecs=opus', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'audio/webm';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class UploadQueue {
    constructor(concurrency = 1) {
      this.concurrency = concurrency;
      this.running = 0;
      this.queue = [];
      this.inFlight = 0;
    }

    add(task) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task, resolve, reject });
        this.pump();
      });
    }

    pump() {
      while (this.running < this.concurrency && this.queue.length) {
        const item = this.queue.shift();
        this.running += 1;
        this.inFlight += 1;
        Promise.resolve()
          .then(() => item.task())
          .then(item.resolve, item.reject)
          .finally(() => {
            this.running -= 1;
            this.inFlight -= 1;
            this.pump();
          });
      }
    }

    drain(timeoutMs = UPLOAD_DRAIN_TIMEOUT_MS) {
      const started = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          if (this.running === 0 && this.queue.length === 0) {
            resolve(true);
            return;
          }
          if (Date.now() - started >= timeoutMs) {
            resolve(false);
            return;
          }
          setTimeout(tick, 100);
        };
        tick();
      });
    }

    get pending() {
      return this.queue.length + this.inFlight;
    }
  }

  class SessionVideoRecorder {
    constructor(token, { sessionId, onLog, onError, timesliceMs = DEFAULT_TIMESLICE_MS } = {}) {
      this.token = token;
      this.sessionId = sessionId || window.INTERVIEW_SESSION_ID || null;
      this.onLog = onLog || (() => {});
      this.onError = onError || (() => {});
      this.timesliceMs = timesliceMs;
      this.chunkIndex = 0;
      this.totalChunksExpected = 0;
      this.uploadQueue = new UploadQueue(1);
      this.recorder = null;
      this.mime = pickVideoMime(true);
      this.heartbeat = null;
      this.totalBytes = 0;
      this.chunkCount = 0;
      this.ackedChunkCount = 0;
      this.lastChunkAt = 0;
      this.lastAckAt = 0;
      this.localParts = [];
      this.ackedIndices = new Set();
      this.failedIndices = new Set();
      this.stopping = false;
    }

    setToken(nextToken) {
      if (!nextToken) return;
      this.token = nextToken;
    }

    setSessionId(nextSessionId) {
      if (!nextSessionId) return;
      this.sessionId = nextSessionId;
    }

    start(mediaStream) {
      if (!mediaStream) throw new Error('No media stream for video recording');
      if (this.recorder?.state === 'recording') return;

      const tracks = mediaStream.getTracks().filter((t) => t.readyState === 'live');
      if (!tracks.length) {
        throw new Error('Camera stream is not active. Refresh the page and allow camera access.');
      }

      const hasAudio = mediaStream.getAudioTracks().some((t) => t.readyState === 'live');
      const streamsToTry = [mediaStream];
      if (!hasAudio) {
        const videoOnly = new MediaStream(mediaStream.getVideoTracks());
        if (videoOnly.getVideoTracks().length) streamsToTry.push(videoOnly);
      }

      this.localParts = [];
      this.ackedIndices.clear();
      this.failedIndices.clear();
      this.totalChunksExpected = 0;
      let lastErr = null;

      for (const stream of streamsToTry) {
        const withAudio = stream === mediaStream && hasAudio;
        for (const mime of videoMimeCandidates(withAudio)) {
          try {
            const options = buildRecorderOptions(mime);
            this.recorder = new MediaRecorder(stream, options);
            this.mime = mime || this.recorder.mimeType || 'video/webm';
            console.log('[recording-client] Using codec:', this.mime, '| video bitrate:', VIDEO_BITS_PER_SECOND / 1000, 'Kbps');
            this.recorder.ondataavailable = (e) => {
              if (!e.data || e.data.size === 0) return;
              const partIndex = this.localParts.length;
              this.localParts.push(e.data);
              this.lastChunkAt = Date.now();
              this.totalChunksExpected = Math.max(this.totalChunksExpected, partIndex + 1);
              window.InterviewIntegrityMonitor?.markRecordingChunk?.();
              console.log(
                `[recording-client] chunk ${partIndex} created (${e.data.size} bytes, total parts: ${this.localParts.length})`
              );
              recordingTrace('chunk_created', {
                index: partIndex,
                bytes: e.data.size,
                total_parts: this.localParts.length,
              });
              if (e.data.size >= MIN_UPLOAD_BYTES) {
                this.enqueueChunk(e.data, partIndex);
              } else {
                console.warn(
                  `[recording-client] chunk ${partIndex} below upload threshold (${e.data.size} < ${MIN_UPLOAD_BYTES}) — will flush on stop`
                );
              }
            };
            this.recorder.onerror = () => this.onError('Video recorder error');
            this.recorder.start(this.timesliceMs);
            this.heartbeat = setInterval(() => {
              if (this.recorder?.state === 'recording') {
                try {
                  this.recorder.requestData();
                } catch (_) {}
              }
            }, this.timesliceMs);
            this.onLog(
              withAudio
                ? 'Session recording started (5s disk chunk upload active)'
                : 'Session recording started — camera only (5s disk chunk upload active)'
            );
            return;
          } catch (err) {
            lastErr = err;
            this.recorder = null;
          }
        }
      }

      throw new Error(
        lastErr?.message ||
          'Could not start video recorder. Use Chrome or Edge, close other apps using the camera, and refresh.'
      );
    }

    _buildChunkFormData(index, blob, { emergency = false } = {}) {
      const typed = blob.type ? blob : new Blob([blob], { type: this.mime });
      const fd = new FormData();
      fd.append('recording', typed, `chunk_${String(index).padStart(3, '0')}.webm`);
      fd.append('session_id', String(this.sessionId || ''));
      fd.append('chunk_index', String(index));
      fd.append('total_chunks_expected', String(Math.max(this.totalChunksExpected, index + 1)));
      fd.append('mime_type', this.mime || 'video/webm');
      if (emergency) {
        fd.append('emergency', 'true');
        fd.append('flush', 'true');
      }
      return fd;
    }

    async _uploadChunkOnce(index, blob, { emergency = false } = {}) {
      const typed = blob.type ? blob : new Blob([blob], { type: this.mime });
      console.log(
        `[recording-client] chunk ${index} upload started (${typed.size} bytes${emergency ? ', emergency' : ''})`
      );
      const fd = this._buildChunkFormData(index, typed, { emergency });
      const res = await fetch(`/interview/${this.token}/recording`, {
        method: 'POST',
        body: fd,
        keepalive: emergency,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(
          `[recording-client] chunk ${index} upload failed (${res.status}):`,
          data.error || res.statusText
        );
        throw new Error(data.error || `Chunk ${index} upload failed (${res.status})`);
      }

      if (!data.skipped) {
        this.totalBytes += data.bytes || typed.size;
        this.chunkCount += 1;
        this.ackedChunkCount += 1;
        this.lastAckAt = Date.now();
        this.ackedIndices.add(index);
        this.failedIndices.delete(index);
        console.log(
          `[recording-client] chunk ${index} upload acked (${typed.size} bytes, acked: ${this.ackedChunkCount}/${this.localParts.length})`
        );
        recordingTrace('chunk_upload_acked', {
          index,
          bytes: typed.size,
          acked: this.ackedChunkCount,
          parts: this.localParts.length,
        });
      }

      return data;
    }

    async _uploadChunkWithRetry(index, blob, { emergency = false } = {}) {
      let lastErr = null;
      for (let attempt = 0; attempt < CHUNK_UPLOAD_RETRIES; attempt += 1) {
        try {
          return await this._uploadChunkOnce(index, blob, { emergency });
        } catch (err) {
          lastErr = err;
          console.warn(
            `[recording-client] chunk ${index} upload failed (attempt ${attempt + 1}/${CHUNK_UPLOAD_RETRIES}):`,
            err.message || err
          );
          if (attempt < CHUNK_UPLOAD_RETRIES - 1) {
            const delay = CHUNK_UPLOAD_RETRY_MS[attempt] || 1000;
            console.log(`[recording-client] chunk ${index} retry in ${delay}ms`);
            await sleep(delay);
          }
        }
      }
      this.failedIndices.add(index);
      this.onError(lastErr?.message || `Chunk ${index} upload failed after retries`);
      throw lastErr;
    }

    async retryFailedChunks() {
      const failed = [...this.failedIndices];
      if (!failed.length) return { retried: 0, recovered: 0 };

      console.log(`[recording-client] Retrying ${failed.length} failed chunk(s): ${failed.join(', ')}`);
      let recovered = 0;
      for (const index of failed) {
        const blob = this.localParts[index];
        if (!blob || blob.size < MIN_UPLOAD_BYTES) continue;
        try {
          await this._uploadChunkWithRetry(index, blob, { emergency: true });
          recovered += 1;
        } catch (_) {}
      }
      console.log(
        `[recording-client] Failed chunk retry complete — recovered ${recovered}/${failed.length}, still failed: ${this.failedIndices.size}`
      );
      return { retried: failed.length, recovered };
    }

    enqueueChunk(blob, partIndex = null) {
      const index = partIndex != null ? partIndex : this.chunkIndex++;
      this.chunkIndex = Math.max(this.chunkIndex, index + 1);
      this.totalChunksExpected = Math.max(this.totalChunksExpected, this.chunkIndex);
      return this.uploadQueue
        .add(() => this._uploadChunkWithRetry(index, blob))
        .catch((err) => {
          console.error(`[recording-client] chunk ${index} queue upload failed:`, err?.message || err);
        });
    }

    _sendBeaconChunk(index, blob) {
      if (!navigator.sendBeacon || blob.size > MAX_EMERGENCY_BEACON_BYTES) return false;
      try {
        const fd = this._buildChunkFormData(index, blob, { emergency: true });
        return navigator.sendBeacon(`/interview/${this.token}/recording`, fd);
      } catch (_) {
        return false;
      }
    }

    async flushPending() {
      if (this.recorder?.state === 'recording') {
        try {
          this.recorder.requestData();
        } catch (_) {}
        await sleep(300);
        try {
          this.recorder.requestData();
        } catch (_) {}
        await sleep(200);
      }

      for (let i = 0; i < this.localParts.length; i += 1) {
        const blob = this.localParts[i];
        if (!blob || blob.size < MIN_UPLOAD_BYTES || this.ackedIndices.has(i)) continue;
        this.chunkIndex = Math.max(this.chunkIndex, i + 1);
        this.totalChunksExpected = Math.max(this.totalChunksExpected, this.chunkIndex);
        await this.uploadQueue
          .add(() => this._uploadChunkWithRetry(i, blob, { emergency: true }))
          .catch(() => {});
      }
      await this.uploadQueue.drain(8000);
    }

    emergencyFlush() {
      if (this.recorder?.state === 'recording') {
        try {
          this.recorder.requestData();
        } catch (_) {}
      }

      let sent = 0;
      for (let i = 0; i < this.localParts.length; i += 1) {
        const blob = this.localParts[i];
        if (!blob || blob.size < MIN_UPLOAD_BYTES || this.ackedIndices.has(i)) continue;
        if (this._sendBeaconChunk(i, blob)) {
          sent += 1;
          // Do not mark acked — sendBeacon delivery is not confirmed by the server.
        }
      }
      if (sent > 0) {
        console.log(`[recording-client] emergencyFlush sent ${sent} chunk(s) via sendBeacon`);
      }
    }

    async endRecording() {
      const totalChunksSent = this.localParts.length || this.chunkIndex;
      this.totalChunksExpected = Math.max(this.totalChunksExpected, totalChunksSent);
      const payload = {
        session_id: this.sessionId,
        total_chunks_sent: totalChunksSent,
        total_chunks_acked: this.ackedChunkCount,
        failed_chunk_indexes: [...this.failedIndices],
        upload_complete: this.failedIndices.size === 0 && this.uploadQueue.pending === 0,
      };
      recordingTrace('end_recording_request', payload);
      console.log('[recording-client] signaling recording end', payload);
      const res = await fetch(`/interview/${this.token}/recording/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Recording end failed (${res.status})`);
      }
      recordingTrace('end_recording_ack', { totalChunksSent, acked: this.ackedChunkCount, data });
      this.onLog(
        `Recording finalize scheduled (${totalChunksSent} parts, ${this.ackedChunkCount} acked, ${this.failedIndices.size} failed)`
      );
      return data;
    }

    async stop() {
      if (this.stopping) {
        await this.uploadQueue.drain();
        return this.getStats();
      }
      this.stopping = true;

      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }

      await new Promise((resolve) => {
        if (!this.recorder || this.recorder.state === 'inactive') {
          resolve();
          return;
        }
        const prevOnStop = this.recorder.onstop;
        this.recorder.onstop = (ev) => {
          if (typeof prevOnStop === 'function') prevOnStop.call(this.recorder, ev);
          resolve();
        };
        try {
          this.recorder.requestData();
        } catch (_) {}
        setTimeout(() => {
          try {
            this.recorder.requestData();
          } catch (_) {}
          setTimeout(() => {
            try {
              this.recorder.requestData();
            } catch (_) {}
            setTimeout(() => {
              if (this.recorder?.state === 'recording') this.recorder.stop();
              else resolve();
            }, 600);
          }, 500);
        }, 400);
      });

      await this.flushPending();
      await this.retryFailedChunks();

      // Drain all in-flight uploads BEFORE telling the server recording is complete.
      let drained = await this.uploadQueue.drain(UPLOAD_DRAIN_TIMEOUT_MS);
      if (!drained) {
        console.warn('[recording-client] Upload queue not drained — retrying failed chunks once more');
        await this.retryFailedChunks();
        drained = await this.uploadQueue.drain(UPLOAD_DRAIN_TIMEOUT_MS);
      }

      if (this.failedIndices.size > 0) {
        console.error(
          `[recording-client] Unrecoverable failed chunks after drain: ${[...this.failedIndices].join(', ')}`
        );
      }
      if (!drained) {
        this.onError(
          `Recording uploads incomplete (${this.uploadQueue.pending} pending, ${this.failedIndices.size} failed)`
        );
      }

      recordingTrace('stop_pre_end', this.getStats());

      try {
        await this.endRecording();
      } catch (err) {
        this.onError(err.message || 'Recording end notification failed');
      }

      const stats = this.getStats();
      recordingTrace('stop_complete', stats);
      console.log(
        `[recording-client] Session recording stopped — parts=${stats.parts} acked=${stats.ackedChunkCount} failed=${stats.failedCount} bytes=${stats.totalBytes}`
      );
      this.onLog(
        `Session recording stopped (${stats.ackedChunkCount} chunks saved, ${stats.failedCount} failed)`
      );
      return stats;
    }

    getStats() {
      return {
        chunkCount: this.chunkCount,
        ackedChunkCount: this.ackedChunkCount,
        failedCount: this.failedIndices.size,
        failedIndexes: [...this.failedIndices],
        totalBytes: this.totalBytes,
        parts: this.localParts.length,
        totalChunksSent: this.localParts.length || this.chunkIndex,
        lastChunkAt: this.lastChunkAt,
        lastAckAt: this.lastAckAt,
        pendingUploads: this.uploadQueue.pending,
      };
    }
  }

  class AnswerAudioRecorder {
    constructor() {
      this.stream = null;
      this.chunks = [];
      this.recorder = null;
      this.mime = pickAudioMime();
      this.startedAt = 0;
    }

    start(audioStream) {
      this.stopSync();
      this.stream = audioStream;
      if (!this.stream?.getAudioTracks?.().length) {
        throw new Error('No microphone available for answer recording');
      }

      this.chunks = [];
      this.startedAt = Date.now();
      const mimes = [this.mime, 'audio/webm', ''];
      let started = false;
      for (const mime of mimes) {
        try {
          const options = mime && MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : {};
          this.recorder = new MediaRecorder(this.stream, options);
          this.mime = mime || this.recorder.mimeType || 'audio/webm';
          this.recorder.ondataavailable = (e) => {
            if (e.data?.size) this.chunks.push(e.data);
          };
          this.recorder.start(200);
          started = true;
          break;
        } catch (_) {
          this.recorder = null;
        }
      }
      if (!started) throw new Error('Could not start answer microphone recorder');
    }

    stopSync() {
      if (this.recorder?.state === 'recording') {
        try {
          this.recorder.stop();
        } catch (_) {}
      }
      this.recorder = null;
      this.stream?.getTracks?.().forEach((t) => {
        try {
          t.stop();
        } catch (_) {}
      });
      this.stream = null;
    }

    async stop() {
      const elapsed = Date.now() - this.startedAt;
      return new Promise((resolve, reject) => {
        if (!this.recorder || this.recorder.state === 'inactive') {
          resolve({ blob: null, elapsed });
          return;
        }
        let settled = false;
        const finish = (blob) => {
          if (settled) return;
          settled = true;
          resolve({ blob, elapsed });
        };
        this.recorder.onstop = () => {
          const blob = new Blob(this.chunks, { type: this.mime });
          this.chunks = [];
          this.recorder = null;
          this.stream?.getTracks?.().forEach((t) => {
            try {
              t.stop();
            } catch (_) {}
          });
          this.stream = null;
          finish(blob.size > 0 ? blob : null);
        };
        try {
          this.recorder.requestData();
        } catch (_) {}
        setTimeout(() => {
          if (this.recorder?.state === 'recording') this.recorder.stop();
        }, 350);
        setTimeout(() => {
          if (!settled) reject(new Error('Answer recording stop timeout'));
        }, 8000);
      });
    }

    async upload(token, questionId, blob) {
      const fd = new FormData();
      fd.append('question_id', String(questionId));
      fd.append('answer_audio', blob, `answer_q${questionId}.webm`);
      const res = await fetch(`/interview/${token}/call/answer`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Answer upload failed');
      return data;
    }
  }

  return { SessionVideoRecorder, AnswerAudioRecorder, pickAudioMime };
})();
