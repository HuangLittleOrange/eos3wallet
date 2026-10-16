import React from 'react';
import { useHistoryPagination } from '../useHistoryPagination';
import type { ChainAction } from '../client';
const { act, create } = require('react-test-renderer');
let renderer: any, current: ReturnType<typeof useHistoryPagination>, scope = 0;
const row = (seq: number): ChainAction => ({ id: `tx${seq}`, seq, time: '2026-10-16T00:00:00Z', contract: 'core.vaulta', action: 'transfer' });
const head = Array.from({ length: 30 }, (_, i) => row(i));
function Harness(props: { client: any; account: string; head: ChainAction[] }) { current = useHistoryPagination(props.client, props.account, props.head, false); return null; }
const client = () => ({ chainId: 'vaulta', historyNode: { url: `https://history-${++scope}.example` }, getActions: jest.fn() });
const render = async (props: any) => { await act(async () => { renderer = create(React.createElement(Harness, props)); }); };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('same-tick scroll events share one read and duplicate rows do not duplicate the list', async () => {
  const rpc = client(); let finish!: (data: any) => void;
  rpc.getActions.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render({ client: rpc, account: 'alice', head });
  await act(async () => { void current.loadMore(); void current.loadMore(); });
  expect(rpc.getActions).toHaveBeenCalledTimes(1);
  await act(async () => finish({ actions: [head[29], row(30)], hasMore: false }));
  expect(current.all).toHaveLength(31); expect(current.loadingMore).toBe(false);
});
test('unchanged heads keep loaded pages; another screen reuses them; a new head uses a new page key', async () => {
  const rpc = client(); rpc.getActions.mockResolvedValue({ actions: [row(30)], hasMore: false });
  const props = { client: rpc, account: 'alice', head }; await render(props);
  await act(async () => current.loadMore());
  await act(async () => renderer.update(React.createElement(Harness, { ...props, head: [...head] })));
  expect(current.all).toHaveLength(31);
  await act(async () => renderer.unmount()); await render(props);
  await act(async () => current.loadMore()); expect(rpc.getActions).toHaveBeenCalledTimes(1);
  await act(async () => renderer.update(React.createElement(Harness, { ...props, head: [row(100), ...head.slice(0, 29)] })));
  expect(current.all).toHaveLength(30);
  await act(async () => current.loadMore()); expect(rpc.getActions).toHaveBeenCalledTimes(2);
});
test('late pages cannot append to a different account', async () => {
  const rpc = client(); let finish!: (value: any) => void;
  rpc.getActions.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = { client: rpc, account: 'alice', head }; await render(props);
  await act(async () => { void current.loadMore(); });
  const bob = head.map((_, i) => row(100 + i));
  await act(async () => renderer.update(React.createElement(Harness, { ...props, account: 'bob', head: bob })));
  await act(async () => finish({ actions: [row(999)], hasMore: false }));
  expect(current.all).toEqual(bob); expect(current.loadingMore).toBe(false);
});
