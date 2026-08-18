import { describe, expect, it } from 'vitest';
import { body, HttpError, intValue, requestIdempotencyKey } from '../netlify/lib/http';

function expectHttpError(fn: () => unknown, status: number) {
  try {
    fn();
    throw new Error('Expected HttpError');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
  }
}

describe('request validation', () => {
  it('accepts safe integer numbers and integer strings', () => {
    expect(intValue(12, 'value')).toBe(12);
    expect(intValue('12', 'value')).toBe(12);
  });

  it('does not coerce malformed values into integers', () => {
    for (const value of [null, true, false, '', '1.5', [], {}]) {
      expectHttpError(() => intValue(value, 'value'), 400);
    }
  });

  it('enforces integer bounds', () => {
    expectHttpError(() => intValue(0, 'gameId', { min: 1 }), 400);
    expectHttpError(() => intValue(11, 'stake', { max: 10 }), 400);
  });

  it('rejects non-object JSON request bodies', async () => {
    await expect(body(new Request('https://example.test', { method: 'POST', body: 'null' }))).rejects.toMatchObject({ status: 400 });
    await expect(body(new Request('https://example.test', { method: 'POST', body: '[]' }))).rejects.toMatchObject({ status: 400 });
  });

  it('normalizes idempotency keys and rejects empty keys', () => {
    const request = new Request('https://example.test', { headers: { 'idempotency-key': '  abc-123  ' } });
    expect(requestIdempotencyKey(request)).toBe('abc-123');
    expectHttpError(() => requestIdempotencyKey(new Request('https://example.test')), 400);
  });
});
