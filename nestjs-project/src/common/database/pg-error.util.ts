import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

/** Shape of the `pg` driver error carried by TypeORM's QueryFailedError. */
interface PgDriverError {
  code?: string;
  detail?: string;
}

/**
 * True when the failure is a unique-constraint violation naming `column`.
 *
 * Shared rather than duplicated per service: this introspects driver internals
 * (`driverError.code` / `.detail`), and two copies would drift the moment the
 * driver changes its message shape.
 */
export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err.driverError as PgDriverError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
