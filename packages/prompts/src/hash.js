// Content hash for prompt versions. Used as the version identity: two runs
// that reference the same hash ran the same bytes of instruction.
import { createHash } from 'node:crypto';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
