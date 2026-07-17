import { AuthUser } from '../middlewares/auth.middleware';

// An ASSISTANT acts on behalf of the teacher who created them, so anywhere we'd
// scope a query/mutation to "the current teacher", an assistant must resolve to
// their parentTeacherId instead of their own id. Duplicated across every
// teacher-facing controller before this was extracted.
export const resolveOwnerId = (authUser: AuthUser): string =>
  authUser.role === 'ASSISTANT' && authUser.parentTeacherId
    ? authUser.parentTeacherId
    : authUser.id;
