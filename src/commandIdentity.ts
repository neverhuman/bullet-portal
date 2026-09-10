import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { CommandEnvelope, CommandStatus } from "./generated/api";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;

export class CommandEncodingError extends Error {}

function unicodeText(value: unknown): asserts value is string {
  if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value)) {
    throw new CommandEncodingError("command text must contain valid Unicode scalar values");
  }
}

// Rust's serde_json::Map uses Unicode scalar order, unlike JS UTF-16 sorting.
function compareKeys(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** Encode the browser's bounded JSON subset exactly as the Kernel's decoded Map.
 * Integers are restricted to the shared safe range; unsupported values never
 * become null, disappear, invoke toJSON or acquire an implementation-specific
 * floating point spelling. Numeric object keys are emitted directly in order.
 */
export function canonicalCommandPayload(payload: unknown): string {
  const chunks: string[] = [];
  let bytes = 0;
  function emit(value: string): void {
    bytes += utf8ToBytes(value).length;
    if (bytes > MAX_PAYLOAD_BYTES) throw new CommandEncodingError("command payload exceeds 1048576 UTF-8 bytes");
    chunks.push(value);
  }
  function encode(value: unknown, depth: number): void {
    if (depth > MAX_DEPTH) throw new CommandEncodingError("command payload exceeds 64 nesting levels");
    if (value === null || typeof value === "boolean") { emit(String(value)); return; }
    if (typeof value === "string") { unicodeText(value); emit(JSON.stringify(value)); return; }
    if (typeof value === "number" && Number.isSafeInteger(value)) { emit(JSON.stringify(value)); return; }
    if (typeof value !== "object" || value === null) {
      throw new CommandEncodingError("command payload requires plain JSON with safe integers");
    }
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new CommandEncodingError("command payload requires plain JSON objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" ||
      (key !== "length" || !array) && (!descriptors[key].enumerable || !("value" in descriptors[key])))) {
      throw new CommandEncodingError("command payload contains non-JSON properties");
    }
    if (array) {
      if (keys.length !== value.length + 1 || value.length > MAX_PAYLOAD_BYTES / 2) {
        throw new CommandEncodingError("command array is sparse, extended or oversized");
      }
      emit("[");
      for (let index = 0; index < value.length; index += 1) {
        const item = descriptors[String(index)];
        if (item === undefined) throw new CommandEncodingError("command array is sparse");
        if (index !== 0) emit(",");
        encode(item.value, depth + 1);
      }
      emit("]");
    } else {
      const names = keys as string[];
      names.forEach(unicodeText);
      names.sort(compareKeys);
      emit("{");
      names.forEach((key, index) => {
        if (index !== 0) emit(",");
        emit(`${JSON.stringify(key)}:`);
        encode(descriptors[key].value, depth + 1);
      });
      emit("}");
    }
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CommandEncodingError("command payload must be an object");
  }
  encode(payload, 0);
  return chunks.join("");
}

function frame(value: string): Uint8Array {
  const bytes = utf8ToBytes(value);
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true);
  return concatBytes(length, bytes);
}

export function prepareCommand(envelope: CommandEnvelope): {
  body: string;
  subject: Pick<CommandStatus, "id" | "kind" | "payload_digest">;
} {
  const { idempotency_key: key, kind } = envelope;
  unicodeText(key); unicodeText(kind);
  if (key === "" || utf8ToBytes(key).length > 256 || /\p{Cc}/u.test(key) ||
      !/^[a-z0-9_-]{1,64}$/.test(kind)) {
    throw new CommandEncodingError("command key or kind is outside the Kernel text bounds");
  }
  const payload = canonicalCommandPayload(envelope.payload);
  return {
    body: `{"idempotency_key":${JSON.stringify(key)},"kind":${JSON.stringify(kind)},"payload":${payload}}`,
    subject: {
      id: `cmd_${bytesToHex(blake3(utf8ToBytes(`cmd:${key}`)))}`,
      kind,
      payload_digest: bytesToHex(blake3(concatBytes(
        frame("bullet-kernel.command-request.v1"), frame(kind), frame(payload),
      ))),
    },
  };
}
