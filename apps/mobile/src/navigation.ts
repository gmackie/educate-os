import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import type { Detail, Tab } from './types';

const q = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? '?' + text : '';
};
const id = encodeURIComponent;

/** The route for a detail screen. Deep links use the same paths (`educateos://class/<id>`). */
export function hrefFor(detail: Detail): string {
  switch (detail.type) {
    case 'class': case 'teacher-class': return '/class/' + id(detail.id);
    case 'assignment': case 'teacher-assignment':
      return '/assignment/' + id(detail.id) + q({ offering: detail.offeringId });
    case 'write': return '/assignment/' + id(detail.id) + '/write' + q({ offering: detail.offeringId });
    case 'teacher-review': return '/review/' + id(detail.id) + q({
      assignment: detail.assignmentId, student: detail.studentName,
      artifacts: JSON.stringify(detail.artifacts.slice(0, 20)),
    });
    case 'family-child': return '/family/' + id(detail.id);
    case 'family-class': return '/family/' + id(detail.studentId) + '/class/' + id(detail.offeringId);
    case 'grades': return '/grades';
    case 'announcements': return '/announcements';
  }
}

export function tabHref(tab: Tab | 'calendar'): string {
  return tab === 'calendar' ? '/calendar' : '/' + tab;
}

/** `navigate(detail)` for screens written before expo-router. */
export function useDetailNavigation(): { navigate: (detail: Detail) => void; changeTab: (tab: Tab | 'calendar') => void } {
  const router = useRouter();
  const navigate = useCallback((detail: Detail) => router.push(hrefFor(detail) as never), [router]);
  const changeTab = useCallback((tab: Tab | 'calendar') => router.navigate(tabHref(tab) as never), [router]);
  return { navigate, changeTab };
}
