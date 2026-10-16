import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

/**
 * Accepts an upstream correlation ID only if it is well-formed (prevents log
 * injection), otherwise generates one. Echoed on every response.
 */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get(REQUEST_ID_HEADER);
    req.requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}
