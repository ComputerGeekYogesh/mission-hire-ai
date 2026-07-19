/**
 * Strip HTML tags and normalize whitespace for user-supplied strings.
 */
export function sanitizeString(value, maxLen = 2000) {
  if (value == null) return '';
  const str = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim();
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}
