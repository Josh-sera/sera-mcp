// Tiny zod -> JSON Schema converter. Just enough to give MCP clients a usable
// input schema for our tool surface without adding another dependency.

import type { z } from "zod";

type JsonSchema = Record<string, any>;

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as any)._def;
  const typeName: string = def.typeName;

  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries<any>(shape)) {
        properties[key] = convert(val);
        if (!val.isOptional() && !(val._def?.typeName === "ZodDefault")) {
          required.push(key);
        }
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length) out.required = required;
      return out;
    }
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      if (def.description) out.description = def.description;
      return out;
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      if (def.description) out.description = def.description;
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodUnion": {
      const opts = def.options.map((o: any) => convert(o));
      return { anyOf: opts };
    }
    case "ZodOptional":
      return convert(def.innerType);
    case "ZodDefault": {
      const inner = convert(def.innerType);
      inner.default = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      return inner;
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: true };
    case "ZodArray":
      return { type: "array", items: convert(def.type) };
    case "ZodLiteral":
      return { const: def.value };
    default:
      return {};
  }
}
