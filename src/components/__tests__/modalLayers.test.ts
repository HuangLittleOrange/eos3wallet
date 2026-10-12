// 全局弹层栈的单测——重点是"层级只由打开先后决定":底下那层重渲染(内容更新)
// 不能跑到上面去盖住后打开的层;返回键只关最上面那层。
// 栈是模块级单例,每个用例用 isolateModules 拿一份干净的。
type LayersModule = typeof import('../modalLayers');

function freshModule(): LayersModule {
  let mod: LayersModule | undefined;
  jest.isolateModules(() => {
    mod = require('../modalLayers');
  });
  return mod!;
}

const ids = (m: LayersModule) => m.getLayers().map((l) => l.id);

describe('modalLayers', () => {
  it('按登记顺序叠放,后打开的在最上面', () => {
    const m = freshModule();
    const a = m.allocLayerId();
    const b = m.allocLayerId();
    m.upsertLayer({ id: a, node: 'A' });
    m.upsertLayer({ id: b, node: 'B' });
    expect(ids(m)).toEqual([a, b]);
  });

  it('已登记的层更新内容时原地替换,不改变层级', () => {
    const m = freshModule();
    const a = m.allocLayerId();
    const b = m.allocLayerId();
    m.upsertLayer({ id: a, node: 'A1' });
    m.upsertLayer({ id: b, node: 'B' });
    m.upsertLayer({ id: a, node: 'A2' });
    expect(ids(m)).toEqual([a, b]);
    expect(m.getLayers()[0].node).toBe('A2');
  });

  it('关掉底下那层不影响上面的层;重复移除是空操作', () => {
    const m = freshModule();
    const a = m.allocLayerId();
    const b = m.allocLayerId();
    m.upsertLayer({ id: a, node: 'A' });
    m.upsertLayer({ id: b, node: 'B' });
    m.removeLayer(a);
    m.removeLayer(a);
    expect(ids(m)).toEqual([b]);
  });

  it('"关掉 A 马上打开 B":A 退场期间 B 叠在上面,A 卸载后只剩 B', () => {
    const m = freshModule();
    const a = m.allocLayerId();
    m.upsertLayer({ id: a, node: 'A' });
    const b = m.allocLayerId();
    m.upsertLayer({ id: b, node: 'B' }); // A 还在播退场动画,没卸载
    expect(ids(m)).toEqual([a, b]);
    m.removeLayer(a); // 退场动画播完
    expect(ids(m)).toEqual([b]);
  });

  it('返回键只关最上面一层;没有层时什么都不做', () => {
    const m = freshModule();
    m.requestCloseTop();
    const closeA = jest.fn();
    const closeB = jest.fn();
    m.upsertLayer({ id: m.allocLayerId(), node: 'A', onRequestClose: closeA });
    m.upsertLayer({ id: m.allocLayerId(), node: 'B', onRequestClose: closeB });
    m.requestCloseTop();
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  it('每次变更都通知订阅者,取消订阅后不再通知;快照引用随变更而变', () => {
    const m = freshModule();
    const listener = jest.fn();
    const unsubscribe = m.subscribeLayers(listener);
    const before = m.getLayers();
    const a = m.allocLayerId();
    m.upsertLayer({ id: a, node: 'A' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(m.getLayers()).not.toBe(before); // useSyncExternalStore 靠引用变化判断要不要重渲染
    unsubscribe();
    m.removeLayer(a);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
