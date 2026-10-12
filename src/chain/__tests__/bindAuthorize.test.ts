jest.mock('../eos3Sign', () => ({
  eos3Request: jest.fn(),
  signPlainTransactionJSON: jest.fn(),
}));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));

import { PublicKey } from '@wharfkit/antelope';
import { PAYLIMIT_CONTRACT, SPONSOR_ACCOUNT } from '../../passkey/constants';
import { CHAINS } from '../config';
import { assertBindTxSafe, displayBindLimit, type BindChainState, type BindIntent } from '../bindIntent';
import { prepareBindAuthorization, signAndCompleteBindAuthorization, type BindAuthorizationInfo } from '../bindAuthorize';
import { TxIntentMismatchError } from '../txIntentCheck';
import { eos3Request, signPlainTransactionJSON, type PlainTxAction, type PlainTxJSON } from '../eos3Sign';
import { fetchWithRetry } from '../../net/fetchRetry';

const publicKey = String(PublicKey.from('EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV'));
const auth = [{ actor: 'alice', permission: 'active' }];
const asset = { tokenContract: 'core.vaulta', symbol: 'A', precision: 4,
  perTxLimit: '10.0000 A', dailyLimit: '10.0000 A', totalBudget: '50.0000 A' };
const identity = { botIdHash: 'a'.repeat(64), permission: 'tgpay1', publicKey };
const intent: BindIntent = { actor: 'alice', chainId: CHAINS.vaulta.chainIdHash, identity, assetLimits: [asset] };
const codeAuthority = { threshold: 1, keys: [], accounts: [{
  permission: { actor: PAYLIMIT_CONTRACT, permission: 'eosio.code' }, weight: 1,
}], waits: [] };
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function emptyState(): BindChainState { return { permissions: [], bots: [], limits: [], allowedActions: [] }; }
function tx(): PlainTxJSON {
  return {
    expiration: new Date(Date.now() + 120000).toISOString().slice(0, 19),
    ref_block_num: 123, ref_block_prefix: 456, max_net_usage_words: 0, max_cpu_usage_ms: 0,
    delay_sec: 0, context_free_actions: [], transaction_extensions: [],
    actions: [
      { account: SPONSOR_ACCOUNT, name: 'noop', authorization: [{ actor: SPONSOR_ACCOUNT, permission: 'active' }], data: {} },
      { account: 'eosio', name: 'updateauth', authorization: clone(auth), data: {
        account: 'alice', permission: 'paytransfer', parent: 'active', auth: clone(codeAuthority),
      } },
      { account: PAYLIMIT_CONTRACT, name: 'setbot', authorization: clone(auth), data: {
        owner: 'alice', bot_id_hash: identity.botIdHash, permission: identity.permission, app_public_key: publicKey,
      } },
      { account: 'eosio', name: 'linkauth', authorization: clone(auth), data: {
        account: 'alice', code: asset.tokenContract, type: 'transfer', requirement: 'paytransfer',
      } },
      { account: PAYLIMIT_CONTRACT, name: 'setlimit', authorization: clone(auth), data: {
        owner: 'alice', bot_id_hash: identity.botIdHash, permission: identity.permission,
        token_contract: asset.tokenContract, token_symbol: '4,A',
        has_per_tx_limit: true, per_tx_limit: '10.0000 A',
        has_daily_limit: true, daily_limit: '10.0000 A',
        has_total_budget: true, total_budget: '50.0000 A',
      } },
    ],
  };
}
function check(transaction = tx(), state = emptyState(), expected = intent) {
  return assertBindTxSafe({ transaction, state, intent: expected });
}
function existingState(): BindChainState {
  return { ...emptyState(), permissions: [{ perm_name: 'paytransfer', parent: 'active',
    required_auth: clone(codeAuthority), linked_actions: [{ account: asset.tokenContract, action: 'transfer' }] }] };
}

