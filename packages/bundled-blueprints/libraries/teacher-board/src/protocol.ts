/** A source-backed card. Provider text is always rendered as text, never markup. */
export interface BoardCard {
  id: string;
  title: string;
  detail: string;
  label: string;
  url?: string;
}
/** The only data saved by these boards: a teacher's own preparation notes and checklist. */
export interface Preparation {
  notes: string;
  tasks: { id: string; text: string; done: boolean }[];
}
/** A live refresh never caches provider records in gadget storage. */
export interface BoardResult {
  title: string;
  subtitle: string;
  cards: BoardCard[];
  refreshedAt: string;
}
/** RPC surface shared by all teacher boards. Connector access stays on the server. */
export interface BoardApi {
  getPreparation(): Promise<Preparation>;
  savePreparation(value: Preparation): Promise<void>;
  refresh(input: string): Promise<BoardResult>;
}
/** Presentation and setup guidance supplied by each blueprint. */
export interface BoardOptions {
  title: string;
  eyebrow: string;
  description: string;
  connector: string;
  setup: string;
  inputLabel: string;
  inputType: "date" | "search" | "none";
  inputValue: string;
  empty: string;
  sample: BoardResult;
}
