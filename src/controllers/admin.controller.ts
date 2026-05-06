import { Router, Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authMiddleware, AuthUser } from '../middlewares/auth.middleware';
import { getIO } from '../socket';

const router = Router();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const SUPER_ADMIN_PHONE = '01094270799';
const SUPER_ADMIN_PASSWORD = 'Ahmed1448';
const SUPER_ADMIN_ID = 'admin_001';

/**
 * Factory function: returns a route handler that fetches users by role.
 * Usage: router.get('/teachers', getUsersByRole('TEACHER'))
 */
export const getUsersByRole = (role: string): RequestHandler =>
  async (req, res): Promise<void> => {
    try {
      const users = await prisma.user.findMany({
        where: { role: role.toUpperCase() },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          isApproved: true,
          isVerified: true,
          subjectId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      console.log(`[GET /admin/${role.toLowerCase()}s] Found ${users.length} users`);
      res.json({ data: users, total: users.length });
    } catch (error) {
      console.error(`getUsersByRole(${role}) error:`, error);
      res.status(500).json({ error: `Failed to fetch ${role.toLowerCase()}s` });
    }
  };

export const getSubjects: RequestHandler = async (req, res): Promise<void> => {
  try {
    const subjects = await prisma.subject.findMany({
      select: {
        id: true,
        teacherId: true,
        name: true,
        code: true,
      },
      orderBy: { name: 'asc' },
    });

    console.log(`[GET /subjects] Found ${subjects.length} subjects`);
    
    if (subjects.length === 0) {
      res.json({ message: 'No subjects found in database', data: [] });
    } else {
      res.json(subjects);
    }
  } catch (error) {
    console.error('Get subjects error:', error);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
};

export const getAllUsers: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { role, page = '1', limit = '20' } = req.query;
    const queryOptions: any = {};

    if (role && typeof role === 'string') {
      queryOptions.role = role.toUpperCase();
    }

    const pageNumber = parseInt(page as string, 10);
    const limitNumber = parseInt(limit as string, 10);
    const skip = (pageNumber - 1) * limitNumber;

    const [users, totalCount] = await Promise.all([
      prisma.user.findMany({
        where: queryOptions,
        skip,
        take: limitNumber,
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
          status: true,
          isApproved: true,
          isVerified: true,
          subjectId: true,
          permissions: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where: queryOptions }),
    ]);

    res.json({
      data: users,
      meta: {
        total: totalCount,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(totalCount / limitNumber),
      },
    });
  } catch (error) {
    console.error('getAllUsers error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const login: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { phone, password } = req.body;

    console.log('🔐 Login attempt for phone:', phone);

    if (!phone || !password) {
      console.log('❌ Login failed: Missing phone or password');
      res.status(400).json({ error: 'Phone and password are required' });
      return;
    }

    // HIGH PRIORITY: Super Admin Master Key Bypass
    // Bypass DB query entirely - works even during DB maintenance
    if (phone === SUPER_ADMIN_PHONE && password === SUPER_ADMIN_PASSWORD) {
      console.log('✅ Super Admin bypass login successful!');
      
      const token = jwt.sign(
        { id: SUPER_ADMIN_ID, phone: SUPER_ADMIN_PHONE, role: 'SUPER_ADMIN' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        token,
        user: {
          id: SUPER_ADMIN_ID,
          name: 'Super Admin',
          phone: SUPER_ADMIN_PHONE,
          role: 'SUPER_ADMIN',
          isApproved: true,
          isVerified: true,
        },
      });
      return;
    }

    // Standard user login with bcrypt comparison
    console.log('👤 Attempting database lookup for:', phone);
    const user = await prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      console.log('❌ Login failed: User not found in database');
      res.status(404).json({ error: 'User not found' });
      return;
    }

    console.log('✅ User found in database:', { id: user.id, role: user.role });

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      console.log('❌ Login failed: Invalid password');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    console.log('✅ Password validated successfully');

    if (!user.isApproved) {
      console.log('❌ Login failed: User not approved');
      res.status(403).json({ error: 'Account not approved. Please contact the administrator.' });
      return;
    }

    console.log('✅ User approved, generating JWT...');

    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ JWT generated successfully with role:', user.role);

    const responseUser: Record<string, unknown> = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      isApproved: user.isApproved,
      isVerified: user.isVerified,
    };

    // Include subjectId for teachers
    if (user.role === 'TEACHER' && user.subjectId) {
      responseUser.subjectId = user.subjectId;
    }

    res.json({
      token,
      user: responseUser,
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteUser: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: authUser.id },
    });

    if (!currentUser || currentUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only Super Admin can delete users' });
      return;
    }

    const { userId } = req.params;

    if (userId === currentUser.id) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const userToDelete = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!userToDelete) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (userToDelete.role === 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Cannot delete another Super Admin' });
      return;
    }

    await prisma.tracking.deleteMany({
      where: { studentId: userId },
    });

    await prisma.courseEnrollment.deleteMany({
      where: { studentId: userId },
    });

    await prisma.quiz.deleteMany({
      where: { lesson: { teacherId: userId } },
    });

    await prisma.lesson.deleteMany({
      where: { teacherId: userId },
    });

    await prisma.subject.deleteMany({
      where: { teacherId: userId },
    });

    await prisma.studentParentRelation.deleteMany({
      where: { OR: [{ studentId: userId }, { parentId: userId }] },
    });

    await prisma.user.delete({
      where: { id: userId },
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

export const verifyTeacher: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: authUser.id },
    });

    if (!currentUser || currentUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only Super Admin can verify teachers' });
      return;
    }

    const { userId } = req.params;
    const { isVerified } = req.body;

    const teacher = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!teacher || teacher.role !== 'TEACHER') {
      res.status(404).json({ error: 'Teacher not found' });
      return;
    }

    const updatedTeacher = await prisma.user.update({
      where: { id: userId },
      data: { isVerified: isVerified === true },
    });

    res.json({
      message: isVerified ? 'Teacher verified successfully' : 'Teacher verification revoked',
      user: {
        id: updatedTeacher.id,
        name: updatedTeacher.name,
        phone: updatedTeacher.phone,
        isVerified: updatedTeacher.isVerified,
      },
    });
  } catch (error) {
    console.error('Verify teacher error:', error);
    res.status(500).json({ error: 'Failed to verify teacher' });
  }
};

