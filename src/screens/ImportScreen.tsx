import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWalletSession } from '../chain/WalletContext';
import { legacyLabel } from '../chain/config';
import { hasMasterPassword } from '../crypto/vault';
import { useI18n } from '../i18n';

const BLUE = '#2E7DF7';

/**
 * 导入钱包入口页 —— 参考 TP「Import Wallets」的入口列表(而不是单页里的
 * 分段控件),真正的输入/派生/账户选择逻辑在各自子页(ImportSecretScreen /
 * ImportWatchScreen / DeviceKeyImportScreen)。私钥导入和设备授权并成一组,
 * 观察钱包单独一组(只看不签)。助记词导入已按
 * 需求去掉(ImportSecretScreen 底层仍支持 mode==='mnemonic',只是这里不再
 * 暴露入口)。
 *
 * OnboardingScreen 的"我有账户"卡片和 WalletListSheet 的"导入钱包"按钮都
 * 直接落到这一屏——不再像之前那样先弹一层只有两行的底部菜单当中转站,
 * 这屏本身就是那个二级页。
 *
 * 主密码网关整屏一起挡(参考 TP:点"导入"就先跳设置主密码,不分具体走哪
 * 一条)——「观察钱包」本身不落任何密钥材料(见 ImportWatchScreen 顶部注释),
 * 单看这一项其实不需要密码保护,但统一挡在入口整屏更符合直觉,不用先猜
 * "这条要设、那条不用设"。设置完 goBack() 回这屏,取消则连这屏一起跳过,
 * 和 CreateWalletMethodScreen/CreateAccountPayScreen 是同一套网关,见
 * SetMasterPasswordScreen 顶部注释。hasMasterPassword() 读取失败时不拦
 * (fail open)——一过性读取失败不该把整个导入入口锁死。
 */
export default function ImportScreen() {
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

  return (
    <View style={styles.root}>
      <PageHeader title={t('import.title')} />
      <View style={{ padding: spacing.lg }}>
        <View style={styles.netCard}>
          <View style={styles.netDot} />
          <Text style={styles.netTxt}>
            {w.client.config.name} · {legacyLabel(w.chainId)}
          </Text>
        </View>

        <View style={styles.group}>
          <Row
            icon={<MaterialCommunityIcons name="key-outline" size={22} color={BLUE} />}
            title={t('import.privateKey')}
            desc={t('import.privateKeyDesc')}
            onPress={() => nav.navigate('ImportSecret', { mode: 'privatekey' })}
          />
          <View style={styles.sep} />
          <Row
            icon={<MaterialCommunityIcons name="cellphone-key" size={22} color={BLUE} />}
            title={t('import.viaEos3')}
            desc={t('import.viaEos3Desc')}
            onPress={() => nav.navigate('DeviceKeyImport')}
          />
        </View>

        <View style={styles.group}>
          <Row
            icon={<Ionicons name="eye-outline" size={20} color="#12A566" />}
            title={t('import.watchWallet')}
            desc={t('import.watchWalletDesc')}
            onPress={() => nav.navigate('ImportWatch')}
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
  onPress,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={onPress} disabled={disabled}>
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

  netCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.white,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    marginBottom: spacing.lg,
  },
  netDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#12A566' },
  netTxt: { fontSize: 13.5, fontWeight: '700', color: colors.text },

  group: { backgroundColor: colors.white, borderRadius: 12, marginBottom: 14, paddingHorizontal: 14 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 50 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
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
