import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import CenterDialog from './CenterDialog';
import { colors, spacing } from '../theme';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

/**
 * 打开外部 DApp 前的风险提示弹层 —— 对齐 TokenPocket 的 "Redirect Prompt":
 * 首次(或未勾选「不再提示」时每次)跳转到内置浏览器前,让用户看清目标域名。
 */
export default function DappRiskSheet({
  visible,
  url,
  onCancel,
  onContinue,
}: {
  visible: boolean;
  url: string;
  onCancel: () => void;
  onContinue: (dontShowAgain: boolean) => void;
}) {
  const [dontShow, setDontShow] = useState(false);
  const { t } = useI18n();

  return (
    <CenterDialog visible={visible} onClose={onCancel} padding={spacing.xl}>
      <View style={styles.card}>
        <Text style={styles.title}>{t('dappRisk.title')}</Text>

        <View style={styles.urlBox}>
          <Ionicons name="link-outline" size={15} color={colors.textSub} />
          <Text style={styles.urlTxt} numberOfLines={1}>
            {url}
          </Text>
        </View>

        <Text style={styles.desc}>{t('dappRisk.desc')}</Text>

        <TouchableOpacity style={styles.checkRow} activeOpacity={0.6} onPress={() => setDontShow((v) => !v)}>
          <Ionicons
            name={dontShow ? 'checkbox' : 'square-outline'}
            size={20}
            color={dontShow ? BLUE : colors.textFaint}
          />
          <Text style={styles.checkTxt}>{t('dappRisk.dontShowAgain')}</Text>
        </TouchableOpacity>

        <View style={styles.btnRow}>
          <TouchableOpacity style={[styles.btn, styles.btnGhost]} activeOpacity={0.7} onPress={onCancel}>
            <Text style={styles.btnGhostTxt}>{t('dappRisk.cancel')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary]}
            activeOpacity={0.85}
            onPress={() => onContinue(dontShow)}
          >
            <Text style={styles.btnPrimaryTxt}>{t('dappRisk.continue')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </CenterDialog>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderRadius: 14, padding: 20, width: '100%', gap: 12 },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, textAlign: 'center' },

  urlBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  urlTxt: { flex: 1, fontSize: 13.5, color: colors.text },

  desc: { fontSize: 12.5, color: colors.textSub, lineHeight: 19 },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkTxt: { fontSize: 13.5, color: colors.text },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn: { flex: 1, height: 46, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: '#F2F3F5' },
  btnGhostTxt: { fontSize: 15.5, color: colors.text },
  btnPrimary: { backgroundColor: BLUE },
  btnPrimaryTxt: { fontSize: 15.5, color: '#fff', fontWeight: '600' },
});
