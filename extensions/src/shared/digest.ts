import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';

/**
 * Deterministic JSON: object keys sorted, no whitespace. Rejects values that JSON would
 * silently drop or distort, so two different manifests can never share a digest.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new DomainError('NON_CANONICAL_VALUE', `${path} is not a finite number`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new DomainError('NON_CANONICAL_VALUE', `${path} must be a plain object`);
      const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new DomainError('NON_CANONICAL_VALUE', `${path}.${key} is undefined; omit the key or use null`);
        return `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`;
      });
      return `{${entries.join(',')}}`;
    }
    default:
      throw new DomainError('NON_CANONICAL_VALUE', `${path} has unsupported type ${typeof value}`);
  }
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function signPayload(payload: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

export function verifySignature(payload: unknown, signature: string, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signPayload(payload, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
