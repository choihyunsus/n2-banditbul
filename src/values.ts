// Keep durable identifiers and configuration within explicit UTF-8 and JSON budgets.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export function utf8(maximum: number) {
  return z
    .string()
    .max(maximum)
    .refine(
      (value) =>
        Buffer.byteLength(value) <= maximum && Buffer.from(value).toString('utf8') === value,
      'Expected bounded, well-formed UTF-8 text',
    );
}
export const identity = utf8(128)
  .min(1)
  .regex(/^[^\s\p{Cc}]+$/u);
export const text = (maximum: number) =>
  utf8(maximum).refine(
    (value) => !!value.trim() && !/\p{Cc}/u.test(value),
    'Expected nonempty text without control characters',
  );
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const timestamp = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function encode(value: unknown, maximum = 131072): string {
  const result = JSON.stringify(value);
  if (typeof result !== 'string' || Buffer.byteLength(result) > maximum)
    throw new Error('JSON exceeds its supported byte limit');
  return result;
}
export function parseJson(value: unknown, maximum = 131072): unknown {
  return JSON.parse(utf8(maximum).parse(value));
}
