// Minimal JSON-schema check for tool inputs. With eager input streaming the API
// no longer validates tool inputs, so we check required keys and primitive types.
export function validateInput(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const props = schema.properties || {};
  for (const key of schema.required || []) {
    if (!(key in input)) return `missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const p = props[key];
    if (!p) {
      if (schema.additionalProperties === false) return `unknown field "${key}"`;
      continue;
    }
    if (p.type && !typeMatches(p.type, value)) return `field "${key}" must be ${p.type}`;
    if (p.enum && !p.enum.includes(value)) return `field "${key}" must be one of ${p.enum.join(", ")}`;
    if (p.type === "array" && p.items?.type && !value.every((v) => typeMatches(p.items.type, v))) {
      return `field "${key}" must be an array of ${p.items.type}`;
    }
  }
  return null;
}

function typeMatches(type, v) {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: return true;
  }
}
