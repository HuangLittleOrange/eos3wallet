import { ANCHOR_WEB_RETURN_URL, isAnchorWebReturnUrl } from '../anchorWebReturn';

test('Anchor transport wake-up preserves the current create/import route', () => {
  expect(isAnchorWebReturnUrl(ANCHOR_WEB_RETURN_URL)).toBe(true);
  expect(isAnchorWebReturnUrl(`${ANCHOR_WEB_RETURN_URL}?status=complete`)).toBe(true);
  expect(isAnchorWebReturnUrl(`${ANCHOR_WEB_RETURN_URL}#complete`)).toBe(true);
});

test('wallet import and external binding links still navigate normally', () => {
  expect(isAnchorWebReturnUrl('eos3wallet://device-key-authorized?provider=anchor&purpose=create')).toBe(false);
  expect(isAnchorWebReturnUrl('eos3wallet://device-key-authorized')).toBe(false);
  expect(isAnchorWebReturnUrl('https://eos3.app/tgbind?bindId=example')).toBe(false);
  expect(isAnchorWebReturnUrl(`${ANCHOR_WEB_RETURN_URL}-other`)).toBe(false);
});
