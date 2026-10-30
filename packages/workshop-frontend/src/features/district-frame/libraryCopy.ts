import { useDistrictSidebar } from './districtFrame'

/** The Workshop's library pages, whose descriptions read differently inside a school. */
export type LibraryPage = 'workspaces' | 'blueprints' | 'explore'

type LibraryCopy = { description: string }

const WORKSHOP: Record<LibraryPage, LibraryCopy> = {
  workspaces: {
    description: 'Each workspace is an isolated environment with its own conversations, gatekeepers, and outputs.',
  },
  blueprints: {
    description: "Reusable starting points you've published or saved. Spin up a workspace from any of them.",
  },
  explore: {
    description: 'Discover featured blueprints to use as starting points. Open one to create a workspace from it, or save it to reuse later.',
  },
}

const SCHOOL: Record<LibraryPage, LibraryCopy> = {
  workspaces: {
    description: 'Each workspace keeps one project together: its conversations, the learning tools you build, and what you make along the way.',
  },
  blueprints: {
    description: "Learning tools and project templates you've published or saved. Start a new workspace from any of them.",
  },
  explore: {
    description: 'Find ready-made learning tools and project templates. Open one to start a workspace from it, or save it for later.',
  },
}

/** The page's description: school-oriented on a district origin, the Workshop's own otherwise. */
export const useLibraryCopy = (page: LibraryPage): LibraryCopy =>
  (useDistrictSidebar() ? SCHOOL : WORKSHOP)[page]
