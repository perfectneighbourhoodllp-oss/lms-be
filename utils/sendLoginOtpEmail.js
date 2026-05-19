const transporter = require('../config/email');

/**
 * Send a 6-digit login OTP to an admin via email.
 * Fires and forgets — errors are logged, never thrown.
 *
 * @param {Object} user - User document (must have email, name)
 * @param {string} otp  - The 6-digit code (sent in clear text only in email)
 */
module.exports = async function sendLoginOtpEmail(user, otp) {
  try {
    if (!user?.email) {
      console.warn('[OTP] Skipping email — no recipient');
      return;
    }

    const html = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:12px">
  <div style="background:#ffffff;padding:24px 28px;border-radius:12px;border:1px solid #e5e7eb">
    <p style="margin:0 0 4px 0;color:#1d4ed8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">
      Login Verification
    </p>
    <h1 style="margin:0 0 16px 0;color:#111827;font-size:20px">Hi ${user.name?.split(' ')[0] || 'Admin'},</h1>
    <p style="color:#374151;font-size:14px;line-height:1.5;margin:0 0 20px 0">
      Use this code to complete your login:
    </p>
    <div style="text-align:center;background:#eff6ff;border:1px dashed #93c5fd;border-radius:10px;padding:20px;margin:0 0 20px 0">
      <p style="margin:0;color:#1e3a8a;font-size:32px;font-weight:bold;letter-spacing:0.4em;font-family:'SF Mono','Consolas',monospace">
        ${otp}
      </p>
    </div>
    <p style="color:#6b7280;font-size:13px;line-height:1.5;margin:0 0 12px 0">
      This code expires in <strong>10 minutes</strong>. Enter it on the login screen exactly as shown.
    </p>
    <p style="color:#dc2626;font-size:12px;line-height:1.5;margin:16px 0 0 0;padding-top:16px;border-top:1px solid #f3f4f6">
      🔒 If you didn't try to log in, someone may know your password.
      Change it immediately and notify your team.
    </p>
  </div>
  <p style="color:#9ca3af;font-size:11px;text-align:center;margin:16px 0 0 0">
    Sent by PNH Lead Management System · automated, do not reply
  </p>
</div>`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.MAIL_FROM,
      to: user.email,
      subject: `🔐 Your login code: ${otp}`,
      html,
      // Include in plain text too for clients that strip HTML
      text: `Your login code is ${otp}. It expires in 10 minutes. If you didn't request this, change your password immediately.`,
    });

    console.log(`[OTP] Login code sent to ${user.email}`);
  } catch (err) {
    console.error('[OTP] Failed to send login code:', err.message);
  }
};
