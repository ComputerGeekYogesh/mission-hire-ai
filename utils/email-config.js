/** @deprecated Use utils/smtp-mailer.js — kept for backward-compatible imports. */
export {
  assertMailConfigured as assertBrevoMailConfigured,
  getFromEmail as getBrevoSenderEmail,
  getReplyToEmail as getBrevoReplyToEmail,
  mailErrorDetail as brevoMailErrorDetail,
} from './smtp-mailer.js';

import { getFromEmail, getFromName, getReplyToEmail } from './smtp-mailer.js';

export function brevoSender() {
  return { email: getFromEmail(), name: getFromName() };
}

export function brevoReplyTo() {
  return { email: getReplyToEmail(), name: getFromName() };
}
