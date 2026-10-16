// 发现新版本时弹的更新面板:版本说明 → 下载(带进度、可取消)→ 交给系统安装器。
//
// 下载完会自动拉起一次安装器。第一次更新时系统会先让用户去设置里允许本 App
// 安装应用,允许完回来安装器不会自己再出现,所以下载完之后「安装」按钮一直在,
// 用户点一下就能重新拉起,不用重新下载。
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import { useI18n } from '../i18n';
import { AppRelease, AppUpdateError, canSelfUpdate, downloadRelease, installRelease } from '../update/appUpdate';

const BLUE = '#1E88FF';

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'ready'; fileUri: string };

export default function AppUpdateSheet({
  release,
  onClose,
}: {
  release: AppRelease | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const busy = useRef(false);
  const installing = useRef(false);

  // 换了一个版本(或者重新打开)就从头开始
  useEffect(() => {
    setPhase({ kind: 'idle' });
    setErr(null);
  }, [release?.versionCode]);

  // 面板被卸载时还在下载,把下载停掉,别在后台白跑流量
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abortRef.current?.abort(); };
  }, []);

  const forced = !!release?.forceUpdate;
  const downloading = phase.kind === 'downloading';
  // 强制更新不给关;下载中也不给点背景关掉,避免误触把进度丢了——要停就点「取消下载」
  const closable = !forced && !downloading;

  const install = async (fileUri: string) => {
    if (!alive.current || installing.current) return;
    installing.current = true;
    setErr(null);
    try {
      await installRelease(fileUri);
    } catch {
      if (alive.current) setErr(t('update.installFailed'));
    } finally { installing.current = false; }
  };

  const start = async () => {
    if (!release || busy.current) return;
    busy.current = true;
    setErr(null);
    if (!canSelfUpdate) {
      try { await Linking.openURL(release.apkUrl); }
      catch { if (alive.current) setErr(t('update.openFailed')); }
      finally { busy.current = false; }
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'downloading', fraction: 0 });
    try {
      const fileUri = await downloadRelease(release, fraction => {
        if (alive.current && !controller.signal.aborted) setPhase({ kind: 'downloading', fraction });
      }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setPhase({ kind: 'ready', fileUri });
      await install(fileUri);
    } catch (e: any) {
      if (!alive.current) return;
      setPhase({ kind: 'idle' });
      // 用户自己点了取消,不算出错
      if (e?.name !== 'AbortError') {
        setErr(e instanceof AppUpdateError && e.code === 'download' ? t('update.downloadFailed') : String(e?.message ?? e));
      }
    } finally {
      abortRef.current = null;
      busy.current = false;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const percent = phase.kind === 'downloading' && phase.fraction >= 0 ? Math.floor(phase.fraction * 100) : null;

  return (
    <BottomSheet visible={release !== null} onClose={closable ? onClose : () => {}} closeOnBackdrop={closable} priority={forced ? 100 : 0}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{t('update.title')}</Text>
          {closable ? (
            <TouchableOpacity hitSlop={8} onPress={onClose} style={{ width: 30, alignItems: 'flex-end' }}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: 30 }} />
          )}
        </View>

        {release ? (
          <>
            <View style={styles.versionRow}>
              <View style={styles.versionChip}>
                <Text style={styles.versionChipTxt}>v{release.versionName}</Text>
              </View>
              {release.title ? <Text style={styles.releaseTitle}>{release.title}</Text> : null}
            </View>

            {release.releaseNotes ? (
              <ScrollView style={styles.notesBox} contentContainerStyle={{ padding: 14 }}>
                <Text selectable style={styles.notes}>{release.releaseNotes}</Text>
              </ScrollView>
            ) : null}

            {downloading ? (
              <View style={styles.progressWrap}>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${percent ?? 100}%`, opacity: percent === null ? 0.35 : 1 }]} />
                </View>
                <Text style={styles.progressTxt}>
                  {percent === null ? t('update.downloadingUnknown') : t('update.downloading', { percent })}
                </Text>
              </View>
            ) : null}

            {forced ? <Text style={styles.hint}>{t('update.requiredHint')}</Text> : null}
            {!canSelfUpdate ? <Text style={styles.hint}>{t('update.iosInstallHint')}</Text> : null}
            {phase.kind === 'ready' ? <Text style={styles.hint}>{t('update.installHint')}</Text> : null}

            {err ? (
              <View style={styles.errBox}>
                <Ionicons name="alert-circle-outline" size={16} color="#F0644E" />
                <Text style={styles.errTxt}>{err}</Text>
              </View>
            ) : null}

            <View style={styles.actions}>
              {downloading ? (
                <TouchableOpacity style={styles.secondaryBtn} onPress={cancel}>
                  <Text style={styles.secondaryTxt}>{t('update.cancelDownload')}</Text>
                </TouchableOpacity>
              ) : !forced && phase.kind === 'idle' ? (
                <TouchableOpacity style={styles.secondaryBtn} onPress={onClose}>
                  <Text style={styles.secondaryTxt}>{t('update.later')}</Text>
                </TouchableOpacity>
              ) : null}

              {phase.kind === 'ready' ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={() => install(phase.fileUri)}>
                  <Text style={styles.primaryTxt}>{t('update.install')}</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.primaryBtn, downloading && styles.primaryBtnOff]}
                  disabled={downloading}
                  onPress={start}
                >
                  <Text style={styles.primaryTxt}>{t('update.updateNow')}</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        ) : null}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: spacing.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 58 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600', color: colors.text },

  versionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  versionChip: { backgroundColor: '#EAF1FF', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  versionChipTxt: { color: BLUE, fontSize: 13, fontWeight: '700' },
  releaseTitle: { flex: 1, fontSize: 15.5, fontWeight: '600', color: colors.text },

  notesBox: { maxHeight: 220, backgroundColor: '#F7F8FA', borderRadius: 10 },
  notes: { fontSize: 14, color: colors.text, lineHeight: 21 },

  progressWrap: { marginTop: 16, gap: 8 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: '#E9EDF3', overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: BLUE },
  progressTxt: { fontSize: 13, color: colors.textSub, textAlign: 'center' },

  hint: { marginTop: 14, fontSize: 12.5, color: colors.textSub, lineHeight: 18 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginTop: 12 },
  errTxt: { flex: 1, fontSize: 13, color: '#F0644E', lineHeight: 19 },

  actions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  secondaryBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#F2F3F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryTxt: { fontSize: 15.5, fontWeight: '600', color: colors.text },
  primaryBtn: { flex: 1, height: 48, borderRadius: 24, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center' },
  primaryBtnOff: { backgroundColor: '#A9C9F5' },
  primaryTxt: { fontSize: 15.5, fontWeight: '600', color: '#fff' },
});
