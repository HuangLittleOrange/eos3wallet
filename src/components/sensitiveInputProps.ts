import type { TextInputProps } from 'react-native';

/**
 * Wallet secrets are not website login credentials. Apply to every password,
 * private-key and mnemonic input, including when a password is revealed.
 * iOS gives textContentType precedence; both hints explicitly disable AutoFill.
 * Keep webcredentials:eos3.app in app.json: native Passkeys require that domain.
 */
export const sensitiveInputProps = Object.freeze({
  textContentType: 'none',
  autoComplete: 'off',
  importantForAutofill: 'no',
  autoCapitalize: 'none',
  autoCorrect: false,
  spellCheck: false,
  smartInsertDelete: false,
} as const satisfies TextInputProps);
