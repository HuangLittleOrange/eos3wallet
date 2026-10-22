import type { TextInputProps } from 'react-native';

/**
 * Wallet secrets are not website login credentials. Apply to every password,
 * private-key and mnemonic input, including when a password is revealed.
 * iOS gives textContentType precedence. `none` maps to an empty native content
 * type and can still let secureTextEntry trigger reusable-password heuristics.
 * Use the non-credential oneTimeCode hint to avoid treating a local wallet
 * unlock as a website login. This may still offer system verification codes;
 * it does not change password masking or read SMS. Android uses autoComplete.
 * Keep webcredentials:eos3.app in app.json: native Passkeys require that domain.
 */
export const sensitiveInputProps = Object.freeze({
  textContentType: 'oneTimeCode',
  autoComplete: 'off',
  importantForAutofill: 'no',
  autoCapitalize: 'none',
  autoCorrect: false,
  spellCheck: false,
  smartInsertDelete: false,
} as const satisfies TextInputProps);
