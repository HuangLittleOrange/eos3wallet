jest.mock('react-native', () => ({
  View:'View',Text:'Text',TextInput:'TextInput',TouchableOpacity:'TouchableOpacity',ActivityIndicator:'ActivityIndicator',
  StyleSheet:{create:(styles:unknown)=>styles},
}));
jest.mock('../../i18n', () => ({ t:(key:string)=>key,useI18n:()=>({locale:'en',t:(key:string)=>key}) }));
jest.mock('../../chain/rex', () => ({...jest.requireActual('../../chain/rex'),readRexBalances:jest.fn()}));
import React from 'react';
import RexOperations from '../RexOperations';
import { readRexBalances, type RexBalances } from '../../chain/rex';
import { rexDisplayCache, rexDisplayKey } from '../../chain/rexDisplayCache';
const {create,act}=require('react-test-renderer');
const client:any={config:{resourceContract:'core.vaulta'}};
let renderer:any;
const reviewed=jest.fn();
const state=():RexBalances=>({account:'alice',liquid:'10.0000 A',total:'200.0000 REX',savings:'100.0000 REX',available:'50.0000 REX',fund:'0.3125 A',maturityDays:21,autoSell:true,maturities:[],order:null});
const props={client,account:'alice',refreshKey:1,canSign:true,busy:false,onReview:reviewed};
const render=async(extra={})=>{await act(async()=>{renderer=create(React.createElement(RexOperations,{...props,...extra}));});};
const press=async(text:string)=>{
  const n=renderer.root.findAllByType('TouchableOpacity').find((n:any)=>n.findAllByType('Text').some((t:any)=>t.children.includes(text)));
  expect(n).toBeDefined();expect(n.props.disabled).not.toBe(true);await act(async()=>{await n.props.onPress();});
};
const input=async(value:string)=>{await act(async()=>renderer.root.findByType('TextInput').props.onChangeText(value));};
const reviewButton=()=>renderer.root.findAllByType('TouchableOpacity').find((n:any)=>n.props.accessibilityLabel==='rex.review');
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;jest.clearAllMocks();rexDisplayCache.invalidate(rexDisplayKey(client,'alice'));rexDisplayCache.invalidate(rexDisplayKey(client,'bob'));jest.mocked(readRexBalances).mockImplementation(async()=>state());});
afterEach(async()=>{if(renderer)await act(async()=>renderer.unmount());renderer=null;});
test('sell-all confirmation carries REX only, then withdrawal uses an independent A amount',async()=>{
  await render();await press('rex.sell');expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
  await press('rex.review');expect(reviewed.mock.calls[0][0]).toEqual([{account:'core.vaulta',name:'sellrex',data:{from:'alice',rex:'50.0000 REX'}}]);
  await press('rex.withdraw');await input('0.3125');await press('rex.review');
  expect(reviewed.mock.calls[1][0]).toEqual([{account:'core.vaulta',name:'withdraw',data:{owner:'alice',amount:'0.3125 A'}}]);
  expect(reviewed.mock.calls[1][1]).toBe('rex.hint.withdraw');
});
test('deposit and unlock confirmation retain their distinct units',async()=>{
  await render();await input('1.2345');await press('rex.review');
  expect(reviewed.mock.calls[0][0].map((a:any)=>[a.name,a.data.amount])).toEqual([['deposit','1.2345 A'],['buyrex','1.2345 A']]);
  await press('rex.unlock');await input('2');await press('rex.review');
  expect(reviewed.mock.calls[1][0]).toEqual([{account:'core.vaulta',name:'mvfrsavings',data:{owner:'alice',rex:'2.0000 REX'}}]);
});
test('cannot enter a REX-sized withdrawal that exceeds the actual A fund',async()=>{
  await render();await press('rex.withdraw');await input('50');expect(reviewButton().props.disabled).toBe(true);expect(reviewed).not.toHaveBeenCalled();
  await input('0.00001');expect(reviewButton().props.disabled).toBe(true);
});
test('a changed on-chain matured amount is reloaded and requires a fresh review',async()=>{
  await render();await press('rex.sell');jest.mocked(readRexBalances).mockResolvedValue({...state(),available:'60.0000 REX'});
  await press('rex.review');expect(reviewed).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('Text').some((n:any)=>n.children.includes('rex.insufficient'))).toBe(true);
  await press('rex.review');expect(reviewed.mock.calls[0][0][0].data.rex).toBe('60.0000 REX');
});
test('failed balance read disables review and refresh recovers without signing',async()=>{
  jest.mocked(readRexBalances).mockRejectedValueOnce(new Error('offline'));await render();
  expect(reviewButton().props.disabled).toBe(true);await press('rex.refresh');await input('1');expect(reviewButton().props.disabled).toBe(false);expect(reviewed).not.toHaveBeenCalled();
});
test('account changes while checking balances never open the old confirmation',async()=>{
  await render();await press('rex.withdraw');await input('0.1');
  let resolve!:(s:RexBalances)=>void;jest.mocked(readRexBalances).mockImplementationOnce(()=>new Promise(r=>resolve=r));
  await press('rex.review');await act(async()=>renderer.update(React.createElement(RexOperations,{...props,account:'bob'})));
  await act(async()=>resolve(state()));expect(reviewed).not.toHaveBeenCalled();
});
test('unmount and read-only wallets cannot launch a transaction',async()=>{
  await render({canSign:false});await input('1');expect(reviewButton().props.disabled).toBe(true);expect(reviewed).not.toHaveBeenCalled();
});
test('open sell orders are cancelled with only the owner action',async()=>{
  jest.mocked(readRexBalances).mockResolvedValue({...state(),order:{open:true,requested:'50.0000 REX'}});
  await render();await press('rex.cancel');expect(reviewed.mock.calls[0][0]).toEqual([{account:'eosio',name:'cnclrexorder',data:{owner:'alice'}}]);
});
test('block refresh retains the draft and visible balances instead of clearing the form',async()=>{
  await render();await input('1.5');
  let finish!:(s:RexBalances)=>void;jest.mocked(readRexBalances).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>renderer.update(React.createElement(RexOperations,{...props,refreshKey:2})));
  expect(renderer.root.findByType('TextInput').props.value).toBe('1.5');
  expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  await act(async()=>finish(state()));expect(renderer.root.findByType('TextInput').props.value).toBe('1.5');
});
test('reopening reuses a recent display snapshot but reviewing still reads live balances',async()=>{
  await render();await act(async()=>renderer.unmount());renderer=null;
  await render();expect(readRexBalances).toHaveBeenCalledTimes(1);
  await input('1');await press('rex.review');expect(readRexBalances).toHaveBeenCalledTimes(2);
});
