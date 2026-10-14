import {parseNodeCatalog} from '../nodeCatalog';
const node=(chain='vaulta',kind='rpc',over:Record<string,unknown>={})=>({id:chain+'-'+kind,name:chain,url:'https://public.example.com',chain,kind,enabled:true,sortOrder:10,...over});
const document=()=>({schemaVersion:1,nodes:[node(),node('vaulta','history'),node('jungle4'),node('jungle4','history')]});
test('published node metadata is sorted and disabled nodes are excluded',()=>{
 const doc=document();doc.nodes.push(node('vaulta','rpc',{id:'preferred',sortOrder:0,name:'Preferred'}),node('vaulta','rpc',{id:'disabled',enabled:false}));
 expect(parseNodeCatalog(doc).vaulta.rpc.map(n=>n.id)).toEqual(['preferred','vaulta-rpc']);
});
test.each(['http://public.example.com','https://user:secret@public.example.com','https://public.example.com?key=value','https://public.example.com#fragment','javascript:alert(1)'])('unsafe node URL is rejected: %s',url=>{
 const doc=document();doc.nodes[0].url=url;expect(()=>parseNodeCatalog(doc)).toThrow();
});
test('duplicate IDs and an empty network cannot replace a working catalog',()=>{
 const doc=document();doc.nodes.push({...doc.nodes[0]});expect(()=>parseNodeCatalog(doc)).toThrow();
 const empty=document();empty.nodes[0].enabled=false;expect(()=>parseNodeCatalog(empty)).toThrow();
});
test('unknown chain identity and invalid schema are rejected',()=>{
 const doc=document();doc.nodes[0].chain='other';expect(()=>parseNodeCatalog(doc)).toThrow();
 expect(()=>parseNodeCatalog({...document(),schemaVersion:2})).toThrow();
});
