function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatScheduledAt(scheduledAt) {
  if (!scheduledAt) return 'As scheduled';
  const d = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(scheduledAt));
  return d.toLocaleString('en-IN', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Shared Mission Hire dark email shell — matches login OTP styling. */
function missionHireEmailShell({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — Mission Hire</title>
  <style>
    body {
      font-family: Georgia, 'Times New Roman', serif;
      background: #0E0C14;
      margin: 0;
      padding: 24px 12px;
    }
    .email-container {
      max-width: 520px;
      margin: auto;
      background: #1E1B29;
      padding: 36px 28px 40px;
      border-radius: 16px;
      border: 1px solid #332E42;
      text-align: center;
    }
    .brand {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 26px;
      font-weight: 600;
      color: #D4A24E;
      letter-spacing: 0.04em;
      margin: 0 0 6px;
    }
    .brand-sub {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #7C90F0;
      margin: 0 0 28px;
    }
    h2 {
      margin: 0 0 18px;
      color: #F3EFE7;
      font-size: 20px;
      font-weight: 600;
    }
    .greeting {
      color: #F3EFE7;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 12px;
      text-align: left;
    }
    p, li {
      color: #A69FB3;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 15px;
      line-height: 1.55;
      margin: 0 0 12px;
      text-align: left;
    }
    p strong, li strong { color: #F3EFE7; }
    .meta-row {
      text-align: left;
      margin: 16px 0 20px;
      padding: 14px 16px;
      background: #26222F;
      border: 1px solid #332E42;
      border-radius: 12px;
    }
    .meta-row p { margin: 0 0 6px; font-size: 14px; }
    .meta-row p:last-child { margin-bottom: 0; }
    .highlight-box {
      margin: 22px auto;
      padding: 20px 22px;
      background: #D4A24E;
      color: #241B08;
      border-radius: 12px;
      font-size: 15px;
      line-height: 1.5;
      text-align: center;
    }
    .highlight-box p { color: #241B08; text-align: center; margin: 0 0 10px; }
    .highlight-box a { color: #241B08; font-weight: 600; word-break: break-all; }
    .cta-link {
      display: inline-block;
      margin-top: 8px;
      padding: 12px 28px;
      background: #1E1B29;
      color: #F3EFE7 !important;
      text-decoration: none;
      border-radius: 10px;
      font-weight: 600;
      font-size: 15px;
      border: 1px solid #332E42;
    }
    .score-pill {
      display: inline-block;
      margin: 12px 0 18px;
      padding: 14px 28px;
      background: #D4A24E;
      color: #241B08;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 18px;
      font-weight: 700;
      border-radius: 12px;
      letter-spacing: 0.02em;
    }
    .status-badge {
      display: inline-block;
      margin: 0 0 16px;
      padding: 10px 18px;
      border-radius: 10px;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      font-weight: 600;
      text-align: center;
    }
    .status-pass {
      background: rgba(107, 191, 138, 0.15);
      color: #6BBF8A;
      border: 1px solid rgba(107, 191, 138, 0.35);
    }
    .status-fail {
      background: rgba(224, 122, 122, 0.12);
      color: #E07A7A;
      border: 1px solid rgba(224, 122, 122, 0.35);
    }
    .qa-block {
      text-align: left;
      margin: 14px 0;
      padding: 16px 18px;
      background: #26222F;
      border-radius: 12px;
      border: 1px solid #332E42;
      border-left: 4px solid #D4A24E;
    }
    .qa-block p { margin: 0 0 8px; font-size: 14px; }
    .qa-block p:last-child { margin-bottom: 0; }
    .qa-block strong { color: #D4A24E; }
    .footer {
      color: #736C82;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      margin-top: 32px;
      text-align: center;
    }
    .footer strong { color: #D4A24E; }
    .guidelines-section {
      text-align: left;
      margin: 24px 0 0;
      padding-top: 20px;
      border-top: 1px solid #332E42;
    }
    .guidelines-title {
      color: #F3EFE7;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 16px;
      font-weight: 700;
      margin: 0 0 14px;
    }
    .guidelines-subtitle {
      color: #7C90F0;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin: 16px 0 8px;
    }
    .guidelines-list {
      margin: 0 0 4px;
      padding-left: 20px;
      color: #A69FB3;
      font-size: 14px;
      line-height: 1.55;
    }
    .guidelines-list li { margin-bottom: 6px; }
    .note-box {
      margin-top: 18px;
      padding: 14px 16px;
      background: rgba(212, 162, 78, 0.08);
      border: 1px solid rgba(212, 162, 78, 0.35);
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.5;
      color: #A69FB3;
      text-align: left;
    }
    .note-box strong { color: #D4A24E; }
    .divider {
      border: none;
      border-top: 1px solid #332E42;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <p class="brand">Mission Hire</p>
    <p class="brand-sub">Video interview AI assistant</p>
    <h2>${escapeHtml(title)}</h2>
    ${bodyHtml}
    <div class="footer">
      Best regards,<br/>
      <strong>Mission Hire</strong>
    </div>
  </div>
</body>
</html>`;
}

export function buildAssessmentInviteEmailHtml({
  name,
  jobTitle,
  scheduledAt,
  interviewUrl,
  heading = 'Assessment Invitation',
  labels = null,
}) {
  const L = labels || {
    inviteIntro: 'You are invited to complete your assessment. Please use the secure link below.',
    joinCta: 'Join your assessment',
    openCta: 'Open assessment',
    guidelinesTitle: 'Guidelines for Your Assessment',
    beforeSection: 'Before the Assessment:',
    duringSection: 'During the Assessment:',
    navigateAwayWarning:
      'Do not switch tabs, minimize the browser window, or navigate away from the assessment. Such actions may be flagged as suspicious activity.',
    monitoredWarning:
      'Suspicious activities are monitored throughout the assessment. You will receive up to four warnings for suspicious behavior; a fifth detection will result in automatic assessment termination.',
    videoBrowserNote:
      'This video assessment is supported only on the Google Chrome browser. Please use a laptop or desktop computer for the best experience. Do not use Mozilla Firefox or other browsers, as they may not support the required voice recognition and video assessment features.',
  };
  const jobLine = jobTitle
    ? `<p><strong>Role:</strong> ${escapeHtml(jobTitle)}</p>`
    : '';
  const bodyHtml = `
    <p class="greeting">Hi ${escapeHtml(name)},</p>
    <p>${escapeHtml(L.inviteIntro)}</p>
    <div class="meta-row">
      ${jobLine}
      <p><strong>Scheduled:</strong> ${formatScheduledAt(scheduledAt)}</p>
    </div>
    <div class="highlight-box">
      <p>${escapeHtml(L.joinCta)}</p>
      <a href="${escapeHtml(interviewUrl)}" class="cta-link">${escapeHtml(L.openCta)}</a>
      <p style="margin:14px 0 0;font-size:12px;opacity:0.9;text-align:center;">
        <a href="${escapeHtml(interviewUrl)}">${escapeHtml(interviewUrl)}</a>
      </p>
    </div>
    <div class="guidelines-section">
      <p class="guidelines-title">${escapeHtml(L.guidelinesTitle)}</p>
      <p class="guidelines-subtitle">${escapeHtml(L.beforeSection)}</p>
      <ul class="guidelines-list">
        <li>Ensure a stable internet connection before clicking the link</li>
        <li>Open the link before it expires within 24 hours</li>
        <li>Find a quiet, well-lit room with minimal background noise</li>
      </ul>
      <p class="guidelines-subtitle">Device &amp; Setup Checks</p>
      <ul class="guidelines-list">
        <li>Allow camera and microphone permissions when prompted</li>
        <li>Ensure your webcam is working and face is clearly visible</li>
        <li>Close all unnecessary tabs and background applications</li>
        <li>Make sure your device is fully charged or plugged in</li>
      </ul>
      <p class="guidelines-subtitle">${escapeHtml(L.duringSection)}</p>
      <ul class="guidelines-list">
        <li>Complete OTP identity verification first before proceeding</li>
        <li>${escapeHtml(L.navigateAwayWarning)}</li>
        <li>${escapeHtml(L.monitoredWarning)}</li>
      </ul>
      <div class="note-box">
        <strong>NOTE:</strong> ${escapeHtml(L.videoBrowserNote)}
      </div>
    </div>
  `;

  return missionHireEmailShell({ title: heading, bodyHtml });
}

function buildQaBlocksHtml(answers, scoreScale = 10) {
  const scale = Number(scoreScale) || 10;
  return answers
    .map(
      (a, i) => `
    <div class="qa-block">
      <p><strong>Q${i + 1}:</strong> ${escapeHtml(a.question)}</p>
      <p><strong>Answer:</strong> ${escapeHtml(a.answer)}</p>
      <p><strong>Feedback:</strong> ${escapeHtml(a.feedback)}</p>
      ${a.score != null ? `<p><strong>Score:</strong> ${escapeHtml(String(Math.round(Number(a.score) || 0)))}/${scale}</p>` : ''}
    </div>`
    )
    .join('');
}

export function buildAssessmentFeedbackEmailHtml({
  candidateContact,
  candidateName = 'Candidate',
  totalScore,
  ratingLabel,
  answers = [],
  scoreScale = 10,
}) {
  const scale = Number(scoreScale) || 10;
  const qaHtml = buildQaBlocksHtml(answers, scale);
  const firstName = String(candidateName || 'Candidate').trim().split(/\s+/)[0] || 'there';

  const bodyHtml = `
    <p class="greeting">Hi ${escapeHtml(firstName)},</p>
    <p>Thank you for completing your assessment. Below is your feedback summary.</p>
    <div class="meta-row">
      <p><strong>Contact:</strong> ${escapeHtml(candidateContact)}</p>
    </div>
    <div class="score-pill">${escapeHtml(totalScore)}/${scale} — ${escapeHtml(ratingLabel)}</div>
    <hr class="divider" />
    ${qaHtml || '<p>No answered questions recorded.</p>'}
  `;

  return missionHireEmailShell({ title: 'Assessment Feedback', bodyHtml });
}

/** Interview feedback email (sent to candidate; admin on CC). */
export function buildInterviewFeedbackEmailHtml({
  candidateContact,
  candidateName = 'Candidate',
  totalScore,
  ratingLabel,
  passed,
  answers = [],
  isAssessment = false,
  scoreScale = 10,
}) {
  const scale = Number(scoreScale) || 10;
  const firstName = String(candidateName || 'Candidate').trim().split(/\s+/)[0] || 'there';
  const introLine = isAssessment
    ? 'Thank you for completing your assessment. Below is your feedback summary.'
    : 'Thank you for completing your interview. Below is your feedback summary.';
  const statusHtml = isAssessment
    ? ''
    : `<div class="status-badge ${passed ? 'status-pass' : 'status-fail'}">${
        passed ? 'Passed — Move to L2' : 'Failed — Do not move forward'
      }</div>`;
  const qaHtml = buildQaBlocksHtml(answers, scale);
  const title = isAssessment ? 'Assessment Feedback' : 'Interview Feedback';

  const bodyHtml = `
    <p class="greeting">Hi ${escapeHtml(firstName)},</p>
    <p>${escapeHtml(introLine)}</p>
    <div class="meta-row">
      <p><strong>Contact:</strong> ${escapeHtml(candidateContact)}</p>
    </div>
    ${statusHtml}
    <div class="score-pill">${escapeHtml(String(totalScore))} — ${escapeHtml(ratingLabel)}</div>
    <hr class="divider" />
    ${qaHtml || '<p>No answered questions recorded.</p>'}
  `;

  return missionHireEmailShell({ title, bodyHtml });
}
