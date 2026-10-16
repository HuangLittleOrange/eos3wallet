import { ABI, PublicKey, Serializer, Transaction } from '@wharfkit/antelope';
import { CHAINS } from './config';
import { t } from '../i18n';
const REX_CHAIN_ID = CHAINS.vaulta.chainIdHash;
function samePublicKey(a:string,b:string) { return PublicKey.from(a).equals(PublicKey.from(b)); }

export const DEVICE_AUTH_ABI = ABI.from({ version:'eosio::abi/1.2', structs:[
 {name:'key_weight',base:'',fields:[{name:'key',type:'public_key'},{name:'weight',type:'uint16'}]},
 {name:'permission_level',base:'',fields:[{name:'actor',type:'name'},{name:'permission',type:'name'}]},
 {name:'permission_level_weight',base:'',fields:[{name:'permission',type:'permission_level'},{name:'weight',type:'uint16'}]},
 {name:'wait_weight',base:'',fields:[{name:'wait_sec',type:'uint32'},{name:'weight',type:'uint16'}]},
 {name:'authority',base:'',fields:[{name:'threshold',type:'uint32'},{name:'keys',type:'key_weight[]'},{name:'accounts',type:'permission_level_weight[]'},{name:'waits',type:'wait_weight[]'}]},
 {name:'updateauth',base:'',fields:[{name:'account',type:'name'},{name:'permission',type:'name'},{name:'parent',type:'name'},{name:'auth',type:'authority'},{name:'authorized_by',type:'name$'}]}
],actions:[] });
export type DeviceAuthority = {parent:string; required_auth:{threshold:number;keys:{key:string;weight:number}[];accounts:unknown[];waits:unknown[]}};
export type DeviceKeyBuild = {transaction:Record<string,unknown>;chainId:string;eosAccount:string;publicKey:string;op:'add'|'remove';remove?:string[];wallet?:{chainPublicKey:string;credentialIdHex:string}};
export type DeviceKeyReview = {built:DeviceKeyBuild;hex:string;expiresAt:number;label:string;cleanup:string[]};
export function deviceUpdateData(account:string,current:DeviceAuthority,key:string,remove:string[],op:'add'|'remove'='add') {
 const keys=current.required_auth.keys.filter(k=> !remove.some(r=>samePublicKey(r,k.key)) && !(op==='remove' && samePublicKey(k.key,key))).map(k=>({...k}));
 if(op==='add' && !keys.some(k=>samePublicKey(k.key,key))) keys.push({key,weight:1});
 keys.sort((a,b)=>Serializer.encode({object:PublicKey.from(a.key)}).hexString.localeCompare(Serializer.encode({object:PublicKey.from(b.key)}).hexString));
 return {account,permission:'active',parent:current.parent||'owner',auth:{...current.required_auth,keys},authorized_by:''};
}
export function validateDeviceKeyReview(built:DeviceKeyBuild,current:DeviceAuthority,intent:{account:string;publicKey:string;remove:string[];label:string;passkey?:string},now=Date.now()):DeviceKeyReview {
 if(built.chainId!==REX_CHAIN_ID || built.eosAccount!==intent.account || built.op!=='add' || !samePublicKey(built.publicKey,intent.publicKey) || (intent.passkey && (!built.wallet || !samePublicKey(built.wallet.chainPublicKey,intent.passkey)))) throw new Error(t('anchorImport.invalidResponse'));
 if(current.required_auth.threshold!==1) throw new Error(t('anchorImport.multisig'));
 const cleanup=built.remove??[];
 if(cleanup.length) throw new Error(t('anchorImport.nameConflict'));
 if(cleanup.some(k=>!intent.remove.some(r=>samePublicKey(r,k))) || intent.remove.some(k=>!cleanup.some(r=>samePublicKey(r,k))) || cleanup.some(k=>k.startsWith('PUB_WA_')||(intent.passkey && samePublicKey(k,intent.passkey))||samePublicKey(k,intent.publicKey))) throw new Error(t('anchorImport.invalidResponse'));
 const hex=built.transaction.serializedTransaction;
 if(typeof hex!=='string'||!hex.length||hex.length>16384||!built.transaction.sponsorRequestId) throw new Error(t('anchorImport.invalidResponse'));
 const tx=Serializer.decode({data:hex,type:Transaction});
 if(Serializer.encode({object:tx}).hexString!==hex || tx.context_free_actions.length || tx.transaction_extensions.length || Number(tx.delay_sec)!==0 || tx.actions.length!==2) throw new Error(t('anchorImport.invalidResponse'));
 const [noop,update]=tx.actions;
 if(String(noop.account)!=='eos3powerup1'||String(noop.name)!=='noop'||noop.data.hexString!==''||noop.authorization.length!==1||String(noop.authorization[0].actor)!=='eos3powerup1'||String(noop.authorization[0].permission)!=='paycpu') throw new Error(t('anchorImport.invalidResponse'));
 const data=deviceUpdateData(intent.account,current,intent.publicKey,cleanup);
 if(String(update.account)!=='eosio'||String(update.name)!=='updateauth'||update.authorization.length!==1||String(update.authorization[0].actor)!==intent.account||String(update.authorization[0].permission)!=='active'||update.data.hexString!==Serializer.encode({object:data,type:'updateauth',abi:DEVICE_AUTH_ABI}).hexString) throw new Error(t('anchorImport.invalidResponse'));
 if(built.transaction.sponsorFee) throw new Error(t('anchorImport.invalidResponse'));
 const expiration=String(tx.expiration);const expiresAt=Date.parse(expiration.endsWith('Z')?expiration:expiration+'Z');
 if(!Number.isFinite(expiresAt)||expiresAt<=now+8000) throw new Error(t('anchorImport.expired'));
 return {built:JSON.parse(JSON.stringify(built)),hex,expiresAt,label:intent.label,cleanup:[...cleanup]};
}
