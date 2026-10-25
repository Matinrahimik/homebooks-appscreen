import type { KvLike } from "../src/types.ts";

export function createMemoryKv(): KvLike & { dump(): Map<string, string | ArrayBuffer> } {
  const store = new Map<string, string | ArrayBuffer>();
  return {
    dump: () => store,
    async get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" }) {
      const value = store.get(key);
      if (value === undefined) return null;
      const type = options?.type || "text";
      if (type === "arrayBuffer") {
        if (typeof value === "string") return new TextEncoder().encode(value).buffer;
        return value;
      }
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      if (type === "json") return JSON.parse(text);
      return text;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      if (typeof value === "string") {
        store.set(key, value);
        return;
      }
      if (value instanceof ArrayBuffer) {
        store.set(key, value);
        return;
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      store.set(key, copy.buffer);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}
