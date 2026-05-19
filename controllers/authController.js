const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const logActivity = require('../utils/logActivity');
const sendLoginOtpEmail = require('../utils/sendLoginOtpEmail');

const signToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// Roles that require email-OTP second factor after password.
// Sales and managers get a JWT directly after password validation.
const OTP_REQUIRED_ROLES = ['admin'];
const OTP_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds between resends
const OTP_MAX_ATTEMPTS = 5;

const generateOtp = () =>
  // 6-digit numeric, zero-padded
  String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const hashOtp = (otp) => bcrypt.hash(otp, 8); // lower rounds than passwords — OTP is short-lived

/**
 * Generate, persist (hashed), and email a new OTP to the user.
 * Respects the resend cooldown — throws if called too soon.
 */
async function issueLoginOtp(user) {
  const now = new Date();
  if (
    user.loginOtpLastSentAt &&
    now - new Date(user.loginOtpLastSentAt) < OTP_RESEND_COOLDOWN_MS
  ) {
    const wait = Math.ceil(
      (OTP_RESEND_COOLDOWN_MS - (now - new Date(user.loginOtpLastSentAt))) / 1000
    );
    const err = new Error(`Please wait ${wait}s before requesting another code`);
    err.statusCode = 429;
    throw err;
  }

  const otp = generateOtp();
  user.loginOtpHash = await hashOtp(otp);
  user.loginOtpExpires = new Date(now.getTime() + OTP_TTL_MS);
  user.loginOtpAttempts = 0;
  user.loginOtpLastSentAt = now;
  await user.save();

  // Fire-and-forget — never block login flow on email failures
  sendLoginOtpEmail(user, otp);
}

exports.register = async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Email already registered' });

    // role is always 'sales' for self-registration; admins create privileged users via /api/users
    const user = await User.create({ name, email, password, role: 'sales', phone });
    const token = signToken(user);

    logActivity({
      req,
      userOverride: user,
      action: 'user.register',
      resource: 'user',
      resourceId: user._id,
      details: `New account registered: ${email}`,
    });

    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }

    // Need OTP fields for the issue step — they're `select: false` by default
    const user = await User.findOne({ email }).select(
      '+loginOtpHash +loginOtpExpires +loginOtpAttempts +loginOtpLastSentAt'
    );
    if (!user || !(await user.matchPassword(password))) {
      logActivity({
        req,
        action: 'login',
        status: 'failed',
        details: `Failed login attempt for ${email}`,
      });
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isActive) {
      logActivity({
        req,
        userOverride: user,
        action: 'login',
        status: 'failed',
        details: 'Login blocked — account deactivated',
      });
      return res.status(403).json({ message: 'Account deactivated — contact admin' });
    }

    // OTP gate — admins must verify a 6-digit emailed code before getting a JWT
    if (OTP_REQUIRED_ROLES.includes(user.role)) {
      try {
        await issueLoginOtp(user);
      } catch (err) {
        // 429 (cooldown) — surface message but don't fail the password step
        if (err.statusCode === 429) {
          return res.status(429).json({
            message: err.message,
            requiresOtp: true,
            email: user.email,
          });
        }
        throw err;
      }

      logActivity({
        req,
        userOverride: user,
        action: 'login.otp_sent',
        details: `OTP sent to ${user.email} for admin login`,
      });

      return res.json({
        requiresOtp: true,
        email: user.email,
        message: 'A 6-digit code has been sent to your email. It expires in 10 minutes.',
      });
    }

    // Non-admin role → issue JWT directly
    const token = signToken(user);
    logActivity({
      req,
      userOverride: user,
      action: 'login',
      details: `${user.name} logged in`,
    });

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/verify-otp
 * Body: { email, otp }
 *
 * Validates the 6-digit code and, on success, issues the actual JWT.
 * Tracks failed attempts; locks the cycle after 5 wrong tries (user must
 * re-submit password to receive a fresh OTP).
 */
exports.verifyLoginOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP required' });
    }
    if (!/^\d{6}$/.test(String(otp))) {
      return res.status(400).json({ message: 'OTP must be 6 digits' });
    }

    const user = await User.findOne({ email }).select(
      '+loginOtpHash +loginOtpExpires +loginOtpAttempts +loginOtpLastSentAt'
    );
    if (!user || !user.isActive) {
      // Don't disclose which one failed
      return res.status(401).json({ message: 'Invalid code' });
    }
    if (!user.loginOtpHash || !user.loginOtpExpires) {
      return res.status(400).json({
        message: 'No active code. Submit your password again to request a new one.',
      });
    }
    if (new Date() > new Date(user.loginOtpExpires)) {
      // Expired — clean up
      user.loginOtpHash = undefined;
      user.loginOtpExpires = undefined;
      user.loginOtpAttempts = 0;
      await user.save();
      return res.status(400).json({
        message: 'Code expired. Submit your password again to request a new one.',
      });
    }
    if (user.loginOtpAttempts >= OTP_MAX_ATTEMPTS) {
      user.loginOtpHash = undefined;
      user.loginOtpExpires = undefined;
      user.loginOtpAttempts = 0;
      await user.save();
      logActivity({
        req,
        userOverride: user,
        action: 'login.otp_locked',
        status: 'failed',
        details: 'Too many wrong OTP attempts — cycle reset',
      });
      return res.status(429).json({
        message: 'Too many wrong attempts. Submit your password again to request a new code.',
      });
    }

    const ok = await bcrypt.compare(String(otp), user.loginOtpHash);
    if (!ok) {
      user.loginOtpAttempts = (user.loginOtpAttempts || 0) + 1;
      await user.save();
      const left = OTP_MAX_ATTEMPTS - user.loginOtpAttempts;
      logActivity({
        req,
        userOverride: user,
        action: 'login.otp_failed',
        status: 'failed',
        details: `Wrong OTP attempt (${user.loginOtpAttempts}/${OTP_MAX_ATTEMPTS})`,
      });
      return res.status(401).json({
        message: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code.',
      });
    }

    // Success — clear OTP state, issue JWT
    user.loginOtpHash = undefined;
    user.loginOtpExpires = undefined;
    user.loginOtpAttempts = 0;
    user.loginOtpLastSentAt = undefined;
    await user.save();

    const token = signToken(user);

    logActivity({
      req,
      userOverride: user,
      action: 'login',
      details: `${user.name} logged in (OTP verified)`,
    });

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/resend-otp
 * Body: { email }
 *
 * Re-sends the login OTP for an admin who's mid-flow. Subject to the
 * 60-second resend cooldown enforced in issueLoginOtp().
 */
exports.resendLoginOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });

    const user = await User.findOne({ email }).select(
      '+loginOtpHash +loginOtpExpires +loginOtpAttempts +loginOtpLastSentAt'
    );
    // Generic response to avoid email enumeration — admins should already
    // know if they're mid-flow.
    if (!user || !user.isActive || !OTP_REQUIRED_ROLES.includes(user.role)) {
      return res.status(200).json({ message: 'If your account exists, a new code has been sent.' });
    }
    // Must already be in a password-verified OTP flow
    if (!user.loginOtpHash) {
      return res.status(400).json({
        message: 'No active login session. Submit your password again.',
      });
    }

    try {
      await issueLoginOtp(user);
    } catch (err) {
      if (err.statusCode === 429) {
        return res.status(429).json({ message: err.message });
      }
      throw err;
    }

    res.json({ message: 'A new code has been sent to your email.' });
  } catch (err) {
    next(err);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    next(err);
  }
};
