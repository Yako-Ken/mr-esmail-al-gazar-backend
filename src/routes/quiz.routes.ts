// Quiz Routes — single-purpose, deliberately narrow.
//
// This router used to be `app.use('/api/quiz', trackingRoutes)`, which mounted
// the ENTIRE tracking router a second time. That re-published six endpoints
// under a second prefix, including `/api/quiz/:lessonId` and
// `/api/quiz/:trackingId/grade-essay` — a second route to every
// session-scanning and grading path, each of which the tracking router already
// exposes under its canonical `/api/trackings` prefix.
//
// Only one endpoint here is actually consumed, by the client:
//   GET /api/quiz/pending-essays   (features/teacher/screens/essay_submissions_screen.dart)
//
// The rest of the tracking surface stays reachable at /api/trackings/*, exactly
// once, where it belongs.
import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { getPendingEssays } from './tracking.routes';

const router = Router();

router.get('/pending-essays', authMiddleware, getPendingEssays);

export default router;
