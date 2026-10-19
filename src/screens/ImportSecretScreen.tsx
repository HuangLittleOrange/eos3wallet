import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  AppState,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import PasswordDialog from '../components/PasswordDialog';
import { sensitiveInputProps } from '../components/sensitiveInputProps';
import { useScreenCaptureGuard } from '../components/useScreenCaptureGuard';
import { useWalletSession } from '../chain/WalletContext';
import { legacyLabel } from '../chain/config';
import {
  deriveFromMnemonic,
  findAccountsByKey,
  fromPrivateKey,
  isValidMnemonic,
  isValidPrivateKey,
  newMnemonic,
  DerivedKey,
  KeyAccountMatch,
} from '../crypto/keys';
import { addWallet, newWalletId, removeSecret, saveSecret, verifyMasterPassword } from '../crypto/vault';
import { verifyImportedAccount } from '../chain/importAccount';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

/**
 * 助记词 / 私钥导入 —— 从原来 ImportScreen 里的分段控件拆出来,
 * mode 现在由路由参数固定,而不是页面里的 Tab(参考 TP 把入口拆成
 * 独立子页的做法)。两种 mode 的派生/查账户/主密码/确认逻辑完全一样,
 * 所以合成一个屏幕,只是入口和标题不同 —— 没有另建两个几乎一样的文件。
 *
 * 主密码在这个页面上不是一进来就要填的东西:本机没设过主密码时,
 * 入口的 ImportScreen 网关已经先带你去 SetMasterPasswordScreen 设置好了,
 * 到这里一定已经有主密码 —— 所以密码框只在派生出账户、真要选一个导入
 * 之前才出现,填的是"验证",不是"设置",和填助记词/私钥这一步分开。
 */
