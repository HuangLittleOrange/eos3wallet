jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), dismissAuthSession: jest.fn() }));
jest.mock('../../crypto/keys', () => ({ generateKey: jest.fn() }));
jest.mock('../../dapp/linkSocket', () => ({ listenLinkChannel: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { AppState, Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { PrivateKey, Serializer, Transaction, UInt64 } from '@wharfkit/antelope';
import { SigningRequest } from '@wharfkit/signing-request';
import { deflateRaw, inflateRaw } from 'pako';
import { listenLinkChannel } from '../../dapp/linkSocket';
import { generateKey } from '../../crypto/keys';
import { unsealMessage } from '../../dapp/linkCrypto';
import { AnchorWebCancelled, anchorWebUrl, connectAnchorWeb, openAnchorWebRequest, signWithAnchorWeb } from '../anchorWeb';
import { CHAINS } from '../config';
// This transport test needs matching ephemeral keys, not fixed protocol vectors.
const key = PrivateKey.generate('K1');
const remoteKey = PrivateKey.generate('K1');
const opts = { zlib: { deflateRaw, inflateRaw } };
const chain = CHAINS.vaulta.chainIdHash;
let receive: (raw: Uint8Array) => void;
let stop: jest.Mock;
let tamper: (payload: any) => void;
function respond(request: SigningRequest, transaction?: Transaction) {
  const resolved = transaction ? { transaction } : request.resolve(new Map(), {actor:'aliceacct111',permission:'active'}, {expiration:new Date(Date.now()+120000).toISOString().slice(0,19)});
  const signature = key.signDigest(resolved.transaction.signingDigest(chain));
  const payload: any = { cid:chain,sa:'aliceacct111',sp:'active',req:request.encode(),sig:String(signature),tx:String(resolved.transaction.id),link_key:String(remoteKey.toPublic()) };
  tamper(payload);
  receive(new TextEncoder().encode(JSON.stringify(payload)));
}
beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState='active';
  jest.mocked(generateKey).mockReturnValue({ privateKey: String(key), publicKey: String(key.toPublic()), legacyPublicKey: key.toPublic().toLegacyString(), path: '' });
  Object.defineProperty(Platform,'OS',{value:'android',configurable:true});
  jest.spyOn(Linking,'openURL').mockResolvedValue(true);
  stop=jest.fn();tamper=()=>{};
  jest.mocked(listenLinkChannel).mockImplementation((_url,run)=> {receive=run;return{stop};});
});
afterEach(()=>{jest.restoreAllMocks();jest.useRealTimers();AppState.currentState='active';});
it('opens Anchor web directly and sends interoperable link_create metadata without a device secret',async()=>{
  jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async url=>{
    expect(url.startsWith('https://vaulta.anchorwallet.io/sign?')).toBe(true);
    expect(url).not.toContain('eos3.app');expect(url).not.toContain(String(key));
    const params=new URL(url).searchParams;const req=SigningRequest.from(params.get('esr')!,opts);
    expect(req.getInfoKey('same_device', 'bool')).toBe(true);
    expect(req.getInfoKey('return_path')).toBe('eos3wallet://device-key-authorized?provider=anchor');
    const expected=Serializer.encode({object:{session_name:'eos3wallet',request_key:key.toPublic(),user_agent:'EOS3 Wallet mobile'},type:'link_create',abi:{structs:[{name:'link_create',base:'',fields:[{name:'session_name',type:'name'},{name:'request_key',type:'public_key'},{name:'user_agent',type:'string$'}]}]}});
    expect(req.getRawInfoKey('link')!.hexString).toBe(expected.hexString);
    respond(req);return{type:'opened'} as any;
  });
  const session=await connectAnchorWeb();expect(session.account).toBe('aliceacct111');expect(String(session.messageKey)).toBe(String(remoteKey.toPublic()));expect(stop).toHaveBeenCalled();
  expect(Linking.openURL).toHaveBeenCalledWith('eos3wallet://device-key-authorized?provider=anchor');
});
it.each(['cid','sa','sp','req','link_key'])('rejects a changed login %s',async field=>{
  tamper=payload=>{payload[field]=field==='sp'?'paytransfer':'INVALID';};
  jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async url=>{respond(SigningRequest.from(new URL(url).searchParams.get('esr')!,opts));return{type:'opened'} as any;});
  await expect(connectAnchorWeb()).rejects.toThrow();
});
it('seals the exact reviewed transaction for the browser session and never asks Anchor to broadcast',async()=>{
  const tx=Transaction.from({expiration:new Date(Date.now()+120000).toISOString().slice(0,19),ref_block_num:1,ref_block_prefix:2,actions:[{account:'eos3powerup1',name:'noop',authorization:[{actor:'eos3powerup1',permission:'paycpu'}],data:''}]});
  const hex=Serializer.encode({object:tx}).hexString;
  // Decode ciphertext with the protocol key material independently; re-use the
  // tested sealed-message encoder only to obtain the wire checksum (not sent by web transport).
  const cryptoModule=require('../../dapp/linkCrypto');
  const spy=jest.spyOn(cryptoModule,'sealMessage');
  jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async url=>{
    const p=new URL(url).searchParams;const sealed=spy.mock.results[spy.mock.results.length-1].value;
    expect(p.get('sealed')).toBe(sealed.ciphertext.hexString);
    const req=SigningRequest.from(unsealMessage(sealed,remoteKey),opts);
    expect(req.getInfoKey('same_device', 'bool')).toBe(true);
    expect(req.getInfoKey('return_path')).toBe('eos3wallet://device-key-authorized?provider=anchor');
    expect(req.shouldBroadcast()).toBe(false);
    expect(Serializer.encode({object:req.getRawTransaction()}).hexString).toBe(hex);
    respond(req,tx);return {type:'opened'} as any;
  });
  const session={account:'aliceacct111',permission:'active' as const,requestKey:key,messageKey:remoteKey.toPublic()};
  expect(await signWithAnchorWeb(session,hex)).toHaveLength(1);
  tamper=payload=>{payload.tx='00'.repeat(32);};
  await expect(signWithAnchorWeb(session,hex)).rejects.toThrow('anchorImport.invalidResponse');
});
it('cancellation and unmount stop the relay and do not navigate back into an abandoned screen',async()=>{
  jest.useFakeTimers();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({type:'cancel'} as any);
  const cancelled=openAnchorWebRequest(anchorWebUrl({chain}), 'https://cb.anchor.link/channel');
  const assertion=expect(cancelled).rejects.toBeInstanceOf(AnchorWebCancelled);
  await jest.advanceTimersByTimeAsync(8000);await assertion;
  expect(stop).toHaveBeenCalled();expect(Linking.openURL).not.toHaveBeenCalled();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({type:'opened'} as any);
  const controller=new AbortController();const promise=openAnchorWebRequest(anchorWebUrl({chain}), 'https://cb.anchor.link/channel',controller.signal);controller.abort();
  await expect(promise).rejects.toBeInstanceOf(AnchorWebCancelled);
  expect(Linking.openURL).not.toHaveBeenCalled();
});

