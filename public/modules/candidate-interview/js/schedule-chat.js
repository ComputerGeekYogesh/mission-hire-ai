/**
 * Interview schedule chat — Mission Hire inbox shell (center hero + elegant history).
 */
(function () {
  const chatWindow = document.getElementById('chat-window');
  const chatWrapper = document.querySelector('.mission-schedule-chat .chat-wrapper');
  const userInput = document.getElementById('user-input');
  const sendButton = document.getElementById('send-button');
  const micButton = document.getElementById('mic-button');
  const inputSection = document.getElementById('input-section');
  const btnReset = document.getElementById('btn-reset-chat');
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  const rightSidebar = document.getElementById('right-sidebar');
  const closeSidebarBtn = document.getElementById('close-sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sidebarList = document.getElementById('sidebar-list');

  const CLIENT_KEY = 'mission_interview_schedule_client';
  const FIELD_ORDER = [
    'Job Profile',
    'Job Description',
    'Experience Required',
    'Number of Questions to Ask',
    'Name',
    'Email',
    'Emails',
  ];

  let chatStarted = false;
  let widgetMode = false;
  let pendingHistoryContext = null;
  let moveToBottomHandler = null;

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setIdleMode(on) {
    chatWindow?.classList.toggle('is-idle', !!on);
    chatWindow?.classList.toggle('chat-active', !on && chatStarted);
    chatWrapper?.classList.toggle('chat-has-input', !on && chatStarted);
  }

  function getChatAnchor() {
    let anchor = document.getElementById('chat-anchor');
    if (!anchor && chatWindow) {
      anchor = document.createElement('div');
      anchor.id = 'chat-anchor';
      anchor.setAttribute('aria-hidden', 'true');
      anchor.style.cssText = 'height:1px;flex-shrink:0;width:100%;';
      chatWindow.appendChild(anchor);
    }
    return anchor;
  }

  function insertBeforeAnchor(node) {
    if (!chatWindow || !node) return;
    const anchor = getChatAnchor();
    chatWindow.insertBefore(node, anchor);
  }

  function heroIconHtml() {
    return (
      '<svg class="mission-hero-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H10l-4.2 3.15a.75.75 0 0 1-1.15-.64V15H6.5A2.5 2.5 0 0 1 4 12.5v-7Z" fill="#241B08"/>' +
      '<path d="M8 8.25h8M8 11.25h5.5" stroke="#D4A24E" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function heroHtml() {
    return (
      '<div id="default-message" class="default-message mission-start-hero">' +
      '<div class="mission-hero-glow" aria-hidden="true"></div>' +
      '<p class="mission-hero-eyebrow">Video interview AI</p>' +
      '<div class="mission-hero-mark" aria-hidden="true">' +
      heroIconHtml() +
      '</div>' +
      '<div id="intro-text">Hello! I\'m Mission Hire.<br><span class="mission-hero-sub">Your Virtual AI Assistant</span></div>' +
      '<p class="mission-hero-lead">Schedule interviews, brief candidates, and move hiring forward — in one conversation.</p>' +
      '<div class="button-container">' +
      '<button type="button" id="btn-start-chat"><i class="bi bi-chat-dots-fill"></i> Talk to Mission Hire</button>' +
      '</div></div>' +
      '<div id="chat-anchor" aria-hidden="true" style="height:1px;flex-shrink:0;width:100%;"></div>'
    );
  }

  function bindStartButton() {
    document.getElementById('btn-start-chat')?.addEventListener('click', startChat);
  }

  function getClientId() {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = 'isc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  }

  function scrollChat() {
    if (!chatWindow) return;
    requestAnimationFrame(() => {
      const anchor = getChatAnchor();
      if (anchor) {
        anchor.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
      chatWindow.scrollTop = chatWindow.scrollHeight;
    });
  }

  function scrollChatToTop() {
    if (chatWindow) {
      requestAnimationFrame(() => {
        chatWindow.scrollTop = 0;
      });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.querySelector('.main-content')?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  function appendMessage(text, className) {
    if (!chatWindow || text == null || text === '') return;

    let cls = className || 'bot-message';
    if (cls.includes('user-message')) {
      /* keep */
    } else if (
      !cls.includes('error') &&
      !cls.includes('success') &&
      !cls.includes('centered') &&
      (text.startsWith('Review before scheduling') || text.includes('• Job Profile:'))
    ) {
      cls = 'bot-message bot-message-review';
    }

    const isUser = cls.includes('user-message');
    const div = document.createElement('div');
    div.className = 'message ' + cls;

    const label = document.createElement('div');
    label.className = 'msg-sender-label';
    label.textContent = isUser ? 'You' : 'Mission Hire';

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text;

    div.append(label, body);
    insertBeforeAnchor(div);
    scrollChat();
  }

  function buildEditablePrompt(promptText) {
    return (promptText || '')
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (/^name\s*:/i.test(trimmed) || /^email(s)?\s*:/i.test(trimmed)) {
          const colon = line.indexOf(':');
          return colon >= 0 ? `${line.slice(0, colon + 1)} ` : line;
        }
        return line;
      })
      .join('\n')
      .trim();
  }

  function parsePromptText(text) {
    const fields = {};
    (text || '').split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
    return fields;
  }

  function renderFieldRows(fields, emptyOk) {
    const rows = [];
    const seen = new Set();
    FIELD_ORDER.forEach((label) => {
      if (seen.has(label)) return;
      seen.add(label);
      const val = fields[label];
      if (!val || val === '-') {
        if (!emptyOk) return;
      }
      const display = val && val !== '-' ? val : '—';
      if (!emptyOk && display === '—') return;
      rows.push(
        `<div class="hist-row"><span class="hist-label">${escapeHtml(label)}</span>` +
          `<span class="hist-val">${escapeHtml(display)}</span></div>`
      );
    });
    return rows.join('');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return '';
    }
  }

  function resizeTextarea() {
    if (!userInput) return;
    userInput.style.height = 'auto';
    const max = 200;
    userInput.style.height = Math.min(max, Math.max(48, userInput.scrollHeight)) + 'px';
    if (inputSection?.classList.contains('centered')) {
      inputSection.style.height = 'auto';
      inputSection.classList.add('rectangle');
    }
  }

  function clearWidgets() {
    chatWindow?.querySelectorAll('.chat-widget').forEach((el) => el.remove());
    widgetMode = false;
  }

  function setTemplateModalOpen(open) {
    chatWrapper?.classList.toggle('mission-template-modal-open', !!open);
    if (open) {
      inputSection?.classList.add('hide');
    } else if (chatStarted && !widgetMode) {
      inputSection?.classList.remove('hide');
    }
  }

  function removeResumeOverlay() {
    document.getElementById('mission-resume-overlay')?.remove();
    setTemplateModalOpen(false);
  }

  function showResumeOverlay(item) {
    closeSidebar();
    removeResumeOverlay();
    setTemplateModalOpen(true);
    const fields = parsePromptText(item.prompt_text);
    const grid = renderFieldRows(fields, false) || '<p style="color:#94a3b8;margin:0">No saved details for this entry.</p>';
    const hasHistoryQuestions = Array.isArray(item.questions) && item.questions.length > 0;
    const questionHint = hasHistoryQuestions
      ? `<p class="mission-resume-question-hint">This template has ${item.questions.length} saved question(s). Change <strong>Number of Questions to Ask</strong> in the prompt to use fewer — only that many will be taken from history.</p>`
      : '';

    const overlay = document.createElement('div');
    overlay.id = 'mission-resume-overlay';
    overlay.className = 'mission-resume-overlay';
    overlay.innerHTML =
      '<div class="mission-resume-card">' +
      '<div class="mission-resume-icon">📋</div>' +
      '<h3>Load previous template?</h3>' +
      `<p class="mission-resume-name">${escapeHtml(item.candidate_name || 'Candidate')}</p>` +
      questionHint +
      `<div class="mission-resume-fields">${grid}</div>` +
      '<div class="mission-resume-actions">' +
      '<button type="button" class="btn-continue">Continue with Mission Hire</button>' +
      '<button type="button" class="btn-dismiss">Cancel</button>' +
      '</div></div>';

    const mount = chatWrapper || chatWindow;
    mount.appendChild(overlay);

    overlay.querySelector('.btn-dismiss')?.addEventListener('click', () => removeResumeOverlay());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) removeResumeOverlay();
    });
    overlay.querySelector('.btn-continue')?.addEventListener('click', () => {
      removeResumeOverlay();
      pendingHistoryContext = {
        fromHistory: true,
        questions: Array.isArray(item.questions) ? item.questions.filter(Boolean) : [],
      };

      if (!chatStarted) {
        startChat();
        document.querySelector('.bot-message-centered')?.classList.add('hide');
      }
      moveInputToBottom();
      inputSection?.classList.remove('hide');

      if (userInput) {
        userInput.value = buildEditablePrompt(item.prompt_text);
        resizeTextarea();
        userInput.focus();
      }
      scrollChatToTop();
    });
  }

  function showTyping() {
    if (document.getElementById('typing-indicator')) return;
    const el = document.createElement('div');
    el.className = 'message bold-message';
    el.id = 'typing-indicator';
    el.textContent = 'Thinking...';
    insertBeforeAnchor(el);
    scrollChat();
  }

  function hideTyping() {
    document.getElementById('typing-indicator')?.remove();
  }

  async function apiCall(payload) {
    const res = await fetch('/admin/interviews/schedule/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: getClientId(), ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Request failed');
    }
    return data;
  }

  let suppressNextQuestionsEcho = false;

  function appendQuestionsList(questions) {
    if (!questions?.length) return;
    const lines = questions.map((q, i) => {
      const text = typeof q === 'string' ? q : q.question || String(q);
      const stripped = text.replace(/^\d+[\.\)]\s*/, '');
      return `${i + 1}. ${stripped}`;
    });
    appendMessage(lines.join('\n'), 'user-message user-message-questions');
  }

  function handleResponse(data) {
    hideTyping();
    if (data.reply) {
      const cls = data.errors?.length
        ? 'bot-message error-msg'
        : data.done
          ? 'bot-message success-msg'
          : 'bot-message';
      appendMessage(data.reply, cls);
    }
    if (data.questions?.length && !suppressNextQuestionsEcho) {
      appendQuestionsList(data.questions);
    }
    suppressNextQuestionsEcho = false;
    if (data.ui) renderWidget(data.ui);
    else clearWidgets();

    if (data.done) {
      inputSection.classList.add('hide');
      widgetMode = false;
      clearWidgets();
      loadHistory();
    }
  }

  async function postAction(action, extra = {}) {
    if (action === 'set_phones' && extra.phones?.trim()) {
      appendMessage(extra.phones.trim(), 'user-message');
    }
    if (action === 'submit_manual_questions' && extra.questionsText?.trim()) {
      const lines = extra.questionsText
        .trim()
        .split(/\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      appendMessage(lines.join('\n'), 'user-message user-message-questions');
      suppressNextQuestionsEcho = true;
    }
    if (action === 'set_interview_type' && extra.value) {
      const labels = { browser: 'Browser (video in browser)', telephony: 'Telephony (phone call)' };
      appendMessage(labels[extra.value] || extra.value, 'user-message');
    }
    if (action === 'set_question_source' && extra.value) {
      const labels = {
        ai: 'Generated by UI (AI)',
        manual: 'Your question list',
        history: 'Use questions from history',
      };
      appendMessage(labels[extra.value] || extra.value, 'user-message');
    }
    if (action === 'set_schedule_mode' && extra.value) {
      const labels = { now: 'Now (call / invite immediately)', later: 'Later (pick date & time)' };
      appendMessage(labels[extra.value] || extra.value, 'user-message');
    }
    if (action === 'set_datetime' && extra.value) {
      appendMessage(extra.value, 'user-message');
    }

    showTyping();
    try {
      const data = await apiCall({ action, ...extra });
      handleResponse(data);
    } catch (e) {
      hideTyping();
      appendMessage(e.message || 'Something went wrong.', 'bot-message error-msg');
      if (action === 'confirm') {
        renderWidget({ type: 'confirm', label: 'Confirm & schedule interview' });
      }
    }
  }

  function mountWidget(box) {
    insertBeforeAnchor(box);
    scrollChat();
  }

  function renderWidget(ui) {
    clearWidgets();
    if (!ui || !chatWindow) return;

    widgetMode = true;
    inputSection.classList.add('hide');

    const box = document.createElement('div');
    box.className = 'message chat-widget';
    const widgetLabel = document.createElement('div');
    widgetLabel.className = 'msg-sender-label';
    widgetLabel.textContent = 'Mission Hire — choose an option';
    box.appendChild(widgetLabel);

    if (ui.type === 'select') {
      const label = document.createElement('label');
      label.textContent = ui.label || 'Select';
      const sel = document.createElement('select');
      sel.className = 'form-select';
      const seenOptions = new Set();
      (ui.options || []).forEach((opt) => {
        if (!opt?.value || seenOptions.has(opt.value)) return;
        seenOptions.add(opt.value);
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm mt-3';
      btn.textContent = 'Continue';
      btn.addEventListener('click', () => {
        const actionMap = {
          interview_type: 'set_interview_type',
          question_source: 'set_question_source',
          schedule_mode: 'set_schedule_mode',
        };
        postAction(actionMap[ui.field] || 'set_value', { value: sel.value });
      });
      box.append(label, sel, btn);
      mountWidget(box);
      return;
    }

    if (ui.type === 'phones') {
      const label = document.createElement('label');
      label.textContent = ui.label || 'Mobile number(s)';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'form-control';
      inp.placeholder = ui.placeholder || '9876543210, 9123456789';
      const hint = document.createElement('div');
      hint.className = 'chat-widget-hint';
      hint.textContent = ui.hint || 'Comma-separated. +91 optional.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm mt-3';
      btn.textContent = 'Save phone & continue';
      btn.addEventListener('click', () => postAction('set_phones', { phones: inp.value }));
      box.append(label, inp, hint, btn);
      inp.focus();
      mountWidget(box);
      return;
    }

    if (ui.type === 'manual_questions') {
      const label = document.createElement('label');
      label.textContent = ui.label || 'Your questions';
      const ta = document.createElement('textarea');
      ta.className = 'form-control chat-widget-questions-input';
      ta.rows = 6;
      ta.placeholder = ui.placeholder || '1. First question\n2. Second question';
      const fileInp = document.createElement('input');
      fileInp.type = 'file';
      fileInp.accept = '.txt,text/plain';
      fileInp.className = 'form-control form-control-sm mt-2';
      fileInp.addEventListener('change', () => {
        const f = fileInp.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          ta.value = String(reader.result || '');
        };
        reader.readAsText(f);
      });
      const hint = document.createElement('div');
      hint.className = 'chat-widget-hint';
      hint.textContent = `Enter exactly ${ui.required_count || 3} questions (one per line) or upload .txt`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm mt-3';
      btn.textContent = 'Submit questions';
      btn.addEventListener('click', () =>
        postAction('submit_manual_questions', { questionsText: ta.value })
      );
      box.append(label, ta, fileInp, hint, btn);
      mountWidget(box);
      return;
    }

    if (ui.type === 'datetime') {
      const label = document.createElement('label');
      label.textContent = ui.label || 'Date & time';
      let inp;
      if (ui.multiline) {
        inp = document.createElement('textarea');
        inp.rows = Math.min(8, 3 + (ui.candidate_count || 3));
        inp.className = 'form-control chat-widget-questions-input';
      } else {
        inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'form-control';
      }
      inp.placeholder = ui.placeholder || '15-06-2026 02:30 PM';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm mt-3';
      btn.textContent = 'Set schedule time';
      btn.addEventListener('click', () => postAction('set_datetime', { value: inp.value }));
      box.append(label, inp, btn);
      inp.focus();
      mountWidget(box);
      return;
    }

    if (ui.type === 'confirm') {
      const label = document.createElement('label');
      label.textContent = ui.label || 'Ready to schedule';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary mt-2';
      btn.textContent = 'Confirm & schedule';
      btn.addEventListener('click', () => postAction('confirm'));
      box.append(label, btn);
      mountWidget(box);
      return;
    }

    widgetMode = false;
    showInputBar();
  }

  function showInputBar() {
    if (!chatStarted) return;
    inputSection.classList.remove('hide');
    if (!widgetMode) {
      setTimeout(() => userInput?.focus(), 80);
    }
  }

  function moveInputToBottom() {
    if (!inputSection.classList.contains('bottom')) {
      inputSection.classList.remove('centered', 'rectangle');
      inputSection.classList.add('bottom');
      sendButton?.classList.remove('hide');
      chatWrapper?.classList.add('chat-has-input');
      setChatActive();
      resizeTextarea();
      userInput?.focus();
      scrollChat();
    }
  }

  function setChatActive() {
    chatWindow?.classList.add('chat-active');
    chatWindow?.classList.remove('is-idle');
  }

  function hideCenteredPrompt() {
    document.querySelector('.bot-message-centered')?.classList.add('hide');
  }

  async function submitBasics() {
    const message = userInput?.value?.trim();
    if (!message) return;

    if (!inputSection.classList.contains('bottom')) {
      moveInputToBottom();
      hideCenteredPrompt();
    }

    appendMessage(message, 'user-message');
    userInput.value = '';
    resizeTextarea();

    showTyping();
    try {
      const payload = { action: 'submit_basics', message };
      if (pendingHistoryContext?.fromHistory) {
        payload.fromHistoryTemplate = true;
        payload.historyQuestions = pendingHistoryContext.questions || [];
      }
      const data = await apiCall(payload);
      if (pendingHistoryContext?.fromHistory) {
        pendingHistoryContext = null;
      }
      handleResponse(data);
      if (!data.ui) showInputBar();
    } catch (e) {
      hideTyping();
      appendMessage(e.message, 'bot-message error-msg');
      showInputBar();
    }
  }

  function startChat() {
    if (chatStarted) return;
    chatStarted = true;
    removeResumeOverlay();
    document.getElementById('default-message')?.remove();
    chatWindow?.classList.remove('chat-active');
    getChatAnchor();

    inputSection.classList.remove('hide', 'bottom');
    inputSection.classList.add('centered');
    sendButton?.classList.add('hide');

    if (userInput) {
      userInput.value = '';
      userInput.style.height = '48px';
    }

    setTimeout(() => userInput?.focus(), 120);

    appendMessage('How can I assist you today?', 'bot-message-centered');

    userInput?.addEventListener('input', resizeTextarea);

    moveToBottomHandler = (e) => {
      if (widgetMode) return;
      if (e.key === 'Enter' && e.shiftKey) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!userInput.value.trim()) return;
        moveInputToBottom();
        document.querySelector('.bot-message-centered')?.classList.add('hide');
        submitBasics();
      }
    };
    userInput?.addEventListener('keydown', moveToBottomHandler);
  }

  sendButton?.addEventListener('click', () => {
    if (widgetMode || !chatStarted) return;
    if (!userInput.value.trim()) return;
    if (!inputSection.classList.contains('bottom')) {
      moveInputToBottom();
      hideCenteredPrompt();
    }
    submitBasics();
  });

  bindStartButton();

  async function resetSession() {
    chatStarted = false;
    widgetMode = false;
    pendingHistoryContext = null;
    removeResumeOverlay();

    if (moveToBottomHandler && userInput) {
      userInput.removeEventListener('keydown', moveToBottomHandler);
      moveToBottomHandler = null;
    }

    chatWindow.innerHTML = heroHtml();
    bindStartButton();
    chatWindow.classList.remove('chat-active');
    chatWrapper?.classList.remove('chat-has-input');
    setIdleMode(true);

    inputSection.classList.add('hide');
    inputSection.classList.remove('centered', 'bottom', 'rectangle');
    sendButton?.classList.add('hide');
    if (userInput) {
      userInput.value = '';
      resizeTextarea();
    }

    await fetch('/admin/interviews/schedule/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: getClientId() }),
    });
  }

  btnReset?.addEventListener('click', resetSession);

  function groupHistoryByProfile(items) {
    const groups = new Map();
    items.forEach((item) => {
      const fields = parsePromptText(item.prompt_text);
      const profile = fields['Job Profile'] || item.job_title || 'Interview';
      if (!groups.has(profile)) groups.set(profile, []);
      groups.get(profile).push(item);
    });
    return groups;
  }

  function renderHistoryEntry(item) {
    const entry = document.createElement('div');
    entry.className = 'sidebar-history-entry';

    const fields = parsePromptText(item.prompt_text);
    const desc = fields['Job Description'] || '';
    const descShort = desc.length > 36 ? `${desc.slice(0, 36)}…` : desc;

    const metaParts = [
      item.candidate_name || 'Candidate',
      item.interview_type,
      descShort || null,
      formatDate(item.scheduled_at || item.created_at),
    ].filter(Boolean);

    const entryHeader = document.createElement('div');
    entryHeader.className = 'sidebar-history-entry-header';
    entryHeader.innerHTML =
      `<div class="sidebar-history-entry-title">${escapeHtml(metaParts.join(' · '))}</div>` +
      '<span class="icon">▼</span>';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'sidebar-collapsible-content sidebar-entry-content';
    const inner = document.createElement('div');
    inner.className = 'content-inner';

    const detailsScroll = document.createElement('div');
    detailsScroll.className = 'history-details-scroll';

    const dl = document.createElement('dl');
    dl.className = 'history-detail-grid';
    FIELD_ORDER.forEach((label) => {
      const val = fields[label];
      if (!val || val === '-') return;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = val;
      dl.append(dt, dd);
    });
    if (!dl.children.length) {
      const p = document.createElement('p');
      p.style.cssText = 'color:#94a3b8;font-size:0.8rem;margin:0';
      p.textContent = 'No job details stored for this entry.';
      detailsScroll.appendChild(p);
    } else {
      detailsScroll.appendChild(dl);
    }

    const actions = document.createElement('div');
    actions.className = 'sidebar-item-actions';
    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'sidebar-history-use-btn';
    useBtn.textContent = 'Load template';
    useBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showResumeOverlay(item);
    });
    actions.appendChild(useBtn);

    inner.append(detailsScroll, actions);
    contentDiv.appendChild(inner);

    entryHeader.addEventListener('click', () => {
      const expanded = entry.classList.contains('expanded');
      entry.closest('.sidebar-profile-group')
        ?.querySelectorAll('.sidebar-history-entry')
        .forEach((el) => el.classList.remove('expanded'));
      if (!expanded) entry.classList.add('expanded');
    });

    entry.append(entryHeader, contentDiv);
    return entry;
  }

  async function loadHistory() {
    if (!sidebarList) return;
    try {
      const res = await fetch('/admin/interviews/schedule/history');
      const data = await res.json();
      sidebarList.innerHTML = '';

      if (!data.items?.length) {
        sidebarList.innerHTML =
          '<li class="sidebar-list-item">' +
          '<div class="sidebar-list-header"><span>No schedules found</span></div></li>';
        return;
      }

      const groups = groupHistoryByProfile(data.items);
      groups.forEach((entries, profile) => {
        const li = document.createElement('li');
        li.className = 'sidebar-list-item sidebar-profile-group';

        const header = document.createElement('div');
        header.className = 'sidebar-list-header';
        header.innerHTML =
          '<div class="title" style="flex-direction:column;align-items:flex-start;flex:1;">' +
          `<div style="font-weight:600;">${escapeHtml(profile)}</div>` +
          `<div class="sidebar-item-meta">${entries.length} schedule${entries.length === 1 ? '' : 's'}</div>` +
          '</div><span class="icon">▼</span>';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'sidebar-collapsible-content';
        const inner = document.createElement('div');
        inner.className = 'content-inner sidebar-profile-entries';

        entries
          .sort(
            (a, b) =>
              new Date(b.scheduled_at || b.created_at || 0) -
              new Date(a.scheduled_at || a.created_at || 0)
          )
          .forEach((item) => {
            inner.appendChild(renderHistoryEntry(item));
          });

        contentDiv.appendChild(inner);

        header.addEventListener('click', () => {
          const expanded = li.classList.contains('expanded');
          sidebarList.querySelectorAll('.sidebar-list-item').forEach((el) => el.classList.remove('expanded'));
          if (!expanded) li.classList.add('expanded');
        });

        li.append(header, contentDiv);
        sidebarList.appendChild(li);
      });
    } catch {
      sidebarList.innerHTML =
        '<li class="sidebar-list-item"><div class="sidebar-list-header" style="color:#f87171">Failed to load history</div></li>';
    }
  }

  function openSidebar() {
    rightSidebar?.classList.add('open');
    sidebarOverlay?.classList.add('active');
    loadHistory();
  }

  function closeSidebar() {
    rightSidebar?.classList.remove('open');
    sidebarOverlay?.classList.remove('active');
  }

  sidebarToggleBtn?.addEventListener('click', openSidebar);
  closeSidebarBtn?.addEventListener('click', closeSidebar);
  sidebarOverlay?.addEventListener('click', closeSidebar);

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition && micButton) {
    const rec = new SpeechRecognition();
    rec.interimResults = true;
    rec.lang = 'en-US';
    let listening = false;
    micButton.addEventListener('click', () => {
      if (!chatStarted) {
        startChat();
        return;
      }
      if (listening) rec.stop();
      else {
        try {
          rec.start();
        } catch (_) {}
      }
    });
    rec.onstart = () => {
      listening = true;
      micButton.classList.add('listening');
    };
    rec.onend = () => {
      listening = false;
      micButton.classList.remove('listening');
    };
    rec.onresult = (ev) => {
      userInput.value = Array.from(ev.results)
        .map((r) => r[0].transcript)
        .join('');
      resizeTextarea();
    };
  }

  if (chatWindow && !chatStarted) {
    setIdleMode(true);
  }
})();
