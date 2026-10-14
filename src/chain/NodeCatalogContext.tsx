import React,{createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import {AppState} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {fetchPublicJSON,OPERATIONS_API_BASE_URL} from '../net/publicApi';
import {BUILTIN_NODE_CATALOG,parseNodeCatalog,type NodeCatalog} from './nodeCatalog';

const KEY='eos3.nodes.v1:'+OPERATIONS_API_BASE_URL;
const MAX_BYTES=256*1024;
const Ctx=createContext<NodeCatalog>(BUILTIN_NODE_CATALOG);
const RefreshCtx=createContext<()=>Promise<NodeCatalog>>(async()=>BUILTIN_NODE_CATALOG);

export function NodeCatalogProvider({children}:{children:React.ReactNode}) {
  const [catalog,setCatalog]=useState(BUILTIN_NODE_CATALOG);
  const [hydrated,setHydrated]=useState(false);
  const catalogRef=useRef(catalog);catalogRef.current=catalog;
  const refreshRef=useRef<()=>Promise<NodeCatalog>>(async()=>catalogRef.current);
  const refreshNow=useCallback(()=>refreshRef.current(),[]);
  useEffect(()=>{
    let alive=true,pending=false,lastAttempt=0;
    let controller:AbortController|null=null;
    const refresh=async(force=false):Promise<NodeCatalog>=>{
      if(!alive||pending||(!force&&(AppState.currentState!=='active'||Date.now()-lastAttempt<5*60*1000)))return catalogRef.current;
      pending=true;lastAttempt=Date.now();controller=new AbortController();
      try{
        const payload=await fetchPublicJSON(OPERATIONS_API_BASE_URL+'/api/app-nodes',{signal:controller.signal,maxLength:MAX_BYTES,label:'Nodes'}) as {schemaVersion?:number;document?:unknown};
        if(payload.schemaVersion!==1||!('document' in payload))throw new Error('Invalid node catalog response');
        const next=payload.document===null?BUILTIN_NODE_CATALOG:parseNodeCatalog(payload.document);
        if(!alive)return catalogRef.current;catalogRef.current=next;setCatalog(next);
        if(payload.document===null)await AsyncStorage.removeItem(KEY).catch(()=>{});
        else await AsyncStorage.setItem(KEY,JSON.stringify(payload.document)).catch(()=>{});
        return next;
      }catch{ /* Offline and invalid updates preserve the last validated catalog. */ return catalogRef.current; }
      finally{pending=false;controller=null;}
    };
    refreshRef.current=()=>refresh(true);
    const hydrate=async()=>{
      try{const raw=await AsyncStorage.getItem(KEY);if(raw&&raw.length<=MAX_BYTES){const cached=parseNodeCatalog(JSON.parse(raw));if(alive)setCatalog(cached);}}catch{}
      if(alive){setHydrated(true);void refresh();}
    };
    void hydrate();
    const subscription=AppState.addEventListener('change',state=>{if(state==='active')void refresh();});
    const timer=setInterval(()=>void refresh(),5*60*1000);
    return()=>{alive=false;controller?.abort();subscription.remove();clearInterval(timer);};
  },[]);
  // Hydrate the catalog before restoring a session that may refer to a remote node ID.
  return hydrated?<RefreshCtx.Provider value={refreshNow}><Ctx.Provider value={catalog}>{children}</Ctx.Provider></RefreshCtx.Provider>:null;
}
export function useNodeCatalog():NodeCatalog{return useContext(Ctx);}

export function useNodeCatalogRefresh(){return useContext(RefreshCtx);}
