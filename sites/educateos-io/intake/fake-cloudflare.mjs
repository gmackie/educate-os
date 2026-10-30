/** Offline transactional Cloudflare storage fake; never imported by production. */
export class FakeStorage {
  values = new Map();
  pending = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async list({prefix = '', startAfter = '', end = '\uffff', limit = Infinity} = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && key > startAfter && key < end).toSorted(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  transaction(fn) {
    const result = this.pending.then(async () => {
      const snapshot = structuredClone(this.values);
      try { return await fn(this); } catch (error) { this.values = snapshot; throw error; }
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
