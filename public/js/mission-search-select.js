/**
 * Lightweight searchable dropdown (single select).
 * Items: { value, label, image?, subtitle?, avatarText?, avatarColor? }
 */
export class MissionSearchSelect {
  constructor(root, options = {}) {
    if (!root) throw new Error('MissionSearchSelect: root required');
    this.root = root;
    this.placeholder = options.placeholder || 'Select…';
    this.disabled = Boolean(options.disabled);
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.showAvatars = options.showAvatars !== false;
    this.items = [];
    this.value = options.value || '';

    this.root.classList.add('mission-search-select');
    this.root.innerHTML = `
      <button type="button" class="mission-search-select-toggle form-control outlined-input text-start" aria-haspopup="listbox">
        <span class="mission-search-select-leading"></span>
        <span class="mission-search-select-label">${this.placeholder}</span>
        <span class="mission-search-select-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="mission-search-select-panel" hidden>
        <input type="search" class="mission-search-select-search form-control form-control-sm" placeholder="Search…" autocomplete="off" />
        <ul class="mission-search-select-list" role="listbox"></ul>
      </div>
      <input type="hidden" class="mission-search-select-value" value="" />
    `;

    this.toggleBtn = this.root.querySelector('.mission-search-select-toggle');
    this.leadingEl = this.root.querySelector('.mission-search-select-leading');
    this.labelEl = this.root.querySelector('.mission-search-select-label');
    this.panel = this.root.querySelector('.mission-search-select-panel');
    this.searchInput = this.root.querySelector('.mission-search-select-search');
    this.listEl = this.root.querySelector('.mission-search-select-list');
    this.hiddenInput = this.root.querySelector('.mission-search-select-value');

    this.toggleBtn.addEventListener('click', () => {
      if (this.disabled) return;
      this.panel.hidden ? this.open() : this.close();
    });

    this.searchInput.addEventListener('input', () => this.renderList());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });

    document.addEventListener('click', (e) => {
      if (!this.root.contains(e.target)) this.close();
    });

    this.setDisabled(this.disabled);
    if (options.items) this.setOptions(options.items);
    if (this.value) this.setValue(this.value, { silent: true });
  }

  setOptions(items) {
    this.items = Array.isArray(items) ? items : [];
    this.renderList();
    if (this.value && !this.items.some((i) => i.value === this.value)) {
      this.setValue('', { silent: true });
    } else if (this.value) {
      this.updateLabel();
    }
  }

  setValue(value, { silent = false } = {}) {
    this.value = value || '';
    this.hiddenInput.value = this.value;
    this.updateLabel();
    if (!silent && this.onChange) this.onChange(this.value);
  }

  getValue() {
    return this.value;
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    this.root.classList.toggle('is-disabled', this.disabled);
    this.toggleBtn.disabled = this.disabled;
    if (this.disabled) this.close();
  }

  open() {
    if (this.disabled) return;
    this.panel.hidden = false;
    this.root.classList.add('is-open');
    this.searchInput.value = '';
    this.renderList();
    setTimeout(() => this.searchInput.focus(), 0);
  }

  close() {
    this.panel.hidden = true;
    this.root.classList.remove('is-open');
  }

  avatarInitials(label) {
    const parts = String(label || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  avatarColorFor(value) {
    let hash = 0;
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
    const hues = [220, 260, 300, 340, 20, 45, 160, 190];
    const hue = hues[Math.abs(hash) % hues.length];
    return `hsl(${hue} 55% 42%)`;
  }

  renderAvatar(item, size = 'md') {
    const wrap = document.createElement('span');
    wrap.className = `mission-search-select-avatar mission-search-select-avatar--${size}`;

    if (item?.image) {
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      wrap.appendChild(img);
      return wrap;
    }

    const initials = document.createElement('span');
    initials.className = 'mission-search-select-avatar-initials';
    initials.textContent = item?.avatarText || this.avatarInitials(item?.label);
    initials.style.background = item?.avatarColor || this.avatarColorFor(item?.value || item?.label);
    wrap.appendChild(initials);
    return wrap;
  }

  updateLabel() {
    const item = this.items.find((i) => i.value === this.value);
    this.labelEl.textContent = item ? item.label : this.placeholder;
    this.labelEl.classList.toggle('text-muted', !item);

    this.leadingEl.innerHTML = '';
    if (item && this.showAvatars && item.avatar !== false) {
      this.leadingEl.appendChild(this.renderAvatar(item, 'sm'));
      this.root.classList.add('has-leading');
    } else {
      this.root.classList.remove('has-leading');
    }
  }

  renderList() {
    const q = String(this.searchInput?.value || '').trim().toLowerCase();
    const filtered = this.items.filter((i) => {
      if (!q) return true;
      const hay = [i.label, i.subtitle, i.value].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    this.listEl.innerHTML = '';
    if (!filtered.length) {
      const li = document.createElement('li');
      li.className = 'mission-search-select-empty';
      li.textContent = 'No results';
      this.listEl.appendChild(li);
      return;
    }
    filtered.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'mission-search-select-option' + (item.value === this.value ? ' is-selected' : '');
      li.dataset.value = item.value;
      li.setAttribute('role', 'option');

      if (this.showAvatars && item.avatar !== false) {
        li.appendChild(this.renderAvatar(item, 'md'));
      }

      const textWrap = document.createElement('span');
      textWrap.className = 'mission-search-select-option-text';
      const title = document.createElement('span');
      title.className = 'mission-search-select-option-label';
      title.textContent = item.label;
      textWrap.appendChild(title);
      if (item.subtitle) {
        const sub = document.createElement('span');
        sub.className = 'mission-search-select-option-sub';
        sub.textContent = item.subtitle;
        textWrap.appendChild(sub);
      }
      li.appendChild(textWrap);

      li.addEventListener('click', () => {
        this.setValue(item.value);
        this.close();
      });
      this.listEl.appendChild(li);
    });
  }
}
