import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import CenterDialog from '../components/CenterDialog';
import { colors, spacing } from '../theme';
import { useWalletSession } from '../chain/WalletContext';
import { CHAINS, NodeInfo, legacyLabel } from '../chain/config';
import { useNodeCatalogRefresh } from '../chain/NodeCatalogContext';
import { probeHistoryNode, probeNode } from '../chain/client';
import { addCustomNode, listCustomNodes, NodeKind, removeCustomNode } from '../chain/customNodes';
import { PRICE_SOURCES, PriceSourceId, probePriceSource } from '../chain/prices';
import { useI18n, TranslationKey } from '../i18n';

const BLUE = '#1E88FF';
const FAST = '#22C55E';
const MIDDLE = '#F5A623';
const SLOW = '#EF4444';

const speedColor = (ms: number) => (ms < 500 ? FAST : ms < 1000 ? MIDDLE : SLOW);

/** 只接受 http/https 地址,和 TP 一样最基本的格式校验 */
const isValidUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s.trim());
const normUrl = (s: string) => s.trim().replace(/\/+$/, '');

type Probe = { ms: number; block: number } | null | 'loading';
type PriceProbe = { ms: number; covered: number } | null | 'loading';

const kindLabel = (kind: NodeKind, t: (key: TranslationKey) => string) =>
  kind === 'rpc' ? t('node.rpcNode') : t('node.historyNode');

