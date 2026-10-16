import { toApiError } from './api-error';

/** User-facing message for any failed request. */
export function errorMessage(err: unknown): string {
  return toApiError(err).message;
}

export function errorCode(err: unknown): string {
  return toApiError(err).code;
}
