import { t } from '../i18n';

const PREFIX = 'tp:multiFragment-version=1.0&protocol=TokenPocket&data=';
const MAX_BYTES = 65_536;
// Keep the URI/JSON-heavy first frame readable at the 280dp display size too.
// 600-byte chunks made it much denser than the mostly-hex following frames:
// TP could collect the latter while repeatedly missing the first one.
const FRAGMENT_BYTES = 300;
const MAX_FRAGMENTS = 256; // enough for the existing 64 KiB bound at 300 bytes/frame
const invalid = () => new Error(t('coldSigning.invalidResponse'));

/** TP v1 uses unsigned IEEE CRC32 over the complete UTF-8 payload. */
export function tokenPocketCrc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function tokenPocketQrFrames(payload: string): string[] {
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_BYTES) throw new Error(t('coldSigning.tooLarge'));
  if (bytes <= 800) return [payload];
  // Requests are ASCII (binary action data is hexadecimal); splitting code points
  // also keeps this helper safe when used with UTF-8 text fixtures.
  const parts: string[] = [];
  let part = '', size = 0;
  for (const char of payload) {
    const length = new TextEncoder().encode(char).length;
    if (size + length > FRAGMENT_BYTES) { parts.push(part); part = ''; size = 0; }
    part += char; size += length;
  }
  if (part) parts.push(part);
  if (parts.length > MAX_FRAGMENTS) throw new Error(t('coldSigning.tooLarge'));
  const checksum = tokenPocketCrc32(payload);
  return parts.map((content, index) => PREFIX + JSON.stringify({ content: `${content}_${checksum}`, index: `${index}/${parts.length}` }));
}

/** One bounded assembly per scan attempt; never mix independently checksummed streams. */
export class TokenPocketQrCollector {
  private checksum: number | undefined;
  private total = 0;
  private bytes = 0;
  private parts = new Map<number, string>();
  accept(raw: string): { text?: string; received: number; total: number } {
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw invalid();
    if (!raw.startsWith('tp:multiFragment')) return { text: raw, received: 1, total: 1 };
    if (!raw.startsWith(PREFIX) || raw.length > 8192) throw invalid();
    let payload: any;
    try {
      const data = raw.slice(PREFIX.length);
      payload = JSON.parse(data.startsWith('{') ? data : decodeURIComponent(data));
    } catch { throw invalid(); }
    if (typeof payload.content !== 'string' || typeof payload.index !== 'string') throw invalid();
    const index = /^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(payload.index);
    const split = payload.content.lastIndexOf('_');
    const suffix = payload.content.slice(split + 1);
    if (!index || split < 0 || !/^(0|[1-9][0-9]{0,9})$/.test(suffix)) throw invalid();
    const at = Number(index[1]), total = Number(index[2]), crc = Number(suffix);
    const content = payload.content.slice(0, split);
    if (total > MAX_FRAGMENTS || at >= total || crc > 0xffffffff ||
        this.checksum !== undefined && (this.checksum !== crc || this.total !== total)) throw invalid();
    if (this.parts.has(at) && this.parts.get(at) !== content) throw invalid();
    if (!this.parts.has(at)) {
      const size = new TextEncoder().encode(content).length;
      if (this.bytes + size > MAX_BYTES) throw invalid();
      this.parts.set(at, content); this.bytes += size;
    }
    this.checksum = crc; this.total = total;
    if (this.parts.size !== total) return { received: this.parts.size, total };
    const text = Array.from({ length: total }, (_, i) => this.parts.get(i)!).join('');
    if (tokenPocketCrc32(text) !== crc) throw invalid();
    return { text, received: total, total };
  }
}
