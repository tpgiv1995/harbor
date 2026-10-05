'use strict';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function choicesFor(field) {
  const source = field.type === 'array' ? field.items : field;
  if (!record(source)) return [];
  if (Array.isArray(source.enum)) return source.enum.map((value, i) => ({ value, label: String(source.enumNames?.[i] ?? value) }));
  const variants = source.oneOf || source.anyOf;
  return Array.isArray(variants) ? variants.map(item => ({ value: item?.const, label: String(item?.title ?? item?.const) })) : [];
}
function fieldType(field) {
  if (field.type) return field.type;
  const values = choicesFor(field).map(choice => typeof choice.value);
  return values.length && values.every(type => type === values[0]) ? values[0] : null;
}
function supportedSchema(schema) {
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) return false;
  if (Object.keys(schema).some(key => !['$schema','type','title','description','properties','required','additionalProperties'].includes(key))) return false;
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean') return false;
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => !own(schema.properties, key)))) return false;
  return Object.entries(schema.properties).every(([key, field]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !record(field)) return false;
    const types = ['string', 'number', 'integer', 'boolean', 'array'];
    const type = fieldType(field);
    if (!types.includes(type)) return false;
    if (field.format && (type !== 'string' || !['email', 'uri', 'url', 'date', 'date-time'].includes(field.format))) return false;
    if (Object.keys(field).some(k => !['type','title','description','format','minLength','maxLength','minimum','maximum','enum','enumNames','oneOf','default','items','minItems','maxItems','uniqueItems'].includes(k))) return false;
    const choices = choicesFor(field);
    const source = type === 'array' ? field.items : field;
    if (type === 'array' && (!record(source) || Object.keys(source).some(k => !['type','enum','enumNames','oneOf','anyOf'].includes(k)) || !choices.length || choices.some(c => typeof c.value !== 'string'))) return false;
    const variants = source.oneOf || source.anyOf;
    if (variants && (!Array.isArray(variants) || variants.some(item => !record(item) || !own(item,'const') || Object.keys(item).some(k => !['const','title'].includes(k))))) return false;
    if (choices.some(choice => typeof choice.value !== (type === 'array' ? 'string' : type === 'integer' ? 'number' : type) || (type === 'integer' && !Number.isInteger(choice.value)))) return false;
    if (new Set(choices.map(choice => choice.value)).size !== choices.length) return false;
    for (const key of ['minimum','maximum','minLength','maxLength','minItems','maxItems']) {
      if (own(field,key) && (typeof field[key] !== 'number' || !Number.isFinite(field[key]) || (/^(min|max)(Length|Items)$/.test(key) && (!Number.isInteger(field[key]) || field[key] < 0)))) return false;
    }
    if ((field.enum || field.oneOf) && !choices.length) return false;
    return true;
  });
}
function validateContent(schema, content) {
  const errors = {};
  if (!supportedSchema(schema) || !record(content)) return { ok: false, errors: { _form: 'This form cannot be answered here' } };
  for (const [key, rawField] of Object.entries(schema.properties)) {
    const field = {...rawField, type:fieldType(rawField)};
    const value = content[key];
    const missing = !own(content, key) || value === undefined || value === '';
    if (missing) { if (schema.required?.includes(key)) errors[key] = 'Required'; continue; }
    if (field.type === 'string') {
      if (typeof value !== 'string') { errors[key] = 'Enter text'; continue; }
      const size = [...value].length;
      if (field.minLength != null && size < field.minLength) errors[key] = `Use at least ${field.minLength} characters`;
      if (field.maxLength != null && size > field.maxLength) errors[key] = `Use at most ${field.maxLength} characters`;
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[key] = 'Enter a valid email address';
      if (['uri','url'].includes(field.format)) { try { new URL(value); } catch { errors[key] = 'Enter a valid URL'; } }
      if (field.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) errors[key] = 'Enter a valid date';
      if (field.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) errors[key] = 'Enter a valid date and time';
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) errors[key] = field.type === 'integer' ? 'Enter a whole number' : 'Enter a number';
      else if (field.minimum != null && value < field.minimum) errors[key] = `Minimum ${field.minimum}`;
      else if (field.maximum != null && value > field.maximum) errors[key] = `Maximum ${field.maximum}`;
    } else if (field.type === 'boolean' && typeof value !== 'boolean') errors[key] = 'Choose Yes or No';
    else if (field.type === 'array') {
      if (!Array.isArray(value) || new Set(value).size !== value.length) errors[key] = 'Choose from the listed options';
      else if (field.minItems != null && value.length < field.minItems) errors[key] = `Choose at least ${field.minItems}`;
      else if (field.maxItems != null && value.length > field.maxItems) errors[key] = `Choose at most ${field.maxItems}`;
    }
    const choices = choicesFor(field);
    if (choices.length && (field.type === 'array' ? !Array.isArray(value) || value.some(v => !choices.some(c => c.value === v)) : !choices.some(c => c.value === value))) errors[key] = 'Choose from the listed options';
  }
  if (Object.keys(content).some(k => !own(schema.properties, k))) errors._form = 'Unknown form field';
  return { ok: !Object.keys(errors).length, errors };
}
function defaultsFor(schema) {
  return Object.fromEntries(Object.entries(schema.properties || {}).filter(([,field]) => own(field,'default')).map(([key,field]) => [key,field.default]));
}
function safeExternalUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
module.exports = { supportedSchema, fieldType, choicesFor, validateContent, defaultsFor, safeExternalUrl };
