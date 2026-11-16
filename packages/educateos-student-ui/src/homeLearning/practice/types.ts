// The shapes the practice screens share, taken from the route contract.
import type { RouteResponse } from "@educateos/api-client";
import type { Answer } from "@educateos/home-learning/scoring";

/** A session as the child's screen runs it. */
export type PracticeView = RouteResponse<"learner.start">;
/** One item. */
export type Item = PracticeView["items"][number];
/** One item of one type. */
export type ItemOf<T extends Item["type"]> = Extract<Item, { type: T }>;

/** What every item component receives. */
export interface ItemProps<T extends Item["type"]> {
  item: ItemOf<T>;
  /** No more answers are taken: the item is finished, or saving. */
  disabled: boolean;
  onAnswer: (answer: Answer) => void;
}

/** A large, easy-to-hit target for small hands. */
export const BIG = "min-h-16 min-w-16 text-2xl";
