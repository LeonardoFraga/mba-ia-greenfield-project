import type { Response } from 'supertest';

/**
 * Standard error envelope produced by `DomainExceptionFilter` and
 * `ValidationExceptionFilter` for every HTTP endpoint in the API.
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

/**
 * `supertest` types `Response.body` as `any`, so every assertion on it trips
 * the `no-unsafe-*` lint rules. Narrow the body once, at the assertion
 * boundary, instead of sprinkling casts through the specs.
 */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}

/** Shorthand for the most common assertion: the domain error code. */
export function errorOf(res: Response): string {
  return bodyOf<ApiErrorBody>(res).error;
}
