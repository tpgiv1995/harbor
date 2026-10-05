'use strict';

// Current sessiond wizard, synthetic homes only. The legacy Linux drive also
// covers sharing and validation failures; this Windows lane checks completion
// and the persisted provider profiles without ever displaying a window.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('@playwright/test');
const { APP_ROOT, VERIFY, captureEnv, hiddenMain, assertHidden, closeApp, ownedRoot } = require('../../scripts/lib/capture-runtime.cjs');
const { prepareRoot } = require('../../scripts/lib/demo-corpus.cjs');

async function drive(scenario) {
  const root = prepareRoot(path.join(VERIFY, `harbor-wizard-${scenario}`));
  const env = captureEnv(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(env.HARBOR_USER_DATA_DIR, { recursive: true });
  const providers = scenario === 'full' ? ['claude','codex','cursor-agent'] : scenario === 'codex-only' ? ['codex'] : ['claude'];
  for (const provider of providers) fs.writeFileSync(path.join(bin, `${provider}.cmd`), '@echo off\r\necho fixture-cli 1.0.0\r\n');
  const claudeHomes = scenario === 'codex-only' ? [] : scenario === 'full' ? ['.claude','.claude-team'] : ['.claude'];
  for (const name of claudeHomes) {
    const dir = path.join(root,name);
    fs.mkdirSync(dir, { recursive:true });
    fs.writeFileSync(path.join(dir,'.claude.json'), JSON.stringify({ oauthAccount: { emailAddress:'demo@example.invalid' } }));
  }
  for (const name of ['.codex','.cursor']) fs.mkdirSync(path.join(root,name),{recursive:true});
  fs.writeFileSync(env.HARBOR_CONFIG_FILE, JSON.stringify({ version:1, setup:{completed:false}, profiles:claudeHomes.map((name,i)=>({id:i?'team':'personal',label:i?'Team':'Personal',letter:i?'T':'P',color:'#6fa8d8',provider:'claude',configHome:path.join(root,name),email:null,isDefault:i===0})) }));
  let app;
  try {
    app=await electron.launch({ executablePath:require('electron'), args:[hiddenMain], cwd:APP_ROOT, timeout:60000,
      env:{...env,HARBOR_SHOT_ROOT:root,PATH:[bin,path.join(process.env.SystemRoot,'System32')].join(path.delimiter),HARBOR_E2E_RELAUNCH_LOG:path.join(root,'relaunch.jsonl')} });
    const page=await app.firstWindow({timeout:60000});
    page.setDefaultTimeout(10000);
    await page.waitForSelector('.setup-root');
    await assertHidden(app);
    for (const step of ['platform','claude','providers','catalog','symlinks','orchestration']) {
      await page.waitForSelector(`.setup-shell[data-step="${step}"]`);
      assert.equal(await page.locator('.setup-next').isDisabled(),false, `${scenario}: ${step} must accept detected fixture defaults`);
      await page.locator('.setup-next').click();
    }
    await page.waitForSelector('.setup-shell[data-step="defaults"]');
    await assertHidden(app);
    assert.equal(await page.locator('.setup-finish').isDisabled(),false);
    await page.locator('.setup-finish').click();
    for(let n=0;n<60;n++) {
      const config=JSON.parse(fs.readFileSync(env.HARBOR_CONFIG_FILE,'utf8'));
      if(config.setup?.completed) {
        assert.equal(config.profiles.filter(p=>p.provider==='claude').length,claudeHomes.length);
        if(providers.includes('codex')) assert(config.profiles.some(p=>p.provider==='codex'));
        console.log(`PASS ${scenario}: hidden wizard completed and provider profiles persisted`);
        return;
      }
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error(`${scenario}: completion was not persisted`);
  } finally {
    await closeApp(app);
    fs.rmSync(ownedRoot(root),{recursive:true,force:true});
  }
}

(async()=>{
  const chosen=process.argv[2]||'all';
  const scenarios=chosen==='all'?['full','minimum','codex-only']:[chosen];
  for(const scenario of scenarios) {
    if(!['full','minimum','codex-only'].includes(scenario)) throw new Error('scenario must be full, minimum, codex-only or all');
    await drive(scenario);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
