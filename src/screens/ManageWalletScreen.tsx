import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { legacyLabel } from '../chain/config';
import { CHAINS } from '../chain/config';
import { useNetworkVisibility } from '../chain/networkVisibility';
import { fmtUSD } from '../chain/format';
import { priceIn } from '../chain/prices';
import PageHeader from '../components/PageHeader';
import { useI18n } from '../i18n';

const BLUE = '#3B47D6';

export default function ManageWalletScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const w = useWallet();
  const { t } = useI18n();
  const { enabled: visibleNetworks } = useNetworkVisibility();
  const total = w.tokens.reduce((s, tk) => s + tk.amount * priceIn(w.prices, tk.contract, tk.symbol), 0);

  return (
    <View style={styles.root}>
      {/* 右上角原来有个"排序"按钮——本页每条链只显示当前一张钱包卡,没有可排的
          列表,点了也没反应,撤掉,等真有多卡列表再回来 */}
      <PageHeader title={t('manageWallet.title')} />

      <View style={styles.body}>
        {/* 左侧链导轨 —— 网络(主网/测试网)切换在这里,和 TP 一致 */}
        <View style={styles.railWrap}>
          <ScrollView contentContainerStyle={{ paddingVertical: 12 }} showsVerticalScrollIndicator={false}>
            {visibleNetworks.map((id) => {
              const active = w.chainId === id;
              const testnet = CHAINS[id].testnet;
              return (
                <TouchableOpacity
                  key={id}
                  style={[styles.railItem, active && styles.railItemActive]}
                  activeOpacity={0.6}
                  onPress={() => w.setChain(id)}
                >
                  <View
                    style={[
                      styles.railIcon,
                      active ? (testnet ? styles.railIconTestActive : styles.railIconActive) : styles.railIconIdle,
                    ]}
                  >
                    <Text style={[styles.railTxt, active && { color: '#fff' }]}>A</Text>
                  </View>
                  <Text style={[styles.railLabel, active && styles.railLabelActive]} numberOfLines={1}>
                    {testnet ? t('manageWallet.testnet') : t('manageWallet.mainnet')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* 右侧钱包 */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.right} showsVerticalScrollIndicator={false}>
          <Text style={styles.netName}>{w.client.config.name}({legacyLabel(w.chainId)})</Text>

          {/* 点卡片进钱包详情——和右下角"..."同一目的地,整卡可点比小按钮好按;
              原来卡片能按下去却什么都不做,旁边还有个不接剪贴板的复制图标,都改掉 */}
          {w.hasAccount && <TouchableOpacity style={styles.walletCard} activeOpacity={0.85} onPress={() => nav.navigate('WalletDetail')}>
            <View style={styles.walletTop}>
              <Text style={styles.walletName} numberOfLines={1}>
                {w.account}
              </Text>
              <View style={styles.currentTag}>
                <Text style={styles.currentTxt}>{t('manageWallet.current')}</Text>
              </View>
            </View>
            <Text style={styles.walletKey} numberOfLines={1}>
              {w.resources?.permissions.find((p) => p.name === 'active')?.keys[0] ?? t('manageWallet.watchOnly')}
            </Text>
            <View style={styles.walletFoot}>
              <Text style={styles.walletBal}>{fmtUSD(total)}</Text>
              <TouchableOpacity hitSlop={8} onPress={() => nav.navigate('WalletDetail')}>
                <Feather name="more-horizontal" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>}

          <TouchableOpacity style={styles.addWallet} activeOpacity={0.6} onPress={() => nav.navigate('Import')}>
            <Ionicons name="add" size={22} color={colors.textSub} />
            <Text style={styles.addWalletTxt}>{t('manageWallet.addWallet', { name: w.client.config.name })}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* 底部操作栏 —— 硬件钱包还没做,点了给"敬请期待"而不是没反应;
          原来最右还有个什么都不干的"⋮",撤掉 */}
      <View style={[styles.foot, { paddingBottom: insets.bottom + 10 }]}>
        <TouchableOpacity
          style={styles.footItem}
          activeOpacity={0.6}
          onPress={() => Alert.alert(t('manageWallet.comingSoonTitle'), t('manageWallet.comingSoonBody'))}
        >
          <MaterialCommunityIcons name="cellphone-link" size={22} color={colors.text} />
          <Text style={styles.footTxt}>{t('manageWallet.hardwareWallet')}</Text>
        </TouchableOpacity>
        <View style={styles.footLine} />
        <TouchableOpacity style={styles.footItem} activeOpacity={0.6} onPress={() => nav.navigate('Networks', { manageVisibility: true })}>
          <MaterialCommunityIcons name="view-grid-outline" size={22} color={colors.text} />
          <Text style={styles.footTxt}>{t('manageWallet.manageNetwork')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  body: { flex: 1, flexDirection: 'row' },

  railWrap: { width: 76, backgroundColor: '#F2F3F5' },
  railItem: { width: 76, alignItems: 'center', paddingVertical: 9 },
  railItemActive: { backgroundColor: colors.white },
  railIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  railIconActive: { backgroundColor: BLUE },
  railIconTestActive: { backgroundColor: colors.gold },
  railIconIdle: { backgroundColor: '#E2E5EA' },
  railTxt: { fontSize: 17, fontWeight: '700', color: '#A8AEBA' },
  railLabel: { fontSize: 10, color: colors.textFaint, marginTop: 4 },
  railLabelActive: { color: colors.text, fontWeight: '600' },

  right: { padding: 16 },
  netName: { fontSize: 17, color: colors.text, marginBottom: 12 },

  walletCard: { backgroundColor: BLUE, borderRadius: 10, padding: 16 },
  walletTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  walletName: { color: '#fff', fontSize: 17, fontWeight: '700', flexShrink: 1 },
  currentTag: { backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 2 },
  currentTxt: { color: BLUE, fontSize: 11.5, fontWeight: '600' },
  walletKey: { color: 'rgba(255,255,255,0.7)', fontSize: 13.5, marginTop: 8 },
  walletFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  walletBal: { color: '#fff', fontSize: 16, fontWeight: '700' },

  addWallet: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#E2E5EA',
    borderStyle: 'dashed',
    borderRadius: 10,
    height: 52,
    marginTop: 14,
  },
  addWalletTxt: { fontSize: 15, color: colors.textSub },

  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E6E8EC',
    paddingTop: 10,
  },
  footItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  footTxt: { fontSize: 15.5, color: colors.text },
  footLine: { width: StyleSheet.hairlineWidth, height: 26, backgroundColor: '#E0E3E8' },
});
