import {discoveryModules} from '../modules';
import {parseAppContent} from '../validation';
import {DEFAULT_CONTENT} from '../defaults';
import type {AppContent,AppBrowseProject,ContentModule} from '../types';
const app:AppBrowseProject={id:'a',enabled:true,featured:false,sortOrder:0,name:'Catalog app',description:'Catalog description',iconUrl:'https://a.example/icon.png',appUrl:'https://a.example',category:'Tools',translations:{zh:{name:'目录应用'}}};
const module=(id='tools'):ContentModule=>({id,enabled:true,sortOrder:0,title:{en:'Tools'},description:{en:'Useful apps'},items:[{id:'i',enabled:true,sortOrder:0,projectId:'a',title:{en:'stale'},description:{en:'stale'},url:'https://stale.example',color:'#123',hot:false}]});
const content=(modules:ContentModule[]):AppContent=>({...DEFAULT_CONTENT,modules});
it('resolves catalog metadata and URLs, includes nonfeatured apps, and refreshes metadata',()=>{
 expect(discoveryModules(content([module()]),[app],'zh')[0].items[0]).toMatchObject({name:'目录应用',desc:'Catalog description',url:app.appUrl,imageUrl:app.iconUrl});
 expect(discoveryModules(content([module()]),[{...app,appUrl:'https://new.example'}],'en')[0].items[0].url).toBe('https://new.example');
});
it('hides disabled, empty, removed and disabled-catalog modules without fallback',()=>{
 for(const modules of [[],[{...module(),enabled:false}],[{...module(),items:[]}],[{...module(),items:module().items.map(i=>({...i,enabled:false}))}]])expect(discoveryModules(content(modules),[app],'en')).toEqual([]);
 expect(discoveryModules(content([module()]),[],'en')).toEqual([]);
 expect(discoveryModules(content([module()]),[{...app,enabled:false}],'en')).toEqual([]);
});
it('orders modules and apps and preserves legacy off state',()=>{
 const legacy={...DEFAULT_CONTENT};delete legacy.modules;
 expect(discoveryModules({...legacy,earnEnabled:false},[app],'en')).toEqual([]);
 const m=module();m.items.push({...m.items[0],id:'custom',projectId:undefined,title:{en:'Custom'},sortOrder:-1});
 expect(discoveryModules(content([{...m,id:'later',sortOrder:2},{...m,id:'first',sortOrder:1}]),[app],'en').map(m=>m.id)).toEqual(['first','later']);
 expect(discoveryModules(content([m]),[app],'en')[0].items.map(i=>i.name)).toEqual(['Custom','Catalog app']);
});
it('validates nested modules, explicit empty list and rejects duplicate references and unsafe links',()=>{
 expect(parseAppContent(content([])).modules).toEqual([]);
 expect(parseAppContent(content([module()])).modules![0].items[0].projectId).toBe('a');
 const m=module();m.items.push({...m.items[0],id:'duplicate'});
 expect(()=>parseAppContent(content([m]))).toThrow();
 expect(()=>parseAppContent(content([{...module(),items:[{...module().items[0],url:'javascript:alert(1)'}]}]))).toThrow();
 expect(()=>parseAppContent({...content([]),modules:null})).toThrow();
});