export default function ImportSecretScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { params } = useRoute<RouteProp<RootStackParamList, 'ImportSecret'>>();
  const mode = params.mode;
  const w = useWalletSession();
  const { t } = useI18n();

  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  // 整个页面都在输入/展示助记词或私钥,挂载期间全程禁截屏
  const protectedScreen = useScreenCaptureGuard(true, 'import-secret');
  const importGeneration = useRef(0);
  const importContext = JSON.stringify([w.chainId, w.node?.url, w.historyNode?.url]);
  const contextRef = useRef(importContext); contextRef.current = importContext;
  const mounted = useRef(true);
  const saving = useRef(false);
  const verification = useRef<AbortController | null>(null);
  const [derived, setDerived] = useState<DerivedKey | null>(null);
  const [found, setFound] = useState<KeyAccountMatch[] | null>(null);
  // 每个账户勾选的权限——默认按链上检测结果预勾选,用户可在确认导入前调整
  // (比如同一把私钥在 owner 和 active 里都有,默认两个都选中;查不到权限名的
  // 兜底路径默认只勾 active,毕竟日常签名场景用 active 更常见,owner 留给用户自己确认)
  const [selectedPerms, setSelectedPerms] = useState<Record<string, string[]>>({});
  // 找到不止一个账户时,这把钥匙这次到底要导入哪一个——单选,底部那颗按钮
  // 只认这一个。默认选中第一个,免得找到唯一一个账户时还要用户自己点一下。
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 主密码不摊在页面上,点了底部主按钮才弹一个居中对话框当场输——和
  // CreateAccountPayScreen 存钱包那一步同一套(PasswordDialog 自己持有密码 state,
  // 提交那一刻才把明文交出来用完即丢),顺带也让密码框不会被虚拟键盘和
  // 一整页 ScrollView 的滚动位置绞在一起、被键盘挡住。
  const [pwdOpen, setPwdOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const secretOk = mode === 'mnemonic' ? isValidMnemonic(secret) : isValidPrivateKey(secret);
  // 底部主按钮两个阶段各自的可用条件:还没解析出账户时看密钥格式对不对;
  // 解析完了看是不是选中了要导入的账户——密码是否够长、对不对留给
  // PasswordDialog 自己的输入框和 saveWallet 里的 verifyMasterPassword 判断
  const submitDisabled = !protectedScreen || busy || (derived ? saveBusy || !selectedAccount : !secretOk);

  const togglePerm = (account: string, perm: string) => {
    setSelectedPerms((prev) => {
      const cur = prev[account] ?? [];
      const has = cur.includes(perm);
      // 不允许一个都不选——不选权限的话这条记录没法说清楚它是用来签什么的
      if (has && cur.length === 1) return prev;
      return { ...prev, [account]: has ? cur.filter((p) => p !== perm) : [...cur, perm] };
    });
  };

  /** 生成新助记词 —— 仅用于测试网演示 */
  const generate = () => {
    if (!protectedScreen || saving.current) return;
    importGeneration.current++;
    setSecret(newMnemonic(12));
    setErr(null);
    setDerived(null);
    setFound(null);
  };

  /** 第一步:本地派生密钥并扫链找账户,不写入任何存储,不涉及密码 */
  const preview = async () => {
    if (!protectedScreen || saving.current) return;
    const generation = ++importGeneration.current;
    const context = importContext;
    const isCurrent = () => mounted.current && generation === importGeneration.current && context === contextRef.current;
    setBusy(true);
    setErr(null);
    setFound(null);
    setSelectedAccount(null);
    try {
      const k = mode === 'mnemonic' ? deriveFromMnemonic(secret) : fromPrivateKey(secret);
      setDerived(k);

      // 主路径走 Chain API(所有节点都有),Hyperion 作兜底。
      // 新旧两种公钥格式都试 —— 不同节点/接口支持度不一。
      const chainUrl = w.node.url;
      const hyperion = w.historyNode?.url;
      let accts = await findAccountsByKey(chainUrl, k.publicKey, hyperion).catch(() => [] as KeyAccountMatch[]);
      if (!accts.length) {
        accts = await findAccountsByKey(chainUrl, k.legacyPublicKey, hyperion).catch(() => [] as KeyAccountMatch[]);
      }
      if (!isCurrent()) return;
      setFound(accts);
      setSelectedPerms(
        Object.fromEntries(accts.map((a) => [a.account, a.permissions.length ? a.permissions : ['active']]))
      );
      // 默认选中第一个——只找到一个账户是最常见的情况,这样不用再多点一下
      setSelectedAccount(accts[0]?.account ?? null);
    } catch (e: any) {
      if (!isCurrent()) return;
      setErr(e?.message ?? t('importSecret.keyParseFailed'));
      setDerived(null);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  /** 第二步(PasswordDialog 提交触发):验证主密码(入口网关已保证一定设置过)、
   * 加密保存并切换到该账户。account 从 selectedAccount 闭包里取,跟主按钮
   * 点下去时选中的是同一个 —— 对话框开着的时候底下的账户行也点不到。 */
  const saveWallet = async (pwd: string) => {
    if (!derived || !selectedAccount || !protectedScreen || busy || saving.current) return;
    saving.current = true;
    const account = selectedAccount;
    const key = derived;
    const chainId = w.chainId;
    const authPermissions = [...(selectedPerms[account] ?? [])];
    const generation = importGeneration.current;
    const context = importContext;
    const controller = new AbortController();
    verification.current = controller;
    const isCurrent = () => mounted.current && !controller.signal.aborted &&
      AppState.currentState !== 'background' && generation === importGeneration.current && contextRef.current === context;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      if (!(await verifyMasterPassword(pwd))) {
        if (isCurrent()) setSaveErr(t('importSecret.masterPasswordWrong'));
        return;
      }
      if (!isCurrent()) return;
      await verifyImportedAccount({ chainId, account, publicKey: key.publicKey, permissions: authPermissions, signal: controller.signal });
      if (!isCurrent()) return;
      const id = newWalletId();
      await saveSecret(id, key.privateKey, pwd);
      if (!isCurrent()) { await removeSecret(id); return; }
      await addWallet({
        id,
        account,
        publicKey: key.publicKey,
        path: key.path,
        createdAt: Date.now(),
        source: mode === 'mnemonic' ? 'mnemonic' : 'privatekey',
        chainId,
        authPermissions,
      }, pwd);
      if (!isCurrent()) return;
      await w.reloadWallets();
      if (!isCurrent()) return;
      w.setAccount(account);
      Alert.alert(t('importSecret.importSuccessTitle'), t('importSecret.importSuccessBody', { account }), [
        // reset 而不是 navigate——这一屏刚刚显示过明文私钥/助记词,不能让「返回」
        // 键还能翻回来看到它;导入这个动作本身也是一次性的,不该留在返回栈里。
        { text: t('permission.ok'), onPress: () => nav.reset({ index: 0, routes: [{ name: 'Tabs' }] }) },
      ]);
    } catch (e: any) {
      if (isCurrent()) setSaveErr(e?.message ?? t('importSecret.saveFailed'));
    } finally {
      if (verification.current === controller) verification.current = null;
      saving.current = false;
      if (mounted.current) setSaveBusy(false);
    }
  };

  useEffect(() => {
    importGeneration.current++;
    verification.current?.abort();
    setDerived(null); setFound(null); setSelectedAccount(null); setSelectedPerms({});
    setPwdOpen(false); setBusy(false); setErr(null); setSaveErr(null);
  }, [importContext]);

  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'background') return;
      importGeneration.current++;
      verification.current?.abort();
      setSecret('');
      setDerived(null);
      setFound(null);
      setBusy(false);
      setPwdOpen(false);
    });
    return () => { mounted.current = false; importGeneration.current++; verification.current?.abort(); sub.remove(); };
  }, []);

  return (
    <View style={styles.root}>
      <PageHeader title={mode === 'mnemonic' ? t('importSecret.mnemonicTitle') : t('importSecret.privateKeyTitle')} />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {!protectedScreen ? <Text>{t('walletDetail.screenProtectionFailed')}</Text> : null}
        <View style={styles.netCard}>
          <View style={styles.netDot} />
          <Text style={styles.netTxt}>
            {w.client.config.name} · {legacyLabel(w.chainId)}
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>{mode === 'mnemonic' ? t('importSecret.mnemonicLabel') : t('importSecret.privateKeyLabel')}</Text>
            {mode === 'mnemonic' ? (
              <TouchableOpacity onPress={generate}>
                <Text style={styles.genTxt}>{t('importSecret.generateNew')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <TextInput
            value={protectedScreen ? secret : ''}
            editable={protectedScreen && !saveBusy}
            onChangeText={(v) => {
              importGeneration.current++;
              verification.current?.abort();
              setBusy(false);
              setSecret(v);
              setDerived(null);
              setFound(null);
              setSelectedAccount(null);
              setErr(null);
            }}
            placeholder={mode === 'mnemonic' ? t('importSecret.mnemonicPlaceholder') : t('importSecret.privateKeyPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={[styles.input, styles.multiline]}
            {...sensitiveInputProps}
            multiline
          />
          {secret.length > 0 && !secretOk ? (
            <Text style={styles.err}>{mode === 'mnemonic' ? t('importSecret.mnemonicInvalid') : t('importSecret.privateKeyInvalid')}</Text>
          ) : null}
        </View>

        {/* 派生结果 */}
        {derived ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultLabel}>{t('importSecret.derivedPubKey')}</Text>
            <Text style={styles.resultKey} selectable>
              {derived.publicKey}
            </Text>
            <Text style={styles.resultPath}>{t('importSecret.path', { path: derived.path })}</Text>
          </View>
        ) : null}

        {derived && found !== null ? (
          found.length === 0 ? (
            <View style={styles.noAcctCard}>
              <Ionicons name="information-circle-outline" size={17} color="#B45309" />
              <Text style={styles.noAcctTxt}>{t('importSecret.noAccountControlled')}</Text>
            </View>
          ) : (
            <View style={styles.resultCard}>
              <Text style={styles.foundLabel}>{t('importSecret.foundAccounts', { n: found.length })}</Text>
              <Text style={styles.permHint}>{t('importSecret.accountControlNote')}</Text>
              {/* 每行只负责"选中哪个账户 + 调整这个账户要导入的权限",不再各自
                  带一颗导入按钮——真正的导入动作统一收到底部那一颗主按钮上,
                  和上面"解析并查找"共用同一个位置,不会出现两颗按钮都像是
                  "导入入口"、用户不知道该点哪个的问题。找到不止一个账户时,
                  点行本身(权限胶囊之外的地方)切换选中,选中态给个勾选图标
                  和描边,和列表/权限选择的常见交互一致。 */}
              {found.map((a) => {
                const perms = selectedPerms[a.account] ?? ['active'];
                const detected = a.permissions;
                const selected = selectedAccount === a.account;
                return (
                  <TouchableOpacity
                    key={a.account}
                    style={[styles.acctBlock, selected && styles.acctBlockOn, saveBusy && !selected && styles.acctRowOff]}
                    activeOpacity={0.7}
                    disabled={saveBusy}
                    onPress={() => setSelectedAccount(a.account)}
                  >
                    <View style={styles.acctRow}>
                      <Text style={styles.acctName}>{a.account}</Text>
                      {found.length > 1 ? (
                        <Ionicons
                          name={selected ? 'radio-button-on' : 'radio-button-off'}
                          size={20}
                          color={selected ? BLUE : colors.textFaint}
                        />
                      ) : null}
                    </View>
                    {detected.length === 0 ? (
                      <Text style={styles.permHint}>{t('importSecret.noPermDetected')}</Text>
                    ) : null}
                    <View style={styles.permChips}>
                      {['owner', 'active', ...detected.filter((p) => p !== 'owner' && p !== 'active')].map((perm) => {
                        const on = perms.includes(perm);
                        return (
                          <TouchableOpacity
                            key={perm}
                            style={[styles.permChip, on && styles.permChipOn]}
                            disabled={saveBusy}
                            onPress={() => togglePerm(a.account, perm)}
                          >
                            <Text style={[styles.permChipTxt, on && styles.permChipTxtOn]}>{perm}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )
        ) : null}

        {err ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color="#F0644E" />
            <Text style={styles.errBoxTxt}>{err}</Text>
          </View>
        ) : null}

        {/* 安全提示 */}
        <View style={styles.warnCard}>
          <Ionicons name="shield-checkmark" size={18} color="#12A566" />
          <Text style={styles.warnTxt}>{t('importSecret.securityNote')}</Text>
        </View>

        {/* 底部只有这一颗主按钮,承担两个阶段的动作——先"解析并查找",找到账户后
            变成"导入":不再像之前那样,上面账户行自带一颗按钮、底下还留一颗
            置灰的提示文案,两颗看着都像入口,用户分不清该点哪个。没找到可导入
            账户时(noAcctCard 已经说明原因)直接不渲染这颗按钮,没有可提交的
            东西,不需要一颗常驻的灰按钮占地方。 */}
        {derived && found && found.length === 0 ? null : (
          <TouchableOpacity
            style={[styles.submit, submitDisabled && styles.submitOff]}
            disabled={submitDisabled}
            activeOpacity={0.85}
            onPress={derived ? () => setPwdOpen(true) : preview}
          >
            {busy || saveBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitTxt}>
                {derived ? t('importSecret.importByPerms') : t('importSecret.parseAndSearch')}
              </Text>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>

      <PasswordDialog
        visible={pwdOpen}
        title={t('importSecret.importByPerms')}
        busy={saveBusy}
        error={saveErr}
        onClose={() => {
          setPwdOpen(false);
          setSaveErr(null);
        }}
        onSubmit={saveWallet}
      />
    </View>
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

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 12 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 14.5, color: colors.textSub, fontWeight: '600' },
  genTxt: { fontSize: 13.5, color: BLUE },
  input: { fontSize: 15.5, color: colors.text, padding: 0, marginTop: 12, outlineStyle: 'none' as any },
  multiline: { minHeight: 76, textAlignVertical: 'top', lineHeight: 24 },
  err: { fontSize: 12.5, color: '#F04438', marginTop: 10 },

  resultCard: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 12 },
  resultLabel: { fontSize: 13, color: colors.textSub },
  resultKey: { fontSize: 12.5, color: colors.text, marginTop: 6, lineHeight: 19 },
  resultPath: { fontSize: 12, color: colors.textFaint, marginTop: 6 },
  foundLabel: { fontSize: 13.5, color: colors.text, marginBottom: 4 },
  acctBlock: {
    backgroundColor: '#F2F7FF',
    borderRadius: 8,
    padding: 14,
    marginTop: 8,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  acctBlockOn: { borderColor: BLUE },
  acctRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  acctName: { fontSize: 16, color: colors.text, fontWeight: '600' },
  acctRowOff: { opacity: 0.5 },
  permHint: { fontSize: 12, color: '#B45309', marginTop: 6, lineHeight: 17 },
  permChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  permChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: '#D6E2F5',
  },
  permChipOn: { backgroundColor: BLUE, borderColor: BLUE },
  permChipTxt: { fontSize: 12.5, color: colors.textSub, fontWeight: '600' },
  permChipTxtOn: { color: '#fff' },
  noAcctCard: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  noAcctTxt: { flex: 1, fontSize: 12.5, color: '#B45309', lineHeight: 19 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginBottom: 12 },
  errBoxTxt: { flex: 1, fontSize: 13, color: '#F0644E', lineHeight: 19 },

  warnCard: { flexDirection: 'row', gap: 8, backgroundColor: '#E8F7EF', borderRadius: 10, padding: 14, marginBottom: 16 },
  warnTxt: { flex: 1, fontSize: 12.5, color: colors.textSub, lineHeight: 19 },

  submit: { backgroundColor: BLUE, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  submitOff: { backgroundColor: '#A9C9F5' },
  submitTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
