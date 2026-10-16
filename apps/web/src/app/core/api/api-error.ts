import { HttpErrorResponse } from '@angular/common/http';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  requestId?: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string };
}

/** Normalises any HTTP failure into the API's error envelope shape for display. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof HttpErrorResponse) {
    const body = (err.error ?? {}) as ErrorEnvelope;
    if (err.status === 0) {
      return { status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the StaySync API. Is it running?' };
    }
    return {
      status: err.status,
      code: body.error?.code ?? 'HTTP_ERROR',
      message: body.error?.message ?? `Request failed (${err.status})`,
      requestId: body.error?.requestId ?? err.headers?.get('X-Request-Id') ?? undefined,
    };
  }
  return { status: -1, code: 'UNKNOWN', message: 'Unexpected error' };
}