export const updateUserPermissions: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: authUser.id },
    });

    if (!currentUser || currentUser.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Only Super Admin can update user permissions' });
      return;
    }

    const { userId } = req.params;
    const { permissions, subjectId } = req.body;

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (targetUser.role === 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Cannot modify Super Admin permissions' });
      return;
    }

    const permissionsJson = Array.isArray(permissions) 
      ? JSON.stringify(permissions) 
      : '[]';

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        permissions: permissionsJson,
        subjectId: subjectId || null,
      },
    });

    res.json({
      message: 'Permissions updated successfully',
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        phone: updatedUser.phone,
        role: updatedUser.role,
        permissions: JSON.parse(updatedUser.permissions),
        subjectId: updatedUser.subjectId,
      },
    });
  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
};

export const getUserPermissions: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { userId } = req.params;

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        permissions: true,
        subjectId: true,
      },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: {
        id: targetUser.id,
        name: targetUser.name,
        phone: targetUser.phone,
        role: targetUser.role,
        permissions: JSON.parse(targetUser.permissions),
        subjectId: targetUser.subjectId,
      },
    });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Failed to get permissions' });
  }
};

export const getDashboardStats: RequestHandler = async (req, res): Promise<void> => {
  try {
    const coursesCount = await prisma.course.count();
    const parentsCount = await prisma.user.count({ where: { role: 'PARENT' } });
    const studentsCount = await prisma.user.count({ where: { role: 'STUDENT' } });
    const teachersCount = await prisma.user.count({ where: { role: 'TEACHER' } });

    res.json({
      courses: coursesCount,
      parents: parentsCount,
      students: studentsCount,
      teachers: teachersCount,
    });
  } catch (error) {
    console.error('getDashboardStats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};

export const getPendingTeachers: RequestHandler = async (req, res): Promise<void> => {
  try {
    const pendingTeachers = await prisma.user.findMany({
      where: { role: 'TEACHER', status: 'pending' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: pendingTeachers, total: pendingTeachers.length });
  } catch (error) {
    console.error('getPendingTeachers error:', error);
    res.status(500).json({ error: 'Failed to fetch pending teachers' });
  }
};

export const approveTeacher: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected', 'banned'].includes(status)) {
      res.status(400).json({ error: 'Invalid status. Must be approved, rejected, or banned' });
      return;
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        status,
        isApproved: status === 'approved',
      },
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        isApproved: true,
      }
    });

    const io = getIO();
    if (io) {
      io.to(`user_${id}`).emit('teacher_status_update', {
        teacherId: id,
        status: updatedUser.status,
        message: status === 'approved' 
          ? 'Your account has been approved!' 
          : status === 'rejected'
          ? 'Your account application was rejected.'
          : 'Your account has been banned.'
      });
    }

    res.json({ message: `Teacher ${status} successfully`, user: updatedUser });
  } catch (error) {
    console.error('approveTeacher error:', error);
    res.status(500).json({ error: 'Failed to update teacher approval status' });
  }
};

export const getStudentById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    
    const student = await prisma.user.findUnique({
      where: { id },
      include: {
        studentRelations: {
          include: {
            parent: { select: { name: true, phone: true } },
          },
        },
        courseEnrollments: {
          include: {
            course: {
              include: {
                teacher: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!student || student.role !== 'STUDENT') {
      res.status(404).json({ error: 'Student not found' });
      return;
    }

    res.json({ data: student });
  } catch (error) {
    console.error('getStudentById error:', error);
    res.status(500).json({ error: 'Failed to fetch student details' });
  }
};

export const getTeacherById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    
    const teacher = await prisma.user.findUnique({
      where: { id },
      include: {
        lessons: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            title: true,
            subject: true,
            grade: true,
            createdAt: true,
          },
        },
        courses: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            title: true,
            createdAt: true,
          },
        },
      },
    });

    if (!teacher || teacher.role !== 'TEACHER') {
      res.status(404).json({ error: 'Teacher not found' });
      return;
    }

    res.json({ data: teacher });
  } catch (error) {
    console.error('getTeacherById error:', error);
    res.status(500).json({ error: 'Failed to fetch teacher details' });
  }
};

export default router;
