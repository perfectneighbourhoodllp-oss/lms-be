const Lead = require('../models/Lead');
const Property = require('../models/Property');
const Activity = require('../models/Activity');

exports.getStats = async (req, res, next) => {
  try {
    const [
      totalLeads,
      newLeads,
      wonLeads,
      totalProperties,
      availableProperties,
      upcomingActivities,
      leadsByStatus,
    ] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ status: 'new' }),
      Lead.countDocuments({ status: 'won' }),
      Property.countDocuments(),
      Property.countDocuments({ status: 'available' }),
      Activity.countDocuments({ completed: false, dueDate: { $gte: new Date() } }),
      Lead.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    res.json({
      leads: { total: totalLeads, new: newLeads, won: wonLeads },
      properties: { total: totalProperties, available: availableProperties },
      activities: { upcoming: upcomingActivities },
      leadsByStatus,
    });
  } catch (err) {
    next(err);
  }
};
