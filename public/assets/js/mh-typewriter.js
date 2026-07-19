/**
 * Lightweight typewriter for Mission Hire marketing headings.
 * Supports line breaks and optional <em> segments.
 */
(function (global) {
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function flattenParts(parts) {
    const tokens = [];
    for (const part of parts || []) {
      if (part.br) {
        tokens.push({ br: true });
        continue;
      }
      const text = String(part.text || '');
      const em = !!part.em;
      for (const ch of text) tokens.push({ ch, em });
    }
    return tokens;
  }

  function renderTokens(tokens, count) {
    let html = '';
    let emOpen = false;
    for (let i = 0; i < count; i += 1) {
      const token = tokens[i];
      if (token.br) {
        if (emOpen) {
          html += '</em>';
          emOpen = false;
        }
        html += '<br>';
        continue;
      }
      if (token.em && !emOpen) {
        html += '<em>';
        emOpen = true;
      } else if (!token.em && emOpen) {
        html += '</em>';
        emOpen = false;
      }
      html += escapeHtml(token.ch);
    }
    if (emOpen) html += '</em>';
    return html;
  }

  function typeInto(el, parts, options = {}) {
    if (!el) return;

    const tokens = flattenParts(parts);
    const fullText = parts
      .map((part) => (part.br ? '\n' : String(part.text || '')))
      .join('');
    el.setAttribute('aria-label', fullText.replace(/\n/g, ' ').trim());

    if (global.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      el.innerHTML = renderTokens(tokens, tokens.length);
      return;
    }

    const speed = options.speed ?? 48;
    const delay = options.delay ?? 500;
    let index = 0;

    el.innerHTML = '';
    el.classList.add('mh-typewriter-active');

    function step() {
      if (index >= tokens.length) {
        el.classList.remove('mh-typewriter-active');
        return;
      }
      index += 1;
      el.innerHTML = renderTokens(tokens, index);
      global.setTimeout(step, speed);
    }

    global.setTimeout(step, delay);
  }

  global.MissionHireTypewriter = { typeInto };
})(window);
