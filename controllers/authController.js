const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logActivity = require('../utils/logActivity');

const signToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

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

    const user = await User.findOne({ email });
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

exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    next(err);
  }
};
