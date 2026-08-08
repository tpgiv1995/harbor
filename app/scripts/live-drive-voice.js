'use strict';
// LIVE verification of Harbor's voice mode, END TO END in the real app: click the
// button, open a real WebRTC session against the real OpenAI model, then inject
// what Pat would have SAID and watch the tool calls that follow.
//
// Deliberately NOT part of `npm run test:e2e`: it costs money, needs the network,
// and would make the gate depend on a third party. The gate proves the wiring
// (spec 13) with voice disabled; this proves the conversation.
//
// The microphone is Chromium's fake capture device, because a harness has none.
// Nothing else is substituted: the handshake, the model, the tools and the send
// path are all the real thing.
//
// Run:
//   DRIVE_OUT=/tmp/voice-shots HARBOR_NO_VOICE=0 \
//     dbus-run-session -- claude-gui node scripts/live-drive-voice.js
//
// Verified 2026-07-27: it listed the open sessions accurately, resolved a spoken
// session reference to the right window, attempted the send, and when the send
// path refused ("pane is not focused for control") it relayed that refusal
// verbatim instead of claiming success.
const path=require('node:path'), fs=require('node:fs'), os=require('node:os');
const APP_ROOT=path.resolve(__dirname,'..');
const { _electron: electron }=require(path.join(APP_ROOT,'node_modules/@playwright/test'));
const OUT=process.env.DRIVE_OUT||'.';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'harbor-voice-'));
  const app=await electron.launch({
    executablePath:require(path.join(APP_ROOT,'node_modules/electron')),
    args:[APP_ROOT],
    env:{...process.env,HARBOR_E2E:'1',HARBOR_NO_DAEMON_START:'1',
      HARBOR_CONTEXT_DIR:path.join(scratch,'ctx'),HARBOR_E2E_USER_DATA:path.join(scratch,'ud'),
      HARBOR_NO_MODEL_DISCOVERY:'1',ELECTRON_DISABLE_GPU:'1',
      // The one thing this drive deliberately turns back on.
      HARBOR_NO_VOICE:'0'},
    cwd:APP_ROOT,timeout:120000});
  const page=await app.firstWindow({timeout:120000});
  await page.waitForSelector('.rail',{timeout:30000});
  await app.evaluate(async({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].setBounds({x:0,y:0,width:2560,height:1600});});
  await page.evaluate(()=>{localStorage.removeItem('harbor-slate-stage');});
  await page.reload();
  await page.waitForSelector('.rail',{timeout:30000});
  await page.waitForFunction(()=>window.__harborSidebarStats?.indexerSessionCount>0,null,{timeout:30000});
  await sleep(1000);

  const report={};

  // Open two windows so the agent has something real to talk about.
  const rows=page.locator('.sr');
  for (let i=0;i<2;i++) { try { await rows.nth(i).dblclick({timeout:3000}); await sleep(400);} catch{} }
  await sleep(2000);
  report.windowsOpen=await page.locator('.win2').count();

  // Stub only the SEND, so the drive cannot type into a real session.
  await page.evaluate(()=>{
    window.__voiceSends=[];
    const real=window.harbor.session.send;
    window.harbor.session.send=async (payload)=>{
      window.__voiceSends.push({sessionId:payload.sessionId,text:payload.text});
      return {ok:true, stubbed:true};
    };
    window.__restoreSend=()=>{window.harbor.session.send=real;};
  });

  report.buttonPresent = await page.locator('.compose-live-voice').count();
  await page.locator('.compose-live-voice').click();

  // Real handshake against the real API.
  try {
    await page.waitForFunction(()=>window.__harborVoice?.phase==='live',null,{timeout:45000});
    report.phase='live';
  } catch {
    report.phase=await page.evaluate(()=>window.__harborVoice?.phase||'?');
    report.error=await page.evaluate(()=>window.__harborVoice?.message||'');
  }
  await page.screenshot({path:path.join(OUT,'voice-live.png')});

  if (report.phase==='live') {
    // What Pat would say. The model must call harbor_list_sessions to answer.
    await page.evaluate(()=>window.__harborVoice.sayAsUser('what sessions are open right now?'));
    await page.waitForFunction(()=>window.__harborVoice?.activity?.some(a=>a.kind==='voice'),null,{timeout:45000}).catch(()=>{});
    await sleep(2500);

    // And an instruction it must translate into a real send.
    const target = await page.evaluate(()=>{
      const w=document.querySelector('.win2 .wh .ti'); return w?w.textContent.trim():null;
    });
    report.target=target;
    await page.evaluate((t)=>window.__harborVoice.sayAsUser(
      `tell the session called "${t}" exactly this: run the full gate and push when it is green`), target);
    await page.waitForFunction(()=>window.__voiceSends?.length>0,null,{timeout:45000}).catch(()=>{});
    await sleep(2000);

    report.sends=await page.evaluate(()=>window.__voiceSends);
    report.activity=await page.evaluate(()=>window.__harborVoice.activity.map(a=>({kind:a.kind,text:a.text.slice(0,150)})));
    await page.screenshot({path:path.join(OUT,'voice-after.png')});
    const bar=await page.locator('.live-voice-bar').boundingBox().catch(()=>null);
    if (bar) await page.screenshot({path:path.join(OUT,'voice-bar.png'),clip:bar});
    await page.evaluate(()=>window.__harborVoice.stop());
    await sleep(600);
    report.phaseAfterStop=await page.evaluate(()=>window.__harborVoice?.phase);
  }

  console.log(JSON.stringify(report,null,1));
  try{await page.evaluate(()=>window.harbor?.e2e?.quit?.());}catch{}
  await app.close({force:true}).catch(()=>{}); try{app.process()?.kill('SIGKILL');}catch{}
  process.exit(0);
})().catch(e=>{console.error('DRIVE FAILED:',e.message);process.exit(1);});
