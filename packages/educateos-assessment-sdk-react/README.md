# @educateos/assessment-sdk-react

Optional read-only React 19 views for the portable Assessment SDK:

- `IntentCard`: learning intent, outcomes, CASE references and task-scoped AI permissions.
- `AssessmentPreview`: the intent card and explicit submission requirements.
- `EvidenceViewer`: submitted revision references and host-supplied authorized text.
- `RubricReview`: evaluator observations, supporting evidence and clearly labelled suggested scores.
- `VersionDiff`: identifies changed public sections, including changed release digests under the same version label.

```tsx
import { AssessmentPreview, EvidenceViewer, RubricReview } from "@educateos/assessment-sdk-react";

<AssessmentPreview definition={definition} />;
<EvidenceViewer evidence={report.evidence} texts={authorizedTexts} />;
<RubricReview report={report} />;
```

Validate untrusted definitions and reports with the core SDK before rendering. The host must
authorize the report and every text read, verify content digests, and provide only evidence the
viewer may see. `EvidenceViewer` matches artifact ID, revision ID and digest before displaying
text; this prevents accidental display of a newer revision, but is not authentication or a digest
verification service. HTML-looking submitted text is rendered as plain text. There are no URL
fetches, embedded media, evaluation execution, inferred AI reasoning or grade writes.

These are semantic document views, not new interaction primitives. They deliberately use plain
headings, lists and definition lists, requiring no Kumo theme, Tailwind compilation, Cloudflare
runtime or RPC context. EducateOS applications can place them inside their existing Kumo surfaces;
third-party hosts retain their own design system. Section labels use React-generated IDs so
multiple cards can coexist accessibly. An approved grade must still go through the host's
authorized teacher review service.

Build/typecheck with `pnpm exec vp run -F @educateos/assessment-sdk-react build` and run the views'
tests with `pnpm --filter @educateos/assessment-sdk-react test:run`. `pnpm --filter
@educateos/assessment-sdk-react build:dist` emits JavaScript and declarations; `pnpm pack` in this
package creates a portable tarball with emitted entry points and a versioned dependency on the
core SDK. The core SDK must also be installed when testing those tarballs locally. No registry
publication or browser app integration is claimed.
