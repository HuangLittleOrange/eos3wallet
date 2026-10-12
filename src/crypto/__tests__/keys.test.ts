jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { PrivateKey } from '@wharfkit/antelope';
import { fromPrivateKey } from '../keys';

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
