/** Some EOS DApps select the TP/Scatter transport by user agent before checking
 * the injected provider. Android omits the WebView marker used by site gateways.
 */
export function tokenPocketUserAgent(platform: string, version: string | number, constants: Record<string, unknown> = {}) {
  const token = platform === 'ios' ? 'TokenPocket_iOS' : 'TokenPocket_Android';
  if (platform !== 'android') return { applicationNameForUserAgent: token, userAgent: undefined };
  const release = constants.Release || String(version || '13');
  const model = constants.Model || 'Android';
  return {
    applicationNameForUserAgent: token,
    userAgent: `Mozilla/5.0 (Linux; Android ${release}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36 ${token}`,
  };
}
