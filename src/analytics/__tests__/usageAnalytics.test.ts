import {createUsageAnalytics,USAGE_ANALYTICS_KEY,type AnalyticsSdk} from '../usageAnalytics';
function fixture(saved:string|null=null,available=true){
 const sdk:jest.Mocked<AnalyticsSdk>={collection:jest.fn<Promise<void>,[boolean]>(async()=>{}),consent:jest.fn<Promise<void>,[Parameters<AnalyticsSdk['consent']>[0]]>(async()=>{}),reset:jest.fn(async()=>{})};
 const storage={getItem:jest.fn(async()=>saved),setItem:jest.fn(async(_key:string,_value:string)=>{})};const loadSdk=jest.fn(async()=>sdk);
 return {sdk,storage,loadSdk,controller:createUsageAnalytics({available,storage,loadSdk})};
}
it.each(['disabled','true','wallet-account'])('keeps explicit opt-out and malformed preferences disabled (%s)',async saved=>{
 const f=fixture(saved);await f.controller.start();expect(f.sdk.collection).not.toHaveBeenCalledWith(true);
 expect(f.controller.snapshot()).toMatchObject({ready:true,enabled:false,error:false});
});
it.each([null,'enabled'])('only allows analytics storage, preserving all advertising denials on startup (%s)',async saved=>{
 const f=fixture(saved);await f.controller.start();expect(f.sdk.collection).toHaveBeenLastCalledWith(true);
 for(const [consent] of f.sdk.consent.mock.calls)expect(consent).toMatchObject({ad_storage:false,ad_user_data:false,ad_personalization:false});
 expect(f.sdk.consent).toHaveBeenLastCalledWith({analytics_storage:true,ad_storage:false,ad_user_data:false,ad_personalization:false});
});
it('persists an explicit enable preference before enabling and stores no account or wallet data',async()=>{
 const f=fixture('disabled');await f.controller.start();await f.controller.setEnabled(true);
 expect(f.storage.setItem).toHaveBeenCalledWith(USAGE_ANALYTICS_KEY,'enabled');
 expect(f.storage.setItem.mock.invocationCallOrder[0]).toBeLessThan(f.sdk.collection.mock.invocationCallOrder.at(-1)!);
 expect(f.controller.snapshot().enabled).toBe(true);expect(Object.keys(f.sdk)).toEqual(['collection','consent','reset']);
});
it('disables before persistence and resets the installation ID',async()=>{
 const f=fixture('enabled');await f.controller.start();f.sdk.collection.mockClear();await f.controller.setEnabled(false);
 expect(f.sdk.collection).toHaveBeenCalledWith(false);expect(f.sdk.reset).toHaveBeenCalledTimes(1);
 expect(f.storage.setItem).toHaveBeenCalledWith(USAGE_ANALYTICS_KEY,'disabled');expect(f.controller.snapshot().enabled).toBe(false);
});
it('a missing Firebase project or unsupported build never loads the native SDK or reads local wallet data',async()=>{
 const f=fixture('enabled',false);await f.controller.start();expect(f.loadSdk).not.toHaveBeenCalled();expect(f.storage.getItem).not.toHaveBeenCalled();
 expect(f.controller.snapshot()).toMatchObject({available:false,enabled:false,ready:true});
});
it('unreadable preferences and native failures fail closed without exposing raw errors',async()=>{
 const f=fixture('enabled');f.storage.getItem.mockRejectedValue(new Error('sensitive native detail'));await f.controller.start();
 expect(f.sdk.collection).not.toHaveBeenCalledWith(true);expect(f.controller.snapshot()).toMatchObject({enabled:false,error:true});
 f.storage.setItem.mockRejectedValueOnce(new Error('wallet sensitive detail'));
 await expect(f.controller.setEnabled(true)).rejects.toThrow('Unable to update usage analytics');expect(f.sdk.collection).not.toHaveBeenCalledWith(true);
});
it('a rapid opt-out cannot be undone by a pending startup or earlier opt-in',async()=>{
 const f=fixture('enabled');const start=f.controller.start();const on=f.controller.setEnabled(true);const off=f.controller.setEnabled(false);
 await Promise.all([start,on,off]);expect(f.sdk.collection).not.toHaveBeenCalledWith(true);
 expect(f.storage.setItem).toHaveBeenLastCalledWith(USAGE_ANALYTICS_KEY,'disabled');expect(f.controller.snapshot().enabled).toBe(false);
});
it('no general event, user-ID, screen, transaction or payload API is exposed',()=>{
 const f=fixture();for(const method of ['logEvent','setUserId','setUserProperties','logScreenView','logTransaction'])expect(method in f.controller).toBe(false);
});

it('enables a new configured installation once without recording an explicit user preference',async()=>{
 const f=fixture();await Promise.all([f.controller.start(),f.controller.start(),f.controller.start()]);
 expect(f.controller.snapshot()).toMatchObject({ready:true,available:true,enabled:true,error:false});
 expect(f.sdk.collection.mock.calls.filter(([enabled])=>enabled)).toHaveLength(1);
 expect(f.storage.setItem).not.toHaveBeenCalled();
});
it('keeps collection disabled after the user turns it off and restarts the app',async()=>{
 let saved:string|null=null;
 const f=fixture();f.storage.getItem.mockImplementation(async()=>saved);
 f.storage.setItem.mockImplementation(async(_key:string,value:string)=>{saved=value;});
 await f.controller.start();expect(f.controller.snapshot().enabled).toBe(true);
 await f.controller.setEnabled(false);expect(saved).toBe('disabled');
 const restarted=createUsageAnalytics({available:true,storage:f.storage,loadSdk:f.loadSdk});
 f.sdk.collection.mockClear();await restarted.start();
 expect(f.sdk.collection).not.toHaveBeenCalledWith(true);expect(restarted.snapshot().enabled).toBe(false);
});
