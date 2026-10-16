import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { toApiError } from './api-error';

describe('toApiError', () => {
  it('maps the API error envelope', () => {
    const err = new HttpErrorResponse({
      status: 403,
      error: { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed', requestId: 'r-1' } },
    });
    expect(toApiError(err)).toEqual({ status: 403, code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed', requestId: 'r-1' });
  });

  it('maps network failures', () => {
    expect(toApiError(new HttpErrorResponse({ status: 0 })).code).toBe('NETWORK_ERROR');
  });

  it('falls back to the X-Request-Id header and a generic message', () => {
    const err = new HttpErrorResponse({ status: 502, error: 'Bad gateway', headers: new HttpHeaders({ 'X-Request-Id': 'hdr-9' }) });
    expect(toApiError(err)).toMatchObject({ status: 502, code: 'HTTP_ERROR', requestId: 'hdr-9' });
  });

  it('handles non-HTTP errors', () => {
    expect(toApiError(new Error('x')).code).toBe('UNKNOWN');
  });
});
