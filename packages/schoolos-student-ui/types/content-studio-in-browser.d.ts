// The two Workers typings `@schoolos/content-studio` is written against that the DOM's typings
// declare more narrowly. This app never runs Content Studio code, but it type-checks the district
// route schemas the API client validates responses with, and they reach Content Studio's sources.
// Both calls behave identically in a browser: `crypto.subtle.digest` accepts any `ArrayBufferView`,
// and `clearTimeout(null)` does nothing. A script, not a module, so both merge into the globals.

declare function clearTimeout(timeoutId: null): void;

interface SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: ArrayBufferView): Promise<ArrayBuffer>;
}
