import React from 'react';
import { Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import type { DistrictClient } from '../api/client';
import type { Principal } from '../types';
import { useAppState } from '../state/app-state';
import { usePalette } from './theme-context';
import { Button, Loading, Page } from './Primitives';

function WorkspaceOnly({ message, ai, onWorkspace, onRetry }: {
  message: string; ai: boolean; onWorkspace: () => void; onRetry: () => void;
}) {
  const palette = usePalette();
  return <Page>
    <View style={{ paddingTop: 55, alignItems: 'center', gap: 14 }}>
      <View style={{ backgroundColor: palette.primarySoft, padding: 22, borderRadius: 25 }}>
        <Sparkles size={38} color={palette.primary}/>
      </View>
      <Text style={{ fontSize: 23, color: palette.ink, fontWeight: '800', textAlign: 'center' }}>
        {ai ? 'Your school workspace is ready' : "Your school's classes aren't available yet"}
      </Text>
      <Text style={{ fontSize: 14, textAlign: 'center', lineHeight: 22, color: palette.muted }}>{message}</Text>
    </View>
    <View style={{ gap: 11, marginTop: 30 }}>
      {ai && <Button label="Open AI workspace" onPress={onWorkspace}/>}
      <Button label="Check school access again" variant="outline" onPress={onRetry}/>
    </View>
  </Page>;
}

/** Renders a data screen once the phone has a session and the school has confirmed who it is. */
export function ClientGate({ children }: { children: (client: DistrictClient, me: Principal) => React.ReactNode }) {
  const state = useAppState();
  const router = useRouter();
  if (state.booting) return <Loading label="Preparing EducateOS…"/>;
  if (state.revoked) return <Redirect href="/signed-out"/>;
  if (!state.session) return <Redirect href="/welcome"/>;
  if (state.checkingAccess) return <Loading label="Checking district access…"/>;
  if (!state.client?.available || !state.principal) {
    return <WorkspaceOnly message={state.principalError || 'The school could not confirm your class permissions.'}
      ai={state.session.district.features?.ai !== false}
      onWorkspace={() => router.navigate('/ai')} onRetry={state.retryAccess}/>;
  }
  return <>{children(state.client, state.principal)}</>;
}
