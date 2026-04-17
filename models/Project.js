const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    developer: { type: String, trim: true },
    location: { type: String, trim: true },
    type: {
      type: String,
      enum: ['Residential', 'Commercial', 'Plots', 'Villa'],
      default: 'Residential',
    },
    isActive: { type: Boolean, default: true },
    // Agents assigned to handle leads for this project
    assignedAgents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Round-robin pointer — index of next agent to receive a lead
    nextAgentIndex: { type: Number, default: 0 },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', projectSchema);