describe('restricted payment binding intent', () => {
  it('accepts complete contract-only authorization with exactly the approved on-chain limits', () => {
    const transaction = tx();
    expect(check(transaction)).toEqual(transaction);
  });
  const attacks: [string, (transaction: PlainTxJSON) => void][] = [
    ['third-party key can bypass the limit contract', (t) => { t.actions[1].data.auth = {
      threshold: 1, keys: [{ key: publicKey, weight: 1 }], accounts: [], waits: [],
    }; }],
    ['extra key alongside the contract', (t) => { t.actions[1].data.auth.keys.push({ key: publicKey, weight: 1 }); }],
    ['different contract receives transfer authority', (t) => { t.actions[1].data.auth.accounts[0].permission.actor = 'attacker'; }],
    ['weakened threshold', (t) => { t.actions[1].data.auth.threshold = 0; }],
    ['wait-based authority', (t) => { t.actions[1].data.auth.waits.push({ wait_sec: 1, weight: 1 }); }],
    ['replaces active permission', (t) => { t.actions[1].data.permission = 'active'; }],
    ['uses owner authorization', (t) => { t.actions[1].authorization[0].permission = 'owner'; }],
    ['links transfer to the bot key', (t) => { t.actions[3].data.requirement = 'tgpay1'; }],
    ['links all actions on a token contract', (t) => { t.actions[3].data.type = ''; }],
    ['links another token contract', (t) => { t.actions[3].data.code = 'eosio.token'; }],
    ['increases actual daily limit but keeps response metadata unchanged', (t) => { t.actions[4].data.daily_limit = '1000.0000 A'; }],
    ['disables actual daily limit', (t) => { t.actions[4].data.has_daily_limit = false; t.actions[4].data.daily_limit = '0.0000 A'; }],
    ['removes total limit', (t) => { t.actions[4].data.has_total_budget = false; t.actions[4].data.total_budget = '0.0000 A'; }],
    ['changes precision', (t) => { t.actions[4].data.token_symbol = '8,A'; }],
    ['another owner', (t) => { t.actions[4].data.owner = 'bob'; }],
    ['another bot', (t) => { t.actions[4].data.bot_id_hash = 'b'.repeat(64); }],
    ['missing setlimit', (t) => { t.actions.pop(); }],
    ['duplicate limit override', (t) => { t.actions.push(clone(t.actions[4])); t.actions[5].data.daily_limit = '1000.0000 A'; }],
    ['duplicate identical limit', (t) => { t.actions.push(clone(t.actions[4])); }],
    ['missing setbot', (t) => { t.actions.splice(2, 1); }],
    ['missing link with no safe existing link', (t) => { t.actions.splice(3, 1); }],
    ['extra authorization on an otherwise safe action', (t) => { t.actions[4].authorization.push({ actor: 'bob', permission: 'active' }); }],
    ['context-free operation', (t) => { t.context_free_actions.push({ account: 'attacker' }); }],
    ['transaction extension', (t) => { t.transaction_extensions.push([0, '00']); }],
    ['delayed authorization', (t) => { t.delay_sec = 60; }],
    ['long-lived authorization', (t) => { t.expiration = '2099-01-01T00:00:00'; }],
    ['expired authorization', (t) => { t.expiration = '2000-01-01T00:00:00'; }],
    ['permission deletion', (t) => { t.actions.push({ account: 'eosio', name: 'deleteauth', authorization: clone(auth), data: { account: 'alice', permission: 'tgpay2' } }); }],
    ['non-user action cannot hide side effects', (t) => { t.actions.push({ account: 'attacker', name: 'run', authorization: [{ actor: 'attacker', permission: 'active' }], data: {} }); }],
    ['general app authorization is outside limited payment scope', (t) => { t.actions.push({ account: PAYLIMIT_CONTRACT, name: 'allowact', authorization: clone(auth), data: { owner: 'alice' } }); }],
  ];
  it.each(attacks)('rejects %s', (_name, mutate) => {
    const transaction = tx(); mutate(transaction);
    expect(() => check(transaction)).toThrow(TxIntentMismatchError);
  });
  it('accepts omitted permission setup only when the chain already has the exact safe authority and links', () => {
    const transaction = tx(); transaction.actions = transaction.actions.filter((a) => a.account !== 'eosio');
    expect(() => check(transaction, existingState())).not.toThrow();
    const unsafe = existingState(); unsafe.permissions[0].required_auth.keys.push({ key: publicKey, weight: 1 });
    expect(() => check(transaction, unsafe)).toThrow(TxIntentMismatchError);
  });
  it('requires removal of old tokens that are absent from the approved selection', () => {
    const state = emptyState();
    state.bots = [{ id: 7, owner: 'alice', bot_id_hash: identity.botIdHash, permission: 'tgpay1' }];
    state.limits = [{ botauth_id: 7, token_contract: 'eosio.token', token_symbol: '4,EOS' }];
    expect(() => check(tx(), state)).toThrow(TxIntentMismatchError);
    const transaction = tx(); transaction.actions.push({ account: PAYLIMIT_CONTRACT, name: 'delasset', authorization: clone(auth),
      data: { owner: 'alice', bot_id_hash: identity.botIdHash, token_contract: 'eosio.token', token_symbol: '4,EOS' } });
    expect(() => check(transaction, state)).not.toThrow();
  });
  it('rejects old general action permissions unless the binding clears them', () => {
    const state = emptyState();
    state.bots = [{ id: 7, owner: 'alice', bot_id_hash: identity.botIdHash, permission: 'tgpay1' }];
    state.allowedActions = [{ botauth_id: 7, active: true }];
    expect(() => check(tx(), state)).toThrow(TxIntentMismatchError);
    const transaction = tx(); transaction.actions.push({ account: PAYLIMIT_CONTRACT, name: 'clearacts', authorization: clone(auth),
      data: { owner: 'alice', bot_id_hash: identity.botIdHash } });
    expect(() => check(transaction, state)).not.toThrow();
  });
  it('does not accept unlimited or duplicate approved assets', () => {
    expect(() => check(tx(), emptyState(), { ...intent, assetLimits: [{ ...asset, perTxLimit: null, dailyLimit: null, totalBudget: null }] })).toThrow(TxIntentMismatchError);
    expect(() => check(tx(), emptyState(), { ...intent, assetLimits: [asset, asset] })).toThrow(TxIntentMismatchError);
  });
  it('shows a disabled limit as unlimited rather than a zero spending allowance', () => {
    expect(displayBindLimit('0.0000 A', 'unlimited')).toBe('unlimited');
    expect(displayBindLimit(null, 'unlimited')).toBe('unlimited');
    expect(displayBindLimit('10.0000 A', 'unlimited')).toBe('10.0000 A');
  });
  it('accepts a total-budget-only binding with the daily and per-transaction limits explicitly disabled', () => {
    const transaction = tx();
    Object.assign(transaction.actions[4].data, {
      has_per_tx_limit: false, per_tx_limit: '0.0000 A', has_daily_limit: false, daily_limit: '0.0000 A',
    });
    const expected = { ...intent, assetLimits: [{ ...asset, perTxLimit: '0.0000 A', dailyLimit: '0.0000 A' }] };
    expect(() => check(transaction, emptyState(), expected)).not.toThrow();
  });
});

