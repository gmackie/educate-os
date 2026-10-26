/** A grade as a family reads it, such as "8 of 10 points". */
export const scoreText = ({ points, maxPoints }: { points: number; maxPoints: number }): string => `${points} of ${maxPoints} points`;
