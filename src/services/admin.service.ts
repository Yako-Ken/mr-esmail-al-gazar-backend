import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getIO } from '../socket';
import { logger } from '../utils/logger';
import { env } from '../utils/env';
import { AppError, NotFoundError, ForbiddenError, BadRequestError } from '../utils/appError';

const prisma = new PrismaClient();

const JWT_SECRET = env.JWT_SECRET;
const SUPER_ADMIN_ID = 'admin_001';

export const listUsersByRole = async (role: string) => {
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

  logger.info(`[GET /admin/${role.toLowerCase()}s] Found ${users.length} users`);
  return users;
};

export const listSubjects = async () => {
  const subjects = await prisma.subject.findMany({
    select: {
      id: true,
      teacherId: true,
      name: true,
      code: true,
    },
    orderBy: { name: 'asc' },
  });

  logger.info(`[GET /subjects] Found ${subjects.length} subjects`);
  return subjects;
};

export interface ListAllUsersParams {
  role?: string;
  page: number;
  limit: number;
}

export const listAllUsers = async ({ role, page, limit }: ListAllUsersParams) => {
  const queryOptions: any = {};
  if (role) {
    queryOptions.role = role.toUpperCase();
  }

  const skip = (page - 1) * limit;

  const [users, totalCount] = await Promise.all([
    prisma.user.findMany({
      where: queryOptions,
      skip,
      take: limit,
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

  return { users, totalCount };
};

export const login = async (phone: string, password: string) => {
  logger.info('🔐 Login attempt for phone:', phone);

  if (!phone || !password) {
    logger.info('❌ Login failed: Missing phone or password');
    throw new BadRequestError('Phone and password are required');
  }

  // Super Admin Master Key Bypass - works even during DB maintenance.
  // Credentials live only in env (SUPER_ADMIN_PHONE / SUPER_ADMIN_PASSWORD_HASH), never in source.
  if (env.SUPER_ADMIN_PHONE && env.SUPER_ADMIN_PASSWORD_HASH && phone === env.SUPER_ADMIN_PHONE) {
    const bypassValid = await bcrypt.compare(password, env.SUPER_ADMIN_PASSWORD_HASH);
    if (bypassValid) {
      logger.info('✅ Super Admin bypass login successful!');

      const token = jwt.sign(
        { id: SUPER_ADMIN_ID, phone: env.SUPER_ADMIN_PHONE, role: 'SUPER_ADMIN' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return {
        token,
        user: {
          id: SUPER_ADMIN_ID,
          name: 'Super Admin',
          phone: env.SUPER_ADMIN_PHONE,
          role: 'SUPER_ADMIN',
          isApproved: true,
          isVerified: true,
        },
      };
    }
  }

  // Standard user login with bcrypt comparison
  logger.info('👤 Attempting database lookup for:', phone);
  const user = await prisma.user.findUnique({
    where: { phone },
  });

  if (!user) {
    logger.info('❌ Login failed: User not found in database');
    throw new NotFoundError('User not found');
  }

  logger.info('✅ User found in database:', { id: user.id, role: user.role });

  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    logger.info('❌ Login failed: Invalid password');
    throw new AppError(401, 'Invalid credentials');
  }

  logger.info('✅ Password validated successfully');

  if (!user.isApproved) {
    logger.info('❌ Login failed: User not approved');
    throw new ForbiddenError('Account not approved. Please contact the administrator.');
  }

  logger.info('✅ User approved, generating JWT...');

  const token = jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  logger.info('✅ JWT generated successfully with role:', user.role);

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

  return { token, user: responseUser };
};

const assertCurrentUserIsSuperAdmin = async (
  authUserId: string,
  forbiddenMessage: string
): Promise<void> => {
  const currentUser = await prisma.user.findUnique({
    where: { id: authUserId },
  });

  if (!currentUser || currentUser.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError(forbiddenMessage);
  }
};

export const deleteUserById = async (authUserId: string, userId: string): Promise<void> => {
  await assertCurrentUserIsSuperAdmin(authUserId, 'Only Super Admin can delete users');

  if (userId === authUserId) {
    throw new BadRequestError('Cannot delete your own account');
  }

  const userToDelete = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!userToDelete) {
    throw new NotFoundError('User not found');
  }

  if (userToDelete.role === 'SUPER_ADMIN') {
    throw new ForbiddenError('Cannot delete another Super Admin');
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
};

export const verifyTeacher = async (authUserId: string, userId: string, isVerified: unknown) => {
  await assertCurrentUserIsSuperAdmin(authUserId, 'Only Super Admin can verify teachers');

  const teacher = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!teacher || teacher.role !== 'TEACHER') {
    throw new NotFoundError('Teacher not found');
  }

  const updatedTeacher = await prisma.user.update({
    where: { id: userId },
    data: { isVerified: isVerified === true },
  });

  return updatedTeacher;
};

export const updateUserPermissions = async (
  authUserId: string,
  userId: string,
  permissions: unknown,
  subjectId: unknown
) => {
  await assertCurrentUserIsSuperAdmin(authUserId, 'Only Super Admin can update user permissions');

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!targetUser) {
    throw new NotFoundError('User not found');
  }

  if (targetUser.role === 'SUPER_ADMIN') {
    throw new ForbiddenError('Cannot modify Super Admin permissions');
  }

  const permissionsJson = Array.isArray(permissions) ? JSON.stringify(permissions) : '[]';

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      permissions: permissionsJson,
      subjectId: (subjectId as string) || null,
    },
  });

  return updatedUser;
};

export const getUserPermissions = async (userId: string) => {
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
    throw new NotFoundError('User not found');
  }

  return targetUser;
};

export const getDashboardStats = async () => {
  const coursesCount = await prisma.course.count();
  const parentsCount = await prisma.user.count({ where: { role: 'PARENT' } });
  const studentsCount = await prisma.user.count({ where: { role: 'STUDENT' } });
  const teachersCount = await prisma.user.count({ where: { role: 'TEACHER' } });

  return {
    courses: coursesCount,
    parents: parentsCount,
    students: studentsCount,
    teachers: teachersCount,
  };
};

export const listPendingTeachers = async () => {
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

  return pendingTeachers;
};

export const approveTeacher = async (id: string, status: string) => {
  if (!['approved', 'rejected', 'banned'].includes(status)) {
    throw new BadRequestError('Invalid status. Must be approved, rejected, or banned');
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
    },
  });

  const io = getIO();
  if (io) {
    io.to(`user_${id}`).emit('teacher_status_update', {
      teacherId: id,
      status: updatedUser.status,
      message:
        status === 'approved'
          ? 'Your account has been approved!'
          : status === 'rejected'
          ? 'Your account application was rejected.'
          : 'Your account has been banned.',
    });
  }

  return updatedUser;
};

export const getStudentById = async (id: string) => {
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
    throw new NotFoundError('Student not found');
  }

  return student;
};

export const getTeacherById = async (id: string) => {
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
    throw new NotFoundError('Teacher not found');
  }

  return teacher;
};
