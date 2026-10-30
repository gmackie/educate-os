import React from 'react';
import { Text, View } from 'react-native';
import { usePalette } from './theme-context';
import { parseBlocks, parseSpans } from '../markdown.ts';

export { plainText } from '../markdown.ts';

function Inline({ text, style }: { text: string; style: object }) {
  const palette = usePalette();
  return <Text style={style}>{parseSpans(text).map((span, i) => <Text key={i} style={{
    fontWeight: span.bold ? '800' : undefined, fontStyle: span.italic ? 'italic' : undefined,
    fontFamily: span.code ? 'Menlo' : undefined, backgroundColor: span.code ? palette.primarySoft : undefined,
  }}>{span.text}</Text>)}</Text>;
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
    return <Inline key={i} text={block.text} style={body}/>;
  })}</View>;
}
