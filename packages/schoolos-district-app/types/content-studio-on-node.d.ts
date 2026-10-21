// The two Workers typings `@schoolos/content-studio` is written against that Node's typings
// declare more narrowly, so this package's Node typecheck accepts the Content Studio sources it
// compiles. Both calls behave identically at runtime under Node and workerd: `crypto.subtle.digest`
// accepts any `ArrayBufferView`, and `clearTimeout(null)` does nothing. A script, not a module, so
// both declarations merge into the global scope and Node's ambient `node:crypto` module.

declare function clearTimeout(timeoutId: null): void;

declare module "node:crypto" {
  namespace webcrypto {
    interface SubtleCrypto {
      digest(algorithm: AlgorithmIdentifier, data: ArrayBufferView): Promise<ArrayBuffer>;
    }
  }
}
