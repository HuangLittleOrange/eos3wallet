jest.mock('../../net/publicApi',()=>({OPERATIONS_API_BASE_URL:'https://eos3.app',fetchPublicJSON:jest.fn()}));
jest.mock('react-native',()=>({AppState:{currentState:'active',addEventListener:jest.fn(()=>({remove:jest.fn()}))}}));
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NodeCatalogProvider,useNodeCatalog,useNodeCatalogRefresh} from '../NodeCatalogContext';
import {fetchPublicJSON} from '../../net/publicApi';
import {BUILTIN_NODE_CATALOG} from '../nodeCatalog';
const {act,create}=require('react-test-renderer');
let state:ReturnType<typeof useNodeCatalog>;
let refresh:ReturnType<typeof useNodeCatalogRefresh>;
let renderer:{unmount():void}|undefined;
function Consumer(){state=useNodeCatalog();refresh=useNodeCatalogRefresh();return null;}
const doc={schemaVersion:1,nodes:(['vaulta','jungle4'] as const).flatMap(chain=>(['rpc','history'] as const).map(kind=>({id:chain+'-'+kind,name:'Cached',url:'https://public.example.com',chain,kind,enabled:true,sortOrder:0})))};
beforeEach(()=>{jest.useFakeTimers();jest.clearAllMocks();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);});
afterEach(()=>{if(renderer)act(()=>renderer?.unmount());renderer=undefined;jest.useRealTimers();});
async function mount(){await act(async()=>{renderer=create(React.createElement(NodeCatalogProvider,null,React.createElement(Consumer)));});}
test('a validated cache survives a failed or invalid refresh',async()=>{
 jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(doc));jest.mocked(fetchPublicJSON).mockResolvedValue({schemaVersion:1,document:{schemaVersion:1,nodes:[]}});
 await mount();expect(state.vaulta.rpc[0].name).toBe('Cached');expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});
test('a valid publication updates the catalog and persists it',async()=>{
 jest.mocked(fetchPublicJSON).mockResolvedValue({schemaVersion:1,document:doc});await mount();expect(state.vaulta.rpc[0].name).toBe('Cached');expect(AsyncStorage.setItem).toHaveBeenCalledWith(expect.stringContaining('eos3.nodes.v1'),JSON.stringify(doc));
});
test('an unconfigured server returns to built-in defaults',async()=>{
 jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(doc));jest.mocked(fetchPublicJSON).mockResolvedValue({schemaVersion:1,document:null});await mount();expect(state).toBe(BUILTIN_NODE_CATALOG);expect(AsyncStorage.removeItem).toHaveBeenCalled();
});
test('explicit refresh reads a new publication without waiting five minutes',async()=>{
 const updated={...doc,nodes:doc.nodes.map(node=>({...node,name:'Updated'}))};
 jest.mocked(fetchPublicJSON).mockResolvedValueOnce({schemaVersion:1,document:doc}).mockResolvedValueOnce({schemaVersion:1,document:updated});
 await mount();await act(async()=>{await refresh();});
 expect(state.vaulta.rpc[0].name).toBe('Updated');expect(fetchPublicJSON).toHaveBeenCalledTimes(2);
});
