import { HttpErrorResponse } from '@angular/common/http';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  /** Per-field issues (e.g. Zod validation errors); only set for VALIDATION_FAILED. */
  details?: { path: string; message: string }[];
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string; details?: { path: string; message: string }[] };
}

/** Appends the first field-level issue to a validation error's message, so the toast is actionable. */
function withDetail(message: string, details: { path: string; message: string }[] | undefined): string {
  if (!details?.length) return message;
  const first = details[0]!;
  const suffix = details.length > 1 ? ` (and ${details.length - 1} more)` : '';
  return `${message}: ${first.path ? `${first.path} — ` : ''}${first.message}${suffix}`;
}

/** Normalises any HTTP failure into the API's error envelope shape for display. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof HttpErrorResponse) {
    const body = (err.error ?? {}) as ErrorEnvelope;
    if (err.status === 0) {
      return { status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the StaySync API. Is it running?' };
    }
    const code = body.error?.code ?? 'HTTP_ERROR';
    const baseMessage = body.error?.message ?? `Request failed (${err.status})`;
    return {
      status: err.status,
      code,
      message: code === 'VALIDATION_FAILED' ? withDetail(baseMessage, body.error?.details) : baseMessage,
      requestId: body.error?.requestId ?? err.headers?.get('X-Request-Id') ?? undefined,
      details: body.error?.details,
    };
  }
  return { status: -1, code: 'UNKNOWN', message: 'Unexpected error' };
}
