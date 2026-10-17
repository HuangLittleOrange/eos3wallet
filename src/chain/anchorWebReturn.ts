// This URL wakes the existing authorization screen without replacing its route
// params (including whether the user chose to create or import a wallet).
export const ANCHOR_WEB_RETURN_URL = 'eos3wallet://anchor-web-return';

export function isAnchorWebReturnUrl(url: string): boolean {
  return url.split(/[?#]/, 1)[0] === ANCHOR_WEB_RETURN_URL;
}
