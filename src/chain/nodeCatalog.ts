import type {ChainId,NodeInfo} from './config';
import {CHAINS} from './config';

export type NodeCatalog=Record<ChainId,{rpc:NodeInfo[];history:NodeInfo[]}>;
export const BUILTIN_NODE_CATALOG:NodeCatalog={vaulta:{rpc:CHAINS.vaulta.nodes,history:CHAINS.vaulta.historyNodes},jungle4:{rpc:CHAINS.jungle4.nodes,history:CHAINS.jungle4.historyNodes}};

/** Only endpoint metadata is configurable. Chain IDs and signing rules stay local. */
export function parseNodeCatalog(value:unknown):NodeCatalog {
  const invalid=():never=>{throw new Error('Invalid node catalog');};
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const doc=value as Record<string,unknown>;
  if(doc.schemaVersion!==1||!Array.isArray(doc.nodes)||doc.nodes.length>100)invalid();
  const result:NodeCatalog={vaulta:{rpc:[],history:[]},jungle4:{rpc:[],history:[]}};
  const seen=new Set<string>();
  const nodes=(doc.nodes as unknown[]).map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry))invalid();
    const node=entry as Record<string,unknown>;
    for(const field of ['id','name','url'])if(typeof node[field]!=='string'||!(node[field] as string).trim()||[...(node[field] as string)].length>(field==='url'?2048:80))invalid();
    if(!['vaulta','jungle4'].includes(String(node.chain))||!['rpc','history'].includes(String(node.kind))||typeof node.enabled!=='boolean'||!Number.isInteger(node.sortOrder)||Math.abs(Number(node.sortOrder))>1000000)invalid();
    if(node.id!==String(node.id).trim()||seen.has(node.id as string))invalid();seen.add(node.id as string);
    let url:URL;try{url=new URL(node.url as string);}catch{return invalid();}
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.search||url.hash||/[\\\p{Cc}\s]/u.test(node.url as string))invalid();
    return node as {id:string;name:string;url:string;chain:ChainId;kind:'rpc'|'history';enabled:boolean;sortOrder:number};
  }).sort((a,b)=>a.sortOrder-b.sortOrder||a.id.localeCompare(b.id));
  for(const node of nodes)if(node.enabled)result[node.chain][node.kind].push({id:node.id,name:node.name,url:node.url.replace(/\/+$/,'')});
  for(const chain of ['vaulta','jungle4'] as const)for(const kind of ['rpc','history'] as const)if(!result[chain][kind].length)invalid();
  return result;
}
