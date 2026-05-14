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
    // Managers responsible for overseeing this project.
    // A manager with at least one project here is scoped to only those projects;
    // a manager with zero assignments anywhere sees all (default behaviour).
    assignedManagers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Round-robin pointer — index of next agent to receive a lead
    nextAgentIndex: { type: Number, default: 0 },
    // Per-agent weights for proportional lead distribution.
    // Plain object keyed by agent _id (string) → weight integer (1–10).
    // Default unset/empty = weight 1 for everyone (equal round-robin).
    agentWeights: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', projectSchema);
