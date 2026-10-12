import { useSigningGuard } from '../chain/useSigningGuard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Linking } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import PasswordDialog from '../components/PasswordDialog';
import AccountNameBoxes from '../components/AccountNameBoxes';
import TokenBadge from '../components/TokenBadge';
import ConfirmTxSheet from '../components/ConfirmTxSheet';
import { useWalletSession } from '../chain/WalletContext';
import { tokenColor } from '../chain/format';
import { accountNameError, isValidAccountName, randomAccountName } from '../chain/account';
import { ActionSpec, Signer, buildTransfer, transact } from '../chain/transact';
import { useResourceRepair } from '../components/ResourceRepairSheet';
import { SIGNUP_AMOUNT, SIGNUP_CONTRACT, isSignupTokenSupported } from '../chain/signup';
import { PendingSignupOrder, clearPendingSignup, loadPendingSignup, savePendingSignup } from '../chain/pendingSignup';
import { generateKey } from '../crypto/keys';
import {
  addWallet,
  clearPendingKey,
  hasMasterPassword,
  loadPendingKey,
  newWalletId,
  savePendingKey,
  saveSecret,
  verifyMasterPassword,
} from '../crypto/vault';
import { biometricSigner, passkeySigner, passwordSigner } from '../chain/signers';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';
const RED = '#F0644E';

// 对齐 TP 的三屏结构:
//   name  —— 只做一件事:起账户名(截图 2/3)
//   order —— 独立的 Account Order 页,转账信息 + 底部 删除订单 / 激活账户(截图 4)
//   save  —— 链上确认建号后,输一次主密码把这把钥匙正式收进钱包
// 'checking' 只是进页面查有没有未完成订单的一瞬间。
// 轮询状态直接内联显示在 order 页上,不再单开一屏"等待中"——TP 也是在订单页
// 原地转圈的。
type Step = 'checking' | 'name' | 'order' | 'save';

const isAccount = isValidAccountName;
// 轮询等新账户上链:间隔 5 秒,最多 24 次(2 分钟)—— 参考 TP/eoseyes 页面给出的
// "几个块""大概 1 分钟"的量级,留了一倍余量
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_TRIES = 24;

