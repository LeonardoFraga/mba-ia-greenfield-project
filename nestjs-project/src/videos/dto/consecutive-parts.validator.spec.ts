import { IsConsecutiveFromOneConstraint } from './consecutive-parts.validator';

describe('IsConsecutiveFromOneConstraint', () => {
  const constraint = new IsConsecutiveFromOneConstraint();

  const parts = (...numbers: unknown[]) =>
    numbers.map((partNumber) => ({ partNumber, etag: 'e' }));

  it('should accept a single part numbered 1', () => {
    expect(constraint.validate(parts(1))).toBe(true);
  });

  it('should accept consecutive parts in order', () => {
    expect(constraint.validate(parts(1, 2, 3))).toBe(true);
  });

  it('should accept consecutive parts reported out of order', () => {
    // The service sorts before sending, so arrival order is not the contract.
    expect(constraint.validate(parts(3, 1, 2))).toBe(true);
  });

  it('should reject a sequence that does not start at 1', () => {
    expect(constraint.validate(parts(2, 3))).toBe(false);
  });

  it('should reject a sequence with a gap', () => {
    // S3 answers 400 InvalidPartOrder for this; catching it here keeps the
    // storage-level complaint from reaching the client.
    expect(constraint.validate(parts(1, 3))).toBe(false);
  });

  it('should reject duplicated part numbers', () => {
    expect(constraint.validate(parts(1, 1, 2))).toBe(false);
  });

  it('should reject an empty array', () => {
    expect(constraint.validate([])).toBe(false);
  });

  it('should reject a non-array value', () => {
    expect(constraint.validate('nope')).toBe(false);
    expect(constraint.validate(undefined)).toBe(false);
  });

  it('should reject entries whose partNumber is not a number', () => {
    expect(constraint.validate(parts('1'))).toBe(false);
  });

  it('should name the property in its default message', () => {
    const message = constraint.defaultMessage({
      property: 'parts',
    } as Parameters<typeof constraint.defaultMessage>[0]);

    expect(message).toContain('parts');
  });
});
