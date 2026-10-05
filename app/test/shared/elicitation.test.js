'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {supportedSchema,validateContent,choicesFor,defaultsFor,safeExternalUrl}=require('../../src/shared/elicitation.cjs');
const schema={type:'object',properties:{name:{type:'string',minLength:2,maxLength:4},count:{type:'integer',minimum:1,maximum:5},ratio:{type:'number',minimum:0},enabled:{type:'boolean',default:false},color:{type:'string',oneOf:[{const:'b',title:'Blue'},{const:'r',title:'Red'}]},tags:{type:'array',items:{type:'string',enum:['a','b'],enumNames:['Alpha','Beta']},minItems:1,maxItems:2}},required:['name','enabled']};
test('elicitation validates mixed primitives, required fields, ranges, enums, defaults and arrays',()=>{
 assert.equal(supportedSchema(schema),true); assert.deepEqual(defaultsFor(schema),{enabled:false});
 assert.equal(validateContent(schema,{name:'Toy',enabled:false,count:3,ratio:.5,color:'b',tags:['a']}).ok,true);
 const invalid=validateContent(schema,{name:'x',count:1.5,ratio:-1,enabled:'yes',color:'green',tags:['a','a']});
 for(const name of Object.keys(schema.properties))assert.ok(invalid.errors[name],name);
 assert.equal(validateContent(schema,{}).errors.name,'Required');
 assert.equal(validateContent(schema,{name:'longer',enabled:true}).ok,false);
 assert.equal(validateContent(schema,{name:'Toy',enabled:false,count:7}).ok,false);
 assert.deepEqual(choicesFor(schema.properties.color),[{value:'b',label:'Blue'},{value:'r',label:'Red'}]);
});
test('elicitation rejects unsupported nested schemas and unexpected fields',()=>{
 assert.equal(supportedSchema({type:'object',properties:{nested:{type:'object',properties:{}}}}),false);
 assert.equal(supportedSchema({type:'object',properties:{name:{type:'string',pattern:'x'}}}),false);
 assert.equal(validateContent(schema,{name:'Toy',enabled:true,extra:'hidden'}).ok,false);
 for(const extra of [{oneOf:[]},{dependencies:{name:['count']}},{additionalProperties:{type:'string'}}])assert.equal(supportedSchema({...schema,...extra}),false);
 for(const field of [{type:'string',oneOf:[{title:'Missing value'}]},{type:'array',items:{type:'string',enum:['a'],pattern:'a'}},{type:'integer',enum:[1.5]},{type:'string',minLength:'two'}])assert.equal(supportedSchema({type:'object',properties:{x:field}}),false);
});
test('single-select const/title choices can infer their primitive type',()=>{
 const shape={type:'object',properties:{color:{oneOf:[{const:'b',title:'Blue'},{const:'r',title:'Red'}]}}};
 assert.equal(supportedSchema(shape),true);
 assert.equal(validateContent(shape,{color:'b'}).ok,true);
 assert.equal(validateContent(shape,{color:'green'}).ok,false);
});
test('elicitation enforces string formats and safe external URLs',()=>{
 for(const [format,good,bad] of [['email','a@example.com','no'],['uri','https://example.com','no'],['date','2026-10-03','2026-02-30'],['date-time','2026-10-03T12:00:00Z','today']]){
  const shape={type:'object',properties:{x:{type:'string',format}}};
  assert.equal(validateContent(shape,{x:good}).ok,true);assert.equal(validateContent(shape,{x:bad}).ok,false);
 }
 assert.equal(safeExternalUrl('https://example.com/path'),'https://example.com/path');
 for(const value of ['file:///C:/secret','javascript:alert(1)','https://user:pass@example.com'])assert.equal(safeExternalUrl(value),null);
});
