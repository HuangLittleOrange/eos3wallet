import { sensitiveInputProps } from '../sensitiveInputProps';

declare const __dirname: string;
const { readdirSync, readFileSync } = require('fs');
const { join, relative } = require('path');
const ts = require('typescript');
const root = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    if (entry.name === '__tests__') return [];
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.tsx') ? [file] : [];
  });
}

// Catch forgotten fields, including conditionally revealed passwords. Check JSX
// attributes rather than regex so arrows, comparisons and multiline props work.
function unprotectedInputs(text: string, secretImport: boolean): number {
  const source = ts.createSourceFile('screen.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let missing = 0;
  const visit = (node: any) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'TextInput') {
      const attrs = node.attributes.properties;
      if (secretImport || attrs.some((attr: any) => attr.name?.getText(source) === 'secureTextEntry')) {
        const policy = attrs.findIndex((attr: any) => ts.isJsxSpreadAttribute(attr) && attr.expression.getText(source) === 'sensitiveInputProps');
        const overridden = attrs.slice(policy + 1).some((attr: any) => ts.isJsxSpreadAttribute(attr) || attr.name?.getText(source) in sensitiveInputProps);
        if (policy < 0 || overridden) missing++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return missing;
}

test('every wallet password, private-key and mnemonic input uses the no-autofill policy', () => {
  const missing = sourceFiles(root).filter(file => unprotectedInputs(readFileSync(file, 'utf8'), file.endsWith('/ImportSecretScreen.tsx')))
    .map(file => relative(root, file));
  expect(missing).toEqual([]);
});

test('coverage guard catches missing policy and later overrides, including revealed passwords', () => {
  expect(unprotectedInputs('<TextInput secureTextEntry={!visible} />', false)).toBe(1);
  expect(unprotectedInputs('<TextInput multiline onChangeText={text => setSecret(text)} />', true)).toBe(1);
  expect(unprotectedInputs('<TextInput secureTextEntry {...sensitiveInputProps} autoComplete="username" />', false)).toBe(1);
  expect(unprotectedInputs('<TextInput secureTextEntry {...sensitiveInputProps} {...other} />', false)).toBe(1);
  expect(unprotectedInputs('<TextInput secureTextEntry {...sensitiveInputProps} editable={!busy} />', false)).toBe(0);
});
