'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');

test('the actual board-window factory never activates a harness window', () => {
  const calls=[];
  class Window extends EventEmitter {
    constructor(options) { super(); this.webContents={on(){},setWindowOpenHandler(){}}; calls.push(['born',options.show]); }
    loadFile(){ this.emit('ready-to-show'); }
    show(){ calls.push(['show']); }
    showInactive(){ calls.push(['inactive']); }
  }
  const factory=source.slice(source.indexOf('function createBoardWindow()'),source.indexOf('\nfunction createWindow()'));
  vm.runInNewContext(factory+'\ncreateBoardWindow();',{BrowserWindow:Window,e2eMode:true,path,__dirname:'.',boardWindows:new Set(),process:{env:{}},isShellNavigation:()=>false});
  assert.deepEqual(calls,[['born',false],['inactive']]);
});

test('inactive maximized startup preserves normal geometry and maximize state through persistence and restore', () => {
  // Execute the shipped startup branch and persistence function with a window
  // model. No Electron import, browser, display, or real profile is involved.
  const normal={x:2100,y:120,width:1100,height:800};
  const area={x:1920,y:0,width:1920,height:1040};
  let bounds={...normal},restore={...normal},maximized=false,saved;
  const win=new EventEmitter();
  const calls=[];
  Object.assign(win,{getBounds:()=>({...bounds}),getNormalBounds:()=>({...restore}),isMaximized:()=>maximized,isDestroyed:()=>false,
    setBounds:b=>{bounds={...b};restore={...b};calls.push('bounds');},showInactive:()=>calls.push('inactive'),
    maximize:()=>{restore={...bounds};maximized=true;bounds={...area};calls.push('maximize');},
    unmaximize:()=>{maximized=false;bounds={...restore};},webContents:{send(){}}});
  const branch=source.slice(source.indexOf("window.once('ready-to-show', () => {"),source.indexOf("  window.on('focus', () => {",source.indexOf("window.once('ready-to-show', () => {")));
  const persist=source.slice(source.indexOf('function persistWindowState('),source.indexOf('\nfunction clampToDisplay('));
  const context={window:win,noFocusSteal:true,e2eMode:false,savedState:{...normal,maximized:true},process:{platform:'win32'},platform:{readActiveWindow:()=>null,focusGuard(){}},markColdStartInteractive(){},sendMaxState(){},sendToRenderer(){},path,WINDOW_STATE_PATH:'synthetic.json',
    require:name=>name==='electron'?{screen:{getDisplayMatching:()=>({workArea:area})}}:name==='node:fs'?{mkdirSync(){},writeFileSync:(_p,s)=>{saved=JSON.parse(s);}}:require(path.join(__dirname,'../../src/main',name))};
  // New helper is optional here so this same test also runs against the old code.
  const helper=path.join(__dirname,'../../src/main/window-presentation.js');
  if(fs.existsSync(helper)) context.windowPresentation=require(helper);
  vm.runInNewContext(persist+'\n'+branch+'\nwindow.emit("ready-to-show"); persistWindowState(window);',context);
  assert.deepEqual(saved,{...normal,maximized:true});
  assert.equal(context.windowPresentation.isMaximized(win),true,'the title bar sees the intended state');
  assert.ok(!calls.includes('maximize'),'startup must not activate by maximizing');
  win.emit('focus');
  assert.equal(maximized,true);
  win.unmaximize();
  assert.deepEqual(bounds,normal,'restore must recover the pre-restart normal rectangle');
});

test('Restore before activation cancels the deferred maximize', () => {
  const presentation=require('../../src/main/window-presentation.js');
  const normal={x:-1500,y:80,width:1000,height:700};
  let bounds=normal, maximizes=0;
  const win=Object.assign(new EventEmitter(),{getBounds:()=>({...bounds}),setBounds:b=>{bounds={...b};},showInactive(){},isMaximized:()=>false,isDestroyed:()=>false,maximize:()=>maximizes++});
  presentation.showInactiveMaximized(win,{getDisplayMatching:()=>({workArea:{x:-1920,y:0,width:1920,height:1080}})});
  presentation.toggleMaximized(win);
  assert.deepEqual(bounds,normal);
  assert.equal(presentation.isMaximized(win),false);
  win.emit('focus');
  assert.equal(maximizes,0);
});