export default function NodeScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  const w = useWalletSession();
  const { t } = useI18n();

  const [rpcProbes, setRpcProbes] = useState<Record<string, Probe>>({});
  const [historyProbes, setHistoryProbes] = useState<Record<string, Probe>>({});
  const [priceProbes, setPriceProbes] = useState<Record<PriceSourceId, PriceProbe>>({} as any);
  const [customRpcNodes, setCustomRpcNodes] = useState<NodeInfo[]>([]);
  const [customHistoryNodes, setCustomHistoryNodes] = useState<NodeInfo[]>([]);

  const [addKind, setAddKind] = useState<NodeKind | null>(null);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const refreshCatalog=useNodeCatalogRefresh();
  const defaultRpcNodes = w.rpcNodes ?? CHAINS[w.chainId].nodes;
  const defaultHistoryNodes = w.defaultHistoryNodes ?? CHAINS[w.chainId].historyNodes;
  const rpcNodes = [...defaultRpcNodes, ...customRpcNodes];
  const historyNodes = [...defaultHistoryNodes, ...customHistoryNodes];

  // 探测列表用参数传进来而不是闭包读 state——不然 runProbes 的身份要跟着
  // customXxxNodes 变,添加/删除一个自定义节点就会把整页已经测好的结果
  // 全部推翻重测一遍(添加处明明只想单独测新节点那一个)。
  const runProbes = useCallback(async (rpcList: NodeInfo[], historyList: NodeInfo[]) => {
    const rInit: Record<string, Probe> = {};
    rpcList.forEach((n) => (rInit[n.id] = 'loading'));
    setRpcProbes(rInit);
    const hInit: Record<string, Probe> = {};
    historyList.forEach((n) => (hInit[n.id] = 'loading'));
    setHistoryProbes(hInit);
    const pInit: Record<string, PriceProbe> = {};
    PRICE_SOURCES.forEach((s) => (pInit[s.id] = 'loading'));
    setPriceProbes(pInit as any);

    // RPC / 历史节点 / 行情源是三套完全独立的服务,并发探测,互不等待
    await Promise.all([
      ...rpcList.map(async (n) => {
        const r = await probeNode(n);
        setRpcProbes((p) => ({ ...p, [n.id]: r }));
      }),
      ...historyList.map(async (n) => {
        const r = await probeHistoryNode(n);
        setHistoryProbes((p) => ({ ...p, [n.id]: r }));
      }),
      ...PRICE_SOURCES.map(async (s) => {
        const r = await probePriceSource(s.id);
        setPriceProbes((p) => ({ ...p, [s.id]: r }));
      }),
    ]);
  }, []);

  // 只在进页面/切链时整页探测一次;自定义节点读完后和默认节点一起测
  useEffect(() => {
    let alive = true;
    (async () => {
      const [rpc, hist] = await Promise.all([
        listCustomNodes(w.chainId, 'rpc').catch(() => [] as NodeInfo[]),
        listCustomNodes(w.chainId, 'history').catch(() => [] as NodeInfo[]),
      ]);
      if (!alive) return;
      setCustomRpcNodes(rpc);
      setCustomHistoryNodes(hist);
      runProbes([...defaultRpcNodes, ...rpc], [...defaultHistoryNodes, ...hist]);
    })();
    return () => {
      alive = false;
    };
  }, [w.chainId, defaultRpcNodes, defaultHistoryNodes, runProbes]);

  const openAdd = (kind: NodeKind) => {
    setCustomName('');
    setCustomUrl('');
    setAddKind(kind);
  };

  const listFor = (kind: NodeKind) => (kind === 'rpc' ? rpcNodes : historyNodes);
  const customCountFor = (kind: NodeKind) => (kind === 'rpc' ? customRpcNodes.length : customHistoryNodes.length);
  const placeholderName = addKind ? `Custom-${customCountFor(addKind) + 1}` : '';

  const submitCustomNode = async () => {
    if (!addKind) return;
    const url = normUrl(customUrl);
    if (!isValidUrl(url)) {
      Alert.alert(t('node.invalidUrlTitle'), t('node.invalidUrlBody'));
      return;
    }
    if (listFor(addKind).some((n) => normUrl(n.url) === url)) {
      Alert.alert(t('node.alreadyAdded'), undefined);
      return;
    }
    setSaving(true);
    try {
      const node: NodeInfo = { id: `custom-${Date.now()}`, name: customName.trim() || placeholderName, url };
      const next = await addCustomNode(w.chainId, addKind, node);
      if (addKind === 'rpc') {
        setCustomRpcNodes(next);
        w.setNode(node);
      } else {
        setCustomHistoryNodes(next);
        w.setHistoryNode(node);
      }
      setAddKind(null);
      // 新节点单独探测一下,不用把整页已经测好的结果都推翻重来
      const probe = addKind === 'rpc' ? await probeNode(node) : await probeHistoryNode(node);
      if (addKind === 'rpc') setRpcProbes((p) => ({ ...p, [node.id]: probe }));
      else setHistoryProbes((p) => ({ ...p, [node.id]: probe }));
    } finally {
      setSaving(false);
    }
  };

  const pasteUrl = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setCustomUrl(text.trim());
  };

  const deleteCustomNode = (n: NodeInfo, kind: NodeKind) => {
    Alert.alert(t('node.deleteNodeTitle'), t('node.deleteNodeBody', { name: n.name }), [
      { text: t('send.cancel'), style: 'cancel' },
      {
        text: t('node.delete'),
        style: 'destructive',
        onPress: async () => {
          const next = await removeCustomNode(w.chainId, kind, n.id);
          if (kind === 'rpc') {
            setCustomRpcNodes(next);
            // 删掉的正好是当前在用的节点,退回默认第一个,不留悬空引用
            if (w.node.id === n.id) w.setNode(defaultRpcNodes[0]);
          } else {
            setCustomHistoryNodes(next);
            if (w.historyNode.id === n.id) w.setHistoryNode(defaultHistoryNodes[0]);
          }
        },
      },
    ]);
  };

  const renderSection = (kind: NodeKind) => {
    const defaults = kind === 'rpc' ? defaultRpcNodes : defaultHistoryNodes;
    const customs = kind === 'rpc' ? customRpcNodes : customHistoryNodes;
    const probes = kind === 'rpc' ? rpcProbes : historyProbes;
    const selectedId = kind === 'rpc' ? w.node.id : w.historyNode.id;
    const onPick = (n: NodeInfo) => (kind === 'rpc' ? w.setNode(n) : w.setHistoryNode(n));
    const blockLabel = kind === 'rpc' ? t('node.blockHeight') : t('node.indexedTo');

    const renderRow = (n: NodeInfo, i: number, custom: boolean) => {
      const p = probes[n.id];
      const selected = selectedId === n.id;
      return (
        <View key={n.id}>
          {i > 0 ? <View style={styles.sep} /> : null}
          <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => onPick(n)}>
            <View style={styles.nameWrap}>
              <Text style={styles.name} numberOfLines={1}>
                {n.name}
              </Text>
              {selected ? <Ionicons name="checkmark" size={20} color={BLUE} style={{ marginLeft: 8 }} /> : null}
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ alignItems: 'flex-end' }}>
                {p === 'loading' ? (
                  <ActivityIndicator size="small" color={BLUE} />
                ) : p === null || p === undefined ? (
                  <>
                    <View style={styles.msRow}>
                      <Text style={[styles.ms, { color: SLOW }]}>{t('node.unavailable')}</Text>
                      <View style={[styles.dot, { backgroundColor: SLOW }]} />
                    </View>
                    <Text style={styles.block}>{t('node.connectFailed')}</Text>
                  </>
                ) : (
                  <>
                    <View style={styles.msRow}>
                      <Text style={styles.ms}>{p.ms} ms</Text>
                      <View style={[styles.dot, { backgroundColor: speedColor(p.ms) }]} />
                    </View>
                    <Text style={styles.block}>
                      {blockLabel} {p.block.toLocaleString('en-US')}
                    </Text>
                  </>
                )}
              </View>
              {custom ? (
                <TouchableOpacity hitSlop={10} style={styles.delBtn} onPress={() => deleteCustomNode(n, kind)}>
                  <Ionicons name="trash-outline" size={18} color={colors.textFaint} />
                </TouchableOpacity>
              ) : null}
            </View>
          </TouchableOpacity>
        </View>
      );
    };

    return (
      <View style={{ marginTop: 20 }}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>{kindLabel(kind, t)}</Text>
          <Text style={styles.sectionDesc}>{kind === 'rpc' ? t('node.rpcDesc') : t('node.historyDesc')}</Text>
        </View>
        <View style={styles.listCard}>
          {defaults.map((n, i) => renderRow(n, i, false))}
          {customs.length ? <View style={styles.sep} /> : null}
          {customs.map((n, i) => renderRow(n, i, false))}
          <View style={styles.sep} />
          <TouchableOpacity style={styles.addRow} activeOpacity={0.6} onPress={() => openAdd(kind)}>
            <Ionicons name="add" size={18} color={BLUE} />
            <Text style={styles.addRowTxt}>{t('node.addCustom', { kind: kindLabel(kind, t) })}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderPriceSection = () => (
    <View style={{ marginTop: 20 }}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{t('node.priceSource')}</Text>
        <Text style={styles.sectionDesc}>{t('node.priceSourceDesc')}</Text>
      </View>
      <View style={styles.listCard}>
        {PRICE_SOURCES.map((s, i) => {
          const p = priceProbes[s.id];
          const selected = w.priceSource === s.id;
          return (
            <View key={s.id}>
              {i > 0 ? <View style={styles.sep} /> : null}
              <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => w.setPriceSource(s.id)}>
                <View style={styles.nameWrap}>
                  <Text style={styles.name} numberOfLines={1}>
                    {s.name}
                  </Text>
                  {selected ? <Ionicons name="checkmark" size={20} color={BLUE} style={{ marginLeft: 8 }} /> : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {p === 'loading' ? (
                    <ActivityIndicator size="small" color={BLUE} />
                  ) : p === null || p === undefined ? (
                    <>
                      <View style={styles.msRow}>
                        <Text style={[styles.ms, { color: SLOW }]}>{t('node.unavailable')}</Text>
                        <View style={[styles.dot, { backgroundColor: SLOW }]} />
                      </View>
                      <Text style={styles.block}>{t('node.connectFailed')}</Text>
                    </>
                  ) : (
                    <>
                      <View style={styles.msRow}>
                        <Text style={styles.ms}>{p.ms} ms</Text>
                        <View style={[styles.dot, { backgroundColor: speedColor(p.ms) }]} />
                      </View>
                      <Text style={styles.block}>{t('node.coverage', { n: p.covered })}</Text>
                    </>
                  )}
                </View>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={styles.side}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>
          {CHAINS[w.chainId].name}({legacyLabel(w.chainId)})
        </Text>
        <TouchableOpacity
          hitSlop={10}
          style={[styles.side, { alignItems: 'flex-end' }]}
          onPress={() => void refreshCatalog().then(next=>{if(next[w.chainId].rpc===defaultRpcNodes&&next[w.chainId].history===defaultHistoryNodes)void runProbes(rpcNodes,historyNodes);})}
        >
          <Text style={styles.moreTxt}>{t('node.refresh')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* 速度说明 */}
        <View style={styles.card}>
          <View style={styles.legendRow}>
            <Text style={styles.legendTitle}>{t('node.speedTitle')}</Text>
            <View style={styles.legend}>
              <Legend color={FAST} label={t('node.fast')} />
              <Legend color={MIDDLE} label={t('node.middle')} />
              <Legend color={SLOW} label={t('node.slow')} />
            </View>
          </View>
          <Text style={styles.legendDesc}>{t('node.speedDesc')}</Text>
        </View>

        {renderSection('rpc')}
        {renderSection('history')}
        {renderPriceSection()}

        <Text style={styles.note}>{t('node.footerNote')}</Text>
      </ScrollView>

      {/* 添加自定义节点 —— 参考 TP 的交互:安全提示 + 名称 + RPC 地址;kind 决定加进哪个列表 */}
      <CenterDialog visible={addKind !== null} onClose={() => setAddKind(null)} backdropColor="rgba(0,0,0,0.5)" padding={spacing.xl}>
        <View style={styles.addCard}>
          <View style={styles.addHead}>
            <Text style={styles.addTitle}>{addKind ? t('node.addCustom', { kind: kindLabel(addKind, t) }) : ''}</Text>
            <TouchableOpacity hitSlop={10} style={styles.addClose} onPress={() => setAddKind(null)}>
              <Ionicons name="close" size={22} color={colors.textSub} />
            </TouchableOpacity>
          </View>

          <View style={styles.warnBox}>
            <Text style={styles.warnTitle}>{t('node.securityWarnTitle')}</Text>
            <Text style={styles.warnDesc}>{t('node.securityWarnBody')}</Text>
          </View>

          <TextInput
            value={customName}
            onChangeText={setCustomName}
            placeholder={placeholderName}
            placeholderTextColor={colors.textFaint}
            style={styles.nameInput}
            maxLength={24}
          />

          <View style={styles.urlBox}>
            <TextInput
              value={customUrl}
              onChangeText={setCustomUrl}
              placeholder={addKind === 'history' ? t('node.customHistoryPlaceholder') : t('node.customRpcPlaceholder')}
              placeholderTextColor={colors.textFaint}
              style={styles.urlInput}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <TouchableOpacity style={styles.pasteBtn} onPress={pasteUrl}>
              <Text style={styles.pasteTxt}>{t('node.paste')}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.addCta, (!isValidUrl(customUrl) || saving) && styles.addCtaOff]}
            activeOpacity={0.85}
            disabled={!isValidUrl(customUrl) || saving}
            onPress={submitCustomNode}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.addCtaTxt}>{t('node.add')}</Text>}
          </TouchableOpacity>
        </View>
      </CenterDialog>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  header: { flexDirection: 'row', alignItems: 'center', height: 50, paddingHorizontal: 12 },
  side: { width: 60, justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },
  moreTxt: { fontSize: 15.5, color: BLUE },

  scroll: { padding: spacing.md, paddingBottom: 30 },

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 18 },
  legendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  legendTitle: { fontSize: 16.5, color: colors.text },
  legend: { flexDirection: 'row', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendLabel: { fontSize: 14.5, color: colors.text },
  legendDesc: { fontSize: 13.5, color: colors.textFaint, lineHeight: 21, marginTop: 12 },

  sectionHead: { marginTop: 4, marginBottom: 8, marginLeft: 4 },
  sectionTitle: { fontSize: 15, color: colors.text, fontWeight: '600' },
  sectionDesc: { fontSize: 12, color: colors.textFaint, marginTop: 3, lineHeight: 17 },

  listCard: { backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 18 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, minHeight: 74 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3' },
  nameWrap: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 12, gap: 7 },
  name: { fontSize: 16.5, color: colors.text, flexShrink: 1 },

  msRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  ms: { fontSize: 16, color: colors.text },
  dot: { width: 8, height: 8, borderRadius: 4 },
  block: { fontSize: 12.5, color: colors.textFaint, marginTop: 5 },
  delBtn: { marginLeft: 12, padding: 4 },

  addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 14 },
  addRowTxt: { fontSize: 14.5, color: BLUE, fontWeight: '500' },

  note: { fontSize: 11.5, color: colors.textFaint, marginTop: 14, marginHorizontal: 4, lineHeight: 18 },

  addCard: { width: '100%', maxWidth: 400, backgroundColor: colors.white, borderRadius: 16, padding: 20 },
  addHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  addTitle: { fontSize: 18, fontWeight: '600', color: colors.text },
  addClose: { position: 'absolute', right: 0, top: -2 },

  warnBox: {
    backgroundColor: '#FFF3E9',
    borderColor: '#F5A623',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  warnTitle: { fontSize: 14, fontWeight: '600', color: '#D97B1F' },
  warnDesc: { fontSize: 12.5, color: '#D97B1F', lineHeight: 19, marginTop: 4 },

  nameInput: {
    height: 46,
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.text,
    marginBottom: 12,
    outlineStyle: 'none' as any,
  },
  urlBox: {
    minHeight: 96,
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 18,
  },
  urlInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    textAlignVertical: 'top',
    outlineStyle: 'none' as any,
  },
  pasteBtn: { alignSelf: 'flex-end' },
  pasteTxt: { fontSize: 14, color: BLUE, fontWeight: '500' },

  addCta: { height: 50, borderRadius: 10, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center' },
  addCtaOff: { backgroundColor: '#A9C9F5' },
  addCtaTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
