jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { PrivateKey } from '@wharfkit/antelope';
import { fromPrivateKey, isValidPrivateKey } from '../keys';

test('legacy 5-prefixed WIF imports preserve the same public identity', () => {
  const key = PrivateKey.generate('K1');
  const wif = key.toWif();
  expect(wif).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{50}$/);
  expect(isValidPrivateKey(wif)).toBe(true);
  expect(fromPrivateKey(wif)).toMatchObject({
    privateKey: String(key), publicKey: String(key.toPublic()),
  });
});

test.each(['WIF', 'PVT_K1'])('%s import tolerates pasted whitespace and invisible separators', (format) => {
  const key = PrivateKey.generate('K1');
  const encoded = format === 'WIF' ? key.toWif() : String(key);
  const pasted = ` \t${encoded.slice(0, 12)}\r\n\u00a0${encoded.slice(12, 24)}\u200b\u200c\u200d\u2060\ufeff${encoded.slice(24)}\n`;
  expect(isValidPrivateKey(pasted)).toBe(true);
  expect(fromPrivateKey(pasted)).toMatchObject({
    privateKey: String(key), publicKey: String(key.toPublic()),
  });
});

test('paste cleanup still rejects damaged or multiple private keys', () => {
  const wif = PrivateKey.generate('K1').toWif();
  const changedChecksum = wif.slice(0, -1) + (wif.endsWith('1') ? '2' : '1');
  for (const invalid of [wif.slice(0, -1), changedChecksum, `${wif} ${wif}`, `“${wif}”`, `${wif.slice(0, 10)}0${wif.slice(11)}`]) {
    expect(isValidPrivateKey(invalid)).toBe(false);
    expect(() => fromPrivateKey(invalid)).toThrow('importSecret.keyParseFailed');
  }
});

test('valid private-key import still returns the same key and public identity', () => {
  const key = PrivateKey.generate('K1');
  expect(fromPrivateKey(String(key))).toMatchObject({ privateKey: String(key), publicKey: String(key.toPublic()) });
});
test('private-key parser errors cannot echo input into the UI', () => {
  const input = 'synthetic sensitive input';
  const parser = jest.spyOn(PrivateKey, 'from').mockImplementationOnce(() => { throw new Error(`Invalid key: ${input}`); });
  try {
    expect(() => fromPrivateKey(input)).toThrow('importSecret.keyParseFailed');
  } finally { parser.mockRestore(); }
});
