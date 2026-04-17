const router = require('express').Router();
const { getProperties, getProperty, createProperty, updateProperty, deleteProperty } = require('../controllers/propertyController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/').get(getProperties).post(createProperty);
router.route('/:id').get(getProperty).put(updateProperty).delete(deleteProperty);

module.exports = router;
