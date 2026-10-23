import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const home = new URL('../../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', home), 'utf8');
const script = fs.readFileSync(new URL('release.js', home), 'utf8');
const android = JSON.parse(/id="release-data" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
for (const version of ['1.0.12', '1.0.13']) {
  const nodes = new Map([
    ['release-data', {textContent: JSON.stringify(android)}],
    ['ios-release-data', {textContent: JSON.stringify({versionName: version, versionCode: 37, apkUrl: 'https://testflight.apple.com/join/BJrMV91r'})}],
    ['ios-download', {href: 'https://testflight.apple.com/join/BJrMV91r'}],
  ]);
  const description = {};
  const listeners = {};
  const document = {
    documentElement: {lang: 'zh-CN'},
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    querySelector(selector) { assert.equal(selector, '[data-i18n="iosDescription"]'); return description; },
    addEventListener(name, fn) { listeners[name] = fn; },
  };
  vm.runInNewContext(script, {document, fetch() { assert.fail('No visitor-side version requests'); }});
  listeners.DOMContentLoaded();
  assert.match(description.textContent, new RegExp(version.replaceAll('.', '\\.')));
  assert.doesNotMatch(description.textContent, /37/);
  assert.equal(description.textContent, `EOS³ Wallet ${version} 已开放 TestFlight 测试，无需登记设备 ID。`);
  document.documentElement.lang = 'en';
  listeners['eos3-language-change']();
  assert.equal(description.textContent, `EOS³ Wallet ${version} is available on TestFlight. No device ID registration required.`);
  assert.equal(nodes.get('release-version').textContent, 'v1.0.10');
}
console.log('PASS: future iOS versions, Chinese/English switching, hidden build number, and Android rendering');
