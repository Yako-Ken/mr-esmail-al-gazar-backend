import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise is forwarded to Express
 * instead of becoming an unhandled rejection.
 *
 * Express 4 does not await route handlers. An `async` handler that throws or
 * rejects therefore never reaches the error-handling middleware — it becomes an
 * unhandled rejection, which on Node 24 terminates the process. One transient
 * `SQLITE_BUSY` would drop every in-flight request, socket and upload.
 *
 * Express 5 forwards these natively, making this wrapper redundant but harmless.
 *
 * @example
 *   router.get('/thing', asyncHandler(async (req, res) => {
 *     const rows = await prisma.thing.findMany();
 *     res.json(rows);
 *   }));
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      // A handler that throws synchronously (before its first await).
      next(error);
    }
  };
}
