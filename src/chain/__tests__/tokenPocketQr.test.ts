jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { TokenPocketQrCollector, tokenPocketCrc32, tokenPocketQrFrames } from '../tokenPocketQr';
test('CRC32 matches the standard vector and short requests remain a single QR', () => {
  expect(tokenPocketCrc32('123456789')).toBe(0xcbf43926);
  expect(tokenPocketQrFrames('short')).toEqual(['short']);
});
test('dynamic frames reassemble out of order, deduplicate and preserve UTF-8 payloads and underscores', () => {
  const text = '中文_tp:payload_with_underscores'.repeat(100);
  const frames = tokenPocketQrFrames(text), collector = new TokenPocketQrCollector();
  expect(frames.length).toBeGreaterThan(2);
  const indices = frames.map((_, i) => i).reverse();
  expect(collector.accept(frames[indices[0]]).received).toBe(1);
  expect(collector.accept(frames[indices[0]]).received).toBe(1);
  let result: ReturnType<TokenPocketQrCollector['accept']>;
  for (const i of indices) result = collector.accept(frames[i]);
  expect(result!.text).toBe(text);
});
test('mixed streams, conflicting duplicates, invalid indices and bad checksums are rejected', () => {
  const frames = tokenPocketQrFrames('A'.repeat(1800)), collector = new TokenPocketQrCollector();
  collector.accept(frames[0]);
  expect(() => collector.accept(tokenPocketQrFrames('B'.repeat(1800))[1])).toThrow();
  const prefix = 'tp:multiFragment-version=1.0&protocol=TokenPocket&data=';
  const payload = JSON.parse(frames[0].slice(prefix.length));
  expect(() => collector.accept(prefix + JSON.stringify({ ...payload, content: 'bad_' + tokenPocketCrc32('A'.repeat(1800)) }))).toThrow();
  for (const index of ['-1/2', '2/2', '0/257', '0/0', '1e0/2']) {
    expect(() => new TokenPocketQrCollector().accept(prefix + JSON.stringify({ ...payload, index }))).toThrow();
  }
  expect(() => new TokenPocketQrCollector().accept(prefix + JSON.stringify({ content: 'bad_0', index: '0/1' }))).toThrow();
});
test('URI-heavy request frames stay small enough for TP camera scanning', () => {
  const prefix = 'tp:multiFragment-version=1.0&protocol=TokenPocket&data=';
  const request = 'eosio:signTransaction-version=1.0&protocol=TokenPocket&network=eosio&chain_id=' +
    'a'.repeat(64) + '&data=' + JSON.stringify({
      tx: { actions: Array.from({ length: 3 }, () => ({ account: 'core.vaulta', name: 'transfer', data: 'ab'.repeat(180) })) },
      account: 'eos3coldtest', publicKey: 'EOS' + 'a'.repeat(50),
    });
  const frames = tokenPocketQrFrames(request);
  expect(frames.length).toBeGreaterThan(4);
  for (const frame of frames) {
    const { content } = JSON.parse(frame.slice(prefix.length));
    const part = content.slice(0, content.lastIndexOf('_'));
    expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(300);
  }
  const collector = new TokenPocketQrCollector();
  let result;
  for (const frame of frames.slice(1)) result = collector.accept(frame);
  expect(result?.text).toBeUndefined();
  expect(collector.accept(frames[0]).text).toBe(request);
});
test('smaller frames preserve the 64 KiB payload limit, including UTF-8 boundaries', () => {
  for (const text of ['x'.repeat(65536), '中'.repeat(21845) + 'x']) {
    const frames = tokenPocketQrFrames(text), collector = new TokenPocketQrCollector();
    expect(frames.length).toBeLessThanOrEqual(256);
    let result;
    for (const frame of frames) result = collector.accept(frame);
    expect(result?.text).toBe(text);
  }
});
test('oversized payloads are bounded and an unrelated scan cannot navigate or execute anything', () => {
  expect(() => tokenPocketQrFrames('x'.repeat(65537))).toThrow('tooLarge');
  const collector = new TokenPocketQrCollector();
  expect(collector.accept('https://untrusted.invalid/').text).toBe('https://untrusted.invalid/');
  expect(() => collector.accept('x'.repeat(65537))).toThrow();
});
