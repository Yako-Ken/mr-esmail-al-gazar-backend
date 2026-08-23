import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodType } from 'zod';

// Validates req.body against a zod schema and replaces it with the parsed (typed, trimmed) result.
export const validateBody = (schema: ZodType): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
};

// Validates req.query against a zod schema and replaces it with the parsed result.
export const validateQuery = (schema: ZodType): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    req.query = result.data as typeof req.query;
    next();
  };
};