it('recovers the buffered login after Android closes the tab and resumes its socket',async()=>{
 jest.useFakeTimers();let change!:(state:string)=>void;const remove=jest.fn();
 jest.spyOn(AppState,'addEventListener').mockImplementation((_event,callback)=>{change=callback as any;return{remove};});
 let request!:SigningRequest;
 jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async url=>{
  request=SigningRequest.from(new URL(url).searchParams.get('esr')!,opts);
  AppState.currentState='background';return{type:'dismiss'} as any;
 });
 let completed=false;const result=connectAnchorWeb().then(value=>{completed=true;return value;});
 await jest.advanceTimersByTimeAsync(0);
 expect(completed).toBe(false);expect(listenLinkChannel).toHaveBeenCalledTimes(2);
 AppState.currentState='active';change('active');
 expect(listenLinkChannel).toHaveBeenCalledTimes(3);
 respond(request);
 expect((await result).account).toBe('aliceacct111');
 expect(remove).toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});

it('aborts the callback recovery window immediately when the import screen is left',async()=>{
 jest.useFakeTimers();
 jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({type:'dismiss'} as any);
 const controller=new AbortController();
 const result=connectAnchorWeb(controller.signal);
 const assertion=expect(result).rejects.toBeInstanceOf(AnchorWebCancelled);
 await jest.advanceTimersByTimeAsync(0);controller.abort();await assertion;
 expect(jest.getTimerCount()).toBe(0);expect(Linking.openURL).not.toHaveBeenCalled();
});

it('waits for Android to return to the foreground before completing a login',async()=>{
 jest.useFakeTimers();let change!:(state:string)=>void;const remove=jest.fn();
 jest.spyOn(AppState,'addEventListener').mockImplementation((_event,callback)=>{change=callback as any;return{remove};});
 jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async url=>{
  AppState.currentState='background';respond(SigningRequest.from(new URL(url).searchParams.get('esr')!,opts));return{type:'opened'} as any;
 });
 let completed=false;const result=connectAnchorWeb().then(value=>{completed=true;return value;});
 await jest.advanceTimersByTimeAsync(0);
 expect(completed).toBe(false);expect(Linking.openURL).toHaveBeenCalled();
 AppState.currentState='active';change('active');
 expect((await result).account).toBe('aliceacct111');expect(remove).toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});

it('cancels foreground waiting on unmount and removes its listener and timeout',async()=>{
 jest.useFakeTimers();const remove=jest.fn();
 jest.spyOn(AppState,'addEventListener').mockReturnValue({remove});
 jest.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async url=>{
  AppState.currentState='background';respond(SigningRequest.from(new URL(url).searchParams.get('esr')!,opts));return{type:'opened'} as any;
 });
 const controller=new AbortController();const result=connectAnchorWeb(controller.signal);
 const assertion=expect(result).rejects.toBeInstanceOf(AnchorWebCancelled);
 await jest.advanceTimersByTimeAsync(0);controller.abort();await assertion;
 expect(remove).toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
