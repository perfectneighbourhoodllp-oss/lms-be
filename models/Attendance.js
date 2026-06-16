const mongoose = require('mongoose');

// How the user is working that day. 'office' is geofenced (must be within radius);
// 'wfh' and 'onsite' record location but skip the office-radius requirement.
const WORK_MODES = ['office', 'wfh', 'onsite'];

// A single check-in or check-out punch: when it happened + where (GPS) + optional selfie proof.
const punchSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    lat: { type: Number },
    lng: { type: Number },
    accuracy: { type: Number }, // GPS accuracy in metres, if the device reported it
    distanceFromOffice: { type: Number }, // metres from the office, computed server-side
    withinGeofence: { type: Boolean }, // whether the punch fell inside the office radius
    selfieUrl: { type: String, trim: true },
    selfiePublicId: { type: String, trim: true }, // Cloudinary public_id for cleanup
  },
  { _id: false }
);

// One document per user per local day. `date` is a 'YYYY-MM-DD' string so "today"
// is unambiguous regardless of server timezone — the client/server compute it consistently.
const attendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD'
    workMode: { type: String, enum: WORK_MODES, default: 'office' },
    checkIn: { type: punchSchema },
    checkOut: { type: punchSchema },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: -1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
module.exports.WORK_MODES = WORK_MODES;
