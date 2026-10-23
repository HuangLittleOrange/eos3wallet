(() => {
  'use strict';
  const translations = {
    zh: Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(node => [node.dataset.i18n, node.textContent])),
    en: {
      skip: 'Skip to content', navExperience: 'Experience', navSecurity: 'Security & transparency', navFaq: 'FAQ', getWallet: 'Get the wallet',
      heroEyebrow: 'Built for EOS', headlineOne: 'Your onchain life.', headlineTwo: 'Made simpler.',
      heroDescription: 'From your first transfer to your next DApp. One wallet for your assets and everyday life onchain.', explore: 'Explore EOS³', heroNote: 'Mobile experience · EOS mainnet · Open source',
      floatOne: 'Your assets, clearly organized', portfolio: 'Portfolio', demoBalance: 'Illustrative assets · Not a real balance', send: 'Send', receive: 'Receive', resources: 'Resources', assets: 'My assets', wallet: 'Wallet', discover: 'Discover', me: 'Profile',
      floatTwo: 'Review before every signature', floatThree: 'Account, network and transaction', illustrationNote: 'AI-generated product illustration. Interface and data are demonstrative.', ecosystem: 'Connected to your onchain world',
      experienceEyebrow: 'One wallet. More possibilities.', experienceTitle: 'Everyday onchain, in one place.', experienceIntro: 'Bring your assets, resources and apps together, with clarity at every step.',
      featureAssets: 'A clear view of your assets', featureAssetsDesc: 'View balances and history. Send, receive and manage saved addresses.', featureResources: 'Manage your resources', featureResourcesDesc: 'Understand RAM, CPU and NET, and manage the resources you need.', featureDapps: 'Explore and connect', featureDappsDesc: 'Browse DApps, review signatures and manage your connected sessions.', previewLabel: 'Feature preview · Example data',
      entryEyebrow: 'Start in a way that suits you', entryTitle: 'Your first steps,\nyour own way.', entryIntro: 'Bring an existing account or create a new one. Choose the wallet entry point that fits how you work.', entryImport: 'Import an existing wallet', entryImportDesc: 'Import with a private key, or add a watch-only account to view onchain assets.', entryPasskey: 'Google / Passkey', entryPasskeyDesc: 'Use convenient login and authentication options, supported by the corresponding login and signing services.', entryCreate: 'Create an account', entryCreateDesc: 'Follow the in-app flow, and review fees and permissions before submitting.',
      securityEyebrow: 'Clarity inspires confidence', securityTitle: 'Multiple layers of protection for your assets.', securityIntro: 'Local encryption, biometric unlocking, transaction review and permission management work together to protect your wallet.', securityKeys: 'Encrypted on your device', securityKeysDesc: 'Imported standard private keys are encrypted with your master password and saved in system secure storage. Biometric unlocking is supported.', securitySign: 'Review what you sign', securitySignDesc: 'Check the account, network, operations and fees. Manage and revoke DApp connections and persistent sessions in the wallet.', securitySource: 'Open code and build instructions', securitySourceDesc: 'Inspect the source, locked dependencies and build steps. Build independently and verify release artifacts.', sourceTitle: 'Transparency starts with the source.', sourceDesc: 'Core code uses the MIT license. Third-party components retain their own terms.', viewSource: 'View source on GitHub',
      iosTitle: 'Ready for your iPhone.', iosDescription: 'EOS³ Wallet is available on TestFlight. Open the install link to see the current version. No device ID registration required.', iosDownload: 'Install with TestFlight', iosSteps: 'Install TestFlight first, then open the link and tap Accept and Install. Requires iOS 16.4 or later.', iosGetTestflight: 'Get TestFlight ↗', iosQrCaption: 'Scan with your iPhone camera',
      downloadEyebrow: 'Your next step', downloadTitle: 'Start your onchain day with EOS³.', downloadIntro: 'The Android release is available. Download the wallet and explore its source, public build, and verification evidence.', downloadApk: 'Download Android APK', githubDownload: 'GitHub backup download ↗', viewBuild: 'Public build ↗', releaseDetails: 'Release details ↗', readme: 'User guide ↗', stableRelease: 'Stable release', releaseNote: 'Signed with the fixed release certificate. Check the version, source, and SHA256 when downloading.', downloadChecksums: 'Download checksums ↗', downloadEvidence: 'Complete evidence ZIP ↗', verifyGuide: 'How to verify an APK ↗',
      faqEyebrow: 'Before you begin', faqTitle: 'A few things to know.', faqNetworks: 'Which networks are supported?', faqNetworksAnswer: 'Currently, only EOS mainnet is supported. Review the account, operations and fees before making a transaction.', faqKeys: 'Where are my private keys stored?', faqKeysAnswer: 'Standard private-key wallets store encrypted keys on the device. Passkey wallets do not store asset private keys in the client and rely on corresponding services for authentication and signing. Exporting or copying a private key creates plaintext; keep it safe.', faqBuild: 'Can I build the app from source?', faqBuildAnswer: 'Yes. EOS³ Wallet publishes its source code, locked dependencies and build instructions, so you can inspect its security mechanisms and build the app yourself. When downloading a release APK, check the SHA256 and build provenance information for that version.', faqDapp: 'Can I disconnect from a DApp?', faqDappAnswer: 'Yes. Disconnect in the browser to revoke the current connection, or revoke persistent DApp sessions in session management. Disconnecting does not reverse transactions already submitted onchain.', footerTagline: 'Connect your assets. Connect your onchain life.', trademarkNote: 'EOS and third-party names belong to their respective owners. Compatibility does not imply endorsement.'
    }
  };
  translations.zh.entryTitle = '第一次使用，\n也能找到自己的方式。';
  const imageDescriptions = {
    zh: 'EOS³ Wallet 的 AI 生成产品示意图，手机上显示示例资产余额，背后为蓝色玻璃球与环绕轨道',
    en: 'AI-generated EOS³ Wallet product illustration: a phone displaying a demo balance, with a blue glass sphere and orbital rings behind it.'
  };
  let language = 'zh';
  let feature = 'assets';
  const languageButton = document.getElementById('language');
  const menuButton = document.getElementById('menu');
  const navigation = document.getElementById('navigation');
  const tabs = [...document.querySelectorAll('[data-feature]')];
  const previews = {
    zh: {
      assets: { title: '每一笔，都清清楚楚', subtitle: 'demo.wallet · EOS', rows: [['资产余额', '1,280.00 A'], ['最近操作', '转账 · 已确认'], ['常用地址', '在地址簿中管理']], note: '支持查看交易记录、转账备注、扫码收款与地址簿。' },
      resources: { title: '资源使用，心中有数', subtitle: '链上资源概览', meters: [['RAM', '2.4 / 8 KB', 30], ['CPU', '12%', 12], ['NET', '8%', 8]], note: '支持 RAM、质押、REX 与 PowerUp 等资源管理方式。' },
      dapps: { title: '连接应用，由你确认', subtitle: '账户 · 网络 · 操作内容', rows: [['当前网络', 'EOS'], ['签名操作', '提交前确认'], ['连接会话', '可管理与撤销']], note: '兼容相关 DApp 接口，支持 ESR / Anchor 会话。' }
    },
    en: {
      assets: { title: 'Every transaction, clearly shown', subtitle: 'demo.wallet · EOS', rows: [['Asset balance', '1,280.00 A'], ['Recent activity', 'Transfer · Confirmed'], ['Saved addresses', 'Manage in address book']], note: 'View history, transfer memos, receive with QR codes and manage your address book.' },
      resources: { title: 'Know your resource usage', subtitle: 'Onchain resource overview', meters: [['RAM', '2.4 / 8 KB', 30], ['CPU', '12%', 12], ['NET', '8%', 8]], note: 'Manage resources with RAM, staking, REX and PowerUp.' },
      dapps: { title: 'Connect apps on your terms', subtitle: 'Account · Network · Operations', rows: [['Current network', 'EOS'], ['Signing operations', 'Review before submitting'], ['Connected sessions', 'Manage and revoke']], note: 'Compatible DApp interfaces, with ESR / Anchor session support.' }
    }
  };
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function renderPreview() {
    const data = previews[language][feature];
    const card = element('div', 'preview-card');
    card.append(element('h3', '', data.title), element('p', 'preview-subtitle', data.subtitle));
    if (feature === 'dapps') {
      const graphic = element('div', 'dapp-network');
      graphic.setAttribute('aria-hidden', 'true');
      const walletNode = element('span', 'dapp-node');
      const walletIcon = element('img', 'preview-logo');
      walletIcon.src = 'assets/eos3-icon-128.webp';
      walletIcon.alt = '';
      walletIcon.width = 38;
      walletIcon.height = 38;
      walletNode.append(walletIcon);
      graphic.append(walletNode, element('span', '', '↔'), element('span', 'dapp-node', '⊞'));
      card.append(graphic);
    }
    for (const [label, value] of data.rows || []) {
      const row = element('div', 'preview-row');
      row.append(element('span', '', label), element('strong', '', value));
      card.append(row);
    }
    for (const [label, value, percent] of data.meters || []) {
      const meter = element('div', 'resource-meter');
      const labelRow = element('div');
      labelRow.append(element('strong', '', label), element('span', '', value));
      const track = element('div', 'meter-track');
      const fill = element('span');
      fill.style.width = `${percent}%`;
      track.setAttribute('aria-hidden', 'true');
      track.append(fill);
      meter.append(labelRow, track);
      card.append(meter);
    }
    card.append(element('p', 'preview-footnote', data.note));
    document.getElementById('feature-content').replaceChildren(card);
  }
  function setFeature(next, focus = false) {
    feature = next;
    for (const tab of tabs) {
      const selected = tab.dataset.feature === feature;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    document.getElementById('feature-panel').setAttribute('aria-labelledby', `tab-${feature}`);
    renderPreview();
  }
  function setMenu(open) {
    navigation.classList.toggle('open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', language === 'zh' ? (open ? '关闭导航' : '打开导航') : (open ? 'Close navigation' : 'Open navigation'));
  }
  function setLanguage(next) {
    language = next;
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translations[language][node.dataset.i18n];
    document.querySelector('[data-i18n-alt="heroImageAlt"]').alt = imageDescriptions[language];
    document.title = language === 'zh' ? 'EOS³ Wallet — 让链上生活，更简单' : 'EOS³ Wallet — Your onchain life. Made simpler.';
    document.querySelector('meta[name="description"]').content = language === 'zh' ? 'EOS³ Wallet，面向 EOS 的移动钱包。管理资产、转账、链上资源与 DApp，了解开源代码和公开构建。' : 'EOS³ Wallet for EOS. Manage assets, transfers, onchain resources and DApps. Explore the source and build instructions.';
    languageButton.textContent = language === 'zh' ? 'EN ↗' : '中文 ↗';
    languageButton.setAttribute('aria-label', language === 'zh' ? 'Switch to English' : '切换到中文');
    navigation.setAttribute('aria-label', language === 'zh' ? '主导航' : 'Main navigation');
    document.querySelector('.hero-visual').setAttribute('aria-label', language === 'zh' ? '钱包界面示意' : 'Illustrative wallet interface');
    document.querySelector('.ecosystem').setAttribute('aria-label', language === 'zh' ? '支持的网络与协议' : 'Supported networks and protocols');
    document.querySelector('[role="tablist"]').setAttribute('aria-label', language === 'zh' ? '钱包功能' : 'Wallet features');
    setMenu(false);
    renderPreview();
    document.dispatchEvent(new CustomEvent('eos3-language-change'));
    try { localStorage.setItem('eos3-site-language', language); } catch { /* Storage may be unavailable in private browsing. */ }
  }
  languageButton.addEventListener('click', () => setLanguage(language === 'zh' ? 'en' : 'zh'));
  menuButton.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
  navigation.addEventListener('click', event => { if (event.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') { setMenu(false); menuButton.focus(); }
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => setFeature(tab.dataset.feature));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); setFeature(tabs[next].dataset.feature, true); }
    });
  });
  let savedLanguage;
  try { savedLanguage = localStorage.getItem('eos3-site-language'); } catch { /* Use Chinese when preferences cannot be read. */ }
  setLanguage(savedLanguage === 'en' ? 'en' : 'zh');
})();
