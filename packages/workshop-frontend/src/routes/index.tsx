import { createFileRoute } from '@tanstack/react-router'
import { HomePage } from '../pages/home/HomePage'
import { homePromptFromSearch } from '../homePrompt'

type HomeSearch = {
  prompt?: string
  cfos_native_state?: string
  cfos_native_key?: string
}

export const Route = createFileRoute('/')({
  component: () => <HomePage prompt={Route.useSearch().prompt} />,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
    cfos_native_state: typeof search.cfos_native_state === 'string'
      ? search.cfos_native_state : undefined,
    cfos_native_key: typeof search.cfos_native_key === 'string'
      ? search.cfos_native_key : undefined,
  }),
})
