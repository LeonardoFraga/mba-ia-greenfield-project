import {
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

interface HasPartNumber {
  partNumber?: unknown;
}

/**
 * S3 requires the parts of a completed multipart upload to start at 1 and be
 * consecutive; otherwise it answers `400 InvalidPartOrder`. Validating it here
 * turns that into the project's own validation error instead of letting a
 * storage-level complaint surface to the client.
 */
@ValidatorConstraint({ name: 'isConsecutiveFromOne', async: false })
export class IsConsecutiveFromOneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value) || value.length === 0) return false;

    const numbers = (value as HasPartNumber[]).map((item) => item.partNumber);
    if (numbers.some((n) => typeof n !== 'number')) return false;

    const sorted = [...(numbers as number[])].sort((a, b) => a - b);
    return sorted.every((n, index) => n === index + 1);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must contain part numbers starting at 1 with no gaps`;
  }
}

export function IsConsecutiveFromOne(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      validator: IsConsecutiveFromOneConstraint,
    });
  };
}
