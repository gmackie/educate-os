// `@schoolos/cartridge` is typed against Workers, whose stream writers accept any byte view; Node's
// typings accept only views over an `ArrayBuffer`. This overload lets this package's Node
// typecheck compile the cartridge sources it imports. Both runtimes accept the same chunks. A
// script, not a module, so the declaration merges into Node's ambient `node:stream/web` module.

declare module "node:stream/web" {
  interface WritableStreamDefaultWriter<W = any> {
    write(chunk: Uint8Array<ArrayBufferLike>): Promise<void>;
  }
}
