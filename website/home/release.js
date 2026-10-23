(() => {
  'use strict';
  const repository = 'HuangLittleOrange/eos3wallet';
  const base = `https://github.com/${repository}`;
  const downloadOrigin = 'https://wallet.eos3.app';
  const names = ['wallet-release.apk', 'SHA256SUMS', 'android-release-evidence.zip'];
  let current;
  let currentIOS;

  function validate(data) {
    if (!data || data.draft !== false || data.prerelease !== false || !Number.isSafeInteger(data.id) || data.id <= 0 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(data.tag_name) || data.html_url !== `${base}/releases/tag/${data.tag_name}` ||
        !/^[a-f0-9]{40}$/.test(data.target_commitish) || !Array.isArray(data.assets)) throw new Error('Invalid release');
    const version = /^EOS³ Wallet v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?) · Android$/.exec(data.name);
    if (!version) throw new Error('Invalid app version');
    const assets = {};
    const prefix = data.mirror?.prefix;
    if (data.mirror?.schemaVersion !== 1 || data.mirror.repository !== repository ||
        typeof prefix !== 'string' || !prefix.startsWith(`/downloads/${data.tag_name}/${data.id}-`) ||
        !/^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\/[1-9]\d*-[a-f0-9]{16}\/$/.test(prefix)) throw new Error('Invalid server mirror');
    for (const name of names) {
      const matches = data.assets.filter(asset => asset.name === name);
      if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest) ||
          matches[0].browser_download_url !== `${base}/releases/download/${data.tag_name}/${name}` ||
          matches[0].mirror_url !== `${prefix}${name}`) throw new Error('Invalid release asset');
      assets[name] = matches[0];
    }
    return { version: version[1], url: data.html_url, assets };
  }

  function render() {
    const english = document.documentElement.lang === 'en';
    const guide = document.getElementById('readme-link');
    if (guide) guide.href = `${base}/blob/main/${english ? 'README.md' : 'README.zh-CN.md'}`;
    if (current) {
      document.getElementById('release-version').textContent = `v${current.version}`;
      document.getElementById('apk-sha256').textContent = current.assets[names[0]].digest.slice(7);
      for (const [id, name] of [['apk-download', names[0]], ['checksum-download', names[1]], ['evidence-download', names[2]]]) {
        document.getElementById(id).href = downloadOrigin + current.assets[name].mirror_url;
      }
      document.getElementById('github-download').href = current.assets[names[0]].browser_download_url;
      document.getElementById('release-page').href = current.url;
    }
    if (currentIOS) {
      document.querySelector('[data-i18n="iosDescription"]').textContent = english
        ? `EOS³ Wallet ${currentIOS.versionName} is available on TestFlight. No device ID registration required.`
        : `EOS³ Wallet ${currentIOS.versionName} 已开放 TestFlight 测试，无需登记设备 ID。`;
    }
    const status = document.getElementById('release-sync');
    if (status) status.textContent = english
      ? 'Downloads verified and synced by the server.' : '下载信息已由后台同步并校验';
  }

  document.addEventListener('DOMContentLoaded', () => {
    try {
      current = validate(JSON.parse(document.getElementById('release-data').textContent));
    } catch { /* Preserve the complete server-rendered release if embedded data is unavailable. */ }
    try {
      const data = JSON.parse(document.getElementById('ios-release-data').textContent);
      if (data && /^\d+\.\d+\.\d+$/.test(data.versionName) &&
          Number.isSafeInteger(data.versionCode) && data.versionCode > 0 &&
          data.apkUrl === document.getElementById('ios-download').href) currentIOS = data;
    } catch { /* Preserve the server-rendered iOS description if metadata is unavailable. */ }
    render();
  });
  document.addEventListener('eos3-language-change', render);
})();
