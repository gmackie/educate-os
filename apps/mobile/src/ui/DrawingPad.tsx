import { useContext, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { Eraser, Trash2, Undo2 } from 'lucide-react-native';
import { usePalette } from './theme-context';
import { Button, ScrollLock } from './Primitives';
import { CANVAS_HEIGHT, CANVAS_WIDTH, PAPER, PEN_COLOURS, PEN_WIDTHS, canvasPoint, extend, strokePath, type Stroke } from '../drawing.ts';
import { uploadTypeFor } from '../media.ts';

/**
 * A touch drawing pad for young learners (SCHO-342), like the web's (SCHO-323): eight colours, an
 * eraser, three pen sizes, undo and clear. "I'm done drawing" exports the canvas as a PNG at its
 * full 960×720 size, white paper behind every stroke, and hands it to `onDrawn` to save.
 */
export function DrawingPad({ stepTitle, disabled = false, onDrawn }: {
  stepTitle: string; disabled?: boolean; onDrawn: (file: { base64: string; mediaType: 'image/png' }) => void;
}) {
  const palette = usePalette();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Stroke | null>(null);
  const [color, setColor] = useState(PEN_COLOURS[0]!.value);
  const [width, setWidth] = useState(PEN_WIDTHS[1]!.value);
  const [error, setError] = useState<string | null>(null);
  const size = useRef({ width: 1, height: 1 });
  const pen = useRef({ color, width });
  pen.current = { color, width };
  const drawing = useRef<Stroke | null>(null);
  const svg = useRef<Svg>(null);
  // The pad's responder is made once, so it reads the page's scroll lock through a ref.
  const lock = useContext(ScrollLock);
  const lockScroll = useRef(lock);
  lockScroll.current = lock;

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // A stroke is never handed to the page's scroll view part way through.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      lockScroll.current(true);
      const { locationX, locationY } = event.nativeEvent;
      drawing.current = { ...pen.current, points: [canvasPoint(locationX, locationY, size.current.width, size.current.height)] };
      setLive(drawing.current);
    },
    onPanResponderMove: (event) => {
      if (!drawing.current) return;
      const { locationX, locationY } = event.nativeEvent;
      const next = extend(drawing.current, canvasPoint(locationX, locationY, size.current.width, size.current.height));
      if (next !== drawing.current) { drawing.current = next; setLive(next); }
    },
    onPanResponderRelease: () => {
      lockScroll.current(false);
      const done = drawing.current;
      drawing.current = null;
      setLive(null);
      if (done) setStrokes((all) => [...all, done]);
    },
    onPanResponderTerminate: () => {
      lockScroll.current(false);
      const done = drawing.current;
      drawing.current = null;
      setLive(null);
      if (done) setStrokes((all) => [...all, done]);
    },
  }), []);

  const save = () => {
    setError(null);
    svg.current?.toDataURL((base64: string) => {
      const data = base64.replace(/^data:image\/png;base64,/, '');
      if (uploadTypeFor('picture', data) !== 'image/png') { setError('The drawing could not be saved. Try again.'); return; }
      onDrawn({ base64: data, mediaType: 'image/png' });
    }, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  };

  const shown = live ? [...strokes, live] : strokes;
  const swatch = (selected: boolean) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center' as const, justifyContent: 'center' as const,
    borderWidth: selected ? 3 : 1, borderColor: selected ? palette.primary : palette.line });
  return <View style={{ gap: 12 }}>
    <View {...responder.panHandlers} onTouchStart={() => lockScroll.current(true)} onTouchEnd={() => lockScroll.current(false)} accessible accessibilityRole="image"
      accessibilityLabel={'Drawing pad for ' + stepTitle + (strokes.length > 0 ? ', ' + strokes.length + ' lines drawn' : ', empty')}
      onLayout={(e) => { size.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height }; }}
      style={{ width: '100%', aspectRatio: CANVAS_WIDTH / CANVAS_HEIGHT, borderRadius: 16, overflow: 'hidden',
        borderWidth: 2, borderColor: palette.line, backgroundColor: PAPER }}>
      {/* The pad, not its paths, takes the touches, so every touch is measured against the whole pad. */}
      <Svg ref={svg} width="100%" height="100%" viewBox={'0 0 ' + CANVAS_WIDTH + ' ' + CANVAS_HEIGHT} pointerEvents="none">
        <Rect x={0} y={0} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill={PAPER}/>
        {shown.map((stroke, i) => <Path key={i} d={strokePath(stroke)} stroke={stroke.color} strokeWidth={stroke.width}
          strokeLinecap="round" strokeLinejoin="round" fill="none"/>)}
      </Svg>
    </View>
    <View accessibilityRole="radiogroup" accessibilityLabel="Colours" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {PEN_COLOURS.map((c) => <Pressable key={c.value} accessibilityRole="radio" accessibilityLabel={c.name}
        accessibilityState={{ checked: color === c.value }} onPress={() => setColor(c.value)} style={swatch(color === c.value)}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.value }}/>
      </Pressable>)}
      <Pressable accessibilityRole="radio" accessibilityLabel="Eraser" accessibilityState={{ checked: color === PAPER }}
        onPress={() => setColor(PAPER)} style={swatch(color === PAPER)}><Eraser size={22} color={palette.ink}/></Pressable>
    </View>
    <View accessibilityRole="radiogroup" accessibilityLabel="Pen size" style={{ flexDirection: 'row', gap: 8 }}>
      {PEN_WIDTHS.map((w) => <Pressable key={w.value} accessibilityRole="radio" accessibilityLabel={w.name + ' pen'}
        accessibilityState={{ checked: width === w.value }} onPress={() => setWidth(w.value)}
        style={{ flex: 1, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 4,
          borderWidth: width === w.value ? 3 : 1, borderColor: width === w.value ? palette.primary : palette.line, backgroundColor: palette.raised }}>
        <View style={{ width: Math.max(8, w.value / 1.4), height: Math.max(8, w.value / 1.4), borderRadius: 20, backgroundColor: palette.ink }}/>
        <Text style={{ color: palette.ink, fontWeight: '700', fontSize: 12 }}>{w.name}</Text>
      </Pressable>)}
    </View>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Button label="Undo" variant="outline" disabled={strokes.length === 0 || disabled}
        icon={<Undo2 size={18} color={palette.primary}/>} onPress={() => setStrokes((all) => all.slice(0, -1))}/></View>
      <View style={{ flex: 1 }}><Button label="Clear" variant="outline" disabled={strokes.length === 0 || disabled}
        icon={<Trash2 size={18} color={palette.primary}/>} onPress={() => setStrokes([])}/></View>
    </View>
    {error && <Text accessibilityRole="alert" style={{ color: palette.red }}>{error}</Text>}
    <Button label="I'm done drawing" disabled={strokes.length === 0 || disabled} onPress={save}/>
  </View>;
}
