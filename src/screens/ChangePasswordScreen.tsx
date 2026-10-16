import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation, usePreventRemove } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import PageHeader from '../components/PageHeader';
import { addBackHandler } from '../components/ModalHost';
import { changeMasterPassword, WrongPasswordError } from '../crypto/vault';
import { colors, spacing } from '../theme';
import { useI18n } from '../i18n';
import { sensitiveInputProps } from '../components/sensitiveInputProps';

export default function ChangePasswordScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [passwords, setPasswords] = useState(['', '', '']);
  const [visible, setVisible] = useState([false, false, false]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const ready = passwords[0].length > 0 && passwords[1].length >= 8 &&
    passwords[1] === passwords[2] && passwords[0] !== passwords[1];
  usePreventRemove(busy, () => {});

  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') { setPasswords(['', '', '']); setVisible([false, false, false]); }
    });
    return () => { mounted.current = false; sub.remove(); };
  }, []);
  useFocusEffect(useCallback(() => {
    const sub = addBackHandler(() => pending.current);
    return () => { sub.remove(); setPasswords(['', '', '']); setVisible([false, false, false]); };
  }, []));

  const confirm = async () => {
    if (!ready || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await changeMasterPassword(passwords[0], passwords[1]);
      if (!mounted.current) return;
      setPasswords(['', '', '']);
      setVisible([false, false, false]);
      Alert.alert(t('changePwd.doneTitle'), t('changePwd.doneBody'), [
        { text: t('send.done'), onPress: () => { if (mounted.current) nav.goBack(); } },
      ]);
    } catch (err: any) {
      if (mounted.current) setError(err instanceof WrongPasswordError ? t('security.passwordWrong') : err?.message ?? t('changePwd.failed'));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const labels = [t('changePwd.current'), t('changePwd.new'), t('changePwd.confirmNew')];
  const placeholders = [t('changePwd.oldPlaceholder'), t('masterPwdCard.minLength'), t('changePwd.confirmPlaceholder')];
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <PageHeader title={t('security.changePassword')} onBack={() => { if (!pending.current) nav.goBack(); }} />
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {passwords.map((value, index) => (
          <View key={index} style={styles.field}>
            <Text style={styles.label}>{labels[index]}</Text>
            <View style={styles.inputRow}>
              <TextInput testID={`change-password-${index}`} accessibilityLabel={labels[index]}
                style={styles.input} value={value} editable={!busy} placeholder={placeholders[index]}
                placeholderTextColor={colors.textFaint} secureTextEntry={!visible[index]}
                {...sensitiveInputProps}
                onChangeText={text => { setPasswords(current => current.map((entry, i) => i === index ? text : entry)); setError(null); }} />
              <TouchableOpacity disabled={busy} accessibilityRole="button"
                accessibilityLabel={t(visible[index] ? 'changePwd.hidePassword' : 'changePwd.showPassword')}
                style={styles.eye} onPress={() => setVisible(current => current.map((entry, i) => i === index ? !entry : entry))}>
                <Ionicons name={visible[index] ? 'eye-outline' : 'eye-off-outline'} size={21} color={colors.textFaint} />
              </TouchableOpacity>
            </View>
          </View>
        ))}
        {passwords[2] && passwords[1] !== passwords[2] ? <Text style={styles.error}>{t('masterPwdCard.mismatch')}</Text> : null}
        {passwords[1] && passwords[0] === passwords[1] ? <Text style={styles.error}>{t('changePwd.invalidNew')}</Text> : null}
        {error ? <Text style={styles.error} selectable>{error}</Text> : null}
        <View style={styles.footer}>
          {busy ? <Text style={styles.progress}>{t('changePwd.saving')}</Text> : null}
          <TouchableOpacity testID="change-password-confirm" style={[styles.submit, (!ready || busy) && styles.submitOff]}
            disabled={!ready || busy} onPress={confirm} activeOpacity={0.85}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{t('send.confirm')}</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },
  content: { flexGrow: 1, padding: spacing.lg, paddingTop: 28 },
  field: { gap: 14, marginBottom: 26 },
  label: { fontSize: 15.5, fontWeight: '500', color: colors.text },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white, borderRadius: 10, minHeight: 54 },
  input: { flex: 1, paddingHorizontal: 14, paddingVertical: 16, fontSize: 16, color: colors.text, outlineStyle: 'none' as any },
  eye: { padding: 16 },
  error: { fontSize: 13, lineHeight: 19, color: colors.red, marginBottom: 12 },
  footer: { marginTop: 'auto', paddingTop: 28 },
  progress: { fontSize: 13, color: colors.textSub, textAlign: 'center', marginBottom: 12 },
  submit: { minHeight: 50, borderRadius: 12, backgroundColor: '#1E88FF', alignItems: 'center', justifyContent: 'center' },
  submitOff: { backgroundColor: '#ABCDF9' },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
