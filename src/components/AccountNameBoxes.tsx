import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable } from 'react-native';

import { colors } from '../theme';

/**
 * TP 风格的账户名输入:12 个等宽小方格,每格一个字符,而不是一条普通输入框。
 *
 * 实现方式是"一个真输入框 + 一排假格子":真正的 TextInput 铺满整个区域但完全
 * 透明(opacity 0),负责接管键盘、选区、系统输入法;下面那排格子只是照着
 * value 把字符画出来。这样不用去处理多个输入框之间的焦点转移/退格回跳,
 * 中文输入法、粘贴、长按选择这些系统行为也都还是原生的。
 */
const LEN = 12;

export default function AccountNameBoxes({
  value,
  onChangeText,
  onBlur,
}: {
  value: string;
  onChangeText: (v: string) => void;
  onBlur?: () => void;
}) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const chars = value.split('');

  return (
    <Pressable style={styles.wrap} onPress={() => inputRef.current?.focus()}>
      {Array.from({ length: LEN }).map((_, i) => {
        // 光标位置:已填满时停在最后一格上,否则停在下一个待填的格子
        const isCursor = focused && (i === chars.length || (chars.length === LEN && i === LEN - 1));
        return (
          <View key={i} style={[styles.box, isCursor && styles.boxActive]}>
            <Text style={styles.boxTxt}>{chars[i] ?? ''}</Text>
          </View>
        );
      })}

      <TextInput
        ref={inputRef}
        value={value}
        // 只放行账户名允许的字符,直接在输入层过滤,免得用户打了非法字符
        // 才在下面看到一行红字(a-z1-5,见 chain/account.ts 的说明)
        onChangeText={(v) => onChangeText(v.toLowerCase().replace(/[^a-z1-5.]/g, '').slice(0, LEN))}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        style={styles.hiddenInput}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        keyboardType="visible-password"
        maxLength={LEN}
        caretHidden
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 10,
    gap: 4,
  },
  box: {
    flex: 1,
    aspectRatio: 0.82,
    borderRadius: 5,
    backgroundColor: '#F2F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxActive: { backgroundColor: '#E3EDFB' },
  boxTxt: { fontSize: 16, color: colors.text, fontWeight: '600' },

  // 透明的真输入框,盖住整排格子接管键盘
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
    color: 'transparent',
  },
});
