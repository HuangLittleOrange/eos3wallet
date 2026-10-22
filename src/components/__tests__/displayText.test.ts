import { safeDisplayText } from '../displayText';

test('renders bidi overrides and zero-width spaces visibly', () => {
  expect(safeDisplayText('a\u202Eb')).toBe('a⟨U+202E⟩b');
  expect(safeDisplayText('a\u200Bb')).toBe('a⟨U+200B⟩b');
  expect(safeDisplayText('a\u2066b\u2069')).toBe('a⟨U+2066⟩b⟨U+2069⟩');
});

test('keeps newlines, tabs and emoji joiners', () => {
  expect(safeDisplayText('line1\nline2\ttab')).toBe('line1\nline2\ttab');
  expect(safeDisplayText('👨\u200D👩')).toBe('👨\u200D👩');
});

test('leaves ordinary text untouched', () => {
  expect(safeDisplayText('memo 你好 123')).toBe('memo 你好 123');
});
