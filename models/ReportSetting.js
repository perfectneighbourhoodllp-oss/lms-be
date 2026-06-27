const mongoose = require('mongoose');

// Singleton settings doc for the scheduled daily report email.
const reportSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'daily', unique: true }, // pin to a single doc
    recipients: { type: [String], default: [] }, // email addresses
    dailyEmailEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Convenience: fetch (or lazily create) the single settings doc.
reportSettingSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'daily' });
  if (!doc) doc = await this.create({ key: 'daily' });
  return doc;
};

module.exports = mongoose.model('ReportSetting', reportSettingSchema);
