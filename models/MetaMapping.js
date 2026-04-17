const mongoose = require('mongoose');

const metaMappingSchema = new mongoose.Schema(
  {
    metaId: { type: String, required: true, unique: true, trim: true },
    type: { type: String, enum: ['form', 'page'], required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    label: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MetaMapping', metaMappingSchema);
