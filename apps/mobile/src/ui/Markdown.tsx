import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { usePalette } from './theme-context';
import { parseBlocks, parseSpans, tableLayout, type Block } from '../markdown.ts';
import { safeLink } from '../modules.ts';

export { plainText } from '../markdown.ts';

/**
 * Opens an external `https` address in the in-app browser, outside the app's own session: the page
 * gets no school credential. Anything that is not plain `https` is refused.
 */
export function openExternal(url: string): void {
  const safe = safeLink(url);
  if (safe) void WebBrowser.openBrowserAsync(safe);
}

function Inline({ text, style }: { text: string; style: object }) {
  const palette = usePalette();
  return <Text style={style}>{parseSpans(text).map((span, i) => <Text key={i}
    {...(span.href ? { accessibilityRole: 'link' as const, accessibilityHint: 'Opens in the browser', onPress: () => openExternal(span.href!) } : {})}
    style={{
      fontWeight: span.bold ? '800' : undefined, fontStyle: span.italic ? 'italic' : undefined,
      fontFamily: span.code ? 'Menlo' : undefined, backgroundColor: span.code ? palette.primarySoft : undefined,
      color: span.href ? palette.primary : undefined, textDecorationLine: span.href ? 'underline' : undefined,
    }}>{span.text}</Text>)}</Text>;
}

/** A pipe table, its columns sharing the width it has; one too wide for the screen scrolls sideways. */
function Table({ block, size, body }: { block: Extract<Block, { kind: 'table' }>; size: number; body: object }) {
  const palette = usePalette();
  const [available, setAvailable] = useState(0);
  const { column, scrolls } = tableLayout(available, block.header.length);
  const cell = { width: column, paddingHorizontal: 10, paddingVertical: 8, borderColor: palette.line };
  return <View onLayout={(e) => setAvailable(e.nativeEvent.layout.width)}>
    <ScrollView horizontal scrollEnabled={scrolls} showsHorizontalScrollIndicator={scrolls} accessibilityLabel="Table">
      <View style={{ borderWidth: 1, borderColor: palette.line, borderRadius: 10, overflow: 'hidden' }}>
        {[block.header, ...block.rows].map((row, r) => <View key={r} style={{ flexDirection: 'row',
          backgroundColor: r === 0 ? palette.primarySoft : undefined, borderTopWidth: r === 0 ? 0 : 1, borderColor: palette.line }}>
          {row.map((text, c) => <View key={c} style={[cell, { borderRightWidth: c < row.length - 1 ? 1 : 0 }]}>
            <Inline text={text} style={[body, { fontSize: size - 1, fontWeight: r === 0 ? '800' : undefined }]}/>
          </View>)}
        </View>)}
      </View>
    </ScrollView>
  </View>;
}

/** Teacher-written Markdown (parsed by src/markdown.ts), drawn natively. Never renders HTML. */
export function Markdown({ source, size = 15 }: { source: string; size?: number }) {
  const palette = usePalette();
  const body = { color: palette.ink, fontSize: size, lineHeight: Math.round(size * 1.5) };
  return <View style={{ gap: 10 }}>{parseBlocks(source).map((block, i) => {
    if (block.kind === 'heading') {
      return <Inline key={i} text={block.text} style={{ color: palette.ink, fontWeight: '800',
        fontSize: block.level === 1 ? size + 7 : block.level === 2 ? size + 4 : size + 1, marginTop: i > 0 ? 6 : 0 }}/>;
    }
    if (block.kind === 'list') {
      return <View key={i} style={{ gap: 6 }}>{block.items.map((item, n) => <View key={n} style={{ flexDirection: 'row', gap: 8 }}>
        <Text style={[body, { color: palette.muted, minWidth: 16 }]}>{block.ordered ? n + 1 + '.' : '•'}</Text>
        <View style={{ flex: 1 }}><Inline text={item} style={body}/></View>
      </View>)}</View>;
    }
    if (block.kind === 'table') return <Table key={i} block={block} size={size} body={body}/>;
    return <Inline key={i} text={block.text} style={body}/>;
  })}</View>;
}
