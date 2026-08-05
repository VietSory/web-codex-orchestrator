import test from "node:test";
import assert from "node:assert";
import { canonicalJson, canonicalJsonBuffer } from "../src/result-bundle/canonical-json.js";

test("Phase 6 Canonical JSON: keys are sorted", () => {
  const input = { z: 1, a: 2, c: { y: 3, x: 4 } };
  const expected = `{
  "a": 2,
  "c": {
    "x": 4,
    "y": 3
  },
  "z": 1
}
`;
  assert.equal(canonicalJson(input), expected);
});

test("Phase 6 Canonical JSON: array order is preserved", () => {
  const input = { list: [{ b: 1, a: 2 }, { z: 3, y: 4 }] };
  const expected = `{
  "list": [
    {
      "a": 2,
      "b": 1
    },
    {
      "y": 4,
      "z": 3
    }
  ]
}
`;
  assert.equal(canonicalJson(input), expected);
});

test("Phase 6 Canonical JSON: produces LF endings", () => {
  const result = canonicalJson({ a: 1 });
  assert.ok(result.endsWith("\n"), "Must end with newline");
  assert.ok(!result.endsWith("\r\n"), "Must not end with CRLF");
});

test("Phase 6 Canonical JSON: buffer generation", () => {
  const buf = canonicalJsonBuffer({ a: 1 });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString("utf8"), '{\n  "a": 1\n}\n');
});
