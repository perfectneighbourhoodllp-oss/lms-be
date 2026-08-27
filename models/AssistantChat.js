const mongoose = require('mongoose');

/**
 * One AI-assistant exchange (a question + its answer) for a single user.
 * Kept for 7 days, then auto-deleted by MongoDB's TTL monitor — no cron needed.
 */
const assistantChatSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    question: { type: String, required: true },
    answer: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// TTL: documents expire 7 days after createdAt (604800 seconds).
assistantChatSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
// Fast per-user history lookups, newest first.
assistantChatSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('AssistantChat', assistantChatSchema);
