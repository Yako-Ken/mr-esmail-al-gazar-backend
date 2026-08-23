import { Request, Response } from 'express';
import { AuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';
import {
  listAdminCourses,
  setCoursePublication,
} from '../services/adminModeration.service';

type AuthenticatedRequest = Request & { user?: AuthUser };

const requireUser = (req: AuthenticatedRequest, res: Response): AuthUser | null => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return req.user;
};

export const listCourses = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!requireUser(req, res)) return;
    const result = await listAdminCourses({
      status: req.query.status as 'ALL' | 'PUBLISHED' | 'DRAFT' | undefined,
      page: req.query.page as number | undefined,
      limit: req.query.limit as number | undefined,
    });
    res.json(result);
  } catch (error) {
    logger.error('listAdminCourses error:', error);
    res.status(500).json({ error: 'Unable to load courses' });
  }
};

export const moderateCourse = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const publish = req.params.action === 'publish';
    if (!publish && req.params.action !== 'unpublish') {
      res.status(404).json({ error: 'Unknown moderation action' });
      return;
    }

    const outcome = await setCoursePublication(
      user.id,
      String(req.params.courseId),
      publish,
    );

    switch (outcome.code) {
      case 'NOT_FOUND':
        res.status(404).json({ error: 'Course not found' });
        return;
      case 'NO_LESSONS':
        res.status(409).json({
          error: 'Add at least one lesson before publishing the course',
          code: 'COURSE_NOT_READY',
        });
        return;
      case 'ALREADY_PUBLISHED':
        res.status(409).json({ error: 'Course is already published', code: 'ALREADY_PUBLISHED' });
        return;
      case 'ALREADY_DRAFT':
        res.status(409).json({ error: 'Course is already a draft', code: 'ALREADY_DRAFT' });
        return;
      default:
        res.json({
          course: { id: String(req.params.courseId), title: outcome.title },
          isPublished: publish,
        });
    }
  } catch (error) {
    logger.error('moderateCourse error:', error);
    res.status(500).json({ error: 'Unable to moderate course' });
  }
};
