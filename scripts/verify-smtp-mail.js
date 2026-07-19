/**
 * Verify Gmail SMTP config from .env
 * Usage: node scripts/verify-smtp-mail.js [recipient@email.com]
 */
import dotenv from 'dotenv';
dotenv.config();
import { assertMailConfigured, getFromEmail, sendMail } from '../utils/smtp-mailer.js';

const to = process.argv[2] || process.env.REPLY_TO_EMAIL || getFromEmail();

try {
  assertMailConfigured();
  console.log('SMTP config OK. From:', getFromEmail());
  console.log('Sending test email to:', to);
  const info = await sendMail({
    to,
    subject: 'Mission Hire — SMTP test',
    html: '<p>If you received this, Gmail SMTP is working.</p>',
  });
  console.log('Success:', info.messageId);
} catch (err) {
  console.error('SMTP test failed:', err.message);
  process.exit(1);
}
