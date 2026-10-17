import React from 'react';
import DeviceKeyImportScreen from './DeviceKeyImportScreen';

/** Google 开户、Passkey 和设备授权都由 eos3.app 网页完成，App 仅持有本机设备密钥。 */
export default function PasskeyCreateScreen() {
  return <DeviceKeyImportScreen purpose="create" />;
}
