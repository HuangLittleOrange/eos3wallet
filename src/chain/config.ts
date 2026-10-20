// 链与节点配置
import { t } from '../i18n';

export type ChainId = 'vaulta' | 'jungle4';
export type NetworkKind = 'mainnet' | 'testnet';

export type NodeInfo = {
  id: string;
  name: string;
  url: string;
};

export type ChainConfig = {
  id: ChainId;
  name: string;
  /**
   * 链的真实 chain_id(get_info 返回的 64 位十六进制哈希)。签名摘要里
   * 包含它,写错只会导致签名被链拒绝,不会把交易签到别的链上去。
   * 硬编码的价值:
   *   1. 交易签名前不用再打一次 get_info 专门问链 ID(TAPOS 由 wharfkit
   *      内部自己拉,省的是我们额外那一次往返);
   *   2. 注入给 DApp 的 chainId 用真实哈希,Scatter 生态的 DApp 拿它和
   *      自己配置的网络比对,给内部 slug 是对不上的;
   *   3. 万一某个自定义节点其实指向别的链,按配置的链 ID 签名会被那条链
   *      拒绝——比跟着节点返回什么就签什么更安全。
   * 两个值都是 2026-08-24 实测 greymass 主网/Jungle4 节点 get_info 抄下来的。
   */
  chainIdHash: string;
  /** 系统代币符号 —— 用户持有/转账/看到的那个符号 */
  symbol: string;
  precision: number;
  /** 系统代币合约 */
  systemToken: string;
  /**
   * delegatebw/buyram/buyrambytes/powerup/REX 这些系统资源 action 该打给谁。
   * 正常是 eosio,但 Vaulta 主网上这些 action 要改打 core.vaulta——它把 eosio
   * 系统合约的这套 action 整个镜像了一份,自己收 A、内部桥接兑换成 EOS 再转发
   * 给真正的 eosio 系统 action(eosio 系统合约本身没有跟着改名重新部署,
   * core_symbol() 编译时写死还是 EOS,实测 rammarket 表 quote 一侧就是
   * "xxx EOS",直接打 eosio 传 A 会被 "max_payment doesn't match core symbol"
   * 断言拒绝)。Jungle4 测试网没有这层桥接合约,原样是 eosio。
   */
  resourceContract: string;
  /** 是否测试网 —— 写操作只允许在测试网进行 */
  testnet: boolean;
  /** 链上查询节点(Chain API):get_info / get_account / get_table_rows / 广播交易 */
  nodes: NodeInfo[];
  /**
   * 历史节点(Hyperion v2):交易记录、全量代币余额。
   * 和上面的 nodes 是两套完全独立的服务,同一家服务商不一定两个都提供,
   * 也不需要绑在一起——参考主流钱包的做法,用户可以分别选择"用哪个节点查链上数据"
   * 和"用哪个节点查历史",切换其中一个不会影响另一个。
   */
  historyNodes: NodeInfo[];
};

