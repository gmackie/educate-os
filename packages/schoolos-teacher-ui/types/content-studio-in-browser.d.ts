// The route schemas the API client validates with reach `@schoolos/content-studio` sources, which
// hash a `Uint8Array` with `crypto.subtle.digest`. The DOM typings this app compiles against accept
// only `ArrayBuffer`-backed views there; browsers, like Workers and Node, accept any view. A script,
// not a module, so the declaration merges into the global `SubtleCrypto`.

interface SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: ArrayBufferView): Promise<ArrayBuffer>;
}
