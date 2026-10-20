import { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Platform, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { fmtAmount, fmtUSD, impersonates, tokenColor } from '../chain/format';
import { priceIn } from '../chain/prices';
import TokenBadge from '../components/TokenBadge';
import DappRiskSheet from '../components/DappRiskSheet';
import { useOpenDapp } from '../dapp/useOpenDapp';
import { clearDappHistory, isUrlLike, normalizeDappUrl } from '../dapp/dappGate';
import { useDappRecords } from '../dapp/useDappRecords';
import { useI18n } from '../i18n';
import { useFocusedAppContent } from '../content/useFocusedAppContent';
import { visibleItems } from '../content/types';
import { projectsForNetwork } from '../content/networkDiscovery';
import NetworkSelector from '../components/NetworkSelector';

const BLUE = '#1E88FF';

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const w = useWallet();
  const { t, locale } = useI18n();
  const [tab, setTab] = useState(0);
  const { projects: allProjects } = useFocusedAppContent(Platform.OS !== 'web' && tab === 1);
  const projects = useMemo(() => projectsForNetwork(allProjects, w.chainId), [allProjects, w.chainId]);

  const TABS = Platform.OS === 'web' ? [t('search.myTokens')] : [t('search.myTokens'), t('search.dapp')];

  const directory = useMemo(() => visibleItems(projects).map((project) => {
    const translated = project.translations?.[locale];
    const name = translated?.name || project.name;
    return {
      ...project,
      name,
      desc: translated?.description || project.description,
      cat: translated?.category || project.category,
      color: project.color || BLUE,
      letter: project.letter || name.slice(0, 1),
    };
  }), [projects, locale]);
  const { open, pending, cancel, confirm } = useOpenDapp(() => nav.goBack());
  const [q, setQ] = useState('');
  const { history } = useDappRecords(w.chainId);

  const clearHistory = () => {
    void clearDappHistory(w.chainId);
  };

  const urlSuggestion = isUrlLike(q) ? normalizeDappUrl(q) : null;

  const tokens = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? w.tokens.filter((tk) => tk.symbol.toLowerCase().includes(s) || tk.contract.includes(s))
      : w.tokens;
    return [...list].sort(
      (a, b) => b.amount * priceIn(w.prices, b.contract, b.symbol) - a.amount * priceIn(w.prices, a.contract, a.symbol)
    );
  }, [w.tokens, w.prices, q]);

  const dapps = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return directory;
    return directory.filter((d) => [d.name, d.desc, d.cat].some((value) => value.toLowerCase().includes(s)));
  }, [directory, q]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={{ paddingHorizontal: spacing.lg }}><NetworkSelector /></View>
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color={colors.textSub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('search.placeholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
            autoCapitalize="none"
            autoFocus
          />
        </View>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={8}>
          <Text style={styles.cancel}>{t('search.cancel')}</Text>
        </TouchableOpacity>
      </View>

      {urlSuggestion ? (
        <TouchableOpacity style={styles.urlSuggestion} activeOpacity={0.6} onPress={() => open(urlSuggestion)}>
          <Ionicons name="globe-outline" size={18} color={BLUE} />
          <Text style={styles.urlSuggestionTxt} numberOfLines={1}>
            {t('search.openWebsite')} <Text style={{ color: BLUE }}>{urlSuggestion}</Text>
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
        </TouchableOpacity>
      ) : !q && history.length ? (
        <View style={styles.historyBlock}>
          <View style={styles.historyHead}>
            <Text style={styles.historyTitle}>{t('search.historyTitle')}</Text>
            <TouchableOpacity hitSlop={8} onPress={clearHistory}>
              <Ionicons name="trash-outline" size={17} color={colors.textFaint} />
            </TouchableOpacity>
          </View>
          <View style={styles.historyChips}>
            {history.map((h) => (
              <TouchableOpacity key={h.url} style={styles.historyChip} activeOpacity={0.6} onPress={() => setQ(h.url)}>
                <Text style={styles.historyChipTxt} numberOfLines={1}>
                  {h.url.replace(/^https?:\/\//, '')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.tabRow}>
        {TABS.map((label, i) => (
          <TouchableOpacity key={label} onPress={() => setTab(i)} style={styles.tabItem}>
            <Text style={[styles.tabTxt, tab === i && styles.tabTxtActive]}>{label}</Text>
            {tab === i ? <View style={styles.tabLine} /> : null}
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md, paddingBottom: 30 }}>
        <View style={styles.card}>
          {tab === 0 ? (
            tokens.length ? (
              tokens.map((tk, i) => {
                const price = priceIn(w.prices, tk.contract, tk.symbol);
                const fake = impersonates(tk.symbol, tk.contract);
                return (
                  <View key={`${tk.contract}-${tk.symbol}`}>
                    {i > 0 ? <View style={styles.sep} /> : null}
                    <TouchableOpacity
                      style={styles.row}
                      activeOpacity={0.6}
                      onPress={() => nav.navigate('TokenDetail', { token: tk })}
                    >
                      <TokenBadge symbol={tk.symbol} color={tokenColor(tk.symbol)} size={44} contract={tk.contract} />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={styles.name}>{tk.symbol}</Text>
                          {fake ? (
                            <View style={styles.fakeTag}>
                              <Ionicons name="warning" size={10} color="#B45309" />
                              <Text style={styles.fakeTxt}>{t('search.unofficial')}</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={[styles.sub, fake && { color: '#B45309' }]} numberOfLines={1}>
                          {fake ? t('search.officialIs', { contract: tk.contract, official: fake }) : tk.contract}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={styles.amt}>{fmtAmount(tk.amount, tk.precision)}</Text>
                        <Text style={styles.fiat}>{price > 0 ? fmtUSD(tk.amount * price) : '—'}</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                );
              })
            ) : (
              <Text style={styles.empty}>{q ? t('search.noMatchingTokens') : t('search.noTokens')}</Text>
            )
          ) : dapps.length ? (
            dapps.map((d, i) => (
              <View key={d.id}>
                {i > 0 ? <View style={styles.sep} /> : null}
                <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => open(d.appUrl)}>
                  <View style={[styles.dappIcon, { backgroundColor: d.color }]}>
                    {d.iconUrl ? (
                      <Image source={{ uri: d.iconUrl }} style={styles.dappImage} resizeMode="cover" />
                    ) : (
                      <Text style={[styles.dappLetter, ['#fff', '#ffffff'].includes(d.color.toLowerCase()) && { color: colors.text }]}>
                        {d.letter}
                      </Text>
                    )}
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.name}>{d.name}</Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {d.desc}
                    </Text>
                  </View>
                  <View style={styles.catTag}>
                    <Text style={styles.catTxt}>{d.cat}</Text>
                  </View>
                  <MaterialCommunityIcons name="open-in-new" size={18} color={colors.textFaint} style={{ marginLeft: 10 }} />
                </TouchableOpacity>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>{q ? t('search.noMatchingDapps') : t('content.emptyDapps')}</Text>
          )}
        </View>

        {tab === 0 && w.tokens.length ? (
          <Text style={styles.note}>{t('search.note', { account: w.account, count: w.tokens.length })}</Text>
        ) : null}
      </ScrollView>

      <DappRiskSheet visible={pending !== null} url={pending ?? ''} onCancel={cancel} onContinue={confirm} />
    </View>
  );
}

const styles = StyleSheet.create({
  dappIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  dappImage: { width: 44, height: 44 },
  dappLetter: { color: '#fff', fontSize: 20, fontWeight: '700' },
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: spacing.md, paddingVertical: 10 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    height: 46,
    borderRadius: 10,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, fontSize: 15.5, color: colors.text, padding: 0, outlineStyle: 'none' as any },
  cancel: { fontSize: 16, color: BLUE },

  urlSuggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    marginHorizontal: spacing.md,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  urlSuggestionTxt: { flex: 1, fontSize: 14, color: colors.text },

  historyBlock: { paddingHorizontal: spacing.md, marginTop: 4 },
  historyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  historyTitle: { fontSize: 13, color: colors.textFaint },
  historyChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  historyChip: { backgroundColor: colors.white, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, maxWidth: 220 },
  historyChipTxt: { fontSize: 12.5, color: colors.textSub },

  tabRow: { flexDirection: 'row', gap: 24, paddingHorizontal: spacing.lg, marginTop: 4 },
  tabItem: { alignItems: 'center', paddingVertical: 6 },
  tabTxt: { fontSize: 16, color: colors.textFaint },
  tabTxtActive: { color: colors.text, fontWeight: '700' },
  tabLine: { height: 3, width: 26, borderRadius: 2, backgroundColor: colors.text, marginTop: 6 },

  card: { backgroundColor: colors.white, borderRadius: 12, paddingHorizontal: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 56 },

  name: { fontSize: 16, color: colors.text },
  sub: { fontSize: 12.5, color: colors.textFaint, marginTop: 3 },
  amt: { fontSize: 15.5, color: colors.text },
  fiat: { fontSize: 12.5, color: colors.textSub, marginTop: 3 },

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

  catTag: { backgroundColor: '#F2F3F5', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 },
  catTxt: { fontSize: 11.5, color: colors.textSub },

  empty: { textAlign: 'center', color: colors.textFaint, paddingVertical: 50, fontSize: 14 },
  note: { textAlign: 'center', fontSize: 11.5, color: colors.textFaint, marginTop: 14 },
});
