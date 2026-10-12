import { useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { fmtTime } from '../chain/format';
import { useMessages } from '../chain/MessagesContext';
import { MessageItem } from '../chain/messages';
import { useI18n } from '../i18n';
import { useOpenDapp } from '../dapp/useOpenDapp';
import DappRiskSheet from '../components/DappRiskSheet';
import { useFocusedAppContent } from '../content/useFocusedAppContent';

const BLUE = '#1E88FF';

export default function MessageCenterScreen() {
  useFocusedAppContent();
  const insets = useSafeAreaInsets();
  const { messages, markAllRead } = useMessages();
  const { t } = useI18n();
  const { open, pending, cancel, confirm } = useOpenDapp();

  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  return (
    <View style={styles.root}>
      <PageHeader title={t('messageCenter.title')} />

      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.center}>
            <MaterialCommunityIcons name="bell-outline" size={52} color="#D6D9E0" />
            <Text style={styles.emptyTxt}>{t('messageCenter.empty')}</Text>
          </View>
        }
        renderItem={({ item }: { item: MessageItem }) => {
          const isTransfer = item.kind === 'transfer';
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              disabled={!item.url}
              onPress={() => item.url && open(item.url)}
            >
              <View style={[styles.icon, { backgroundColor: isTransfer ? '#E8F7EF' : '#E7F0FF' }]}>
                <MaterialCommunityIcons
                  name={isTransfer ? 'arrow-bottom-left' : 'bullhorn-outline'}
                  size={20}
                  color={isTransfer ? '#12A566' : BLUE}
                />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.body}>{item.body}</Text>
                <Text style={styles.time}>{fmtTime(new Date(item.time).toISOString())}</Text>
              </View>
              {item.url ? <MaterialCommunityIcons name="open-in-new" size={18} color={BLUE} style={{ marginLeft: 10 }} /> : null}
            </TouchableOpacity>
          );
        }}
      />
      <DappRiskSheet visible={pending !== null} url={pending ?? ''} onCancel={cancel} onContinue={confirm} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  row: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: 14 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15.5, fontWeight: '500', color: colors.text },
  body: { fontSize: 13, color: colors.textSub, marginTop: 3, lineHeight: 19 },
  time: { fontSize: 12, color: colors.textFaint, marginTop: 5 },

  center: { alignItems: 'center', paddingVertical: 80, gap: 12 },
  emptyTxt: { fontSize: 15, color: colors.text },
});