export const CHAINS: Record<ChainId, ChainConfig> = {
  vaulta: {
    id: 'vaulta',
    name: 'Vaulta',
    chainIdHash: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
    // Vaulta 改名后用户持有/转账用的代币是 core.vaulta 合约下的 A,不再是旧的
    // eosio.token/EOS——旧 EOS 代币还挂在链上(见 format.ts 的 CANONICAL 表,
    // 继续识别防假币),余额/转账/买卖都已经是 A 了。
    // delegatebw/buyram/powerup/REX 这些资源 action 也改打 core.vaulta(不是
    // eosio),同样收 A——实测过一笔真实的 core.vaulta::powerup(max_payment
    // "1.0000 A"),链上会自动桥接成 eosio::powerup 需要的 EOS。
    // Jungle4 测试网没有经历这次改名,symbol/resourceContract 都还是原来的
    // EOS/eosio。
    symbol: 'A',
    precision: 4,
    systemToken: 'core.vaulta',
    resourceContract: 'core.vaulta',
    testnet: false,
    // 参考 TP 节点设置页实测补齐的公共 BP 节点列表(2026-08 逐个探测过 /v1/chain/get_info
    // 确认能连、证书有效才收进来)。原来的 EOS Nation / EOS Detroit 地址已经连不上了——
    // 两家都换了域名,这里顺手更新到它们现在实际在用的地址,不是新加的服务商。
    // TP 列表里还有两个没收:
    //   - EOSphere(vaulta-hyperion.eosphere.io):这个域名本身就是给 Hyperion 用的,
    //     打 /v1/chain/get_info 实测返回 500,不是能广播交易的链节点,放去 historyNodes。
    //   - Starteos(api-mainnet.starteos.io):实测 TLS 证书已过期,钱包节点走的是明文之外
    //     唯一的信任锚点,证书都保证不了就不该进默认列表,跳过。
    nodes: [
      { id: 'greymass', name: 'Greymass', url: 'https://eos.greymass.com' },
      { id: 'eosrio', name: 'EOS Rio', url: 'https://api.eosrio.io' },
      { id: 'nation', name: 'EOS Nation', url: 'https://eos.api.eosnation.io' },
      { id: 'detroit', name: 'DetroitLedger', url: 'https://api.eos.detroitledger.tech' },
      { id: 'alohaeos', name: 'Alohaeos', url: 'https://api.main.alohaeos.com' },
      { id: 'eosauthority', name: 'EOS Authority', url: 'https://publicapi-mainnet.eosauthority.com' },
      { id: 'eossg', name: 'EOS SG', url: 'https://mainnet.eosio.sg' },
      { id: 'eossupport', name: 'EOS Support', url: 'https://api.eossupport.io' },
      { id: 'eoseyes', name: 'EOSEyes', url: 'https://eos.eoseyes.com' },
      { id: 'eosusa', name: 'EOSUSA', url: 'https://eos.eosusa.io' },
      { id: 'genereos', name: 'Genereos', url: 'https://mainnet.genereos.io' },
      { id: 'newdex', name: 'Newdex', url: 'https://eos.newdex.one' },
      { id: 'tokenpocket', name: 'TokenPocket', url: 'https://eospush.tokenpocket.pro' },
    ],
    historyNodes: [
      { id: 'eosrio-hyperion', name: 'EOS Rio (Hyperion)', url: 'https://eos.hyperion.eosrio.io' },
      { id: 'eosphere-hyperion', name: 'EOSphere (Hyperion)', url: 'https://vaulta-hyperion.eosphere.io' },
    ],
  },
  jungle4: {
    id: 'jungle4',
    name: 'Jungle4',
    chainIdHash: '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d',
    symbol: 'EOS',
    precision: 4,
    systemToken: 'eosio.token',
    resourceContract: 'eosio',
    testnet: true,
    nodes: [
      { id: 'greymass-j4', name: 'Greymass', url: 'https://jungle4.greymass.com' },
      { id: 'cryptolions', name: 'CryptoLions', url: 'https://jungle4.cryptolions.io' },
    ],
    historyNodes: [
      { id: 'cryptolions-hyperion', name: 'CryptoLions (Hyperion)', url: 'https://jungle4.cryptolions.io' },
    ],
  },
};

/**
 * 各链的"旧称"展示文案 —— 之所以不像 name 一样直接写死在 CHAINS 里,是因为
 * 它需要跟着当前语言变;CHAINS 是模块加载时就建好的静态对象,字段里烤死的
 * 字符串没法在语言切换后跟着变,所以改成一个按需调用、每次都读最新语言的函数。
 */
export function legacyLabel(id: ChainId): string {
  return id === 'vaulta' ? t('chainConfig.legacyVaulta') : t('chainConfig.legacyJungle4');
}

export const DEFAULT_CHAIN: ChainId = 'vaulta';

/** Registry-backed selectors can add networks without hard-coded UI branches. */
export function networksFor(kind: NetworkKind): ChainConfig[] {
  return Object.values(CHAINS).filter(network => network.testnet === (kind === 'testnet'));
}
export function isChainId(value: unknown): value is ChainId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHAINS, value);
}
