import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { T, text } from '../theme';

export function Button({ title, onPress, variant = 'primary', disabled, busy, style }) {
  const tone = s[variant] || s.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        s.btn, tone,
        (disabled || busy) && s.disabled,
        pressed && s.pressed,
        style,
      ]}
    >
      {busy
        ? <ActivityIndicator color={variant === 'primary' ? '#fff' : T.green800} />
        : <Text style={[s.btnText, variant !== 'primary' && s.btnTextDark]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, error, ...props }) {
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <Text style={[text.label, { marginBottom: 5 }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={T.muted}
        {...props}
        style={[s.input, error && { borderColor: T.red }, props.multiline && s.multiline, props.style]}
      />
      {error ? <Text style={s.err}>{error}</Text> : null}
      {hint && !error ? <Text style={[text.hint, { marginTop: 4 }]}>{hint}</Text> : null}
    </View>
  );
}

export function Card({ children, style }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Banner({ tone = 'info', children }) {
  const map = {
    info: { bg: T.leafSoft, fg: T.green700 },
    warn: { bg: T.amberSoft, fg: T.amber },
    error: { bg: T.redSoft, fg: T.red },
  };
  const c = map[tone] || map.info;
  return (
    <View style={[s.banner, { backgroundColor: c.bg }]}>
      <Text style={{ color: c.fg, fontSize: 13.5, lineHeight: 19 }}>{children}</Text>
    </View>
  );
}

export function Chip({ label, selected, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={[s.chip, selected && { backgroundColor: T.green800, borderColor: T.green800 }]}
    >
      <Text style={[s.chipText, selected && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

export function Stat({ label, value, tone }) {
  return (
    <View style={[s.stat, tone === 'warn' && { backgroundColor: T.amberSoft, borderColor: '#f0dfbc' }]}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: T.radius,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
    minHeight: 52,
  },
  primary: { backgroundColor: T.green800 },
  secondary: { backgroundColor: T.white, borderColor: T.line },
  ghost: { backgroundColor: 'transparent', borderColor: T.line },
  danger: { backgroundColor: T.red },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.82 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnTextDark: { color: T.green800 },

  input: {
    backgroundColor: T.white,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: T.radiusSm,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontSize: 16,
    color: T.ink,
  },
  multiline: { minHeight: 86, textAlignVertical: 'top' },
  err: { color: T.red, fontSize: 12.5, marginTop: 4 },

  card: {
    backgroundColor: T.white,
    borderRadius: T.radius,
    borderWidth: 1,
    borderColor: T.line,
    padding: 16,
    marginBottom: 14,
  },

  banner: { borderRadius: T.radiusSm, padding: 12, marginBottom: 14 },

  chip: {
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.line,
    backgroundColor: T.white,
    marginRight: 8,
    marginBottom: 8,
  },
  chipText: { fontSize: 13.5, color: T.inkSoft, fontWeight: '600' },

  stat: {
    flex: 1,
    backgroundColor: T.white,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: T.radius,
    padding: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 27, fontWeight: '700', color: T.green800 },
  statLabel: { fontSize: 11, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2, fontWeight: '700' },
});
