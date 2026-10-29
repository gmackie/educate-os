/**
 * ES2023 array methods the app uses that Hermes (React Native 0.88) does not ship yet. Loaded first
 * by app/_layout.tsx. Without it `toSorted` is undefined on device, and Today fails to load.
 */
declare global {
  interface Array<T> { toSorted(compare?: (a: T, b: T) => number): T[] }
}

if (typeof Array.prototype.toSorted !== 'function') {
  Object.defineProperty(Array.prototype, 'toSorted', {
    configurable: true, writable: true,
    value<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      const copy = this.slice();
      copy.sort(compare);
      return copy;
    },
  });
}

export {};
