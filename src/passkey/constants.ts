// Passkey RP ID 与应用的域名关联声明保持一致。
export const EOS3_RP_ID = 'eos3.app';
export const EOS3_BASE_URL = 'https://eos3.app';

// 资源代付服务配置。
export const SPONSOR_BASE_URL = 'https://powerup.eos3.app';
export const SPONSOR_PROJECT_ID = 'eos3-wallet-web';

// 签名前使用固定收款账户核对代付交易，避免响应替换收款人。
export const SPONSOR_ACCOUNT = 'eos3powerup1';

/** 单笔代付手续费上限，以所选网络的系统代币计价。 */
export const SPONSOR_MAX_FEE = 0.05;

// 受限支付的可信合约，权限和额度校验使用固定账户。
export const PAYLIMIT_CONTRACT = 'paylimit1111';
