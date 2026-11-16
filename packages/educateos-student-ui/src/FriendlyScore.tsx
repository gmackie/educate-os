import { StarIcon } from "@phosphor-icons/react";

/** The most stars a young learner's work is shown with. */
const STARS = 3;

/**
 * A score as a young learner reads it: one to three stars and a few kind words. Any score earns a
 * star, because a five-year-old who handed something in did something.
 */
export const friendlyScore = (points: number, maxPoints: number): { stars: number; words: string } => {
  const share = maxPoints > 0 ? points / maxPoints : 0;
  if (share >= 0.85) return { stars: 3, words: "Great work!" };
  if (share >= 0.5) return { stars: 2, words: "Good job! Keep going." };
  return { stars: 1, words: "Nice try! Let's keep practicing." };
};

/** A score as stars and words, for a young learner. The stars are one image, named for a screen reader. */
export const FriendlyScore = ({ points, maxPoints, size = 28 }: { points: number; maxPoints: number; size?: number }) => {
  const { stars, words } = friendlyScore(points, maxPoints);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span role="img" aria-label={`${stars} of ${STARS} stars`} className="inline-flex text-kumo-brand">
        {Array.from({ length: STARS }, (_, i) => <StarIcon key={i} aria-hidden size={size} weight={i < stars ? "fill" : "regular"} />)}
      </span>
      <span className="font-semibold">{words}</span>
    </span>
  );
};
