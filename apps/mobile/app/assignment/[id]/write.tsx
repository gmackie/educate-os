import { Redirect, useLocalSearchParams } from 'expo-router';
import { param } from '../../../src/params';

/**
 * Old `/assignment/<id>/write` links. Writing is now a step of the assignment, saved and submitted
 * with its other steps (SCHO-342), so this opens the assignment.
 */
export default function WriteRoute() {
  const params = useLocalSearchParams();
  const offering = param(params.offering);
  return <Redirect href={{ pathname: '/assignment/[id]', params: { id: param(params.id), ...(offering ? { offering } : {}) } }}/>;
}
