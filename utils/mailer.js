require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
});

const sendInterviewEmail = (to, name) => {
  const mailOptions = {
    from: `"380 SMS App Team" <${process.env.MAIL_USER}>`,
    to,
    subject: 'Interview Scheduled - L1 Round',
    text: `Hi ${name},

Your interview for the L1 round has been scheduled.

You will receive a call shortly from the 380 SMS App team.

Best regards,
380 SMS App Team`
  };

  return transporter.sendMail(mailOptions);
};

module.exports = { sendInterviewEmail };