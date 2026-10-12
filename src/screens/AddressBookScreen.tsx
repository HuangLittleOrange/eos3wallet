import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import BottomSheet from '../components/BottomSheet';
import PageHeader from '../components/PageHeader';
import { useWalletSession } from '../chain/WalletContext';
import { accountNameError, isValidAccountName } from '../chain/account';
import { Contact, listContacts, removeContact, saveContact } from '../chain/addressBook';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';
const emptyAddressBook = require('../../assets/illustrations/empty-address-book.png');

export default function AddressBookScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, 'AddressBook'>>();
  const w = useWalletSession();
  const { t } = useI18n();

  /** 从转账页进来选联系人时为 true */
  const picking = route.params?.picking ?? false;

  const [list, setList] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);

  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setList(await listContacts(w.chainId));
    setLoading(false);
  }, [w.chainId]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setName('');
    setAccount('');
    setMemo('');
    setErr(null);
    setAdding(true);
  };

  const openEdit = (c: Contact) => {
    setEditing(c);
    setName(c.name);
    setAccount(c.account);
    setMemo(c.memo);
    setErr(null);
    setAdding(true);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await saveContact({
        id: editing?.id,
        name,
        account,
        memo,
        chainId: w.chainId,
      });
      setAdding(false);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? t('addressBook.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = (c: Contact) =>
    Alert.alert(t('addressBook.removeTitle'), t('addressBook.removeBody', { name: c.name }), [
      { text: t('addressBook.cancel'), style: 'cancel' },
      {
        text: t('addressBook.delete'),
        style: 'destructive',
        onPress: async () => {
          await removeContact(c.id);
          await load();
        },
      },
    ]);

  const pick = (c: Contact) => {
    nav.navigate('Send', { scanned: { account: c.account, memo: c.memo } });
  };

  const nameErr = account.length > 0 ? accountNameError(account) : null;
  const canSave = !!name.trim() && isValidAccountName(account) && !busy;

  return (
    <View style={styles.root}>
      <PageHeader
        title={t('addressBook.title')}
        right={
          <TouchableOpacity hitSlop={8} onPress={openAdd}>
            <Ionicons name="add" size={26} color={colors.text} />
          </TouchableOpacity>
        }
      />

      <FlatList
        data={list}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Text style={styles.hint}>
            {t('addressBook.currentNetwork', { name: w.client.config.name })}
            {picking ? t('addressBook.pickHint') : ''}
          </Text>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={BLUE} />
            </View>
          ) : (
            <View style={styles.center}>
              <Image source={emptyAddressBook} style={styles.emptyImage} resizeMode="contain" />
              <Text style={styles.emptyTxt}>{t('addressBook.empty')}</Text>
              <Text style={styles.emptySub}>{t('addressBook.emptySub')}</Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={openAdd} activeOpacity={0.85}>
                <Text style={styles.emptyBtnTxt}>{t('addressBook.addFirst')}</Text>
              </TouchableOpacity>
            </View>
          )
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.6}
              onPress={() => (picking ? pick(item) : openEdit(item))}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarTxt}>{item.name.slice(0, 1)}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.acct}>{item.account}</Text>
                {item.memo ? (
                  <View style={styles.memoTag}>
                    <Ionicons name="pricetag-outline" size={11} color="#B45309" />
                    <Text style={styles.memoTxt} numberOfLines={1}>
                      Memo {item.memo}
                    </Text>
                  </View>
                ) : null}
              </View>
              {picking ? (
                <Ionicons name="chevron-forward" size={19} color={colors.textFaint} />
              ) : (
                <TouchableOpacity onPress={() => confirmRemove(item)} hitSlop={10}>
                  <Ionicons name="trash-outline" size={19} color={colors.textFaint} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          </View>
        )}
      />

      {/* 新增 / 编辑 */}
      <BottomSheet visible={adding} onClose={() => setAdding(false)} closeOnBackdrop={!busy}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHead}>
            <View style={{ width: 30 }} />
            <Text style={styles.sheetTitle}>{editing ? t('addressBook.editContact') : t('addressBook.addContact')}</Text>
            <TouchableOpacity hitSlop={8} onPress={() => setAdding(false)} disabled={busy} style={{ width: 30, alignItems: 'flex-end' }}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t('addressBook.nameLabel')}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('addressBook.namePlaceholder')}
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              editable={!busy}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t('addressBook.accountLabel')}</Text>
            <TextInput
              value={account}
              onChangeText={(v) => setAccount(v.toLowerCase())}
              placeholder={t('addressBook.accountPlaceholder')}
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              autoCapitalize="none"
              maxLength={12}
              editable={!busy}
            />
            {nameErr ? <Text style={styles.fieldErr}>{nameErr}</Text> : null}
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t('addressBook.memoLabel')}</Text>
            <TextInput
              value={memo}
              onChangeText={setMemo}
              placeholder={t('addressBook.memoPlaceholder')}
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              autoCapitalize="none"
              editable={!busy}
            />
            <Text style={styles.fieldHint}>{t('addressBook.memoHint')}</Text>
          </View>

          {err ? (
            <View style={styles.errBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#F0644E" />
              <Text style={styles.errTxt}>{err}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.saveBtn, !canSave && styles.saveOff]}
            disabled={!canSave}
            onPress={submit}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveTxt}>{t('addressBook.save')}</Text>}
          </TouchableOpacity>
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },
  scroll: { padding: spacing.md, paddingBottom: 30 },
  hint: { fontSize: 12.5, color: colors.textFaint, marginBottom: 10, marginLeft: 4 },

  card: { backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 16, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#E7EBF2', alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 17, fontWeight: '700', color: colors.textSub },
  name: { fontSize: 16, color: colors.text, fontWeight: '500' },
  acct: { fontSize: 13, color: colors.textSub, marginTop: 3 },
  memoTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    backgroundColor: '#FEF3C7',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 5,
  },
  memoTxt: { fontSize: 11, color: '#B45309' },

  center: { alignItems: 'center', paddingVertical: 52, gap: 12, paddingHorizontal: 30 },
  emptyImage: { width: 132, height: 96 },
  emptyTxt: { fontSize: 16, color: colors.text, fontWeight: '600' },
  emptySub: { fontSize: 13, color: colors.textSub, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { backgroundColor: BLUE, borderRadius: 24, paddingHorizontal: 28, height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  emptyBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '600' },

  sheet: {
    backgroundColor: '#F2F3F5',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: spacing.md,
    maxHeight: '88%',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', height: 56 },
  sheetTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },

  field: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 10 },
  fieldLabel: { fontSize: 13.5, color: colors.textSub, marginBottom: 10 },
  input: { fontSize: 16, color: colors.text, padding: 0, outlineStyle: 'none' as any },
  fieldErr: { fontSize: 12.5, color: '#F0644E', marginTop: 10 },
  fieldHint: { fontSize: 12, color: colors.textFaint, marginTop: 10, lineHeight: 18 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginBottom: 10 },
  errTxt: { flex: 1, fontSize: 13, color: '#F0644E' },

  saveBtn: { height: 52, borderRadius: 26, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  saveOff: { backgroundColor: '#A9C9F5' },
  saveTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
