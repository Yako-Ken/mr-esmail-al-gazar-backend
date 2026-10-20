import { PrismaClient } from '@prisma/client';
import { getIO } from '../socket';
import { logger } from '../utils/logger';
import { AppError, NotFoundError, ForbiddenError, BadRequestError } from '../utils/appError';

import prisma from '../config/prisma';

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

// The Subject catalog model was removed (no code ever created rows in it — this
// always returned an empty list in practice). Kept as a stub so /api/subjects
// keeps its existing {message, data: []} contract for the Flutter client, which
// already falls back to a hardcoded subject list whenever this comes back empty.
export const listSubjects = async () => {
  return [] as Array<{ id: string; teacherId: string; name: string; code: string }>;
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

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (!target) throw new NotFoundError('User not found');
  if (target.role !== 'TEACHER') throw new BadRequestError('Only teacher accounts can be approved');

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
