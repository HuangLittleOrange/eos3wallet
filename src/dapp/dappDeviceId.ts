// TokenPocket 的 tp.getDeviceId() —— 给 DApp 一个"这台设备"的标识。
//
// 不能真把设备标识交出去:每个网站拿到的都是同一个值,就成了跨站追踪用户的
// 现成工具。这里按网站来源各生成一个随机 id 存起来——同一个网站每次拿到的
// 都一样(它拿这个做限流、记住登录设备,照样好使),不同网站之间对不上号。
// 不含任何密钥材料,放 AsyncStorage 即可。
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const KEY = 'aurora.dapp.deviceIds.v1';

export async function dappDeviceId(origin: string): Promise<string> {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}') ?? {};
  } catch {
    map = {};
  }
  if (map[origin]) return map[origin];
  const id = Crypto.randomUUID();
  map[origin] = id;
  await AsyncStorage.setItem(KEY, JSON.stringify(map));
  return id;
}
