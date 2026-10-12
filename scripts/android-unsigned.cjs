'use strict';

function removeAndroidSigning(source) {
  const block = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
`;
  if (source.split(block).length !== 2 || (source.match(/signingConfig signingConfigs\.debug/g) ?? []).length !== 2) {
    throw new Error('Android signing template changed; review before creating an unsigned build.');
  }
  const result = source.replace(block, '').replaceAll('signingConfig signingConfigs.debug', 'signingConfig null');
  if (/storeFile|storePassword|keyPassword|keyAlias|signingConfigs\./.test(result)) throw new Error('Unexpected Android signing material remains.');
  return result;
}

module.exports = { removeAndroidSigning };
