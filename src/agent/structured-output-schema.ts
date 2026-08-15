import { ExecutionError } from "../execution/errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function fail(schemaPath: string, message: string): never {
  throw new ExecutionError(
    "AGENT_OUTPUT_INVALID",
    `Invalid structured-output schema at ${schemaPath}: ${message}.`,
    {
      schema_path: schemaPath,
    },
  );
}

function visitSchema(
  node: unknown,
  schemaPath: string,
  seen: Set<object>,
): void {
  if (!isRecord(node)) {
    return;
  }

  if (seen.has(node)) {
    return;
  }

  seen.add(node);

  if ((Object.hasOwn(node, "const") || Object.hasOwn(node, "enum")) && !Object.hasOwn(node, "type")) {
    fail(schemaPath, "const and enum schemas must declare an explicit type");
  }

  if (node.type === "object") {
    if (node.additionalProperties !== false) {
      fail(
        schemaPath,
        "object schemas must set additionalProperties to false",
      );
    }

    if (!isRecord(node.properties)) {
      fail(schemaPath, "object schemas must define properties");
    }

    if (
      !Array.isArray(node.required) ||
      !node.required.every(
        (entry): entry is string => typeof entry === "string",
      )
    ) {
      fail(
        schemaPath,
        "object schemas must define a string required array",
      );
    }

    const required = node.required as string[];

    if (new Set(required).size !== required.length) {
      fail(
        schemaPath,
        "the required array contains duplicate field names",
      );
    }

    const propertyNames = Object.keys(node.properties).sort();
    const requiredNames = [...required].sort();

    const sameNames =
      propertyNames.length === requiredNames.length &&
      propertyNames.every(
        (propertyName, index) =>
          propertyName === requiredNames[index],
      );

    if (!sameNames) {
      fail(
        schemaPath,
        "every property must appear exactly once in required",
      );
    }

    for (const [name, child] of Object.entries(node.properties)) {
      visitSchema(
        child,
        `${schemaPath}.properties.${name}`,
        seen,
      );
    }
  }

  if (isRecord(node.items)) {
    visitSchema(node.items, `${schemaPath}.items`, seen);
  } else if (Array.isArray(node.items)) {
    node.items.forEach((child, index) => {
      visitSchema(
        child,
        `${schemaPath}.items[${index}]`,
        seen,
      );
    });
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    const union = node[unionKey];

    if (Array.isArray(union)) {
      union.forEach((child, index) => {
        visitSchema(
          child,
          `${schemaPath}.${unionKey}[${index}]`,
          seen,
        );
      });
    }
  }

  for (const definitionsKey of ["$defs", "definitions"] as const) {
    const definitions = node[definitionsKey];

    if (isRecord(definitions)) {
      for (const [name, child] of Object.entries(definitions)) {
        visitSchema(
          child,
          `${schemaPath}.${definitionsKey}.${name}`,
          seen,
        );
      }
    }
  }
}

export function assertStructuredOutputSchema(
  schema: Record<string, unknown>,
): void {
  if (schema.type !== "object") {
    fail("$", "the root schema must have type object");
  }

  visitSchema(schema, "$", new Set<object>());
}