const node = { id: 'test', name: 'Test RPC', url: 'https://rpc.example' };
function build(): BindAuthorizationInfo {
  return { eosAccount: 'alice', chainId: intent.chainId, projectName: 'Payment app', assetLimits: [clone(asset)], transaction: tx() };
}
function preparation(fresh = build(), preview = clone(fresh)) {
  return { bindId: 'test-bind', eosAccount: 'alice', chain: 'vaulta' as const, node,
    build: fresh, preview, assetLimits: [clone(asset)] };
}
let chainState: BindChainState;
const unlock = jest.fn(async () => ({ kind: 'privatekey' as const, privateKey: 'not-read-by-mocked-signer' }));
beforeEach(() => {
  jest.clearAllMocks(); chainState = emptyState();
  (fetchWithRetry as jest.Mock).mockImplementation(async (url: string, request: RequestInit) => {
    const body = JSON.parse(String(request.body));
    const result = url.endsWith('/get_info') ? { chain_id: intent.chainId }
      : url.endsWith('/get_account') ? { account_name: 'alice', permissions: chainState.permissions }
      : { rows: body.table === 'botauth' ? chainState.bots : body.table === 'assetlimit' ? chainState.limits : chainState.allowedActions, more: false };
    return { ok: true, json: async () => clone(result) };
  });
  (signPlainTransactionJSON as jest.Mock).mockResolvedValue({ signature: 'signature', serializedTransaction: 'bytes' });
  (eos3Request as jest.Mock).mockResolvedValue({ ok: true, eosAccount: 'alice', txid: 'txid' });
});

