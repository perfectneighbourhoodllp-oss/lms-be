const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    type: {
      type: String,
      enum: ['residential', 'commercial', 'land', 'rental'],
      required: true,
    },
    status: {
      type: String,
      enum: ['available', 'under-offer', 'sold', 'rented', 'off-market'],
      default: 'available',
    },
    price: { type: Number, required: true },
    address: {
      street: String,
      city: String,
      state: String,
      zip: String,
      country: { type: String, default: 'US' },
    },
    bedrooms: { type: Number },
    bathrooms: { type: Number },
    area: { type: Number },
    images: [String],
    listedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Property', propertySchema);
