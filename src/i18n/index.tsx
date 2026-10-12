// 轻量自制多语言方案——没有引入 i18next 这类库,一是这次只需要"按 key 查字符串 +
// 简单 {{var}} 插值",库提供的复数规则/命名空间懒加载这些功能都用不上,二是这个
// 项目里但凡能自己写清楚的基础设施(vault 加密、权限计算……)都没有为了省事去引
// 第三方库,这里延续同样的风格。所有语言词典都对齐同一份 key 类型(见 locales/zh.ts
// 的注释),漏翻一个 key 编译期就报错。
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';

import zh from './locales/zh';
import en from './locales/en';
import ko from './locales/ko';
import vi from './locales/vi';
import ja from './locales/ja';
import ru from './locales/ru';

export type LocaleId = 'zh' | 'en' | 'ko' | 'vi' | 'ja' | 'ru';
export type TranslationKey = keyof typeof zh;

const DICTS: Record<LocaleId, Record<TranslationKey, string>> = { zh, en, ko, vi, ja, ru };

/** 语言名字始终显示成它自己的文字(简体中文/English/한국어/…),不随当前选的语言变——
 *  参考主流 App 的通用做法,不然用户切到一个自己不认识的语言后,想切回来都得先猜。 */
export const LOCALES: { id: LocaleId; label: string }[] = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
  { id: 'ko', label: '한국어' },
  { id: 'vi', label: 'Tiếng Việt' },
  { id: 'ja', label: '日本語' },
  { id: 'ru', label: 'Русский' },
];

/**
 * 对外(HTTP Accept-Language、注入进 DApp WebView 的 navigator.language)要用的
 * BCP47 标签——我们内部的 LocaleId 是自己起的短 key,不能直接当 BCP47 用。
 * DApp 浏览器靠这个让网页知道"用户当前用的是哪个语言",和真实浏览器
 * 暴露 navigator.language 的行为一致(见 dapp/injected.ts)。
 */
export const BCP47: Record<LocaleId, string> = {
  zh: 'zh-CN',
  en: 'en-US',
  ko: 'ko-KR',
  vi: 'vi-VN',
  ja: 'ja-JP',
  ru: 'ru-RU',
};

const STORAGE_KEY = 'aurora.locale.v1';

/**
 * 新用户(还没在「语言」页里手动选过)首次打开时,按手机系统语言列表(用户在系统
 * 设置里可能排了好几个偏好语言,从前往后找)自动挑一个我们支持的;都不支持就退回
 * 英文,不再固定假设中文——这样一个把手机设成韩语的用户第一次打开就是韩语界面,
 * 而不是先看到中文再自己去「语言」页找。用户一旦在语言页里手动选过一次,那个选择
 * 存进 AsyncStorage 后永远优先于这里的自动检测(见下面 I18nProvider 的 useEffect)。
 */
function detectDeviceLocale(): LocaleId {
  try {
    for (const l of Localization.getLocales()) {
      const code = l.languageCode as LocaleId | null;
      if (code && code in DICTS) return code;
    }
  } catch {
    // 极少数情况下拿不到设备语言列表,退回英文兜底
  }
  return 'en';
}

const DEFAULT_LOCALE: LocaleId = detectDeviceLocale();

function translate(locale: LocaleId, key: TranslationKey, vars?: Record<string, string | number>): string {
  // 缺翻译退回中文基准词典,而不是直接把 key 原样显示出来——界面上不该出现
  // "wallet.send" 这种明显没接好的文本,退回一种能读的语言至少不影响使用。
  let s = DICTS[locale][key] ?? DICTS.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      // split/join 而不是 new RegExp:t() 在渲染路径上被高频调用,
      // 且插值内容来自外部数据,不该走"先转义再编译正则"这条既慢又容易踩
      // 特殊字符的路
      s = s.split(`{{${k}}}`).join(String(v));
    }
  }
  return s;
}

/** 供组件树外的纯业务逻辑(chain/crypto/dapp/passkey 下抛出的 Error 等)使用——
 * 这些代码拿不到 React context,只能退而求其次读这个模块级变量,由 I18nProvider
 * 在语言切换 / 首次从 AsyncStorage 读到已保存语言时同步过来。挂载前短暂地是
 * DEFAULT_LOCALE,不影响正确性,因为这些错误只会在用户实际操作时才抛出,
 * 那时候 Provider 早就挂好并同步过当前语言了。 */
let currentLocale: LocaleId = DEFAULT_LOCALE;
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale, key, vars);
}

type I18nState = {
  locale: LocaleId;
  setLocale: (id: LocaleId) => void;
  /** t('wallet.send') 或者带插值 t('wallet.cacheMinutesAgo', { n: 3 }) */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

const Ctx = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleId>(DEFAULT_LOCALE);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved && saved in DICTS) setLocaleState(saved as LocaleId);
    });
  }, []);

  useEffect(() => {
    currentLocale = locale;
  }, [locale]);

  const setLocale = useCallback((id: LocaleId) => {
    setLocaleState(id);
    AsyncStorage.setItem(STORAGE_KEY, id).catch(() => {});
  }, []);

  const tFn = useCallback((key: TranslationKey, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t: tFn }), [locale, setLocale, tFn]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return v;
}
