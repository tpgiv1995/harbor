'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {permissionPrompt}=require('../../src/shared/permission.cjs');
const edit={tool_name:'Edit',tool_input:{file_path:'C:\\Synthetic\\toy.txt',old_string:'red',new_string:'blue'},permission_suggestions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]};
test('permission card preserves edit inputs and exact session suggestion',()=>{
 const prompt=permissionPrompt(edit);
 assert.deepEqual(prompt.toolInput,edit.tool_input);
 assert.deepEqual(prompt.persistent.updates,edit.permission_suggestions);
 assert.match(prompt.persistent.label,/auto-approve file edits and common file commands/);
});
test('WebFetch preserves the server domain rule and offers its label',()=>{
 const input={tool_name:'WebFetch',tool_input:{url:'https://example.com/toy',prompt:'Title'},permission_suggestions:[{type:'addRules',destination:'localSettings',behavior:'allow',rules:[{toolName:'WebFetch',ruleContent:'domain:example.com'}]}]};
 assert.equal(permissionPrompt(input).persistent.label,"Yes, and don't ask again for example.com");
 assert.deepEqual(permissionPrompt(input).persistent.updates,input.permission_suggestions);
});
test('unknown, hook-confirmed and unproven permission shapes stay native',()=>{
 for(const input of [
  {...edit,permission_suggestions:undefined},{...edit,permission_suggestions:[]},
  {...edit,tool_name:'AskUserQuestion'},{...edit,tool_name:'ExitPlanMode'},
  {...edit,tool_name:'Bash'},{...edit,tool_name:'mcp__toy__build'},
  {...edit,permission_suggestions:[...edit.permission_suggestions,{type:'addDirectories'}]},
  {...edit,permission_suggestions:[{type:'setMode',mode:'bypassPermissions',destination:'session'}]},
 ])assert.equal(permissionPrompt(input),null);
});

test('compound Bash preserves every measured rule and the native persistent label', () => {
 const rules = [{toolName:'Bash',ruleContent:'node red.js'},{toolName:'Bash',ruleContent:'node blue.js'}];
 const input = {tool_name:'Bash',tool_input:{command:'node red.js && node blue.js',description:'Print toy colors'},cwd:'C:\\Synthetic',permission_suggestions:[{type:'addRules',behavior:'allow',destination:'localSettings',rules}]};
 const prompt = permissionPrompt(input);
 assert.deepEqual(prompt.persistent.updates,input.permission_suggestions);
 assert.equal(prompt.persistent.label,'Yes, and don\'t ask again for "node red.js" and "node blue.js" commands in C:\\Synthetic');
 assert.equal(permissionPrompt({...input,permission_suggestions:[{...input.permission_suggestions[0],rules:[rules[0]]}]}),null);
 assert.equal(permissionPrompt({...input,permission_suggestions:[{type:'addDirectories',directories:['C:\\Other'],destination:'session'},{type:'setMode',mode:'acceptEdits',destination:'session'}]}),null);
});

test('MCP permission preserves exact tool rule, server, arguments and native label', () => {
 const input = {tool_name:'mcp__toy__paint',tool_input:{color:'blue'},mcp_server:{name:'toy',source:'dynamic'},cwd:'C:\\Synthetic',permission_suggestions:[{type:'addRules',behavior:'allow',destination:'localSettings',rules:[{toolName:'mcp__toy__paint'}]}]};
 const prompt = permissionPrompt(input);
 assert.equal(prompt.serverName,'toy');
 assert.equal(prompt.displayTool,'Paint');
 assert.deepEqual(prompt.toolInput,{color:'blue'});
 assert.deepEqual(prompt.persistent.updates,input.permission_suggestions);
 assert.equal(prompt.persistent.label,"Yes, and don't ask again for toy / Paint commands in C:\\Synthetic");
 assert.equal(permissionPrompt({...input,mcp_server:{name:'another'}}),null);
});
