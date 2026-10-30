import React, { useMemo } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import { ArrowRight, ChevronRight, RotateCw } from 'lucide-react-native';
import { font, radius, spacing, type Palette } from '../theme';
import { usePalette } from './theme-context';
import type { LoadState } from '../hooks/useLoad';

export function Page({ children, refresh, busy, scroll = true }: {
  children: React.ReactNode; refresh?: () => void; busy?: boolean; scroll?: boolean;
}) {
  const palette = usePalette();
  const styles = useStyles();
  const content = <View style={styles.page}>{children}</View>;
  if (!scroll) return <View style={{ flex: 1 }}>{content}</View>;
  // Forms (quizzes, posts, responses) stay reachable above the keyboard, which a drag puts away.
  return <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
    automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive"
    contentContainerStyle={{ paddingBottom: 48 }} accessibilityLabel="Page content">
    {refresh && <Pressable accessibilityRole="button" accessibilityLabel="Refresh page"
      disabled={busy} onPress={refresh} style={styles.refresh}>
      <RotateCw size={17} color={palette.primary}/><Text style={styles.smallBlue}>Refresh</Text>
    </Pressable>}
    {content}
  </ScrollView>;
}
const MARK = require('../../assets/mark.png') as number;

/** The EducateOS mark (the app icon's glyph), tinted to `color`. */
export function Mark({ size, color }: { size: number; color: string }) {
  return <Image source={MARK} accessibilityIgnoresInvertColors
    style={{ width: size, height: size, tintColor: color }} resizeMode="contain"/>;
}
export function Eyebrow({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.eyebrow}>{children}</Text>;
}
export function Title({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  const styles = useStyles();
  return <View style={{ gap: 7, marginBottom: spacing.xl }}>
    <Text accessibilityRole="header" style={styles.title}>{children}</Text>
    {subtitle && <Text style={styles.muted}>{subtitle}</Text>}
  </View>;
}
export function Section({ title, children, trailing }: { title: string; children: React.ReactNode; trailing?: React.ReactNode }) {
  const styles = useStyles();
  return <View style={{ marginBottom: 25 }}>
    <View style={styles.sectionTitle}><Text accessibilityRole="header" style={styles.sectionHeading}>{title}</Text>{trailing}</View>
    {children}
  </View>;
}
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}
export function TextBody({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  const styles = useStyles();
  return <Text style={muted ? styles.muted : styles.body}>{children}</Text>;
}
export function Chip({ label, tone = 'blue' }: { label: string; tone?: 'blue' | 'green' | 'amber' | 'neutral' | 'red' }) {
  const palette = usePalette();
  const colors = tone === 'green' ? [palette.tealSoft, palette.teal] :
    tone === 'amber' ? [palette.amberSoft, palette.amber] :
    tone === 'red' ? [palette.redSoft, palette.red] :
    tone === 'neutral' ? [palette.background, palette.muted] : [palette.primarySoft, palette.primary];
  return <View style={{ alignSelf: 'flex-start', backgroundColor: colors[0], paddingHorizontal: 10, paddingVertical: 5, borderRadius: 40 }}>
    <Text style={{ color: colors[1], fontWeight: '700', fontSize: 11 }}>{label}</Text>
  </View>;
}
export function Button({ label, onPress, variant = 'primary', disabled = false, icon }: {
  label: string; onPress: () => void; variant?: 'primary' | 'outline' | 'quiet' | 'danger';
  disabled?: boolean; icon?: React.ReactNode;
}) {
  const palette = usePalette();
  const styles = useStyles();
  const fg = variant === 'primary' ? palette.onPrimary : variant === 'danger' ? palette.red : palette.primary;
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} style={({ pressed }) => [
      styles.button, { backgroundColor: variant === 'primary' ? palette.primary : variant === 'danger' ? palette.redSoft :
        variant === 'outline' ? palette.raised : 'transparent',
      borderWidth: variant === 'outline' ? 1 : 0, borderColor: palette.line, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
    ]}>
    {icon}<Text style={{ fontSize: font.body, fontWeight: '700', color: fg }}>{label}</Text>
    {variant === 'primary' && <ArrowRight size={16} color={palette.onPrimary}/>}
  </Pressable>;
}
/** A row of mutually exclusive choices, such as a class's Assignments · Grades · Roster. */
export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (value: T) => void;
}) {
  const palette = usePalette();
  return <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: palette.background, borderRadius: 14,
    borderWidth: 1, borderColor: palette.line, padding: 4, gap: 4 }}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={option.label}
        onPress={() => onChange(option.value)} style={{ flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center',
          backgroundColor: selected ? palette.raised : 'transparent' }}>
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: selected ? '800' : '600', color: selected ? palette.primary : palette.muted }}>
          {option.label}</Text>
      </Pressable>;
    })}
  </View>;
}
export function Field({ label, value, onChangeText, placeholder, multiline = false,
  keyboardType = 'default', secureTextEntry = false }: {
  label: string; value: string; onChangeText: (s: string) => void; placeholder?: string; multiline?: boolean;
  keyboardType?: 'default' | 'url' | 'numeric' | 'email-address'; secureTextEntry?: boolean;
}) {
  const palette = usePalette();
  const styles = useStyles();
  return <View style={{ gap: 7 }}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder}
      autoCapitalize="none" autoCorrect={false} multiline={multiline} keyboardType={keyboardType}
      secureTextEntry={secureTextEntry} selectionColor={palette.primary} placeholderTextColor={palette.subtle}
      style={[styles.field, multiline && { minHeight: 110, textAlignVertical: 'top' }]}
      accessibilityLabel={label}/>
  </View>;
}
export function Item({ title, detail, onPress, leading, trailing }: {
  title: string; detail?: string; onPress?: () => void; leading?: React.ReactNode; trailing?: React.ReactNode;
}) {
  const palette = usePalette();
  const styles = useStyles();
  return <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'}
    accessibilityLabel={title + (detail ? '. ' + detail : '')} style={({ pressed }) => [styles.item, { opacity: pressed && onPress ? 0.6 : 1 }]}>
    {leading && <View style={styles.leading}>{leading}</View>}
    <View style={{ flex: 1, gap: 4 }}><Text style={styles.itemTitle}>{title}</Text>
      {detail && <Text style={styles.itemDetail}>{detail}</Text>}</View>
    {trailing || (onPress ? <ChevronRight size={17} color={palette.subtle}/> : null)}
  </Pressable>;
}
export function Placeholder({ title, message }: { title: string; message: string }) {
  const styles = useStyles();
  return <Card style={{ paddingVertical: 28, alignItems: 'center', gap: 8 }}>
    <Text style={styles.itemTitle}>{title}</Text>
    <Text style={[styles.muted, { textAlign: 'center' }]}>{message}</Text>
  </Card>;
}
export function Loading({ label = 'Loading school information…' }: { label?: string }) {
  const palette = usePalette();
  const styles = useStyles();
  return <View style={{ paddingVertical: 32, alignItems: 'center', gap: 12 }}>
    <ActivityIndicator color={palette.primary}/><Text style={styles.muted}>{label}</Text>
  </View>;
}
export function QueryState<T>({ state, retry, children, empty, emptyText }: {
  state: LoadState<T>; retry: () => void; children: (value: T) => React.ReactNode;
  empty?: (value: T) => boolean; emptyText?: string;
}) {
  if (state.status === 'loading') return <Loading/>;
  if (state.status === 'error') return <View style={{ gap: 12 }}>
    <Placeholder title="Couldn't load this page" message={state.message}/>
    <Button variant="outline" label="Try again" onPress={retry}/>
  </View>;
  if (empty?.(state.value)) return <Placeholder title="Nothing here yet" message={emptyText || 'Your school will add information here when it is available.'}/>;
  return <>{children(state.value)}</>;
}
export function dateLabel(value: string, long = false): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(undefined, long ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric' }).format(new Date(time));
}
export function shortName(value: string): string {
  return value.split(/\s+/)[0] || value;
}
function makeStyles(palette: Palette) {
  return StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 24, gap: 0 },
  refresh: { flexDirection: 'row', gap: 7, alignSelf: 'flex-end', paddingRight: 20, paddingTop: 16, alignItems: 'center' },
  smallBlue: { color: palette.primary, fontSize: 12, fontWeight: '600' },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.35, textTransform: 'uppercase', color: palette.primary, marginBottom: 8 },
  title: { fontSize: font.hero, fontWeight: '800', letterSpacing: -1, color: palette.ink, lineHeight: 38 },
  muted: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  body: { color: palette.ink, fontSize: font.body, lineHeight: 23 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionHeading: { fontSize: font.subtitle, fontWeight: '800', color: palette.ink, letterSpacing: -0.3 },
  card: { backgroundColor: palette.surface, padding: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.line },
  field: { borderWidth: 1, borderColor: palette.line, borderRadius: radius.md, paddingHorizontal: 16,
    paddingVertical: 14, fontSize: font.body, color: palette.ink, backgroundColor: palette.raised },
  fieldLabel: { fontSize: 13, color: palette.ink, fontWeight: '700' },
  button: { borderRadius: radius.md, paddingHorizontal: 18, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, minHeight: 48 },
  item: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  leading: { height: 42, width: 42, borderRadius: 14, backgroundColor: palette.primarySoft,
    justifyContent: 'center', alignItems: 'center' },
  itemTitle: { color: palette.ink, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  itemDetail: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  });
}

/** The shared styles for the current theme. */
export function useStyles() {
  const palette = usePalette();
  return useMemo(() => makeStyles(palette), [palette]);
}
