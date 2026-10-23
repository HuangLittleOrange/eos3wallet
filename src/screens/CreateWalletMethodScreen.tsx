import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWalletSession } from '../chain/WalletContext';
import { hasMasterPassword } from '../crypto/vault';
import { useI18n } from '../i18n';

const BLUE = '#2E7DF7';

/**
 * 合约付费开户，或通过 eos3.app 网页授权开通本机钱包。
 * 先设置主密码：网页授权使用的设备私钥也需加密保存在本机。
 */
export default function CreateWalletMethodScreen() {
  const nav = useNavigation<any>();
  const w = useWalletSession();
  const { t } = useI18n();

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      hasMasterPassword()
        .then((has) => {
          if (alive && !has) nav.navigate('SetMasterPassword');
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [nav])
  );

  const canPay = w.wallets.some((x) => x.source !== 'watch');

  return (
    <View style={styles.root}>
      <PageHeader title={t('createWalletMethod.title')} />
      <View style={{ padding: spacing.lg }}>
        <View style={styles.group}>
          <Row
            icon={<MaterialCommunityIcons name="file-sign" size={22} color={BLUE} />}
            title={t('createWalletMethod.byContract')}
            desc={canPay ? t('createWalletMethod.byContractDescReady') : t('createWalletMethod.byContractDescBlocked')}
            onPress={() => nav.navigate('CreateAccountPay')}
          />
        </View>

        {/* Google 登录、开户和账户授权由网页完成，App 不调用原生 Passkey。 */}
        <View style={styles.group}>
          <Row
            icon={<Ionicons name="logo-google" size={20} color="#EA4335" />}
            title={t('createWalletMethod.googleOneTap')}
            desc={t('createWalletMethod.googleOneTapDesc')}
            onPress={() => nav.navigate('PasskeyCreate')}
          />
        </View>
      </View>
    </View>
  );
}

function Row({
  icon,
  title,
  desc,
  disabled,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={[styles.row, disabled && styles.rowOff]} activeOpacity={0.6} onPress={onPress}>
      <View style={styles.rowIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDesc}>{desc}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  group: { backgroundColor: colors.white, borderRadius: 12, marginBottom: 14, paddingHorizontal: 14 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  rowOff: { opacity: 0.45 },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#F2F3F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 15.5, color: colors.text, fontWeight: '600' },
  rowDesc: { fontSize: 12.5, color: colors.textFaint, marginTop: 3 },
});
