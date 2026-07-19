(function () {
  const copyBtn = document.getElementById('chrome-restriction-copy-btn');
  const linkInput = document.getElementById('chrome-restriction-link');
  const copyConfirm = document.getElementById('chrome-restriction-copy-confirm');

  if (linkInput) {
    linkInput.value = window.location.href;
  }

  if (!copyBtn || !linkInput) return;

  let confirmTimer = null;

  async function copyInviteLink() {
    const url = window.location.href;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        linkInput.removeAttribute('readonly');
        linkInput.focus();
        linkInput.select();
        document.execCommand('copy');
        linkInput.setAttribute('readonly', 'readonly');
      }
    } catch (_) {
      linkInput.removeAttribute('readonly');
      linkInput.focus();
      linkInput.select();
      try {
        document.execCommand('copy');
      } catch (_) {}
      linkInput.setAttribute('readonly', 'readonly');
    }

    if (copyConfirm) {
      copyConfirm.classList.remove('d-none');
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        copyConfirm.classList.add('d-none');
      }, 2000);
    }
  }

  copyBtn.addEventListener('click', copyInviteLink);
})();
