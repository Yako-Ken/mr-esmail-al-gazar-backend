import { Router } from 'express';
import { 
  deleteUser, 
  verifyTeacher, 
  updateUserPermissions, 
  getUserPermissions,
  getAllUsers,
  getSubjects,
  getDashboardStats,
  getUsersByRole,
  getPendingTeachers,
  approveTeacher,
  getStudentById,
  getTeacherById,
} from '../controllers/admin.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { roleMiddleware } from '../middlewares/role.middleware';

const router = Router();

router.use(authMiddleware);
router.use(roleMiddleware('SUPER_ADMIN'));

router.get('/subjects', getSubjects);
router.get('/dashboard-stats', getDashboardStats);
router.get('/pending-teachers', getPendingTeachers);
router.patch('/approve-teacher/:id', approveTeacher);
router.get('/teachers', getUsersByRole('TEACHER'));
router.get('/teachers/:id', getTeacherById);
router.get('/students', getUsersByRole('STUDENT'));
router.get('/students/:id', getStudentById);
router.get('/', getAllUsers);
router.delete('/:userId', deleteUser);
router.patch('/:userId/verify', verifyTeacher);
router.patch('/:userId/permissions', updateUserPermissions);
router.get('/:userId/permissions', getUserPermissions);

export default router;
