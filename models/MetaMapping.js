const mongoose = require('mongoose');

const metaMappingSchema = new mongoose.Schema(
  {
    metaId: { type: String, required: true, unique: true, trim: true },
    type: { type: String, enum: ['form', 'page'], required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    // Optional per-mapping agent set. Leads matching this form/page are assigned:
    //   - [] (empty) → project's weighted round-robin (all project agents)
    //   - [one]      → always that agent (fixed pin, no accept timer)
    //   - [two+]     → round-robin within this subset only (scoped reassignment)
    assignedAgents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Round-robin cursor for this mapping's own agent set
    nextAgentIndex: { type: Number, default: 0 },
    label: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MetaMapping', metaMappingSchema);
