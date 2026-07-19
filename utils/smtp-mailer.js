import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

function stripQuotes(value) {
  return String(value ?? '').trim().replace(/^["']|["']$/g, '');
}

function getSmtpConfig() {
  const host = process.env.MAIL_HOST || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.MAIL_PORT || process.env.SMTP_PORT || 587);
  const encryption = (process.env.MAIL_ENCRYPTION || process.env.SMTP_ENCRYPTION || 'tls')
    .trim()
    .toLowerCase();
  const secure = encryption === 'ssl' || port === 465;
  const user = stripQuotes(process.env.MAIL_USERNAME || process.env.SMTP_USER || '');
  const pass = stripQuotes(process.env.MAIL_PASSWORD || process.env.SMTP_PASS || '');

  return { host, port, secure, user, pass };
}

export function getFromEmail() {
  return (
    stripQuotes(process.env.MAIL_FROM_ADDRESS) ||
    stripQuotes(process.env.FROM_EMAIL) ||
    stripQuotes(process.env.MAIL_USERNAME) ||
    stripQuotes(process.env.SMTP_USER) ||
    ''
  ).trim();
}

export function getFromName() {
  return (
    stripQuotes(process.env.MAIL_FROM_NAME) ||
    stripQuotes(process.env.FROM_NAME) ||
    'Mission Hire'
  ).trim();
}

export function getReplyToEmail() {
  return (stripQuotes(process.env.REPLY_TO_EMAIL) || getFromEmail()).trim();
}

export function assertMailConfigured() {
  const { user, pass } = getSmtpConfig();
  if (!user || !pass) {
    throw new Error(
      'Mail not configured. Set MAIL_USERNAME and MAIL_PASSWORD (or SMTP_USER / SMTP_PASS) in .env'
    );
  }
  if (!getFromEmail()) {
    throw new Error('Mail FROM address not configured. Set MAIL_FROM_ADDRESS in .env');
  }
}

let transporter = null;

export function getTransporter() {
  if (!transporter) {
    const cfg = getSmtpConfig();
    assertMailConfigured();
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, html, text, cc, replyTo, toName }) {
  assertMailConfigured();

  const fromEmail = getFromEmail();
  const fromName = getFromName();
  const toAddress = String(to || '').trim().toLowerCase();
  if (!toAddress) throw new Error('Recipient email is required');

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: toName ? `"${toName}" <${toAddress}>` : toAddress,
    replyTo: replyTo || getReplyToEmail(),
    subject,
    html,
  };

  if (text) mailOptions.text = text;
  if (cc) mailOptions.cc = cc;

  const info = await getTransporter().sendMail(mailOptions);
  console.log(`✅ Email sent to ${toAddress} via SMTP (from ${fromEmail}, id: ${info.messageId})`);
  return info;
}

export function mailErrorDetail(error) {
  return error?.message || String(error);
}

/** @deprecated use getFromEmail */
export function getBrevoSenderEmail() {
  return getFromEmail();
}

/** @deprecated use assertMailConfigured */
export function assertBrevoMailConfigured() {
  return assertMailConfigured();
}

/** @deprecated */
export function brevoMailErrorDetail(error) {
  return mailErrorDetail(error);
}
