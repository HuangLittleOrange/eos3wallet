// Confirmation text comes from DApps (memos, signed messages, action fields).
// Unicode bidi overrides and zero-width characters are invisible but can reorder
// what the user reads, so render them as explicit escapes instead of hiding them.
// ZWNJ/ZWJ (U+200C/U+200D) stay untouched: they join emoji/script sequences and
// cannot reorder surrounding text.
const UNSAFE_DISPLAY =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function safeDisplayText(value: string): string {
  return value.replace(
    UNSAFE_DISPLAY,
    (ch) => `⟨U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  );
}
