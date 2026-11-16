import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { BookOpen, Laptop, PenLine } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Detail, QuizSummary } from '../types';
import { usePalette } from '../ui/theme-context';
import { Markdown } from '../ui/Markdown';
import { Button, Card, Chip, Item, Section } from '../ui/Primitives';
import { imageType } from '../media.ts';

/**
 * The ways to do an assignment that are not its steps: the quiz it is bound to, or, when the
 * activity itself could not be opened, where to do it instead. Step work (writing, drawing,
 * photos, recordings) and Submit are in ActivityWork.tsx, which submits only once every step is done.
 */
export function AssignmentActions({ offeringId, quiz, activityMissing, ai, schoolHost, navigate }: {
  offeringId: string; quiz: QuizSummary | null; activityMissing: boolean;
  ai: boolean; schoolHost: string; navigate: (d: Detail) => void;
}) {
  const palette = usePalette();
  return <View style={{ gap: 12, marginBottom: 18 }}>
    {quiz && <Button label={quiz.attempts.some((a) => a.status === 'in-progress') ? 'Resume the quiz' : 'Take the quiz'}
      icon={<PenLine size={18} color={palette.onPrimary}/>} onPress={() => navigate({ type: 'quiz', offeringId, quizId: quiz.id })}/>}
    {activityMissing && !quiz && <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Laptop size={22} color={palette.primary}/>
      <Text style={{ color: palette.muted, lineHeight: 21, flex: 1 }}>
        {'The steps of this assignment could not be opened. Tap Refresh to try again, or open it ' +
          (ai ? 'in the AI tab or ' : '') + 'on a computer at ' + schoolHost + '.'}
      </Text>
    </Card>}
  </View>;
}

/** Starter materials from the teacher, opened in place: text as Markdown, pictures inline. */
export function StarterMaterials({ client, assignmentId, materials }: {
  client: DistrictClient; assignmentId: string; materials: { id: string; title: string }[];
}) {
  const palette = usePalette();
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, Awaited<ReturnType<DistrictClient['starterMaterial']>>['content'] | 'error'>>({});
  const toggle = (id: string) => {
    setOpen(open === id ? null : id);
    if (content[id]) return;
    client.starterMaterial(assignmentId, id).then((m) => setContent((c) => ({ ...c, [id]: m.content })),
      () => setContent((c) => ({ ...c, [id]: 'error' })));
  };
  return <Section title="Starter materials">
    <Card>{materials.map((item) => {
      const body = content[item.id];
      return <View key={item.id}>
        <Item title={item.title} detail={open === item.id ? 'Tap to close' : 'From your teacher'}
          leading={<BookOpen size={19} color={palette.primary}/>} onPress={() => toggle(item.id)}/>
        {open === item.id && <View style={{ paddingBottom: 12 }}>
          {!body ? <Text style={{ color: palette.muted }}>Opening…</Text>
            : body === 'error' ? <Text style={{ color: palette.red }}>This material could not be opened.</Text>
            : body.kind === 'text' ? <Markdown source={body.text}/>
            : body.kind === 'bytes' && imageType(body.base64) ? <Image accessibilityLabel={item.title} resizeMode="contain"
              source={{ uri: 'data:' + imageType(body.base64) + ';base64,' + body.base64 }}
              style={{ width: '100%', height: 280, borderRadius: 12 }}/>
            : <Chip label={body.kind === 'external' ? 'Opens on a computer' : 'Open this file on a computer'} tone="neutral"/>}
        </View>}
      </View>;
    })}</Card>
  </Section>;
}
