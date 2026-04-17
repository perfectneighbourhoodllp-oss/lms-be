const Activity = require('../models/Activity');

exports.getActivities = async (req, res, next) => {
  try {
    const { lead, property, type, completed } = req.query;
    const filter = {};

    if (lead) filter.lead = lead;
    if (property) filter.property = property;
    if (type) filter.type = type;
    if (completed !== undefined) filter.completed = completed === 'true';

    const activities = await Activity.find(filter)
      .populate('lead', 'name email')
      .populate('property', 'title')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });

    res.json(activities);
  } catch (err) {
    next(err);
  }
};

exports.createActivity = async (req, res, next) => {
  try {
    const activity = await Activity.create({ ...req.body, createdBy: req.user.id });
    res.status(201).json(activity);
  } catch (err) {
    next(err);
  }
};

exports.updateActivity = async (req, res, next) => {
  try {
    const activity = await Activity.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!activity) return res.status(404).json({ message: 'Activity not found' });
    res.json(activity);
  } catch (err) {
    next(err);
  }
};

exports.deleteActivity = async (req, res, next) => {
  try {
    const activity = await Activity.findByIdAndDelete(req.params.id);
    if (!activity) return res.status(404).json({ message: 'Activity not found' });
    res.json({ message: 'Activity deleted' });
  } catch (err) {
    next(err);
  }
};
