import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { tokenIconOf } from '../chain/tokenIcons';

type Props = {
  symbol: string;
  color: string;
  size?: number;
  chainColor?: string; // 右下角小链标
  /** 有本地图标(见 tokenIcons.ts)就显示真实 logo,没有就退回字母头像 */
  contract?: string;
};

export default function TokenBadge({ symbol, color, size = 42, chainColor, contract }: Props) {
  const icon = tokenIconOf(contract, symbol);

  return (
    <View style={{ width: size, height: size }}>
      {icon ? (
        <Image
          source={icon}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          resizeMode="cover"
        />
      ) : (
        <View
          style={[
            styles.badge,
            { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
          ]}
        >
          <Text style={[styles.letter, { fontSize: size * 0.42 }]} numberOfLines={1}>
            {symbol.slice(0, 3)}
          </Text>
        </View>
      )}
      {chainColor ? (
        <View
          style={[
            styles.chainDot,
            {
              width: size * 0.34,
              height: size * 0.34,
              borderRadius: size * 0.17,
              backgroundColor: chainColor,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  letter: {
    color: '#fff',
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  chainDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    borderWidth: 2,
    borderColor: '#fff',
  },
});
