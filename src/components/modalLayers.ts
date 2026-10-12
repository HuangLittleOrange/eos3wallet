// 全局弹层栈的数据部分(纯 TS,不碰 React/RN,方便单测)。渲染在 ModalHost.tsx。
//
// 为什么不用原生 Modal:iOS 上 RN 的 Modal 是从"离它最近的 ViewController"
// 去 present 的。页面里并排摆的两个 Modal 找到的都是根 VC,而根 VC 同一时间
// 只能 present 一个——第二个会被 UIKit 静默拒掉(只打一行 "Attempt to present
// ... which is already presenting" 日志),界面上就是"点了没反应"。不光是
// "叠着弹"才会撞上:BottomSheet/CenterDialog 关闭时要播完退场动画才卸载
// Modal,这 200ms 里原生 Modal 还挂着,所以"关掉 A 马上打开 B"这种最常见的
// 写法也会让 B 丢掉。安卓每个 Modal 是独立 Dialog,不受影响,所以这类问题
// 只在 iPhone 上出现、很难在开发时发现。
//
// 就算收拢成只剩一个原生 Modal,它仍然要跟别的原生弹出(系统分享面板、以后
// 接的相册/文件选择器)抢同一条 present 链,还是会互相踩。所以干脆不 present:
// 各处弹层把内容登记到这里,由 ModalHost 用普通 View 盖在 App 内容上面、按打开
// 顺序叠起来渲染。原生层面什么都不弹,这一类问题从根上就不存在了。

export type ModalLayer = {
  id: number;
  node: unknown;
  /** 安卓返回键:交给最上面那一层处理 */
  onRequestClose?: () => void;
};

type Listener = () => void;

let layers: ModalLayer[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit() {
  for (const l of listeners) l();
}

export function allocLayerId(): number {
  return nextId++;
}

/**
 * 登记或更新一层。第一次登记的层追加到栈顶;已登记的层原地更新内容,
 * 不改变层级——层级只由"什么时候打开"决定,不能因为底下那层重渲染了一次
 * 就跑到上面去把新弹的层盖住。
 */
export function upsertLayer(layer: ModalLayer) {
  const i = layers.findIndex((l) => l.id === layer.id);
  layers = i === -1 ? [...layers, layer] : layers.map((l, j) => (j === i ? layer : l));
  emit();
}

export function removeLayer(id: number) {
  if (!layers.some((l) => l.id === id)) return;
  layers = layers.filter((l) => l.id !== id);
  emit();
}

export function getLayers(): ModalLayer[] {
  return layers;
}

/** 有没有弹层开着(含正在播退场动画的)——页面的返回键处理据此让路 */
export function hasOpenLayers(): boolean {
  return layers.length > 0;
}

export function subscribeLayers(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 安卓返回键:只关最上面一层,和原生 Modal 一层一个 Dialog 时系统的行为一致 */
export function requestCloseTop() {
  layers[layers.length - 1]?.onRequestClose?.();
}
