import { randomBytes } from 'node:crypto';
import { PUBLIC_ID_BYTES } from './videos.constants';

/**
 * Generates the unguessable identifier the public URL is built from.
 *
 * `randomBytes` is a CSPRNG and `base64url` is already URL-safe, so no
 * dependency is involved: 8 bytes render as 11 characters with 64 bits of
 * entropy, which is what makes an unlisted video unenumerable.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
