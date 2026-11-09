import { createHash } from 'node:crypto';
import { canonicalizeEx } from 'json-canonicalize';
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from './project-manifest.js';
export { greatestCommonDivisor } from './shared-internal.js';

export function parseProjectManifest(input: unknown): ProjectManifest {
  return ProjectManifestSchema.parse(input);
}

function assertJsonData(
  value: unknown,
  ancestors = new WeakSet<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(
      `Canonical JSON cannot contain values of type "${typeof value}"`,
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON cannot contain circular references');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('Canonical JSON cannot contain sparse arrays');
      }
      assertJsonData(value[index], ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON objects must be plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Canonical JSON cannot contain symbol keys');
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError(
          'Canonical JSON objects cannot contain accessor properties',
        );
      }
      assertJsonData(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

export function canonicalJson(value: unknown): string {
  assertJsonData(value);
  return canonicalizeEx(value, { strictUndefined: true });
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
