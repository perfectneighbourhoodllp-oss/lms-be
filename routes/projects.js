const router = require('express').Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  assignAgents,
  assignManagers,
} = require('../controllers/projectController');

router.use(protect);

// All authenticated users can list/view projects (needed for lead form dropdown)
router.get('/', getProjects);
router.get('/:id', getProject);

// Only admin/manager can create, edit, delete, assign agents
router.post('/', authorize('admin', 'manager'), createProject);
router.put('/:id', authorize('admin', 'manager'), updateProject);
router.delete('/:id', authorize('admin'), deleteProject);
router.put('/:id/assign-agents', authorize('admin', 'manager'), assignAgents);

// Manager assignments — admin-only, since this controls who can see this project
router.put('/:id/assign-managers', authorize('admin'), assignManagers);

module.exports = router;
