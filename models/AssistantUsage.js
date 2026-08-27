const mongoose = require('mongoose');

/**
 * One AI-assistant chat request's token usage + computed cost, per user.
 * Powers the admin "AI usage & cost" view. Kept 180 days (TTL), then pruned.
 */
const assistantUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    model: { type: String, required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheCreateTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Auto-prune after 180 days.
assistantUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('AssistantUsage', assistantUsageSchema);
