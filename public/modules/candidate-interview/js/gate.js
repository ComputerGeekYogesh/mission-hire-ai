(function () {
  const token = window.INTERVIEW_TOKEN;
  const msg = document.getElementById('gate-msg');
  const btnSend = document.getElementById('btn-send-otp');
  const btnVerify = document.getElementById('btn-verify-otp');
  const btnResend = document.getElementById('btn-resend-otp');
  const otpInput = document.getElementById('otp-input');
  const otpError = document.getElementById('gate-otp-error');
  const resendCountdownEl = document.getElementById('resend-countdown');
  const resendLabelEl = document.getElementById('resend-label');
  const digitInputs = Array.from(document.querySelectorAll('.otp-digit'));

  const RESEND_COOLDOWN_SEC = 45;
  let resendTimer = null;
  let resendLeft = 0;

  if (!btnSend && !btnVerify) return;

  function syncOtpValue() {
    if (!otpInput) return '';
    const code = digitInputs.map((el) => el.value.replace(/\D/g, '')).join('');
    otpInput.value = code;
    if (btnVerify) btnVerify.disabled = code.length !== 6;
    digitInputs.forEach((el, i) => {
      el.classList.toggle('is-filled', !!el.value);
      el.classList.remove('is-error', 'is-success');
    });
    return code;
  }

  function setOtpError(text) {
    if (!otpError) return;
    if (text) {
      otpError.textContent = text;
      otpError.classList.remove('d-none');
      digitInputs.forEach((el) => el.classList.add('is-error'));
    } else {
      otpError.textContent = '';
      otpError.classList.add('d-none');
      digitInputs.forEach((el) => el.classList.remove('is-error'));
    }
  }

  function pulseDigit(el) {
    el.classList.remove('otp-pulse');
    void el.offsetWidth;
    el.classList.add('otp-pulse');
  }

  function formatResend(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function startResendCooldown() {
    resendLeft = RESEND_COOLDOWN_SEC;
    if (btnResend) {
      btnResend.disabled = true;
      btnResend.classList.remove('is-active');
    }
    if (resendTimer) clearInterval(resendTimer);
    if (resendLabelEl) resendLabelEl.textContent = 'Resend in';
    if (resendCountdownEl) resendCountdownEl.textContent = formatResend(resendLeft);
    resendTimer = setInterval(() => {
      resendLeft -= 1;
      if (resendCountdownEl) resendCountdownEl.textContent = formatResend(Math.max(0, resendLeft));
      if (resendLeft <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
        if (btnResend) {
          btnResend.disabled = false;
          btnResend.classList.add('is-active');
          if (resendLabelEl) resendLabelEl.textContent = 'Resend';
          if (resendCountdownEl) resendCountdownEl.textContent = '';
        }
      }
    }, 1000);
  }

  async function sendOtp() {
    if (msg) {
      msg.textContent = '';
      msg.className = 'gate-status';
    }
    setOtpError('');
    if (btnSend) btnSend.disabled = true;
    if (btnResend) btnResend.disabled = true;
    try {
      const res = await fetch(`/interview/${token}/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send code');
      if (msg) {
        msg.className = 'gate-status is-success';
        msg.textContent = data.dev_otp
          ? `Code sent (dev: ${data.dev_otp})`
          : 'A new code was sent to your email.';
      }
      if (btnResend) {
        if (resendLabelEl) resendLabelEl.textContent = 'Resend in';
      }
      startResendCooldown();
      digitInputs[0]?.focus();
    } catch (e) {
      if (msg) {
        msg.className = 'gate-status is-error';
        msg.textContent = e.message;
      }
      if (btnResend) {
        btnResend.disabled = false;
        btnResend.classList.add('is-active');
        if (resendLabelEl) resendLabelEl.textContent = 'Resend';
        if (resendCountdownEl) resendCountdownEl.textContent = '';
      }
    } finally {
      if (btnSend) btnSend.disabled = false;
    }
  }

  digitInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      const v = input.value.replace(/\D/g, '');
      input.value = v.slice(-1);
      if (v) pulseDigit(input);
      syncOtpValue();
      if (input.value && index < digitInputs.length - 1) {
        digitInputs[index + 1].focus();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        digitInputs[index - 1].focus();
        digitInputs[index - 1].value = '';
        syncOtpValue();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      pasted.split('').forEach((ch, i) => {
        if (digitInputs[i]) digitInputs[i].value = ch;
      });
      syncOtpValue();
      digitInputs[Math.min(pasted.length, 5)]?.focus();
    });

    input.addEventListener('focus', () => {
      input.classList.add('is-focus');
    });
    input.addEventListener('blur', () => {
      input.classList.remove('is-focus');
    });
  });

  btnSend?.addEventListener('click', sendOtp);
  btnResend?.addEventListener('click', () => {
    if (btnResend.disabled) return;
    sendOtp();
  });

  btnVerify?.addEventListener('click', async () => {
    setOtpError('');
    if (msg) {
      msg.textContent = '';
      msg.className = 'gate-status';
    }
    const code = syncOtpValue();
    if (code.length !== 6) {
      setOtpError('Please enter all 6 digits.');
      return;
    }

    btnVerify.disabled = true;
    btnVerify.classList.add('is-loading');
    try {
      const res = await fetch(`/interview/${token}/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: otpInput.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid code');
      digitInputs.forEach((el) => el.classList.add('is-success'));
      window.location.href = data.next;
    } catch (e) {
      setOtpError(e.message || 'Invalid code. Please try again.');
      if (msg) {
        msg.className = 'gate-status is-error';
        msg.textContent = e.message;
      }
      btnVerify.disabled = false;
      btnVerify.classList.remove('is-loading');
    }
  });

  sendOtp();
})();
