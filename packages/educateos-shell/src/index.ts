// @educateos/shell: the frame every SPA on a district origin draws (SCHO-260, plan §4).
//
// Source-only, like @gadgets/ui: a Tailwind consumer must list this package's `src` as an
// `@source` (as it does packages/ui/src), because the shell's utility classes are compiled by the
// consuming app, and must enable `@custom-variant dark` for Kumo's `data-mode` theme.
//
// A follow-up adds the ⌘K command palette; `SchoolShell`'s `headerActions` is its slot.
export * from "./navigation.ts";
export * from "./manifest.ts";
export * from "./theme.ts";
export * from "./SchoolShell.tsx";
