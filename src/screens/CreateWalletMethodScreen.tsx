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
 * “创建钱包”的入口 —— 选合约付费开户还是 Google Passkey 开户,不再有
 * “助记词 + 手动填一个已经在别处开通好的账户名”这条旧路(已删除
 * CreateWalletScreen)。合约创建里已经包含完整的助记词生成/备份/验证,
 * 是旧流程的超集,不需要再单独留一条。
 *
 * 合约创建本质是往 signupwallet 合约转一笔钱 + 一个带公钥的 memo(参考
 * eoseyes.com/signup),这笔钱不一定非要本机已有钱包出——交易所提现、
 * 别的设备上的钱包,只要转账时能带上正确的 memo 都能触发建号。所以这一项
 * 一直可点;本机没有可签名钱包时,CreateAccountPayScreen 的支付步骤会退化成
 * “生成新钱包 + 展示转账收款信息”,而不是在这里就拦掉。
 *
 * 主密码网关整屏一起挡——参考 TP:不管接下来走合约建号、Google 一键注册
 * 还是 passkey 登录,本机没设过主密码就先跳去 SetMasterPasswordScreen,和
 * ImportScreen/CreateAccountPayScreen 是同一套网关(设置完 goBack() 回这屏,
 * 取消则连这屏一起跳过,见 SetMasterPasswordScreen 顶部注释)。Google/passkey
 * 这两条本地其实不落任何需要密码保护的密钥,单看这两条本可以不用挡,但
 * 统一成"进这几个入口一律先设过主密码"这一条规则更符合直觉、也和 TP 对齐,
 * 不必让用户先猜"这条要设、那条不用设"。
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

        {/* Passkey 相关的入口单独一组,始终展示 —— 不按系统版本提前藏掉。
            能拿到的那个 isSupported() 只是"Android 9+ / iOS 15+"的粗判断,
            既不保证真能用(没设锁屏、没有凭据提供方照样会失败),提前藏掉
            还会让用户连"为什么不能用"都看不到。真正的可用性等 ceremony 跑起来
            自然会有结果,失败路径已经有明确提示(见 nativePasskey.ts)。 */}
        <View style={styles.group}>
          {/* 后端目前只有 Google OAuth 一条建会话的路(/api/auth/google/start),
              没有邮箱注册端点,所以文案照实写成 Google。等后端把邮箱注册接上
              再换这一行。 */}
          <Row
            icon={<Ionicons name="logo-google" size={20} color="#EA4335" />}
            title={t('createWalletMethod.googleOneTap')}
            desc={t('createWalletMethod.googleOneTapDesc')}
            onPress={() => nav.navigate('PasskeyCreate')}
          />
          <View style={styles.sep} />
          <Row
            icon={<MaterialCommunityIcons name="fingerprint" size={22} color={BLUE} />}
            title={t('createWalletMethod.loginWithPasskey')}
            desc={t('createWalletMethod.loginWithPasskeyDesc')}
            onPress={() => nav.navigate('PasskeyLogin')}
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
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 50 },

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
