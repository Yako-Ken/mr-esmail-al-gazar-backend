import { Request, RequestHandler } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { handleControllerError } from '../middlewares/errorHandler';
import { logger } from '../utils/logger';
import { redactUser } from '../utils/redact';
import * as adminService from '../services/admin.service';

/**
 * Factory function: returns a route handler that fetches users by role.
 * Usage: router.get('/teachers', getUsersByRole('TEACHER'))
 */
export const getUsersByRole = (role: string): RequestHandler =>
  async (req, res): Promise<void> => {
    try {
      const users = await adminService.listUsersByRole(role);
      res.json({ data: users, total: users.length });
    } catch (error) {
      handleControllerError(`getUsersByRole(${role})`, error, res);
    }
  };

export const getSubjects: RequestHandler = async (req, res): Promise<void> => {
  try {
    const subjects = await adminService.listSubjects();

    if (subjects.length === 0) {
      res.json({ message: 'No subjects found in database', data: [] });
    } else {
      res.json(subjects);
    }
  } catch (error) {
    handleControllerError('getSubjects', error, res);
  }
};

export const getAllUsers: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { role, page = '1', limit = '20' } = req.query;

    const pageNumber = parseInt(page as string, 10);
    const limitNumber = parseInt(limit as string, 10);

    const { users, totalCount } = await adminService.listAllUsers({
      role: role && typeof role === 'string' ? role : undefined,
      page: pageNumber,
      limit: limitNumber,
    });

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
    handleControllerError('getAllUsers', error, res);
  }
};

export const deleteUser: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { userId } = req.params;
    await adminService.deleteUserById(authUser.id, userId);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    handleControllerError('deleteUser', error, res);
  }
};

export const verifyTeacher: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { userId } = req.params;
    const { isVerified } = req.body;
    const updatedTeacher = await adminService.verifyTeacher(authUser.id, userId, isVerified);

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
    handleControllerError('verifyTeacher', error, res);
  }
};

export const updateUserPermissions: RequestHandler = async (req, res): Promise<void> => {
  try {
    const authUser = (req as Request & { user?: AuthUser }).user;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { userId } = req.params;
    const { permissions, subjectId } = req.body;
    const updatedUser = await adminService.updateUserPermissions(authUser.id, userId, permissions, subjectId);

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
    handleControllerError('updateUserPermissions', error, res);
  }
};

export const getUserPermissions: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { userId } = req.params;
    const targetUser = await adminService.getUserPermissions(userId);

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
    handleControllerError('getUserPermissions', error, res);
  }
};

export const getDashboardStats: RequestHandler = async (req, res): Promise<void> => {
  try {
    const stats = await adminService.getDashboardStats();
    res.json(stats);
  } catch (error) {
    handleControllerError('getDashboardStats', error, res);
  }
};

export const getPendingTeachers: RequestHandler = async (req, res): Promise<void> => {
  try {
    const pendingTeachers = await adminService.listPendingTeachers();
    res.json({ data: pendingTeachers, total: pendingTeachers.length });
  } catch (error) {
    handleControllerError('getPendingTeachers', error, res);
  }
};

export const approveTeacher: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updatedUser = await adminService.approveTeacher(id, status);
    res.json({ message: `Teacher ${status} successfully`, user: updatedUser });
  } catch (error) {
    handleControllerError('approveTeacher', error, res);
  }
};

/**
 * Fields a moderator is entitled to see on a profile.
 *
 * `admin.service.getStudentById` / `getTeacherById` load the `User` row with
 * `include` and no `select`, so their return value is the whole row. Handing
 * that straight to `res.json` published the bcrypt `password` hash, the
 * `deviceId` and `sessionVersion` used for device limits and token revocation,
 * the unverified `parentPhone` contact hint, and the `vodafoneCashNumber` /
 * `instapayHandle` payment identifiers — none of which account moderation needs,
 * and all of which turn a read-only profile view into a credential and payment
 * disclosure.
 *
 * So both handlers project an allow-list instead of spreading. Guardian
 * *linkage* survives (the moderator still needs to tell a linked account from an
 * unlinked one) while the guardian's own phone number does not: that is a third
 * party's contact detail, pulled in only because the relation is included.
 */
const projectProfileScalars = <
  T extends {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    role: string;
    status: string;
    isApproved: boolean;
    isVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
>(
  user: T,
) => ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  email: user.email,
  role: user.role,
  status: user.status,
  isApproved: user.isApproved,
  isVerified: user.isVerified,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

export const getStudentById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const student = await adminService.getStudentById(id);

    const data = {
      ...projectProfileScalars(student),
      studentRelations: student.studentRelations.map((relation) => ({
        id: relation.id,
        studentId: relation.studentId,
        parentId: relation.parentId,
        // Identity of the guardian, not their contact details.
        parent: { id: relation.parentId, name: relation.parent.name },
      })),
      courseEnrollments: student.courseEnrollments.map((enrollment) => ({
        id: enrollment.id,
        studentId: enrollment.studentId,
        courseId: enrollment.courseId,
        status: enrollment.status,
        createdAt: enrollment.createdAt,
        course: enrollment.course
          ? {
              id: enrollment.course.id,
              title: enrollment.course.title,
              subject: enrollment.course.subject,
              grade: enrollment.course.grade,
              isPublished: enrollment.course.isPublished,
              teacher: { id: enrollment.course.teacherId, name: enrollment.course.teacher.name },
            }
          : null,
      })),
    };

    logger.info('[GET /admin/users/students/:id] profile projected', redactUser(student));

    res.json({ data });
  } catch (error) {
    handleControllerError('getStudentById', error, res);
  }
};

export const getTeacherById: RequestHandler = async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const teacher = await adminService.getTeacherById(id);

    const data = {
      ...projectProfileScalars(teacher),
      // The service already narrows these two relations; they carry no personal
      // data, so they are passed through as returned.
      lessons: teacher.lessons,
      courses: teacher.courses,
    };

    logger.info('[GET /admin/users/teachers/:id] profile projected', redactUser(teacher));

    res.json({ data });
  } catch (error) {
    handleControllerError('getTeacherById', error, res);
  }
};
