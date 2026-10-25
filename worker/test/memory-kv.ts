import type { KvLike } from "../src/types.ts";

export interface MemoryKv extends KvLike {
  dump(): Map<string, string | ArrayBuffer>;
  gets: { key: string; type: string }[];
  streamPuts: string[];
}

export function createMemoryKv(): MemoryKv {
  const store = new Map<string, string | ArrayBuffer>();
  const gets: { key: string; type: string }[] = [];
  const streamPuts: string[] = [];
  return {
    dump: () => store,
    gets,
    streamPuts,
    async get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" | "stream" }) {
      const type = options?.type || "text";
      gets.push({ key, type });
      const value = store.get(key);
      if (value === undefined) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      if (type === "stream") {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            if (bytes.byteLength === 0) {
              controller.close();
              return;
            }
            const mid = Math.max(1, Math.floor(bytes.byteLength / 2));
            controller.enqueue(bytes.slice(0, mid));
            if (mid < bytes.byteLength) controller.enqueue(bytes.slice(mid));
            controller.close();
          },
        });
      }
      if (type === "arrayBuffer") return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const text = new TextDecoder().decode(bytes);
      if (type === "json") return JSON.parse(text);
      return text;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>) {
      if (typeof value === "string") {
        store.set(key, value);
        return;
      }
      if (value instanceof ReadableStream) {
        streamPuts.push(key);
        const reader = value.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const copy = new Uint8Array(next.value.byteLength);
          copy.set(next.value);
          parts.push(copy);
          size += copy.byteLength;
        }
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        store.set(key, out.buffer);
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
