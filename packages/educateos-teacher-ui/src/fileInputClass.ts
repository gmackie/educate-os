/**
 * The look of a native file input, from Kumo's tokens: its button styled like a Kumo secondary
 * button, so a file picker sits with the controls around it. Kumo has no file input of its own,
 * and the native one keeps the browser's keyboard and screen-reader behavior.
 */
export const FILE_INPUT_CLASS = [
  "max-w-full rounded-lg text-sm text-kumo-default",
  "file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-solid file:border-kumo-line file:bg-kumo-base file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-kumo-default",
  "hover:file:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand",
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:file:cursor-not-allowed",
].join(" ");
