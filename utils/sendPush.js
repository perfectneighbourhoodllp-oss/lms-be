const User = require('../models/User');
const { getMessagingClient } = require('../config/firebase');

/**
 * Send a push notification to all of a user's registered devices. Best-effort:
 * never throws into the caller, and prunes tokens Firebase reports as invalid so
 * the deviceTokens list stays clean.
 *
 * @param {string} userId
 * @param {{ title: string, body: string, data?: Record<string,string> }} payload
 */
async function sendPush(userId, { title, body, data = {} }) {
  try {
    const messaging = getMessagingClient();
    if (!messaging || !userId) return;

    const user = await User.findById(userId).select('deviceTokens isActive').lean();
    if (!user || user.isActive === false) return;
    const tokens = (user.deviceTokens || []).filter(Boolean);
    if (!tokens.length) return;

    // FCM data values must be strings.
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );

    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'leads', defaultSound: true, defaultVibrateTimings: true },
      },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    console.log(`[PUSH] sent to ${tokens.length} device(s) — ok:${res.successCount} fail:${res.failureCount}`);

    // Prune tokens that are no longer valid (uninstalled app / expired).
    if (res.failureCount > 0) {
      const dead = [];
      res.responses.forEach((r, i) => {
        const code = r.error?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          dead.push(tokens[i]);
        }
      });
      if (dead.length) {
        await User.updateOne({ _id: userId }, { $pull: { deviceTokens: { $in: dead } } });
      }
    }
  } catch (err) {
    console.error('[PUSH] sendPush failed:', err.message);
  }
}

module.exports = sendPush;
