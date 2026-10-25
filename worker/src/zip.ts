/** Uncompressed ZIP (method 0). PNGs are already compressed. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date()): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const d = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface StoreZipFile {
  name: string;
  crc: number;
  size: number;
}

function nameBytes(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

export function zipLocalHeader(name: string, crc: number, size: number, time: number, date: number): Uint8Array {
  const encoded = nameBytes(name);
  const local = new Uint8Array(30 + encoded.length);
  const view = new DataView(local.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, crc >>> 0, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, encoded.length, true);
  local.set(encoded, 30);
  return local;
}

export function zipCentralHeader(
  name: string,
  crc: number,
  size: number,
  offset: number,
  time: number,
  date: number,
): Uint8Array {
  const encoded = nameBytes(name);
  const central = new Uint8Array(46 + encoded.length);
  const view = new DataView(central.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, crc >>> 0, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, encoded.length, true);
  view.setUint32(42, offset, true);
  central.set(encoded, 46);
  return central;
}

export function zipEndOfCentral(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return end;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

export function zipStore(files: ZipEntry[], when = new Date()): Uint8Array {
  const { time, date } = dosTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const crc = crc32(file.data);
    const local = zipLocalHeader(file.name, crc, file.data.byteLength, time, date);
    locals.push(local, file.data);
    centrals.push(zipCentralHeader(file.name, crc, file.data.byteLength, offset, time, date));
    offset += local.byteLength + file.data.byteLength;
  }
  const central = concat(centrals);
  const end = zipEndOfCentral(files.length, central.byteLength, offset);
  return concat([...locals, central, end]);
}

export function storeZipByteLength(files: StoreZipFile[]): number {
  const encoder = new TextEncoder();
  let total = 22;
  for (const file of files) total += 30 + encoder.encode(file.name).length + file.size + 46 + encoder.encode(file.name).length;
  return total;
}

/**
 * STORE zip whose file bytes come from caller-provided streams. Headers are small.
 * The file bytes are enqueued as the underlying stream yields them.
 */
export function storeZipStream(
  files: StoreZipFile[],
  open: (index: number) => Promise<ReadableStream<Uint8Array> | null>,
  when = new Date(),
): ReadableStream<Uint8Array> {
  const { time, date } = dosTime(when);
  const locals = files.map((file) => zipLocalHeader(file.name, file.crc, file.size, time, date));
  let offset = 0;
  const centrals = files.map((file, index) => {
    const header = zipCentralHeader(file.name, file.crc, file.size, offset, time, date);
    offset += locals[index].byteLength + file.size;
    return header;
  });
  const central = concat(centrals);
  const end = zipEndOfCentral(files.length, central.byteLength, offset);
  let index = 0;
  let phase: "local" | "body" | "tail" = files.length === 0 ? "tail" : "local";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (phase === "tail") {
          if (central.byteLength) controller.enqueue(central);
          controller.enqueue(end);
          controller.close();
          return;
        }
        if (phase === "local") {
          controller.enqueue(locals[index]);
          const body = await open(index);
          if (!body) {
            controller.error(new Error(`Missing zip entry ${files[index].name}`));
            return;
          }
          reader = body.getReader();
          phase = "body";
          return;
        }
        const next = await reader!.read();
        if (next.done) {
          reader!.releaseLock();
          reader = null;
          index += 1;
          phase = index >= files.length ? "tail" : "local";
          continue;
        }
        controller.enqueue(next.value);
        return;
      }
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}
