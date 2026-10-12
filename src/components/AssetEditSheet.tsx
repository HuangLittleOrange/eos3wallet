import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import { AuthorizedAppAsset, LimitDraft, PayLimitAssetConfig, fullAssetKey } from '../chain/permissions';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

/**
 * 新增/编辑一个已授权代币的额度——受控组件,编辑态(草稿值、正在编辑哪个代币)
 * 都放在 PermissionDetailScreen 里,这里只管展示和上抛用户输入,不自己管状态
 * (跟旧 web 版把这些状态塞进全局 WalletContext 不一样,eostp 这边延续
 * PermissionScreen.tsx 已经在用的"页面本地状态"写法)。
 */
export default function AssetEditSheet({
  visible,
  isNewAsset,
  asset,
  draft,
  selectableAssets,
  busy,
  onChangeDraft,
  onSelectAsset,
  onSave,
  onClose,
}: {
  visible: boolean;
  isNewAsset: boolean;
  asset: AuthorizedAppAsset | null;
  draft: LimitDraft;
  selectableAssets: PayLimitAssetConfig[];
  busy: boolean;
  onChangeDraft: (field: keyof LimitDraft, value: string) => void;
  onSelectAsset: (candidate: PayLimitAssetConfig) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  // 不能在这里 `if (!asset) return null` 直接不渲染 <BottomSheet> —— 关闭时父组件是
  // 先把 asset 置空再把 visible 变 false(见 PermissionDetailScreen),提前 return 会让
  // BottomSheet 整个被卸载,退出动画根本来不及播,直接生硬地消失。这里跟 ConfirmTxSheet
  // 一样,始终挂载 BottomSheet,只在内容里对 asset 判空。
  const symbol = asset?.symbol ?? '';
  const tokenContract = asset?.tokenContract ?? '';

  return (
    <BottomSheet visible={visible} onClose={onClose} closeOnBackdrop={!busy}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{isNewAsset ? t('permission.addAssetTitle') : t('permission.editLimitsTitle')}</Text>
          <TouchableOpacity hitSlop={8} disabled={busy} onPress={onClose} style={{ width: 30, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Text style={styles.subtitle}>
            {isNewAsset ? `${t('permission.newAssetPrefix')} ` : ''}
            {symbol} · {tokenContract}
          </Text>
          {isNewAsset ? <Text style={styles.note}>{t('permission.addAssetNote')}</Text> : null}

          {isNewAsset && asset && selectableAssets.length > 0 ? (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('permission.assetLabel')}</Text>
              <View style={styles.assetOptions}>
                {selectableAssets.map((candidate) => {
                  const active = fullAssetKey(candidate) === fullAssetKey(asset);
                  return (
                    <TouchableOpacity
                      key={fullAssetKey(candidate)}
                      style={[styles.assetOption, active && styles.assetOptionActive]}
                      onPress={() => onSelectAsset(candidate)}
                    >
                      <Text style={[styles.assetOptionTxt, active && styles.assetOptionTxtActive]}>
                        {candidate.symbol} · {candidate.tokenContract}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t('permission.dailyLimitLabel')}</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={draft.dailyLimit}
                inputMode="decimal"
                placeholder="0"
                placeholderTextColor={colors.textFaint}
                onChangeText={(value) => onChangeDraft('dailyLimit', value)}
              />
              <Text style={styles.inputUnit}>{symbol}</Text>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t('permission.totalBudgetLabel')}</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={draft.totalBudget}
                inputMode="decimal"
                placeholder="0"
                placeholderTextColor={colors.textFaint}
                onChangeText={(value) => onChangeDraft('totalBudget', value)}
              />
              <Text style={styles.inputUnit}>{symbol}</Text>
            </View>
          </View>
        </ScrollView>

        <TouchableOpacity style={[styles.saveBtn, busy && styles.disabled]} disabled={busy || !asset} activeOpacity={0.8} onPress={onSave}>
          <Ionicons name="checkmark-circle-outline" size={17} color="#fff" />
          <Text style={styles.saveTxt}>{isNewAsset ? t('permission.addAssetTitle') : t('permission.saveLimitsLabel')}</Text>
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '86%',
    paddingHorizontal: spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 58 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600', color: colors.text },

  subtitle: { fontSize: 13, color: colors.textSub, marginTop: 2 },
  note: { fontSize: 12, color: colors.textSub, marginTop: 8, lineHeight: 17 },

  field: { marginTop: 16 },
  fieldLabel: { fontSize: 13.5, fontWeight: '600', color: colors.text, marginBottom: 7 },
  assetOptions: { gap: 8 },
  assetOption: { borderRadius: 10, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 10 },
  assetOptionActive: { borderColor: BLUE, backgroundColor: '#F0F6FF' },
  assetOptionTxt: { fontSize: 13.5, color: colors.text },
  assetOptionTxtActive: { color: BLUE, fontWeight: '600' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 14,
  },
  input: { flex: 1, height: 46, fontSize: 15, color: colors.text },
  inputUnit: { fontSize: 13.5, fontWeight: '600', color: colors.textSub },

  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    height: 48,
    borderRadius: 14,
    backgroundColor: BLUE,
    marginTop: 20,
  },
  saveTxt: { color: '#fff', fontSize: 15.5, fontWeight: '700' },

  disabled: { opacity: 0.5 },
});
