(function () {
  window.InterviewVoice?.ensureVoicesLoaded?.();

  const token = window.INTERVIEW_TOKEN;
  const video = document.getElementById('preflight-video');
  const btn = document.getElementById('btn-complete-preflight');
  const msg = document.getElementById('preflight-msg');
  const chkCamera = document.getElementById('chk-camera');
  const chkMic = document.getElementById('chk-mic');
  const chkFace = document.getElementById('chk-face');
  const chkHeadphones = document.getElementById('chk-headphones');
  const headphoneDeviceList = document.getElementById('headphone-device-list');
  const hpOutputSelect = document.getElementById('hp-output-select');
  const hpSetupPanel = document.getElementById('hp-setup-panel');
  const hpNoHeadphonesError = document.getElementById('hp-no-headphones-error');
  const hpPlayTestTone = document.getElementById('hp-play-test-tone');
  const hpToneConfirm = document.getElementById('hp-tone-confirm');
  const hpToneYes = document.getElementById('hp-tone-yes');
  const livePip = document.getElementById('preflight-live-pip');
  const mediaChecking = document.getElementById('preflight-media-checking');
  const mediaErrorPanel = document.getElementById('preflight-media-error');
  const mediaErrorTitle = document.getElementById('preflight-media-error-title');
  const mediaErrorBody = document.getElementById('preflight-media-error-body');
  const mediaErrorHint = document.getElementById('preflight-media-error-hint');
  const mediaRetryBtn = document.getElementById('preflight-media-retry');
  const audioMeter = document.getElementById('preflight-audio-meter');
  const audioMeterFill = document.getElementById('preflight-audio-meter-fill');

  const HEADPHONE_POLL_MS = 4000;
  const DEVICE_CHANGE_DEBOUNCE_MS = 1500;

  const mediaCheck = () => window.PreflightMediaCheck;
  const STATES = () => mediaCheck()?.VERIFICATION_STATE || {};

  let stream = null;
  let faceOk = false;
  let cameraOk = false;
  let micOk = false;
  let headphonesVerified = false;
  let headphoneDeviceLabel = '';
  let headphonePollTimer = null;
  let deviceChangeTimer = null;
  let faceMesh = null;
  let verifiedFaceSignature = '';
  let tonePlayedForDeviceId = '';
  let headphoneLeakagePassed = false;
  let selectedOutputId = '';
  let lastHeadphoneDevices = [];
  let lastHeadphoneDeviceCount = 0;
  let preflightUnlocked = false;
  let mediaVerificationState = 'checking';
  let mediaCheckInFlight = false;
  let audioMeterCtx = null;
  let audioMeterSource = null;
  let audioMeterAnim = null;

  const faceStabilizer = window.InterviewFaceDetect?.createStabilizer?.() || null;
  const announced = { camera: null, mic: null, face: null, headphones: null };

  const hpDetect = () => window.InterviewHeadphoneDetect;

  function statusOkHtml() {
    return (
      '<span class="preflight-check-icon"><i class="bi bi-check" aria-hidden="true"></i></span> OK'
    );
  }

  function speakStatus(key, label, ok, detail) {
    if (announced[key] === ok && !detail) return;
    announced[key] = ok;
    window.InterviewVoice?.speak(detail || `${label}: ${ok ? 'OK' : 'pending'}`);
  }

  function releaseMediaStream() {
    stopAudioMeter();
    if (stream) {
      mediaCheck()?.stopMediaStream?.(stream);
      stream = null;
    }
    if (video) video.srcObject = null;
  }

  function stopAudioMeter() {
    if (audioMeterAnim) cancelAnimationFrame(audioMeterAnim);
    audioMeterAnim = null;
    try {
      audioMeterSource?.disconnect();
    } catch (_) {}
    audioMeterSource = null;
    try {
      if (audioMeterCtx?.state !== 'closed') audioMeterCtx.close();
    } catch (_) {}
    audioMeterCtx = null;
    if (audioMeterFill) audioMeterFill.style.width = '0%';
    audioMeter?.classList.add('d-none');
  }

  function startAudioMeter(activeStream) {
    stopAudioMeter();
    if (!activeStream || !audioMeter || !audioMeterFill) return;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      audioMeterCtx = new AudioContextCtor();
      audioMeterSource = audioMeterCtx.createMediaStreamSource(activeStream);
      const analyser = audioMeterCtx.createAnalyser();
      analyser.fftSize = 256;
      audioMeterSource.connect(analyser);
      audioMeter.classList.remove('d-none');

      const buffer = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!audioMeterCtx || audioMeterCtx.state === 'closed') return;
        analyser.getFloatTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          peak = Math.max(peak, Math.abs(buffer[i]));
        }
        audioMeterFill.style.width = `${Math.min(100, Math.round(peak * 400))}%`;
        audioMeterAnim = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) {
      stopAudioMeter();
    }
  }

  function setMediaUiState(state) {
    mediaVerificationState = state;
    const S = STATES();
    const isChecking = state === S.CHECKING || state === 'checking';
    const isSuccess = state === S.SUCCESS;
    const isError = state && state.startsWith('error_');

    mediaChecking?.classList.toggle('d-none', !isChecking);
    mediaErrorPanel?.classList.toggle('d-none', !isError);
    livePip?.classList.toggle('d-none', !isSuccess);

    if (isError && mediaCheck()?.getMessageForState) {
      const copy = mediaCheck().getMessageForState(state);
      if (mediaErrorTitle) mediaErrorTitle.textContent = copy.title;
      if (mediaErrorBody) mediaErrorBody.textContent = copy.body;
      if (mediaErrorHint) {
        if (copy.hint) {
          mediaErrorHint.textContent = copy.hint;
          mediaErrorHint.classList.remove('d-none');
        } else {
          mediaErrorHint.textContent = '';
          mediaErrorHint.classList.add('d-none');
        }
      }
    }

    if (!isSuccess) {
      cameraOk = false;
      micOk = false;
      faceOk = false;
      setCheck(chkCamera, false, 'Camera', 'camera');
      setCheck(chkMic, false, 'Microphone', 'mic');
      setCheck(chkFace, false, 'Face detected', 'face');
    }
    updateBtn();
  }

  function buildFaceSignature(landmarks) {
    if (!landmarks?.length) return '';
    const nose = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const chin = landmarks[152];
    const forehead = landmarks[10];
    const leftCheek = landmarks[234];
    const rightCheek = landmarks[454];
    if (!nose || !leftEye || !rightEye || !chin || !forehead || !leftCheek || !rightCheek) return '';

    const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
    const faceHeight = Math.abs(chin.y - forehead.y);
    if (!eyeDist || !faceHeight) return '';

    const midEyeX = (leftEye.x + rightEye.x) / 2;
    const midEyeY = (leftEye.y + rightEye.y) / 2;
    const yaw = (nose.x - midEyeX) / eyeDist;
    const pitch = (nose.y - midEyeY) / faceHeight;
    const cheekRatio =
      Math.hypot(rightCheek.x - leftCheek.x, rightCheek.y - leftCheek.y) / eyeDist;
    const noseToChin = Math.hypot(chin.x - nose.x, chin.y - nose.y) / faceHeight;

    return [yaw, pitch, cheekRatio, noseToChin].map((n) => Number(n).toFixed(4)).join(',');
  }

  function setCheck(el, ok, label, key, detail) {
    const valEl = el?.querySelector('[data-status-val]');
    if (valEl) {
      el.classList.toggle('ok', ok);
      el.classList.toggle('fail', !ok);
      if (key === 'headphones') {
        if (ok) {
          valEl.className = 'preflight-status-val val-ok';
          valEl.innerHTML = statusOkHtml();
          if (headphoneDeviceLabel) el.setAttribute('title', headphoneDeviceLabel);
        } else {
          valEl.className = 'preflight-status-val val-warn';
          valEl.textContent = detail?.includes('not detected') ? 'not detected' : 'pending';
          el.removeAttribute('title');
        }
      } else if (ok) {
        valEl.className = 'preflight-status-val val-ok';
        valEl.innerHTML = statusOkHtml();
      } else {
        valEl.className = 'preflight-status-val val-pending';
        valEl.textContent = detail?.includes('failed') ? 'failed' : 'pending';
      }
    }
    if (key === 'camera' && ok) livePip?.classList.remove('d-none');
    if (key === 'headphones') speakStatus(key, label, ok, detail || null);
  }

  function resetHeadphoneValidation() {
    headphonesVerified = false;
    headphoneLeakagePassed = false;
    tonePlayedForDeviceId = '';
    hpToneConfirm?.classList.add('d-none');
    if (hpToneYes) hpToneYes.disabled = true;
    if (hpPlayTestTone) hpPlayTestTone.disabled = !selectedOutputId;
  }

  function setContinueLocked(locked) {
    preflightUnlocked = !locked;
    if (!btn) return;
    btn.disabled = locked;
    btn.classList.toggle('is-locked', locked);
    btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
  }

  function updateBtn() {
    const hpReady =
      headphonesVerified &&
      headphoneLeakagePassed &&
      tonePlayedForDeviceId &&
      selectedOutputId &&
      tonePlayedForDeviceId === selectedOutputId &&
      hpDetect()?.isAcceptableHeadphoneOutput(headphoneDeviceLabel);

    const ready = cameraOk && micOk && faceOk && hpReady;
    setContinueLocked(!ready);
  }

  function showNoHeadphonesError(show) {
    hpNoHeadphonesError?.classList.toggle('d-none', !show);
    hpSetupPanel?.classList.toggle('d-none', show);
    if (show) {
      resetHeadphoneValidation();
      selectedOutputId = '';
      headphoneDeviceLabel = '';
      if (hpOutputSelect) {
        hpOutputSelect.innerHTML = '<option value="">No headphone devices found</option>';
        hpOutputSelect.disabled = true;
      }
      if (headphoneDeviceList) {
        headphoneDeviceList.innerHTML =
          '<li class="preflight-device-item inactive"><span class="preflight-device-dot off"></span>No headphone devices detected</li>';
      }
      if (hpPlayTestTone) hpPlayTestTone.disabled = true;
      setCheck(chkHeadphones, false, 'Headphones', 'headphones', 'Headphones: not detected');
    }
    updateBtn();
  }

  function renderHeadphoneDevices(headphoneDevices) {
    const detect = hpDetect();
    lastHeadphoneDevices = headphoneDevices;

    if (hpOutputSelect) {
      hpOutputSelect.disabled = !headphoneDevices.length;
      hpOutputSelect.innerHTML = headphoneDevices.length
        ? headphoneDevices
            .map((d) => {
              const label = detect?.formatOutputLabel(d) || d.label;
              const sel = d.deviceId === selectedOutputId ? ' selected' : '';
              return `<option value="${d.deviceId}"${sel}>${label}</option>`;
            })
            .join('')
        : '<option value="">No headphone devices found</option>';
    }

    if (headphoneDeviceList) {
      headphoneDeviceList.innerHTML = headphoneDevices.length
        ? headphoneDevices
            .map((d) => {
              const label = detect?.formatOutputLabel(d) || d.label;
              const isSelected = d.deviceId === selectedOutputId;
              return `<li class="preflight-device-item active${isSelected ? ' is-selected' : ''}" data-device-id="${d.deviceId}" role="button" tabindex="0">
              <span class="preflight-device-dot ok"></span>
              ${label}
              ${isSelected ? '<span class="preflight-device-check"><i class="bi bi-check" aria-hidden="true"></i></span>' : ''}
            </li>`;
            })
            .join('')
        : '';
    }
  }

  async function checkHeadphones() {
    const detect = hpDetect();
    let headphoneDevices = [];

    try {
      headphoneDevices = (await detect?.enumerateHeadphoneOutputs(stream)) || [];
    } catch (e) {
      msg.textContent = 'Could not list audio devices: ' + e.message;
      showNoHeadphonesError(true);
      return;
    }

    if (!headphoneDevices.length) {
      showNoHeadphonesError(true);
      msg.textContent =
        'No headphones detected. Connect wired/USB headphones, or use Chrome/Edge if Bluetooth (e.g. AirPods) is connected but not listed here.';
      return;
    }

    hpNoHeadphonesError?.classList.add('d-none');
    hpSetupPanel?.classList.remove('d-none');

    if (
      headphonesVerified &&
      lastHeadphoneDeviceCount &&
      lastHeadphoneDeviceCount !== headphoneDevices.length
    ) {
      resetHeadphoneValidation();
      selectedOutputId = '';
      headphoneDeviceLabel = '';
      msg.textContent =
        'Headphone device changed. Reconnect your headset and complete verification again.';
      setCheck(chkHeadphones, false, 'Headphones', 'headphones', 'Headphones: pending verification');
    }
    lastHeadphoneDeviceCount = headphoneDevices.length;

    if (!msg.textContent) msg.textContent = '';

    const selectedStillValid = headphoneDevices.find((d) => d.deviceId === selectedOutputId);
    if (
      headphonesVerified &&
      (!selectedStillValid || !detect?.isAcceptableHeadphoneOutput(selectedStillValid.label))
    ) {
      headphonesVerified = false;
      resetHeadphoneValidation();
      selectedOutputId = '';
      headphoneDeviceLabel = '';
      msg.textContent =
        'Headphones disconnected. Reconnect your headphones and complete the test tone again.';
      setCheck(chkHeadphones, false, 'Headphones', 'headphones', 'Headphones: not detected');
    }

    const stillPresent = headphoneDevices.some((d) => d.deviceId === selectedOutputId);
    if (!stillPresent) {
      selectedOutputId = headphoneDevices[0].deviceId;
      headphoneDeviceLabel = detect?.formatOutputLabel(headphoneDevices[0]) || '';
      resetHeadphoneValidation();
      if (headphonesVerified) {
        msg.textContent =
          'Headphones disconnected. Reconnect your headphones and complete the test tone again.';
      }
    }

    renderHeadphoneDevices(headphoneDevices);

    const hasComboJack = headphoneDevices.some((d) =>
      /speaker\s*\+\s*headphones?/i.test(d.label || '')
    );
    if (hasComboJack && !headphonesVerified) {
      msg.textContent =
        'Select "Speaker + Headphones" (not Speakers only), play the test tone, and confirm you hear it in your wired headset.';
    }

    if (hpPlayTestTone) {
      hpPlayTestTone.disabled = !selectedOutputId;
    }

    if (!headphonesVerified) {
      setCheck(chkHeadphones, false, 'Headphones', 'headphones', 'Headphones: pending verification');
    }

    updateBtn();
  }

  function selectOutputDevice(id) {
    const detect = hpDetect();
    const device = lastHeadphoneDevices.find((d) => d.deviceId === id);
    if (!device || !detect?.isAcceptableHeadphoneOutput(device.label)) return;

    selectedOutputId = id;
    headphoneDeviceLabel = detect.formatOutputLabel(device) || device.label || '';
    resetHeadphoneValidation();
    msg.textContent = 'Play the test tone and confirm you heard it in your headphones.';
    if (hpOutputSelect) hpOutputSelect.value = id;
    renderHeadphoneDevices(lastHeadphoneDevices);
    updateBtn();
  }

  function startHeadphoneMonitor() {
    stopHeadphoneMonitor();
    checkHeadphones();
    headphonePollTimer = setInterval(checkHeadphones, HEADPHONE_POLL_MS);
    navigator.mediaDevices?.addEventListener('devicechange', onAudioDeviceChange);
  }

  function stopHeadphoneMonitor() {
    if (headphonePollTimer) clearInterval(headphonePollTimer);
    headphonePollTimer = null;
    if (deviceChangeTimer) clearTimeout(deviceChangeTimer);
    deviceChangeTimer = null;
    navigator.mediaDevices?.removeEventListener('devicechange', onAudioDeviceChange);
  }

  function onAudioDeviceChange() {
    clearTimeout(deviceChangeTimer);
    deviceChangeTimer = setTimeout(() => {
      const wasVerified = headphonesVerified || headphoneLeakagePassed;
      checkHeadphones().then(() => {
        if (wasVerified && (!headphonesVerified || !headphoneLeakagePassed)) {
          msg.textContent =
            'Headphones disconnected or changed. Reconnect your headset and complete verification again.';
        }
      });
    }, DEVICE_CHANGE_DEBOUNCE_MS);
  }

  async function runMediaVerification({ manualRetry = false } = {}) {
    if (mediaCheckInFlight) return;

    const check = mediaCheck();
    if (!check?.verifyCameraMic) {
      console.error('[Preflight] PreflightMediaCheck not available');
      setMediaUiState(STATES().ERROR_GENERIC || 'error_generic');
      if (mediaErrorTitle) {
        mediaErrorTitle.textContent = 'Device check failed to start';
      }
      if (mediaErrorBody) {
        mediaErrorBody.textContent =
          'The camera/microphone verification module did not load. Please refresh the page and try again.';
      }
      mediaErrorPanel?.classList.remove('d-none');
      msg.textContent = 'Refresh the page. If Teams, Zoom, or another app is using your camera, close it first.';
      return;
    }

    mediaCheckInFlight = true;
    msg.textContent = '';
    releaseMediaStream();
    setMediaUiState(STATES().CHECKING || 'checking');

    console.log('[Preflight] media verification started', { manualRetry });

    try {
      const result = await mediaCheck().verifyCameraMic({
        videoEl: video,
        autoRetryOnce: !manualRetry,
        autoRetryDelayMs: 2000,
      });

      console.log('[Preflight] media verification result', {
        ok: result.ok,
        state: result.state,
        reason: result.reason,
        autoRetried: result.autoRetried,
      });

      if (!result.ok) {
        setMediaUiState(result.state);
        mediaErrorPanel?.classList.remove('d-none');
        if (result.autoRetried) {
          msg.textContent =
            'Still unable to access your camera or microphone after retrying. Close Teams, Zoom, OBS, or other apps using your camera/mic, then click Retry.';
        } else if (result.state === STATES().ERROR_DEVICE_IN_USE) {
          msg.textContent =
            'Close Microsoft Teams, Zoom, or any other app using your camera or microphone, then click Retry.';
        }
        return;
      }

      stream = result.stream;
      setMediaUiState(STATES().SUCCESS);
      cameraOk = true;
      micOk = stream.getAudioTracks().some((t) => t.enabled && t.readyState === 'live');
      setCheck(chkCamera, true, 'Camera', 'camera');
      setCheck(chkMic, micOk, 'Microphone', 'mic');
      startAudioMeter(stream);
      startHeadphoneMonitor();
      initFaceMesh();
      startSnapshots();

      if (result.audioWarning) {
        msg.textContent = result.audioWarning;
      }

      window.InterviewVoice?.speak(
        'Camera and microphone check passed. Connect your USB or wired headphones, then play the test tone.'
      );
    } catch (e) {
      console.error('[Preflight] media verification error', e);
      setMediaUiState(STATES().ERROR_GENERIC || 'error_generic');
      msg.textContent = e.message || 'Could not verify camera or microphone.';
    } finally {
      mediaCheckInFlight = false;
      updateBtn();
    }
  }

  hpOutputSelect?.addEventListener('change', () => selectOutputDevice(hpOutputSelect.value));
  headphoneDeviceList?.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-device-id]');
    if (el) selectOutputDevice(el.getAttribute('data-device-id'));
  });

  hpPlayTestTone?.addEventListener('click', async () => {
    if (!selectedOutputId || !stream) return;
    const detect = hpDetect();
    const device = lastHeadphoneDevices.find((d) => d.deviceId === selectedOutputId);
    if (!device || !detect?.isAcceptableHeadphoneOutput(device.label)) {
      msg.textContent = 'Select a valid headphone device first.';
      return;
    }

    msg.textContent = 'Stay silent — playing test tone and checking for speaker leakage…';
    hpPlayTestTone.disabled = true;
    resetHeadphoneValidation();

    try {
      const leak = await detect.verifyPrivateHeadphoneOutput(selectedOutputId, stream);
      if (!leak.passed) {
        msg.textContent =
          leak.reason ||
          'Audio is playing through speakers. Plug in headphones and try again.';
        return;
      }

      headphoneLeakagePassed = true;
      tonePlayedForDeviceId = selectedOutputId;
      hpToneConfirm?.classList.remove('d-none');
      if (hpToneYes) hpToneYes.disabled = false;
      msg.textContent =
        'Private headphone audio confirmed. Click below only if you heard the tone in your headset.';
    } catch (e) {
      msg.textContent = e.message || 'Could not verify headphone output.';
    } finally {
      hpPlayTestTone.disabled = !selectedOutputId;
      updateBtn();
    }
  });

  hpToneYes?.addEventListener('click', () => {
    if (
      !headphoneLeakagePassed ||
      !tonePlayedForDeviceId ||
      tonePlayedForDeviceId !== selectedOutputId ||
      !hpDetect()?.isAcceptableHeadphoneOutput(headphoneDeviceLabel)
    ) {
      msg.textContent = 'Play the test tone and pass the speaker check before confirming.';
      return;
    }

    headphonesVerified = true;
    setCheck(chkHeadphones, true, 'Headphones', 'headphones');
    msg.textContent = 'Headphones verified.';
    hpToneConfirm?.classList.add('d-none');
    updateBtn();
  });

  mediaRetryBtn?.addEventListener('click', () => {
    void runMediaVerification({ manualRetry: true });
  });

  async function submitPreflight() {
    if (!preflightUnlocked) return;

    await checkHeadphones();
    if (
      !headphonesVerified ||
      !headphoneLeakagePassed ||
      tonePlayedForDeviceId !== selectedOutputId ||
      !hpDetect()?.isAcceptableHeadphoneOutput(headphoneDeviceLabel)
    ) {
      msg.textContent = 'Complete headphone verification before continuing.';
      setContinueLocked(true);
      return;
    }

    try {
      const leak = await hpDetect().verifyPrivateHeadphoneOutput(selectedOutputId, stream);
      if (!leak.passed) {
        resetHeadphoneValidation();
        setCheck(chkHeadphones, false, 'Headphones', 'headphones', 'Headphones: pending verification');
        msg.textContent =
          leak.reason ||
          'Headphones no longer verified. Reconnect your headset and run the test tone again.';
        setContinueLocked(true);
        return;
      }
    } catch (e) {
      resetHeadphoneValidation();
      msg.textContent = e.message || 'Could not re-verify headphones.';
      setContinueLocked(true);
      return;
    }

    try {
      const res = await fetch(`/interview/${token}/preflight/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera: cameraOk,
          microphone: micOk,
          face: faceOk,
          headphones_hardware_detected: true,
          headphones_verified: true,
          headphones_test_tone_passed: true,
          headphones_leakage_passed: true,
          headphones_detection_method: 'test_tone_confirmed',
          device_label: headphoneDeviceLabel,
          device_id: selectedOutputId,
          face_signature: verifiedFaceSignature || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preflight failed');

      sessionStorage.setItem(`mission_hp_${token}`, selectedOutputId);
      sessionStorage.setItem(`mission_hp_method_${token}`, 'test_tone_confirmed');
      sessionStorage.setItem(`mission_hp_label_${token}`, headphoneDeviceLabel);

      cleanupPreflight();
      window.InterviewVoice?.speak('Device check complete. Entering the interview room.');
      window.location.href = data.next;
    } catch (e) {
      msg.textContent = e.message;
      setContinueLocked(true);
    }
  }

  function cleanupPreflight() {
    stopHeadphoneMonitor();
    releaseMediaStream();
  }

  function initFaceMesh() {
    if (typeof FaceMesh === 'undefined') {
      faceOk = true;
      setCheck(chkFace, true, 'Face detected', 'face');
      updateBtn();
      return;
    }
    faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });
    faceMesh.setOptions({
      maxNumFaces: 2,
      refineLandmarks: true,
      minDetectionConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    faceMesh.onResults((results) => {
      const stable = faceStabilizer
        ? faceStabilizer.update(results)
        : {
            faceDetected: (results.multiFaceLandmarks?.length || 0) === 1,
            multipleFaces: (results.multiFaceLandmarks?.length || 0) > 1,
          };
      faceOk = stable.faceDetected && !stable.multipleFaces;
      setCheck(
        chkFace,
        faceOk,
        stable.multipleFaces ? 'Single face required' : 'Face detected',
        'face',
        stable.multipleFaces ? 'Face detected: multiple faces' : null
      );
      if (faceOk) {
        const sig = buildFaceSignature(results.multiFaceLandmarks?.[0]);
        if (sig) verifiedFaceSignature = sig;
      }
      updateBtn();
    });
    const cam = new Camera(video, {
      onFrame: async () => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          await faceMesh.send({ image: video });
        }
      },
      width: 640,
      height: 480,
    });
    cam.start();
  }

  function startSnapshots() {
    setInterval(async () => {
      if (!stream || !faceOk) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const fd = new FormData();
        fd.append('snapshot', blob, 'snap.jpg');
        fd.append('face_count', '1');
        await fetch(`/interview/${token}/snapshot`, { method: 'POST', body: fd });
      }, 'image/jpeg', 0.85);
    }, 15000);
  }

  setContinueLocked(true);
  window.addEventListener('beforeunload', cleanupPreflight);
  window.addEventListener('pagehide', cleanupPreflight);

  btn?.addEventListener('click', (ev) => {
    if (!preflightUnlocked) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    submitPreflight();
  });

  void runMediaVerification();
})();
