import type { Response } from 'express';

/** Consistent success envelope: `{ data, meta? }`. */
export function sendData<T>(res: Response, data: T, status = 200, meta?: Record<string, unknown>): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string | undefined;
  };
}

export function errorBody(code: string, message: string, requestId: string | undefined, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }), requestId } };
}
