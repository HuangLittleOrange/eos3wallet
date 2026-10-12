// 全局 jest 环境配置。
//
// @react-native-async-storage/async-storage 在 jest 环境(不是真的 RN 原生
// 运行时)里拿不到原生模块,任何 import 它的文件——哪怕测试本身根本没调用
// 到 AsyncStorage,只是模块依赖图上传递引用到了——都会直接炸掉,报
// "NativeModule: AsyncStorage is null"。用它官方自带的 jest mock 顶上,
// 这是这个库文档里写明的标准接法,不是我们自己拍脑袋加的 workaround。
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Resolve Expo's lazy fetch while the native-module mocks are still available.
// Otherwise Jest's global cleanup can first load it after the test environment
// has been torn down, causing a spurious "Cannot log after tests are done" error.
void globalThis.fetch;

// Keep native network requests observable through each test's fetch fixture.
jest.mock('expo/fetch', () => ({ fetch: (...args) => globalThis.fetch(...args) }));
