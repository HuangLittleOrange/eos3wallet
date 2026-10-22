import { deflateRaw } from 'pako';

import { boundedInflateRaw, MAX_ESR_COMPRESSED, MAX_ESR_INFLATED } from '../esrZlib';

test('round trips a normal ESR payload', () => {
  const input = new TextEncoder().encode('esr://small-request');
  const output = boundedInflateRaw(deflateRaw(input));
  expect(new TextDecoder().decode(output)).toBe('esr://small-request');
});

test('rejects a decompression bomb instead of allocating it', () => {
  const bomb = deflateRaw(new Uint8Array(MAX_ESR_INFLATED + 1));
  expect(bomb.length).toBeLessThan(MAX_ESR_COMPRESSED);
  expect(() => boundedInflateRaw(bomb)).toThrow();
});

test('rejects oversized compressed input', () => {
  expect(() => boundedInflateRaw(new Uint8Array(MAX_ESR_COMPRESSED + 1))).toThrow();
});
