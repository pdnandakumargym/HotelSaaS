import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors.js';
import { errorBody } from '../shared/http.js';

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json(errorBody('ROUTE_NOT_FOUND', 'Route not found', req.requestId));
  };
}

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

/** Converts every thrown error into the standard envelope without leaking internals. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const requestId = req.requestId;

    if (err instanceof AppError) {
      if (!err.expose) logger.error({ err, requestId }, 'application error');
      res
        .status(err.status)
        .json(errorBody(err.code, err.expose ? err.message : 'Internal server error', requestId, err.expose ? err.details : undefined));
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json(
        errorBody('VALIDATION_FAILED', 'Request validation failed', requestId, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))),
      );
      return;
    }

    // Prisma known request errors: map constraint failures to client errors without leaking SQL.
    const prismaErr = err as { name?: string; code?: string; meta?: Record<string, unknown>; message?: string };
    if (prismaErr?.name === 'PrismaClientKnownRequestError' && typeof prismaErr.code === 'string') {
      const target = (prismaErr.meta?.['target'] ?? (prismaErr.meta?.['driverAdapterError'] as { cause?: { constraint?: { fields?: string[] } } } | undefined)?.cause?.constraint?.fields) as
        | string[]
        | string
        | undefined;
      switch (prismaErr.code) {
        case 'P2002':
          res.status(409).json(errorBody('ALREADY_EXISTS', 'A record with the same value already exists.', requestId, target ? { fields: target } : undefined));
          return;
        case 'P2003':
          res.status(409).json(errorBody('REFERENCE_INVALID', 'A related record does not exist, belongs elsewhere, or is still in use.', requestId));
          return;
        case 'P2025':
          res.status(404).json(errorBody('NOT_FOUND', 'Resource not found', requestId));
          return;
        case 'P2004':
        case 'P2011':
          res.status(400).json(errorBody('CONSTRAINT_VIOLATION', 'The data breaks a validation rule.', requestId));
          return;
      }
    }
    if (typeof prismaErr?.message === 'string' && /violates check constraint|invalid time zone/.test(prismaErr.message)) {
      res.status(400).json(errorBody('CONSTRAINT_VIOLATION', 'The data breaks a validation rule.', requestId));
      return;
    }

    // body-parser / http-errors style errors
    const httpErr = err as HttpLikeError;
    const status = httpErr?.status ?? httpErr?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const map: Record<string, [string, string]> = {
        'entity.too.large': ['PAYLOAD_TOO_LARGE', 'Request body is too large'],
        'entity.parse.failed': ['MALFORMED_JSON', 'Request body is not valid JSON'],
        'encoding.unsupported': ['UNSUPPORTED_ENCODING', 'Unsupported content encoding'],
      };
      const [code, message] = map[httpErr.type ?? ''] ?? ['BAD_REQUEST', 'Bad request'];
      res.status(status).json(errorBody(code, message, requestId));
      return;
    }

    logger.error({ err, requestId }, 'unhandled error');
    res.status(500).json(errorBody('INTERNAL_ERROR', 'Internal server error', requestId));
  };
}
