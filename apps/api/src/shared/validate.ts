import type { Request } from 'express';
import type { z } from 'zod';
import { ValidationError } from './errors.js';

export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

export function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}
