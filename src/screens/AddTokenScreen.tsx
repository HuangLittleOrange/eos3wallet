import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { impersonates, tokenColor } from '../chain/format';
import { loadTokenPrefs, setTokenAdded, setTokenHidden, TokenPrefs } from '../chain/tokenPrefs';
import TokenBadge from '../components/TokenBadge';
import { useI18n } from '../i18n';
import { rememberTokenDirectory } from '../chain/tokenDirectory';

const BLUE = '#1E88FF';

/** EOS/Vaulta 生态常见代币的正规发行合约 */
const COMMON = [
  { symbol: 'A', contract: 'core.vaulta' },
  { symbol: 'EOS', contract: 'eosio.token' },
  { symbol: 'USDT', contract: 'tethertether' },
  { symbol: 'BOX', contract: 'boxbdaotoken' },
  { symbol: 'DFS', contract: 'minedfstoken' },
];

type Mode = 'discover' | 'home' | 'mine';

export default function AddTokenScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  const w = useWallet();
  const { t } = useI18n();
  const MODE_TITLE: Record<Mode, string> = {
    discover: t('addToken.hotTokens'),
    home: t('addToken.homeTokens'),
    mine: t('addToken.myTokens'),
  };
  const [q, setQ] = useState('');
  const [prefs, setPrefs] = useState<TokenPrefs>({ hidden: [], added: [] });
  const [mode, setMode] = useState<Mode>('discover');
  const [noticeOpen, setNoticeOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadTokenPrefs(w.chainId, w.account).then((p) => {
      if (!cancelled) setPrefs(p);
    });
    return () => {
      cancelled = true;
    };
  }, [w.chainId, w.account]);

  const systemId = `${w.client.config.systemToken}:${w.client.config.symbol}`;

  // 账户实际持有的代币 + 生态常见代币(未持有的可手动加)
  const displayTokens = w.tokens.length ? w.tokens : (w.cachedTokens ?? []);
  const held = displayTokens.map((tk) => ({
    id: `${tk.contract}:${tk.symbol}`,
    symbol: tk.symbol,
    contract: tk.contract,
    held: true,
  }));
  const heldKeys = new Set(held.map((h) => h.id));
  const extra = COMMON.filter((c) => !heldKeys.has(`${c.contract}:${c.symbol}`)).map((c) => ({
    id: `${c.contract}:${c.symbol}`,
    symbol: c.symbol,
    contract: c.contract,
    held: false,
  }));

  // 是否显示在首页:系统代币强制常显;持有的看有没有被手动隐藏;
  // 未持有的看有没有被手动从「热门代币」加进来
  const isOnHome = (c: { id: string; held: boolean }) =>
    c.id === systemId ? true : c.held ? !prefs.hidden.includes(c.id) : prefs.added.includes(c.id);

  // 「首页代币」「我的代币」是查看首页当前展示了什么 / 账户实际持有什么的两个快捷入口,
  // 不是独立页面——同一份列表按不同条件过滤,点了就切视图,「‹」回到默认的热门代币发现页
  let base: { id: string; symbol: string; contract: string; held: boolean }[];
  if (mode === 'home') base = [...held, ...extra].filter(isOnHome);
  else if (mode === 'mine') base = held;
  else base = [...held, ...extra];

  const list = useMemo(() => {
    if (!q.trim()) return base;
    const s = q.trim().toLowerCase();
    return base.filter((c) => c.symbol.toLowerCase().includes(s) || c.contract.includes(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, q]);

  /** 持有的代币:切换首页隐藏/显示。未持有的代币:切换要不要加一个 0 余额占位到首页。 */
  const toggle = async (c: { id: string; held: boolean }) => {
    if (c.id === systemId) return; // 系统代币不可隐藏,永远在首页
    if (c.held) {
      const next = await setTokenHidden(w.chainId, w.account, c.id, isOnHome(c));
      setPrefs(next);
    } else {
      const add = !isOnHome(c);
      const next = await setTokenAdded(w.chainId, w.account, c.id, add);
      setPrefs(next);
      if (add) {
        const [contract, symbol] = c.id.split(':');
        void w.client.getTokenMetadata(contract, symbol)
          .then(metadata => rememberTokenDirectory(w.chainId, w.account, [metadata]))
          .catch(() => {}); // Adding a local preference remains possible offline.
      }
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {!w.tokens.length && displayTokens.length ? <Text style={{ color: colors.textSub, fontSize: 12, paddingHorizontal: spacing.lg }}>{t('content.cached')}</Text> : null}
      {/* 搜索条 */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color={colors.textSub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('addToken.searchPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
            autoCapitalize="none"
          />
        </View>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={8}>
          <Text style={styles.cancel}>{t('addToken.cancel')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 30 }}>
        {mode === 'discover' ? (
          <>
            {/* 两个入口:看首页当前展示了什么 / 看账户实际持有什么 */}
            <View style={styles.entryCard}>
              <TouchableOpacity style={styles.entryRow} activeOpacity={0.6} onPress={() => setMode('home')}>
                <Text style={styles.entryTxt}>{t('addToken.homeTokens')}</Text>
                <Ionicons name="chevron-forward" size={19} color={colors.textFaint} />
              </TouchableOpacity>
              <View style={styles.entrySep} />
              <TouchableOpacity style={styles.entryRow} activeOpacity={0.6} onPress={() => setMode('mine')}>
                <Text style={styles.entryTxt}>{t('addToken.myTokens')}</Text>
                <Ionicons name="chevron-forward" size={19} color={colors.textFaint} />
              </TouchableOpacity>
            </View>

            <View style={styles.gap} />
          </>
        ) : (
          <View style={styles.backRow}>
            <TouchableOpacity style={styles.backBtn} activeOpacity={0.6} onPress={() => setMode('discover')}>
              <Ionicons name="chevron-back" size={20} color={colors.text} />
              <Text style={styles.backTxt}>{MODE_TITLE[mode]}</Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'discover' ? <Text style={styles.section}>{t('addToken.hotTokens')}</Text> : null}

        {mode === 'discover' && noticeOpen ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTxt}>{t('addToken.noticeText')}</Text>
            <TouchableOpacity onPress={() => setNoticeOpen(false)} hitSlop={8}>
              <Ionicons name="close" size={20} color="#F5851F" />
            </TouchableOpacity>
          </View>
        ) : null}

        {mode !== 'discover' && list.length === 0 ? (
          <Text style={styles.emptyTxt}>
            {mode === 'home' ? t('addToken.homeEmpty') : t('addToken.mineEmpty')}
          </Text>
        ) : null}

        {list.map((c, i) => {
          const onHome = isOnHome(c);
          const isSystem = c.id === systemId;
          const fake = impersonates(c.symbol, c.contract);
          return (
            <View key={c.id}>
              {i > 0 ? <View style={styles.sep} /> : null}
              <View style={styles.row}>
                <TokenBadge symbol={c.symbol} color={tokenColor(c.symbol)} size={44} contract={c.contract} />
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.sym}>{c.symbol}</Text>
                    {fake ? (
                      <View style={styles.fakeTag}>
                        <Ionicons name="warning" size={10} color="#B45309" />
                        <Text style={styles.fakeTxt}>{t('addToken.unofficial')}</Text>
                      </View>
                    ) : c.held ? null : (
                      <View style={styles.zeroTag}>
                        <Text style={styles.zeroTxt}>{t('addToken.notHeld')}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.contract, fake && { color: '#B45309' }]} numberOfLines={1}>
                    {fake ? t('addToken.officialIs', { contract: c.contract, official: fake }) : c.contract}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => toggle(c)} hitSlop={8} disabled={isSystem}>
                  <Ionicons
                    name={onHome ? 'remove-circle-outline' : 'add-circle-outline'}
                    size={26}
                    color={isSystem ? '#E4E6EB' : onHome ? '#C7CBD4' : BLUE}
                  />
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: spacing.md, paddingVertical: 10 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#F2F3F5',
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 16,
  },
  searchInput: { flex: 1, fontSize: 15.5, color: colors.text, padding: 0, outlineStyle: 'none' as any },
  cancel: { fontSize: 16, color: colors.text },

  entryCard: { backgroundColor: colors.white, paddingHorizontal: spacing.lg },
  entryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 62 },
  entryTxt: { fontSize: 17, color: colors.text },
  entrySep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3' },

  gap: { height: 10, backgroundColor: '#F2F3F5' },

  backRow: { paddingHorizontal: spacing.md, paddingTop: 4, paddingBottom: 8 },
  backBtn: { flexDirection: 'row', alignItems: 'center' },
  backTxt: { fontSize: 17, fontWeight: '600', color: colors.text, marginLeft: 2 },

  section: { fontSize: 17, color: colors.text, paddingHorizontal: spacing.lg, paddingTop: 18, paddingBottom: 12 },

  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#FEF3E9',
    marginHorizontal: spacing.lg,
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
  },
  noticeTxt: { flex: 1, color: '#F5851F', fontSize: 14.5, lineHeight: 22 },

  emptyTxt: { fontSize: 14.5, color: colors.textFaint, textAlign: 'center', paddingVertical: 30 },

  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 14 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 76 },
  sym: { fontSize: 16.5, color: colors.text },
  fakeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#FEF3C7',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  fakeTxt: { fontSize: 10, color: '#B45309', fontWeight: '600' },
  zeroTag: { backgroundColor: '#F2F3F5', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  zeroTxt: { fontSize: 10, color: colors.textFaint },
  contract: { fontSize: 13.5, color: colors.textFaint, marginTop: 4 },
});
