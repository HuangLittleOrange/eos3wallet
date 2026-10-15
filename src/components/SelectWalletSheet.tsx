import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import { useWalletSession } from '../chain/WalletContext';
import { DEFAULT_CHAIN } from '../chain/config';
import type { StoredWallet } from '../crypto/vault';
import { listRecentRecipients } from '../chain/recentRecipients';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

export default function SelectWalletSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (acct: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const w = useWalletSession();
  const { t } = useI18n();
  const TABS = [t('selectWallet.recent'), t('selectWallet.walletList')];
  const [tab, setTab] = useState(1);
  // 最近:只列用户在转账页亲手转过的收款方(见 recentRecipients.ts)。不从链上
  // 交易记录里取——那里混着 DApp 换币打给的合约、买资源打给的系统合约和别人
  // 转进来的账户,链上看都是普通 transfer,分不出哪笔是用户自己发的。
  const [recent, setRecent] = useState<string[]>([]);

  // 收款账户属于当前网络,不能把其他链上的同名账户当作同一个收款方。
  const wallets: Pick<StoredWallet, 'id' | 'account' | 'publicKey' | 'source'>[] = [...w.wallets]
    .filter((wallet) => (wallet.chainId ?? DEFAULT_CHAIN) === w.chainId)
    .sort((a, b) => b.createdAt - a.createdAt);
  // 保留当前临时浏览的账户,同时展示本机已经添加的全部钱包。
  if (w.account && !wallets.some((wallet) => wallet.account === w.account)) {
    wallets.unshift({ id: '__current__', account: w.account, publicKey: '', source: 'watch' });
  }

  const load = useCallback(async () => {
    setRecent(await listRecentRecipients(w.chainId));
  }, [w.chainId]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const pick = (acct: string) => {
    onClose();
    onPick(acct);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{t('selectWallet.title')}</Text>
          <TouchableOpacity hitSlop={8} onPress={onClose} style={{ width: 30, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        {/* 最近 / 钱包 两段切换 */}
        <View style={styles.segment}>
          {TABS.map((label, i) => (
            <TouchableOpacity
              key={label}
              onPress={() => setTab(i)}
              style={[styles.segItem, tab === i && styles.segItemActive]}
            >
              <Text style={[styles.segTxt, tab === i && styles.segTxtActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
          {tab === 1 ? (
            wallets.map((wallet) => (
              <TouchableOpacity key={wallet.id} style={styles.card} activeOpacity={0.6} onPress={() => pick(wallet.account)}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarTxt}>A</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0, marginLeft: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={styles.name} numberOfLines={1}>{wallet.account}</Text>
                    {(wallet.id === w.currentWallet?.id || wallet.id === '__current__') ? (
                      <View style={styles.currentTag}>
                        <Text style={styles.currentTxt}>{t('selectWallet.current')}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.key} numberOfLines={1}>
                    {wallet.publicKey || (wallet.source === 'passkey' ? 'Passkey' : t('selectWallet.watchOnlyWallet'))}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          ) : recent.length ? (
            <View style={styles.listCard}>
              {recent.map((a, i) => (
                <View key={a}>
                  {i > 0 ? <View style={styles.sep} /> : null}
                  <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => pick(a)}>
                    <View style={styles.miniAvatar}>
                      <Text style={styles.miniAvatarTxt}>{a.slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <Text style={styles.rowName}>{a}</Text>
                    <Ionicons name="chevron-forward" size={17} color={colors.textFaint} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.empty}>{t('selectWallet.noRecent')}</Text>
          )}
        </ScrollView>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#F2F3F5',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    height: '68%',
    paddingHorizontal: spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 58 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600', color: colors.text },

  segment: { flexDirection: 'row', backgroundColor: '#E6E8EC', borderRadius: 8, padding: 4, marginBottom: 14 },
  segItem: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  segItemActive: { backgroundColor: colors.white },
  segTxt: { fontSize: 15, color: colors.textSub },
  segTxtActive: { color: colors.text, fontWeight: '700' },

  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 10 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#3B47D6', alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontSize: 18, fontWeight: '800' },
  name: { flexShrink: 1, fontSize: 16.5, color: colors.text },
  currentTag: { borderWidth: 1, borderColor: BLUE, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 1 },
  currentTxt: { color: BLUE, fontSize: 11.5 },
  key: { fontSize: 13, color: colors.textFaint, marginTop: 6 },

  listCard: { backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 48 },
  miniAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E7EBF2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniAvatarTxt: { color: colors.textSub, fontSize: 15, fontWeight: '700' },
  rowName: { flex: 1, fontSize: 16, color: colors.text },

  empty: { textAlign: 'center', color: colors.textFaint, fontSize: 14 },
});
