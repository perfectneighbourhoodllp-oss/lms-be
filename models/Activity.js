const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['call', 'email', 'meeting', 'note', 'task'],
      required: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    dueDate: { type: Date },
    completed: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Activity', activitySchema);
