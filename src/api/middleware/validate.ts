import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodType } from 'zod';

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(422).json({ success: false, error: 'validation failed' });
      return;
    }
    req.body = result.data;
    next();
  };
}
