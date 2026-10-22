// ESR payloads are tiny (a few KB at most). A hostile `esr:` QR/deep link or a
// malicious Anchor relay can otherwise hand pako a deflate bomb and exhaust the
// JS heap. Cap both the compressed input and the inflated output.
import { Inflate, deflateRaw } from 'pako';

export const MAX_ESR_COMPRESSED = 16 * 1024;
export const MAX_ESR_INFLATED = 256 * 1024;

/** pako-compatible raw inflate with a hard output limit. */
export function boundedInflateRaw(data: Uint8Array): Uint8Array {
  if (data.length > MAX_ESR_COMPRESSED) throw new Error('ESR payload too large');
  const inflator = new Inflate({ raw: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  inflator.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > MAX_ESR_INFLATED) throw new Error('ESR payload too large');
    chunks.push(chunk);
  };
  inflator.push(data, true);
  if (inflator.err) throw new Error(inflator.msg || 'Invalid ESR payload');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Shared by `esr:` parsing and the Anchor web relay. `deflateRaw` is only used
 * for requests we build ourselves, so it stays unbounded. */
export const ESR_ZLIB = { zlib: { deflateRaw, inflateRaw: boundedInflateRaw } };
