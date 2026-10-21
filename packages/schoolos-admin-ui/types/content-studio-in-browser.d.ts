// The district route schemas this UI reaches through @schoolos/api-client import Content Studio,
// whose sources hash with `crypto.subtle.digest` over a `Uint8Array`. The DOM typings this package
// checks against declare `digest` more narrowly than Workers do; the call behaves the same in every
// runtime, which accepts any `ArrayBufferView`. A script, not a module, so the declaration merges
// into the global `SubtleCrypto`.

interface SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: ArrayBufferView): Promise<ArrayBuffer>;
}
