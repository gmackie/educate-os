import { Link } from "@cloudflare/kumo";
import type { FamilyView } from "./useFamily.ts";

/** Links to the same page for each child; hidden when there is only one. */
export const LearnerSwitcher = ({ family, current, pathFor }: { family: FamilyView; current: string; pathFor: (learnerId: string) => string }) =>
  family.learners.length < 2 ? null : (
    <nav aria-label="Your children" className="flex flex-wrap gap-2">
      {family.learners.map((learner) => (
        <Link
          key={learner.id}
          href={pathFor(learner.id)}
          variant="plain"
          aria-current={learner.id === current ? "page" : undefined}
          className={`rounded-full border border-kumo-hairline px-4 py-2 ${learner.id === current ? "bg-kumo-tint font-semibold" : ""}`}
        >
          {`${learner.avatar} ${learner.displayName}`}
        </Link>
      ))}
    </nav>
  );
