// Minimal JSON-Schema-subset validator (type/object/properties/required,
// items for arrays). Zero deps; full ajv is overkill for tool arg checks.
const TYPES = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', object: 'object', array: 'array' };

function typeOk(v, t) {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === TYPES[t];
}

/**
 * @param {unknown} value
 * @param {object} schema
 * @param string [path] for error messages
 * @returns string[] list of human-readable errors, empty = valid
 */
export function validateArgs(value, schema, path = 'args') {
  const errors = [];
  if (schema.type) {
    if (!TYPES[schema.type] || !typeOk(value, schema.type)) {
      return [`${path}: expected ${schema.type}`];
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}.${req}: required`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown property`);
        continue;
      }
      errors.push(...validateArgs(v, props[k], `${path}.${k}`));
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateArgs(v, schema.items, `${path}[${i}]`)));
  }
  return errors;
}
