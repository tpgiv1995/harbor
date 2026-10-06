'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fetchOauthUsage}=require('../../src/main/providers/usage.js');
test('Claude can use an injected app-managed credential reader when no file exists',async()=>{
 const r=await fetchOauthUsage('/claude',{readCredentials:async()=>({claudeAiOauth:{accessToken:'fixture',expiresAt:9999999999999}}),readFile:async()=>{throw Error('missing')},fetchImpl:async(_,o)=>{assert.equal(o.headers.authorization,'Bearer fixture');return {ok:true,json:async()=>({five_hour:{utilization:22}})}}});assert.equal(r.payload.rate_limits.five_hour.used_percentage,22);
});
test('Claude missing login produces an actionable reason without a network request',async()=>{
 const r=await fetchOauthUsage('/claude',{readCredentials:async()=>({claudeAiOauth:{expiresAt:0}}),reportUnavailable:true,fetchImpl:async()=>{throw Error('must not call')}});assert.match(r.reason,/sign in/i);assert.equal(r.unavailable,true);
});