describe('prepare and sign only the confirmed immutable binding', () => {
  it.each(['chainId', 'eosAccount'] as const)('rejects changed %s before any private key access', async (field) => {
    const fresh = build(); fresh[field] = 'wrong';
    await expect(prepareBindAuthorization(preparation(fresh))).rejects.toThrow(TxIntentMismatchError);
    expect(fetchWithRetry).not.toHaveBeenCalled(); expect(unlock).not.toHaveBeenCalled();
  });
  it('rejects a changed identity between the first preview and rebuilt transaction', async () => {
    const fresh = build(); const preview = clone(fresh);
    fresh.transaction.actions[2].data.bot_id_hash = 'b'.repeat(64);
    await expect(prepareBindAuthorization(preparation(fresh, preview))).rejects.toThrow(TxIntentMismatchError);
  });
  it('rejects changed response limits even before inspecting the signed on-chain limits', async () => {
    const fresh = build(); fresh.assetLimits[0].dailyLimit = '100.0000 A';
    fresh.assetLimits[0].perTxLimit = '100.0000 A';
    await expect(prepareBindAuthorization(preparation(fresh))).rejects.toThrow(TxIntentMismatchError);
  });
  it('signs local actions and the selected chain from a frozen snapshot, unaffected by edits after preparation', async () => {
    const opts = preparation(); const plan = await prepareBindAuthorization(opts);
    opts.build.transaction.actions[4].data.daily_limit = '1000.0000 A';
    opts.assetLimits[0].dailyLimit = '1000.0000 A';
    expect(Object.isFrozen(plan.build.transaction.actions[4].data)).toBe(true);
    await expect(signAndCompleteBindAuthorization({ plan, getSigner: unlock, isCurrent: () => true })).resolves.toEqual({ txId: 'txid' });
    expect(signPlainTransactionJSON).toHaveBeenCalledWith(expect.objectContaining({ chainId: intent.chainId, transactionJson: plan.build.transaction }));
    expect(plan.build.transaction.actions[4].data.daily_limit).toBe('10.0000 A');
    expect(eos3Request).toHaveBeenCalledWith('/api/eos-wallet/tp-bind/complete', expect.objectContaining({ assetLimits: [asset] }));
  });
  it('refuses a plan that did not pass preparation', async () => {
    const fake = { bindId: 'test', chain: 'vaulta' as const, node, intent, build: build() };
    await expect(signAndCompleteBindAuthorization({ plan: fake, getSigner: unlock, isCurrent: () => true })).rejects.toThrow(TxIntentMismatchError);
    expect(unlock).not.toHaveBeenCalled(); expect(signPlainTransactionJSON).not.toHaveBeenCalled();
  });
  it('refuses an omitted authority that became unsafe after the confirmation was shown', async () => {
    chainState = existingState();
    const fresh = build(); fresh.transaction.actions = fresh.transaction.actions.filter((a) => a.account !== 'eosio');
    const plan = await prepareBindAuthorization(preparation(fresh));
    chainState.permissions[0].required_auth.keys.push({ key: publicKey, weight: 1 });
    await expect(signAndCompleteBindAuthorization({ plan, getSigner: unlock, isCurrent: () => true })).rejects.toThrow(TxIntentMismatchError);
    expect(unlock).not.toHaveBeenCalled(); expect(signPlainTransactionJSON).not.toHaveBeenCalled();
  });
  it('refuses signing after a wallet or network switch during authentication', async () => {
    const plan = await prepareBindAuthorization(preparation());
    let current = true;
    const changed = async () => { current = false; return { kind: 'privatekey' as const, privateKey: 'unused' }; };
    await expect(signAndCompleteBindAuthorization({ plan, getSigner: changed, isCurrent: () => current })).rejects.toThrow(TxIntentMismatchError);
    expect(signPlainTransactionJSON).not.toHaveBeenCalled(); expect(eos3Request).not.toHaveBeenCalled();
  });
  it('fails closed on chain state query errors', async () => {
    const plan = await prepareBindAuthorization(preparation());
    (fetchWithRetry as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(signAndCompleteBindAuthorization({ plan, getSigner: unlock, isCurrent: () => true })).rejects.toThrow('offline');
    expect(unlock).not.toHaveBeenCalled();
  });
  it('rejects incomplete table pagination', async () => {
    (fetchWithRetry as jest.Mock).mockImplementation(async (url: string) => ({ ok: true, json: async () =>
      url.endsWith('/get_info') ? { chain_id: intent.chainId } : url.endsWith('/get_account') ? { account_name: 'alice', permissions: [] } : { rows: [], more: true },
    }));
    await expect(prepareBindAuthorization(preparation())).rejects.toThrow(TxIntentMismatchError);
  });
});
