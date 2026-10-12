import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Image, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { colors, spacing, BRAND_NAME } from '../theme';
import { useWalletSession } from '../chain/WalletContext';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const onboardingHero = require('../../assets/illustrations/onboarding-wallet.png');

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<Nav>();
  const w = useWalletSession();
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);

  const goHaveAccount = () => nav.navigate('Import');

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top }]}
      contentContainerStyle={{ flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.hero}>
        <Image source={onboardingHero} style={styles.heroImage} resizeMode="contain" />
      </View>

      <Text style={styles.title}>{t('onboarding.title', { brand: BRAND_NAME })}</Text>
      <Text style={styles.subtitle}>{t('onboarding.subtitle')}</Text>

      {w.walletsReadError ? (
        <View style={styles.warnBox}>
          <Ionicons name="warning-outline" size={16} color="#B45309" />
          <View style={{ flex: 1 }}>
            <Text style={styles.warnTxt}>{t('onboarding.readErrorText')}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              activeOpacity={0.7}
              disabled={retrying}
              onPress={async () => {
                setRetrying(true);
                await w.reloadWallets();
                setRetrying(false);
              }}
            >
              {retrying ? (
                <ActivityIndicator size="small" color="#B45309" />
              ) : (
                <>
                  <Ionicons name="refresh" size={14} color="#B45309" />
                  <Text style={styles.retryTxt}>{t('onboarding.retry')}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <View style={{ flex: 1 }} />

      <View style={styles.cards}>
        <TouchableOpacity style={styles.card} activeOpacity={0.7} onPress={goHaveAccount}>
          <View style={[styles.cardIcon, { backgroundColor: '#EAF1FF' }]}>
            <MaterialCommunityIcons name="wallet-outline" size={22} color="#2E7DF7" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{t('onboarding.haveAccount')}</Text>
            <Text style={styles.cardDesc}>{t('onboarding.haveAccountDesc')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={19} color={colors.textFaint} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} activeOpacity={0.7} onPress={() => nav.navigate('CreateWalletMethod')}>
          <View style={[styles.cardIcon, { backgroundColor: '#EAF1FF' }]}>
            <Ionicons name="add-circle-outline" size={22} color="#2E7DF7" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{t('onboarding.noAccount')}</Text>
            <Text style={styles.cardDesc}>{t('onboarding.noAccountDesc')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={19} color={colors.textFaint} />
        </TouchableOpacity>
      </View>

      <Text style={[styles.footNote, { paddingBottom: insets.bottom + 14 }]}>{t('onboarding.footNote')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  hero: { height: 278, alignItems: 'center', justifyContent: 'center' },
  heroImage: { width: 238, height: 278 },

  title: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 8 },
  subtitle: {
    fontSize: 13.5,
    color: colors.textSub,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 10,
    paddingHorizontal: spacing.xxl,
  },

  warnBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 12,
    marginHorizontal: spacing.lg,
    marginTop: 14,
  },
  warnTxt: { fontSize: 12.5, color: '#7C4A03', lineHeight: 18 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#B45309',
  },
  retryTxt: { fontSize: 12, color: '#B45309', fontWeight: '600' },

  cards: { paddingHorizontal: spacing.lg, gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
  },
  cardIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  cardDesc: { fontSize: 12.5, color: colors.textFaint, marginTop: 3 },

  footNote: { fontSize: 11.5, color: colors.textFaint, textAlign: 'center', marginTop: 18 },
});
