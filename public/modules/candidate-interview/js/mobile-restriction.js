(function () {
  const copyBtn = document.getElementById('mobile-restriction-copy-btn');
  const linkInput = document.getElementById('mobile-restriction-link');
  const copyConfirm = document.getElementById('mobile-restriction-copy-confirm');
  const desktopBtn = document.getElementById('mobile-restriction-desktop-btn');
  const desktopMsg = document.getElementById('mobile-restriction-desktop-msg');

  if (linkInput) {
    linkInput.value = window.location.href;
  }

  let confirmTimer = null;

  async function copyInviteLink() {
    const url = window.location.href;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else if (linkInput) {
        linkInput.removeAttribute('readonly');
        linkInput.focus();
        linkInput.select();
        document.execCommand('copy');
        linkInput.setAttribute('readonly', 'readonly');
      }
    } catch (_) {
      if (!linkInput) return;
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

  copyBtn?.addEventListener('click', copyInviteLink);

  desktopBtn?.addEventListener('click', async () => {
    await copyInviteLink();
    if (desktopMsg) {
      desktopMsg.classList.remove('d-none');
    }
  });
})();
