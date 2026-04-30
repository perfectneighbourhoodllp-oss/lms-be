const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { list, unreadCount, markRead, markAllRead } = require('../controllers/notificationController');

router.use(protect);

router.get('/', list);
router.get('/unread-count', unreadCount);
router.post('/read-all', markAllRead);
router.post('/:id/read', markRead);

module.exports = router;