export default function CreateAccountPayScreen() {
  const nav = useNavigation<any>();
  // 只读会话半边(链/账户/钱包/操作函数),不订阅余额/行情等实时数据——
  // 本页一个实时字段都不用,跟着每轮 refresh 的分批落位陪跑纯属浪费
  const w = useWalletSession();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>('checking');
  const [order, setOrder] = useState<PendingSignupOrder | null>(null);

  // ---------- 起名 ----------
  const [accountName, setAccountName] = useState('');
  const [nameCheck, setNameCheck] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [agreed, setAgreed] = useState(false);
  // 金额是固定的(SIGNUP_AMOUNT),这里只需要确认合约当前还收这个代币
  const [tokenOk, setTokenOk] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [nextBusy, setNextBusy] = useState(false);

  // ---------- 付款 ----------
  const [confirm, setConfirm] = useState<ActionSpec[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const repair = useResourceRepair(w, { onCancel: setTxErr });

  const payer = w.currentWallet;
  const signingGuard = useSigningGuard(JSON.stringify([payer?.id, payer?.publicKey, w.chainId,
    w.node.url, w.account, 'active']), confirm, () => setConfirm(null));
  const canPay = !!payer;

  // 进页面先查一遍本机有没有这条链的未完成订单;有的话弹出"是否前往激活"
  // (参考 TP 截图 1 后面那个弹窗),Delete 就地清掉从头开始,Confirm 直接进
  // 订单详情页。cancelable: false —— 和 TP 一样必须明确二选一。
  useEffect(() => {
    let alive = true;
    if (w.chainId !== 'vaulta') {
      setStep('name');
      return;
    }
    loadPendingSignup(w.chainId).then((o) => {
      if (!alive) return;
      if (!o) {
        setStep('name');
        return;
      }
      Alert.alert(t('createAccountPay.resumeTitle'), undefined, [
        {
          text: t('createAccountPay.resumeDelete'),
          style: 'destructive',
          onPress: () => {
            clearPendingSignup(o.chainId).catch(() => {});
            clearPendingKey(o.publicKey).catch(() => {});
            setStep('name');
          },
        },
        {
          text: t('createAccountPay.resumeConfirm'),
          onPress: () => {
            setOrder(o);
            setAccountName(o.accountName);
            setStep('order');
          },
        },
      ], { cancelable: false });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.chainId]);

  // 本机还没设过主密码就先去设置一次 —— 这是 App 统一的密钥保管前提,和
  // ImportScreen 用的是同一套网关。注意这里只在"从没设过"时出现一次,
  // 正常流程中不会再要求验证密码(TP 的建号流程里也没有密码这一步)。
  useFocusEffect(
    useCallback(() => {
      if (step !== 'name') return;
      let alive = true;
      hasMasterPassword()
        .then((has) => {
          if (alive && !has) nav.navigate('SetMasterPassword');
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [step, nav])
  );

  // 起名这一屏先确认合约当前还认这个代币 —— token 表是合约方自己可改的白名单,
  // 万一哪天把 eosio.token 撤了,提前挡住比事后发现钱转过去没反应要好
  useEffect(() => {
    if (step !== 'name' || tokenOk) return;
    let alive = true;
    (async () => {
      try {
        const supported = await isSignupTokenSupported(w.node.url, w.client.config.systemToken);
        if (!alive) return;
        if (!supported) {
          setQuoteErr(t('createAccountPay.tokenNotSupported', { contract: SIGNUP_CONTRACT, symbol: w.client.config.symbol }));
          return;
        }
        setTokenOk(true);
      } catch (e: any) {
        if (alive) setQuoteErr(e?.message ?? t('createAccountPay.quoteFailed'));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, tokenOk, w.client, w.node.url]);

  // 账户名失焦查一次是否已被占用(不能完全杜绝抢注竞态,但能挡掉明显撞号的情况)
  const checkName = async (name: string) => {
    if (!isAccount(name)) {
      setNameCheck('idle');
      return;
    }
    setNameCheck('checking');
    try {
      await w.client.getAccount(name);
      setNameCheck('taken');
    } catch {
      setNameCheck('available');
    }
  };

  const useRandomName = () => {
    const name = randomAccountName();
    setAccountName(name);
    checkName(name);
  };

  const nameReady = nameCheck === 'available' && agreed && tokenOk && !nextBusy;

  /**
   * 「下一步」:当场生成这个账户要用的密钥,存进临时槽位,并把订单落盘,
   * 然后进 Account Order 页。全程不问密码 —— 密码留到账户真的建好、要把
   * 这把钥匙收进钱包时才要一次。
   */
  const goOrder = async () => {
    if (!tokenOk) return;
    setNextBusy(true);
    try {
      const key = generateKey();
      await savePendingKey(key.privateKey, key.publicKey);
      const now = Date.now();
      const next: PendingSignupOrder = {
        id: `${w.chainId}-${now}`,
        chainId: w.chainId,
        accountName,
        publicKey: key.publicKey,
        legacyPublicKey: key.legacyPublicKey,
        path: key.path,
        contract: SIGNUP_CONTRACT,
        memo: `${accountName}-${key.legacyPublicKey}`,
        amount: SIGNUP_AMOUNT,
        symbol: w.client.config.symbol,
        precision: w.client.config.precision,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      await savePendingSignup(next);
      setOrder(next);
      setStep('order');
    } catch (e: any) {
      Alert.alert(t('createAccountPay.orderCreateFailed'), e?.message ?? t('send.unknownError'));
    } finally {
      setNextBusy(false);
    }
  };

  const patchOrder = async (patch: Partial<PendingSignupOrder>) => {
    if (!order) return;
    const next = { ...order, ...patch, updatedAt: Date.now() };
    setOrder(next);
    await savePendingSignup(next).catch(() => {});
  };

  // ---------- 用本机钱包付这笔开户费 ----------
  const review = () => {
    if (!order) return;
    setTxErr(null);
    try {
      const action = buildTransfer({
        contract: w.client.config.systemToken,
        from: w.account,
        to: order.contract,
        amount: order.amount,
        symbol: order.symbol,
        precision: order.precision,
        // memo 里的公钥用旧版 EOS... 格式,不是 PUB_K1_... —— TP 截图和 eoseyes.com
        // 页面给出的示例都是旧格式,这类"转账+memo 建号"的合约生态里旧格式更通用
        memo: order.memo,
      });
      setConfirm([action]);
    } catch (e: any) {
      Alert.alert(t('send.buildFailedTitle'), e?.message ?? t('send.unknownError'));
    }
  };

  const broadcast = async (getSigner: () => Promise<Signer>) => {
    if (!confirm || !payer) return;
    const attempt = signingGuard.begin();
    if (!attempt) return;
    setBusy(true);
    setTxErr(null);
    let signer: Signer | null = null;
    try {
      signer = await getSigner();
      if (!attempt.isCurrent()) return;
      const res = await transact({ chainId: w.chainId, node: w.node, actor: w.account, signer, actions: confirm, isCurrent: attempt.isCurrent });
      setConfirm(null);
      await patchOrder({ status: 'submitted', txid: res.txId, explorerUrl: res.explorerUrl });
      startPolling();
    } catch (e: any) {
      if (attempt.isCurrent() && !repair.offer(e, signer, 'active')) setTxErr(e?.message ?? t('send.signOrBroadcastFailed'));
    } finally {
      attempt.finish();
      setBusy(false);
    }
  };

  const submit = (password: string) =>
    broadcast(passwordSigner(payer!, password));
  const submitBiometric = () =>
    broadcast(biometricSigner(payer!));
  const submitPasskey = () =>
    broadcast(passkeySigner(payer!));

  // ---------- 「激活账户」:查链上有没有建好 ----------
  const [polling, setPolling] = useState(false);
  const [pollTries, setPollTries] = useState(0);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef(false);
  /** 建号后从链上读到的、这把钥匙实际控制的权限(通常是 owner + active) */
  const [onChainPerms, setOnChainPerms] = useState<string[] | null>(null);

  const pollOnce = useCallback(async () => {
    try {
      const acct = await w.client.getAccount(accountName);
      pollingRef.current = false;
      setPolling(false);
      // 顺手从链上读这把钥匙实际拿到了哪些权限,存进钱包记录 —— signupwallet
      // 目前是 owner/active 都用同一把钥匙,但那是合约的行为、不是我们能替它保证的,
      // 所以照实读,不硬编码(资产页顶部那个权限标就靠这份记录)
      const mine = acct.permissions.filter((p) => p.keys.includes(order?.publicKey ?? '')).map((p) => p.name);
      if (mine.length) setOnChainPerms(mine);
      setStep('save');
      return;
    } catch {
      // 还没建好
    }
    if (!pollingRef.current) return;
    setPollTries((n) => {
      const next = n + 1;
      if (next >= POLL_MAX_TRIES) {
        pollingRef.current = false;
        setPolling(false);
        setPollTimedOut(true);
      } else {
        pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountName, w.client, order?.publicKey]);

  const startPolling = () => {
    if (order?.status !== 'submitted') patchOrder({ status: 'submitted' });
    pollingRef.current = true;
    setPolling(true);
    setPollTries(0);
    setPollTimedOut(false);
    pollOnce();
  };

  useEffect(
    () => () => {
      pollingRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    []
  );

  const deleteOrder = () => {
    Alert.alert(t('createAccountPay.deleteOrderTitle'), t('createAccountPay.deleteOrderBody'), [
      { text: t('createAccountPay.cancel'), style: 'cancel' },
      {
        text: t('createAccountPay.deleteOrder'),
        style: 'destructive',
        onPress: async () => {
          pollingRef.current = false;
          if (pollTimer.current) clearTimeout(pollTimer.current);
          await clearPendingSignup(w.chainId).catch(() => {});
          if (order) await clearPendingKey(order.publicKey).catch(() => {});
          setOrder(null);
          setAccountName('');
          setNameCheck('idle');
          setAgreed(false);
          setPolling(false);
          setPollTimedOut(false);
          setTxErr(null);
          setStep('name');
        },
      },
    ]);
  };

  // ---------- 建好之后:输一次主密码,把临时密钥转成正式钱包 ----------
  // 密码由 PasswordDialog 自己持有,这里只在提交那一刻拿到它用完就丢,不进 state
  const [pwdOpen, setPwdOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const saveWallet = async (pwd: string) => {
    if (!order) return;
    setSaveBusy(true);
    setSaveErr(null);
    try {
      if (!(await verifyMasterPassword(pwd))) {
        setSaveErr(t('importSecret.masterPasswordWrong'));
        return;
      }
      const priv = await loadPendingKey(order.publicKey);
      if (!priv) {
        setSaveErr(t('createAccountPay.pendingKeyMissing'));
        return;
      }
      const id = newWalletId();
      await saveSecret(id, priv, pwd);
      await addWallet({
        id,
        account: order.accountName,
        publicKey: order.publicKey,
        path: order.path,
        createdAt: Date.now(),
        source: 'privatekey',
        chainId: order.chainId,
        authPermissions: onChainPerms ?? undefined,
      });
      // 正式条目写好了才清临时槽位,中间任何一步失败都还能重来
      if (order) await clearPendingKey(order.publicKey).catch(() => {});
      await clearPendingSignup(order.chainId).catch(() => {});
      await w.reloadWallets();
      w.setAccount(order.accountName);
      Alert.alert(t('createAccountPay.accountCreatedTitle'), t('createAccountPay.accountCreatedBody', { account: order.accountName }), [
        // reset 而不是 navigate——这是一次性的三步建号流程(起名/订单/存钥匙),
        // 完成之后「返回」键不该还能翻回中间那几步
        { text: t('permission.ok'), onPress: () => nav.reset({ index: 0, routes: [{ name: 'Tabs' }] }) },
      ]);
    } catch (e: any) {
      setSaveErr(e?.message ?? t('importSecret.saveFailed'));
    } finally {
      setSaveBusy(false);
    }
  };

  if (w.chainId !== 'vaulta') {
    return (
      <View style={styles.root}>
        <PageHeader title={t('createAccountPay.title')} />
        <View style={{ padding: spacing.lg }}>
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color={RED} />
            <Text style={styles.errBoxTxt}>{t('createAccountPay.mainnetOnlyBody')}</Text>
          </View>
        </View>
      </View>
    );
  }

  // ---------- 起名(TP 截图 2/3) ----------
  if (step === 'checking' || step === 'name') {
    return (
      <View style={styles.root}>
        <PageHeader title="" />
        {step === 'checking' ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.textFaint} size="small" />
          </View>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.namePad} showsVerticalScrollIndicator={false}>
              <Text style={styles.h1}>{t('createAccountPay.nameHeading', { chain: w.client.config.name })}</Text>
              <Text style={styles.h1Sub}>{t('createAccountPay.nameSubtitle')}</Text>

              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>{t('createAccountPay.setAccountName', { symbol: w.client.config.symbol })}</Text>
                <TouchableOpacity onPress={useRandomName} hitSlop={8}>
                  <Text style={styles.linkBtn}>{t('createAccountPay.randomAccount')}</Text>
                </TouchableOpacity>
              </View>

              <AccountNameBoxes value={accountName} onChangeText={setAccountName} onBlur={() => checkName(accountName)} />

              <View style={styles.statusLine}>
                {accountName.length > 0 && !isAccount(accountName) ? (
                  <Text style={styles.err}>{accountNameError(accountName) ?? t('send.invalidAccount')}</Text>
                ) : nameCheck === 'checking' ? (
                  <Text style={styles.hint}>{t('createAccountPay.checking')}</Text>
                ) : nameCheck === 'taken' ? (
                  <Text style={styles.err}>{t('createAccountPay.nameTaken')}</Text>
                ) : nameCheck === 'available' ? (
                  <Text style={styles.okTxt}>{t('createAccountPay.nameAvailable')}</Text>
                ) : null}
              </View>

              {quoteErr ? (
                <View style={styles.errBox}>
                  <Ionicons name="alert-circle-outline" size={17} color={RED} />
                  <Text style={styles.errBoxTxt}>{quoteErr}</Text>
                </View>
              ) : null}
            </ScrollView>

            {/* 底部固定:同意协议 + 下一步(TP 截图 3) */}
            <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 28 }]}>
              <TouchableOpacity style={styles.agreeRow} activeOpacity={0.7} onPress={() => setAgreed((v) => !v)}>
                <Ionicons
                  name={agreed ? 'checkmark-circle' : 'ellipse-outline'}
                  size={21}
                  color={agreed ? BLUE : colors.textFaint}
                />
                <Text style={styles.agreeTxt}>
                  {t('createAccountPay.agreePrefix')}
                  <Text style={styles.agreeLink} onPress={() => Linking.openURL('https://eos3.app/terms')}>
                    {t('createAccountPay.serviceAgreement')}
                  </Text>
                </Text>
              </TouchableOpacity>

              {/* 代币支持检查在后台默默跑完就直接放行,但没查完之前按钮是灰的——
                  不加这行提示的话,用户明明已经填完名字、勾了协议,却看不出
                  按钮为什么点不动,像是卡住了 */}
              {!tokenOk && !quoteErr ? (
                <View style={styles.checkingRow}>
                  <ActivityIndicator size="small" color={colors.textFaint} />
                  <Text style={styles.hint}>{t('createAccountPay.checkingToken')}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.bigBtn, !nameReady && styles.bigBtnOff]}
                disabled={!nameReady}
                activeOpacity={0.85}
                onPress={goOrder}
              >
                {nextBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.bigBtnTxt}>{t('createAccountPay.nextStep')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    );
  }

  // ---------- 建好了,收进钱包 ----------
  // 成功页只负责"报喜 + 一个主按钮",密码不摊在页面上,点按钮才弹对话框(TP 就是
  // 这么处理需要密码的动作的)
  if (step === 'save') {
    return (
      <View style={styles.root}>
        <PageHeader title="" />
        <View style={[styles.donePad, { paddingBottom: insets.bottom + 28 }]}>
          <View style={styles.doneIcon}>
            <Ionicons name="checkmark" size={38} color="#fff" />
          </View>
          <Text style={styles.doneTitle}>{t('createAccountPay.accountCreated')}</Text>
          <Text style={styles.doneAccount}>{order?.accountName}</Text>
          <Text style={styles.doneHint}>{t('createAccountPay.saveWalletHint')}</Text>

          <View style={{ flex: 1 }} />

          <TouchableOpacity style={styles.bigBtn} activeOpacity={0.85} onPress={() => setPwdOpen(true)}>
            <Text style={styles.bigBtnTxt}>{t('createAccountPay.saveWallet')}</Text>
          </TouchableOpacity>
        </View>

        <PasswordDialog
          visible={pwdOpen}
          title={t('createAccountPay.saveWallet')}
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

  // ---------- Account Order(TP 截图 4) ----------
  // 走到这一步 order 必然已经有了(order/save 两个步骤都是在订单落盘之后才进的),
  // 留个兜底纯粹是让下面能安全地直接取 order.xxx,不用满屏可选链
  if (!order) return null;
  const paid = order.status === 'submitted';
  const explorer = order.explorerUrl;
  return (
    <View style={styles.root}>
      <PageHeader title="" />
      <ScrollView contentContainerStyle={styles.orderPad} showsVerticalScrollIndicator={false}>
        <Text style={styles.h1}>{t('createAccountPay.orderHeading')}</Text>
        <Text style={styles.h1Sub}>{t('createAccountPay.orderSubtitle')}</Text>

        <Text style={styles.fieldLabel}>{t('createAccountPay.orderAccount')}</Text>
        <View style={styles.readonlyBox}>
          <Text style={styles.readonlyTxt}>{order.accountName}</Text>
        </View>

        <Text style={styles.fieldLabel}>{t('createAccountPay.payWith')}</Text>
        <View style={styles.payRow}>
          <TokenBadge
            symbol={order.symbol ?? ''}
            color={tokenColor(order.symbol ?? '')}
            size={26}
            contract={w.client.config.systemToken}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.payTxt}>{order.symbol}</Text>
            <Text style={styles.paySub}>{canPay ? t('createAccountPay.payFromWallet', { account: w.account }) : t('createAccountPay.payFromExternal')}</Text>
          </View>
        </View>

        {/* Process 说明 + To/Memo 同在一张白卡片里(TP 截图 4 就是这么分组的:
            "怎么转"和"转给谁、备注写什么"属于同一件事,不该被灰底切开) */}
        <Text style={styles.fieldLabel}>{t('createAccountPay.process')}</Text>
        <View style={styles.processCard}>
          <Bullet text={t('createAccountPay.processStep1', { amount: order.amount, symbol: order.symbol })} />
          <Bullet text={t('createAccountPay.processStep2')} />
          <Bullet text={t('createAccountPay.processStep3')} />

          <CopyField label={t('createAccountPay.toNecessary')} value={order.contract} />
          <CopyField label={t('createAccountPay.memoNecessary')} value={order.memo} multiline />
        </View>

        {txErr ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color={RED} />
            <Text style={styles.errBoxTxt}>{txErr}</Text>
          </View>
        ) : null}

        {polling ? (
          <View style={styles.pollRow}>
            <ActivityIndicator color={BLUE} size="small" />
            <Text style={styles.hint}>{t('createAccountPay.waitingHint', { account: order.accountName, tries: pollTries })}</Text>
          </View>
        ) : pollTimedOut ? (
          <Text style={styles.hint}>{t('createAccountPay.timedOutHint')}</Text>
        ) : null}

        {explorer ? (
          <TouchableOpacity onPress={() => Linking.openURL(explorer)}>
            <Text style={styles.linkTxt}>{t('createAccountPay.viewOnExplorer')}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      {/* 底部并排两个按钮(TP 截图 4) */}
      <View style={[styles.orderBar, { paddingBottom: insets.bottom + 28 }]}>
        <TouchableOpacity style={[styles.halfBtn, styles.delBtn]} activeOpacity={0.85} onPress={deleteOrder}>
          <Text style={styles.halfBtnTxt}>{t('createAccountPay.deleteOrder')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.halfBtn, styles.actBtn, (polling || busy) && styles.bigBtnOff]}
          disabled={polling || busy}
          activeOpacity={0.85}
          // 本机有能付款的钱包、且这单还没付 → 直接走签名转账;
          // 否则(外部转账)就是 TP 那个"我转好了,去激活"的语义:查链上有没有建好
          onPress={canPay && !paid ? review : startPolling}
        >
          <Text style={styles.halfBtnTxt}>
            {canPay && !paid ? t('createAccountPay.payAndCreate') : t('createAccountPay.activeAccount')}
          </Text>
        </TouchableOpacity>
      </View>

      <ConfirmTxSheet
        visible={confirm !== null}
        onClose={() => setConfirm(null)}
        actions={confirm ?? []}
        chainName={w.client.config.name}
        testnet={w.client.config.testnet}
        actor={w.account}
        busy={busy}
        error={txErr}
        walletId={payer?.id}
        passkey={payer?.source === 'passkey'}
        onConfirm={submit}
        onConfirmBiometric={submitBiometric}
        onConfirmPasskey={submitPasskey}
      />
      {repair.element}
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletBar} />
      <Text style={styles.bulletTxt}>{text}</Text>
    </View>
  );
}

/** TP 那种「灰底一行 + 右侧 Copy」的只读字段 */
function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <View>
      <Text style={styles.fieldLabelWarn}>
        {label}
        <Text style={styles.necessary}>{t('createAccountPay.necessary')}</Text>
      </Text>
      <View style={styles.copyRow}>
        <Text style={styles.copyTxt} numberOfLines={multiline ? 2 : 1}>
          {value}
        </Text>
        <TouchableOpacity onPress={copy} hitSlop={8}>
          <Text style={[styles.linkBtn, copied && { color: '#12A566' }]}>
            {copied ? t('createAccountPay.copied') : t('createAccountPay.copy')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },
  loading: { alignItems: 'center', paddingVertical: 40 },

  namePad: { paddingHorizontal: spacing.lg, paddingBottom: 24 },
  orderPad: { paddingHorizontal: spacing.lg, paddingBottom: 24 },

  donePad: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: 48 },
  doneIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#12A566',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneTitle: { fontSize: 22, fontWeight: '700', color: colors.text, marginTop: 22 },
  doneAccount: { fontSize: 17, color: BLUE, fontWeight: '600', marginTop: 10 },
  doneHint: { fontSize: 13, color: colors.textFaint, lineHeight: 20, textAlign: 'center', marginTop: 16 },

  h1: { fontSize: 27, fontWeight: '700', color: colors.text, lineHeight: 36 },
  h1Sub: { fontSize: 13.5, color: colors.textFaint, marginTop: 8, lineHeight: 20 },

  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 10 },
  fieldLabel: { fontSize: 14, color: colors.textSub, fontWeight: '500', marginTop: 20, marginBottom: 8 },
  // 卡片内的字段标题:上下留白由 processCard 的 gap 统一给,自己不再加 marginTop
  fieldLabelWarn: { fontSize: 14, color: colors.text, fontWeight: '500', marginBottom: 8 },
  necessary: { color: RED, fontSize: 13 },
  linkBtn: { fontSize: 14, color: BLUE, fontWeight: '600' },

  statusLine: { minHeight: 26, justifyContent: 'center', alignItems: 'flex-end' },
  hint: { fontSize: 12.5, color: colors.textFaint, lineHeight: 18, flex: 1 },
  checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  err: { fontSize: 12.5, color: '#F04438' },
  okTxt: { fontSize: 12.5, color: '#12A566' },

  readonlyBox: { backgroundColor: colors.white, borderRadius: 10, paddingVertical: 15, paddingHorizontal: 14 },
  readonlyTxt: { fontSize: 15.5, color: colors.text },

  payRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  payTxt: { fontSize: 15.5, color: colors.text, fontWeight: '600' },
  paySub: { fontSize: 12, color: colors.textFaint, marginTop: 2 },

  processCard: { backgroundColor: colors.white, borderRadius: 10, padding: 12, gap: 12 },
  bullet: { flexDirection: 'row', gap: 10, backgroundColor: '#F0F6FF', borderRadius: 6, padding: 11 },
  bulletBar: { width: 3, borderRadius: 2, backgroundColor: BLUE },
  bulletTxt: { flex: 1, fontSize: 12.5, color: colors.textSub, lineHeight: 19 },

  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#EFF2F6',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  copyTxt: { flex: 1, fontSize: 13.5, color: colors.text, lineHeight: 19 },

  pollRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  linkTxt: { fontSize: 13.5, color: BLUE, marginTop: 12 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginTop: 14 },
  errBoxTxt: { flex: 1, fontSize: 13, color: RED, lineHeight: 19 },

  bottomBar: { paddingHorizontal: spacing.lg, paddingTop: 8 },
  agreeRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 14 },
  agreeTxt: { flex: 1, fontSize: 13, color: colors.textSub },
  agreeLink: { color: BLUE },

  bigBtn: { backgroundColor: BLUE, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  bigBtnOff: { opacity: 0.45 },
  bigBtnTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },

  orderBar: { flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingTop: 8 },
  halfBtn: { flex: 1, height: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  delBtn: { backgroundColor: RED },
  actBtn: { backgroundColor: BLUE },
  halfBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
