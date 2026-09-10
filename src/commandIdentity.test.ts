import { expect, it } from "vitest";
import { canonicalCommandPayload, CommandEncodingError, prepareCommand } from "./commandIdentity";

// Literal vectors produced by bullet_application::CommandRequest::new with
// serde_json::Map at Kernel 0d4a85c47fff0cde25102b28b5ee3f41eaad65ee.
it("matches the Kernel's command identity and framed request digest", () => {
  expect(prepareCommand({ idempotency_key: "portal_fixture", kind: "run_demo", payload: {} })).toEqual({
    body: '{"idempotency_key":"portal_fixture","kind":"run_demo","payload":{}}',
    subject: {
      id: "cmd_7f17e3847e0e585b4f86bf695a110d43e4ca777a8e8f69018fc7d4aabe476c5e", kind: "run_demo",
      payload_digest: "8255376a5ef33424238fe4163eb1ac32f139e1b7b5477f8d9eca54676b90ebb0",
    },
  });
});

it("matches Rust numeric-key and Unicode ordering independently of insertion order", () => {
  const payload = { z: 0, "10": 10, "2": 2, "\ue000": "bmp", "𐀀": "astral", a: [true, null, -1, Number.MAX_SAFE_INTEGER] };
  const envelope = { idempotency_key: "portál_🛰", kind: "run_demo", payload };
  const expected = '{"10":10,"2":2,"a":[true,null,-1,9007199254740991],"z":0,"\ue000":"bmp","𐀀":"astral"}';
  expect(canonicalCommandPayload(payload)).toBe(expected);
  expect(prepareCommand(envelope).subject).toEqual({
    id: "cmd_79d2f28c168feea8a8d7182f891e74512934154b9a800bf3b226671aa1f61fc4", kind: "run_demo",
    payload_digest: "75e8349f75d6ad5a095d95c569132712ea0a206441b6a186dd89d2fceef19bed",
  });
  expect(prepareCommand({ ...envelope, payload: Object.fromEntries(Object.entries(payload).reverse()) }))
    .toEqual(prepareCommand(envelope));
});

it("matches Rust escaping and counts UTF-8 bytes in every frame", () => {
  const payload = { nested: { z: "line\nquote\"slash/\\nul\0", a: false }, text: "é\t\b\f\r" };
  expect(prepareCommand({ idempotency_key: "escaped", kind: "run_demo", payload }).subject).toEqual({
    id: "cmd_a6b296e774cd99a43e8355ffa0bba55a8a3e0948431cd69a5e9497d4b20de11f", kind: "run_demo",
    payload_digest: "75c3457580c068f8a9539113cf33bf2b9624bdbd8c1f3810ab44c6d81b15d4ce",
  });
});

it("rejects ambiguous non-JSON values without invoking accessors or toJSON", () => {
  let invoked = false;
  const getter = Object.defineProperty({}, "a", { enumerable: true, get() { invoked = true; return 1; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const extra = [1]; Object.assign(extra, { extra: 2 });
  for (const payload of [null, [], { a: undefined }, { a: NaN }, { a: Infinity }, { a: 1.5 },
    { a: Number.MAX_SAFE_INTEGER + 1 }, { a: 1n }, { a: Symbol() }, { a: () => 1 },
    { a: new Date() }, { a: new Map() }, getter, { toJSON() { invoked = true; return {}; } },
    { a: [, 1] }, { a: extra }, { [Symbol()]: 1 }, { a: "\ud800" }, { "\udfff": 1 }, cycle]) {
    expect(() => canonicalCommandPayload(payload)).toThrow(CommandEncodingError);
  }
  expect(invoked).toBe(false);
});

it("enforces encoded byte bounds and snapshots the submitted body", () => {
  const envelope = { idempotency_key: "key", kind: "run_demo", payload: { text: "x" } };
  const prepared = prepareCommand(envelope);
  envelope.payload.text = "changed";
  expect(prepared.body).toContain('"text":"x"');
  expect(prepareCommand(envelope).subject.payload_digest).not.toBe(prepared.subject.payload_digest);
  expect(() => canonicalCommandPayload({ text: "é".repeat(524_288) })).toThrow("UTF-8 bytes");
  for (const key of ["", "x".repeat(257), "é".repeat(129), "key\u0085", "\ud800"]) {
    expect(() => prepareCommand({ ...envelope, idempotency_key: key })).toThrow(CommandEncodingError);
  }
  for (const kind of ["", "Run", "x".repeat(65), "run\n"]) {
    expect(() => prepareCommand({ ...envelope, kind })).toThrow(CommandEncodingError);
  }
});
