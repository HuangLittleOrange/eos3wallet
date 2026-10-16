jest.mock('../deviceKey', () => ({ assertPendingDeviceChain: jest.fn() }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('../anchorWeb', () => ({ signWithAnchorWeb: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { Serializer, Transaction } from '@wharfkit/antelope';
import { fetchWithRetry } from '../../net/fetchRetry';
import { signWithAnchorWeb } from '../anchorWeb';
import { prepareAnchorDeviceImport, submitAnchorDeviceImport } from '../anchorDeviceImport';
import { DEVICE_AUTH_ABI, deviceUpdateData, validateDeviceKeyReview, type DeviceAuthority } from '../anchorDeviceReview';
import { CHAINS } from '../config';
const account='aliceacct111';
const old='EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const phone='EOS7HwiLJMpfyvJQp554XKaum5L6bULAJ9oA4EVQvR69yqdMoRwcC';
const wa='PUB_WA_5hyixc7vkMbKiThWi1TnFtXw7HTDcHfjREj2SzxCtgw3jQGepa5T9VHEy1Tunjzzj';
const session={account,permission:'active'} as any;
const pending={id:'pending',publicKey:phone,legacyPublicKey:phone,label:'Phone',createdAt:1,chainId:'vaulta'} as const;
const node={url:'https://rpc.test'};
function fixture(){
 const current:DeviceAuthority={parent:'owner',required_auth:{threshold:1,keys:[{key:old,weight:1},{key:wa,weight:1}],accounts:[{permission:{actor:'guardian1111',permission:'active'},weight:1}],waits:[{wait_sec:3600,weight:1}]}};
 const intent={account,publicKey:phone,label:'Phone',remove:[]};
 const update=deviceUpdateData(account,current,phone,[]);
 const tx=Transaction.from({expiration:new Date(Date.now()+120000).toISOString().slice(0,19),ref_block_num:1,ref_block_prefix:2,actions:[
  {account:'eos3powerup1',name:'noop',authorization:[{actor:'eos3powerup1',permission:'paycpu'}],data:''},
  {account:'eosio',name:'updateauth',authorization:[{actor:account,permission:'active'}],data:Serializer.encode({object:update,type:'updateauth',abi:DEVICE_AUTH_ABI}).hexString},
 ]});
 const built={eosAccount:account,chainId:CHAINS.vaulta.chainIdHash,publicKey:phone,op:'add' as const,remove:[] as string[],transaction:{serializedTransaction:Serializer.encode({object:tx}).hexString,sponsorRequestId:'reserved',sponsorFee:''}};
 return{current,intent,update,tx,built};
}
beforeEach(()=>jest.resetAllMocks());
it('keeps WA recovery keys, delegations and waits and adds only the phone key',()=>{
 const f=fixture();const review=validateDeviceKeyReview(f.built,f.current,f.intent);
 expect(review.hex).toBe(f.built.transaction.serializedTransaction);
 expect(f.update.auth.keys).toHaveLength(3);expect(f.update.auth.keys.some(k=>k.key===wa)).toBe(true);
 expect(f.update.auth.accounts).toEqual(f.current.required_auth.accounts);expect(f.update.auth.waits).toEqual(f.current.required_auth.waits);
});
it.each(['network','account','key','remove','fee','extra-action','threshold','authority-key','expired','trailing'])('rejects %s before opening the signer',what=>{
 const f=fixture();
 if(what==='network')f.built.chainId='bad';if(what==='account')f.built.eosAccount='bob';if(what==='key')f.built.publicKey=old;
 if(what==='remove')f.built.remove=[old];if(what==='fee')f.built.transaction.sponsorFee='0.0100 A';
 if(what==='extra-action')f.tx.actions.push(f.tx.actions[1]);
 if(what==='threshold')f.update.auth.threshold=2;
 if(what==='authority-key')f.update.auth.keys=[{key:phone,weight:1}];
 f.tx.actions[1].data=Serializer.encode({object:f.update,type:'updateauth',abi:DEVICE_AUTH_ABI});
 if(what==='expired')f.tx.expiration='2000-01-01T00:00:00' as any;
 f.built.transaction.serializedTransaction=Serializer.encode({object:f.tx}).hexString+(what==='trailing'?'00':'');
 expect(()=>validateDeviceKeyReview(f.built,f.current,f.intent)).toThrow();
 expect(signWithAnchorWeb).not.toHaveBeenCalled();
});
it('calls the deployed account API without a platform login and preserves reviewed bytes on push',async()=>{
 const f=fixture();
 jest.mocked(fetchWithRetry).mockImplementation(async url=>({ok:true,json:async()=>String(url).endsWith('get_info')?{chain_id:CHAINS.vaulta.chainIdHash}:String(url).endsWith('get_account')?{account_name:account,permissions:[{perm_name:'active',...f.current}]}:String(url).endsWith('/build')?f.built:{txid:'success'}} as Response));
 const review=await prepareAnchorDeviceImport(session,pending,node,'vaulta');
 expect(review).not.toBeNull();jest.mocked(signWithAnchorWeb).mockResolvedValue(['SIG_WA_fixture']);
 await submitAnchorDeviceImport(session,review!);
 const call=jest.mocked(fetchWithRetry).mock.calls.find(([url])=>String(url).endsWith('/push'))!;
 expect(call[0]).toBe('https://eos3.app/api/passkey-chain/device-keys/account/push');
 const body=JSON.parse(String(call[1]!.body));expect(body.eosAccount).toBe(account);
 expect(body.signedTransaction.serializedTransaction).toBe(review!.hex);expect(body.signedTransaction.sponsorRequestId).toBe('reserved');
 expect(call[2]!.attempts).toBe(1);
});
it('refuses multisig and a test network before contacting the build API',async()=>{
 jest.mocked(fetchWithRetry).mockImplementation(async url=>({ok:true,json:async()=>String(url).endsWith('get_info')?{chain_id:CHAINS.vaulta.chainIdHash}:{account_name:account,permissions:[{perm_name:'active',required_auth:{threshold:2}}]}} as Response));
 await expect(prepareAnchorDeviceImport(session,pending,node,'vaulta')).rejects.toThrow('anchorImport.multisig');
 expect(jest.mocked(fetchWithRetry).mock.calls.every(([url])=>!String(url).includes('eos3.app'))).toBe(true);
 await expect(prepareAnchorDeviceImport(session,{...pending,chainId:'jungle4'},node,'jungle4')).rejects.toThrow('anchorImport.mainnetOnly');
});
