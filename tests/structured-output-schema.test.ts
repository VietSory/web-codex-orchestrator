import { strict as assert } from "node:assert";
import test from "node:test";
import {
  ASSESSMENT_OUTPUT_SCHEMA,
  IMPLEMENTATION_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
} from "../src/agent/output-schemas.js";
import { assertStructuredOutputSchema } from "../src/agent/structured-output-schema.js";
import { ExecutionError } from "../src/execution/errors.js";

function expectInvalidSchema(
  action: () => unknown,
): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof ExecutionError &&
      error.code === "AGENT_OUTPUT_INVALID",
  );
}

test(
  "P4-116: every production structured-output schema satisfies strict required-field rules",
  () => {
    assert.doesNotThrow(() =>
      assertStructuredOutputSchema(
        ASSESSMENT_OUTPUT_SCHEMA,
      ),
    );

    assert.doesNotThrow(() =>
      assertStructuredOutputSchema(
        IMPLEMENTATION_OUTPUT_SCHEMA,
      ),
    );

    assert.doesNotThrow(() =>
      assertStructuredOutputSchema(
        REVIEW_OUTPUT_SCHEMA,
      ),
    );
  },
);

test(
  "P4-117: a property omitted from required is rejected before Codex",
  () => {
    const invalid = structuredClone(
      REVIEW_OUTPUT_SCHEMA,
    ) as Record<string, unknown>;

    const properties =
      invalid.properties as Record<string, unknown>;

    properties.optional_debug = {
      type: "string",
    };

    expectInvalidSchema(() =>
      assertStructuredOutputSchema(invalid),
    );
  },
);

test(
  "P4-118: nested object schemas must also require every property",
  () => {
    const invalid = {
      type: "object",
      additionalProperties: false,
      properties: {
        result: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: {
              type: "string",
            },
          },
          required: [],
        },
      },
      required: ["result"],
    };

    expectInvalidSchema(() =>
      assertStructuredOutputSchema(invalid),
    );
  },
);

test(
  "P4-119: duplicate required entries are rejected",
  () => {
    const invalid = {
      type: "object",
      additionalProperties: false,
      properties: {
        result: {
          type: "string",
        },
      },
      required: ["result", "result"],
    };

    expectInvalidSchema(() =>
      assertStructuredOutputSchema(invalid),
    );
  },
);
