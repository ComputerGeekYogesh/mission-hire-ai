/**
 * Structured console logs for video assessment AI interaction flow.
 * Format: [TIMESTAMP] [LOG_LEVEL] [MODULE] — Message | metadata: {...}
 */

function formatLine(level, module, message, metadata = {}) {
  const ts = new Date().toISOString();
  const meta =
    metadata && Object.keys(metadata).length
      ? ` | metadata: ${JSON.stringify(metadata)}`
      : '';
  return `[${ts}] [${level}] [${module}] — ${message}${meta}`;
}

function write(level, module, message, metadata) {
  const line = formatLine(level, module, message, metadata);
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else if (level === 'DEBUG') console.debug(line);
  else console.log(line);
}

export const assessmentLog = {
  session(message, metadata, level = 'INFO') {
    write(level, 'SESSION', message, metadata);
  },
  question(message, metadata, level = 'INFO') {
    write(level, 'QUESTION', message, metadata);
  },
  intent(message, metadata, level = 'INFO') {
    write(level, 'INTENT', message, metadata);
  },
  response(message, metadata, level = 'INFO') {
    write(level, 'RESPONSE', message, metadata);
  },
  scope(message, metadata, level = 'INFO') {
    write(level, 'SCOPE', message, metadata);
  },
  edgeCase(message, metadata, level = 'INFO') {
    write(level, 'EDGE_CASE', message, metadata);
  },
  answer(message, metadata, level = 'INFO') {
    write(level, 'ANSWER', message, metadata);
  },
  system(message, metadata, level = 'ERROR') {
    write(level, 'SYSTEM', message, metadata);
  },
};
