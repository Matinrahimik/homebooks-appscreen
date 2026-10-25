/**
 * One Durable Object per project. Requests are mutexed so a compare-and-swap
 * of the small project JSON cannot interleave at an await.
 */
interface GateStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  transaction?<T>(closure: (txn: GateStorage) => Promise<T>): Promise<T>;
}

interface GateState {
  storage: GateStorage;
}

interface GateBody {
  op: "read" | "cas" | "replace" | "delete";
  expected?: number;
  doc?: string;
}

export class ProjectGate {
  #chain: Promise<void> = Promise.resolve();
  #state: GateState;

  constructor(state: GateState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const previous = this.#chain;
    let release: () => void = () => {};
    this.#chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#handle(request);
    } finally {
      release();
    }
  }

  async #handle(request: Request): Promise<Response> {
    let body: GateBody;
    try {
      body = await request.json() as GateBody;
    } catch {
      return Response.json({ error: "invalid_gate_body" }, { status: 400 });
    }
    const storage = this.#state.storage;
    if (body.op === "read") {
      const version = Number(await storage.get("version") || 0);
      const doc = await storage.get("doc");
      return Response.json({ version, doc: typeof doc === "string" ? doc : null });
    }
    const run = async (txn: GateStorage): Promise<Response> => {
      if (body.op === "delete") {
        await txn.delete("doc");
        await txn.put("version", 0);
        return Response.json({ ok: true, version: 0, doc: null });
      }
      if (body.op === "replace") {
        const version = Number(await txn.get("version") || 0) + 1;
        await txn.put("doc", body.doc || "");
        await txn.put("version", version);
        return Response.json({ ok: true, version, doc: body.doc || "" });
      }
      if (body.op === "cas") {
        const version = Number(await txn.get("version") || 0);
        const doc = await txn.get("doc");
        const current = typeof doc === "string" ? doc : null;
        if (version !== body.expected) {
          return Response.json({ ok: false, version, doc: current });
        }
        const next = version + 1;
        await txn.put("doc", body.doc || "");
        await txn.put("version", next);
        return Response.json({ ok: true, version: next, doc: body.doc || "" });
      }
      return Response.json({ error: "unknown_op" }, { status: 400 });
    };
    if (typeof storage.transaction === "function") return storage.transaction(run);
    return run(storage);
  }
}

class MemoryStorage implements GateStorage {
  #map = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.#map.has(key) ? this.#map.get(key) : undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.#map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async transaction<T>(closure: (txn: GateStorage) => Promise<T>): Promise<T> {
    return closure(this);
  }
}

const namespaces = new WeakMap<object, Map<string, ProjectGate>>();

/** In-process ProjectGate used when the Worker binding is absent (unit tests). */
export function memoryProjectGate(kv: object): { idFromName(name: string): string; get(id: string): ProjectGate } {
  let gates = namespaces.get(kv);
  if (!gates) {
    gates = new Map();
    namespaces.set(kv, gates);
  }
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      let gate = gates.get(id);
      if (!gate) {
        gate = new ProjectGate({ storage: new MemoryStorage() });
        gates.set(id, gate);
      }
      return gate;
    },
  };
}
