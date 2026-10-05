'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createReplyStore,frameReply,quotePath}=require('../../src/renderer/stage/question-reply.cjs');
const questions=[{question:'Which color?',options:[{label:'Blue'}]},{question:'Which size?',options:[{label:'Small'}]}];
test('reply arming belongs to its session and disappears without modifying a draft',()=>{
 const store=createReplyStore();const a={id:'a',sessionId:'one',questions};const b={id:'b',sessionId:'two',questions};
 store.arm(a);store.arm(b);assert.equal(store.get('one').id,'a');
 store.cancel('one','old');assert.equal(store.get('one').id,'a');
 store.show('one');assert.equal(store.get('one').collapsed,false);
 store.reconcile([b]);assert.equal(store.get('one'),null);assert.equal(store.get('two').id,'b');
 store.reconcile([{...b,answered:true}]);assert.equal(store.get('two'),null);
});
test('chat reply carries clarification, every question, text, and quoted attachment paths',()=>{
 const text=frameReply({questions},'Discuss first',['C:\\Test Images\\toy.png']);
 assert.match(text,/The user wants to clarify/);assert.match(text,/Which color/);assert.match(text,/Which size/);assert.match(text,/Discuss first/);assert.ok(text.includes('"C:\\Test Images\\toy.png"'));
 assert.equal(quotePath('C:\\toy.txt'),'C:\\toy.txt');
});
