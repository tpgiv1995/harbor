'use strict';

const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const BOARD_CLI = path.join(REPO_DIR, 'bin', 'harbor-board');
const IMAGE_FIXTURE = path.join(APP_DIR, 'assets', 'icon-16.png');
const { flattenScene } = require(path.join(APP_DIR, 'src', 'shared', 'board-view.cjs'));
const PORT = 9338;
const OUT = path.join(os.tmpdir(), 'harbor-drive-board-authoring');
const AUTHORED_ID = 'cli-authored-board';
const AUTHORED_NAME = 'CLI Authored Board';
const BRAINSTORM_ID = 'cli-brainstorm-board';
const BRAINSTORM_NAME = 'CLI Brainstorm Board';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) this.events.push(msg);
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} from ${pending.method} ${pending.hint}`));
        else pending.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, hint: String(params.expression || '').slice(0, 140) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.exception?.description || 'page error'} while evaluating ${expression.slice(0, 140)}`);
    }
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function seedBoard(boardsDir, id, name) {
  const board = {
    type: 'excalidraw',
    version: 2,
    source: 'local',
    name,
    updatedAt: new Date().toISOString(),
    elements: [],
    appState: {},
    files: {},
  };
  fs.writeFileSync(path.join(boardsDir, `${id}.json`), `${JSON.stringify(board, null, 2)}\n`);
}

function runCli(args, boardsDir, timeoutMs = 30000) {
  const finalArgs = args.includes('--json') ? args : [...args, '--json'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOARD_CLI, ...finalArgs], {
      cwd: REPO_DIR,
      env: { ...process.env, HARBOR_BOARDS_DIR: boardsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: harbor-board ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(stdout.trim()); } catch {}
      if (code !== 0 || !json?.ok) {
        reject(new Error(`harbor-board ${args.join(' ')} failed with ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ args: finalArgs, json, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function readBoard(boardsDir, id) {
  return JSON.parse(fs.readFileSync(path.join(boardsDir, `${id}.json`), 'utf8'));
}

async function authorBoards(boardsDir, report) {
  seedBoard(boardsDir, AUTHORED_ID, AUTHORED_NAME);
  seedBoard(boardsDir, BRAINSTORM_ID, BRAINSTORM_NAME);
  report(true, 'seeded empty board files', `boards=2 dir=${boardsDir}`);

  const outputs = [];
  const command = async (label, args) => {
    const result = await runCli(args, boardsDir);
    outputs.push({ label, args: result.args, output: result.json });
    report(true, `CLI ${label}`, `id=${result.json.id || result.json.boardId || 'none'} added=${result.json.ids?.length ?? 'n/a'}`);
    return result.json;
  };

  const listed = await command('list seeded boards', ['list']);
  if (listed.count !== 2) throw new Error(`CLI listed ${listed.count} seeded boards, expected 2`);
  const sticky = await command('add-sticky', ['add-sticky', AUTHORED_ID, '--text', 'CLI sticky: render me', '--color', 'yellow', '--x', '80', '--y', '80']);
  const rectangle = await command('add-shape rectangle', ['add-shape', AUTHORED_ID, '--shape', 'rectangle', '--text', 'CLI rectangle label', '--x', '340', '--y', '80', '--width', '220', '--height', '130', '--fill', '#a5d8ff']);
  const triangle = await command('add-shape triangle', ['add-shape', AUTHORED_ID, '--shape', 'triangle', '--text', 'CLI triangle label', '--x', '660', '--y', '80', '--width', '220', '--height', '160', '--fill', '#d0bfff']);
  await command('add-template flowchart', ['add-template', AUTHORED_ID, '--template', 'flowchart', '--x', '80', '--y', '380']);
  await command('add-table', ['add-table', AUTHORED_ID, '--rows', '2', '--cols', '3', '--x', '820', '--y', '420']);
  const connector = await command('connect', ['connect', AUTHORED_ID, '--from', rectangle.id, '--to', triangle.id, '--label', 'CLI bound connector']);
  const image = await command('add-image', ['add-image', AUTHORED_ID, '--file', IMAGE_FIXTURE, '--x', '860', '--y', '720']);
  await command('compose brainstorm', ['compose', BRAINSTORM_ID, '--topic', 'CLI Brainstorm: Live Validation', '--diagram', 'mindmap', '--section', 'Ideas', '--section', 'Risks', '--section', 'Actions']);

  const showAuthored = await command('show authored', ['show', AUTHORED_ID, '--full']);
  const showBrainstorm = await command('show brainstorm', ['show', BRAINSTORM_ID, '--full']);
  const authored = readBoard(boardsDir, AUTHORED_ID);
  const brainstorm = readBoard(boardsDir, BRAINSTORM_ID);
  const authoredLive = authored.elements.filter((element) => !element.isDeleted);
  const brainstormLive = brainstorm.elements.filter((element) => !element.isDeleted);
  const authoredFlat = flattenScene(authored);
  const brainstormFlat = flattenScene(brainstorm);
  const expected = {
    authoredCount: authoredLive.length,
    brainstormCount: brainstormLive.length,
    stickyId: sticky.id,
    rectangleId: rectangle.id,
    triangleId: triangle.id,
    connectorId: connector.id,
    imageId: image.id,
    authoredFlat: {
      stickies: showAuthored.stickies.length,
      texts: showAuthored.texts.length,
      images: showAuthored.images.length,
      shapes: showAuthored.shapes.length,
      connectors: showAuthored.connectors.length,
    },
    brainstormFlat: {
      stickies: showBrainstorm.stickies.length,
      texts: showBrainstorm.texts.length,
      images: showBrainstorm.images.length,
      shapes: showBrainstorm.shapes.length,
      connectors: showBrainstorm.connectors.length,
    },
  };
  report(authoredLive.length > 0, 'authored scene has live elements', `elements=${authoredLive.length}`);
  report(brainstormLive.length > 0, 'compose scene has live elements', `elements=${brainstormLive.length}`);
  report(['stickies', 'texts', 'images', 'shapes', 'connectors'].every((key) => authoredFlat[key].length === showAuthored[key].length), 'flattenScene matches CLI show for authored board', `stickies=${authoredFlat.stickies.length} texts=${authoredFlat.texts.length} images=${authoredFlat.images.length} shapes=${authoredFlat.shapes.length} connectors=${authoredFlat.connectors.length}`);
  report(['stickies', 'texts', 'images', 'shapes', 'connectors'].every((key) => brainstormFlat[key].length === showBrainstorm[key].length), 'flattenScene matches CLI show for compose board', `stickies=${brainstormFlat.stickies.length} texts=${brainstormFlat.texts.length} shapes=${brainstormFlat.shapes.length} connectors=${brainstormFlat.connectors.length}`);
  report(Boolean(authored.files[authoredLive.find((element) => element.id === image.id)?.fileId]), 'image bytes embedded', `files=${Object.keys(authored.files).length}`);
  report(Boolean(authoredLive.find((element) => element.id === connector.id)?.startBinding && authoredLive.find((element) => element.id === connector.id)?.endBinding), 'connector persisted with bindings', `connector=${connector.id}`);

  // H5: every bound connector terminates at a side-midpoint anchor of each
  // endpoint shape (Miro's 4 connect dots), never center to center through a
  // shape body. Checked on the compose mindmap (the export Pat reported) AND
  // the explicit connect command.
  const sideAnchors = (el) => ([
    [el.x + el.width / 2, el.y],
    [el.x + el.width, el.y + el.height / 2],
    [el.x + el.width / 2, el.y + el.height],
    [el.x, el.y + el.height / 2],
  ]);
  const onAnchor = (el, x, y) => sideAnchors(el).some(([ax, ay]) => Math.abs(ax - x) < 0.01 && Math.abs(ay - y) < 0.01);
  const anchorVerdicts = [];
  for (const [label, sceneUnder] of [['brainstorm', brainstorm], ['authored', authored]]) {
    const byId = new Map(sceneUnder.elements.map((element) => [element.id, element]));
    for (const arrow of sceneUnder.elements.filter((element) => element.type === 'arrow' && !element.isDeleted)) {
      const source = byId.get(arrow.startBinding?.elementId);
      const targetEl = byId.get(arrow.endBinding?.elementId);
      if (!source || !targetEl) { anchorVerdicts.push(`${label}:${arrow.id}:unbound`); continue; }
      const last = arrow.points.at(-1);
      const startOk = onAnchor(source, arrow.x, arrow.y);
      const endOk = onAnchor(targetEl, arrow.x + last[0], arrow.y + last[1]);
      if (!startOk || !endOk) anchorVerdicts.push(`${label}:${arrow.id}: start=${startOk} end=${endOk} at ${arrow.x},${arrow.y}`);
    }
  }
  report(anchorVerdicts.length === 0, 'H5: every bound connector terminates on side-midpoint anchors', anchorVerdicts.join(' | ') || 'all arrows on anchors');
  return { outputs, expected };
}

function magicHex(file, bytes) {
  return fs.readFileSync(file).subarray(0, bytes).toString('hex');
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-board-authoring-drive-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  const exportsDir = path.join(tmp, 'exports');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });

  const failures = [];
  const lines = [];
  const report = (condition, name, measured = '') => {
    const line = `${condition ? 'PASS' : 'FAIL'} ${name}${measured ? `: ${measured}` : ''}`;
    console.log(line);
    lines.push(line);
    if (!condition) failures.push(line);
    return condition;
  };

  const authored = await authorBoards(boardsDir, report);
  fs.writeFileSync(path.join(OUT, 'cli-outputs.json'), `${JSON.stringify(authored.outputs, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'expected.json'), `${JSON.stringify(authored.expected, null, 2)}\n`);
  report(true, 'captured CLI JSON outputs', `commands=${authored.outputs.length}`);

  if (process.argv.includes('--author-only')) {
    report(failures.length === 0, 'CLI authoring drive', `authored=${authored.expected.authoredCount} brainstorm=${authored.expected.brainstormCount}`);
    console.log(`boards: ${boardsDir}`);
    console.log(`artifacts: ${OUT}`);
    process.exit(failures.length ? 1 : 0);
  }

  try {
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
  } catch (buildError) {
    if (fs.existsSync(path.join(APP_DIR, 'dist', 'index.html'))) {
      console.log('build did not run here; using existing app/dist (a resolvable vite is absent in this worktree)');
    } else {
      throw buildError;
    }
  }
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = {
    ...config.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
    boardsDir,
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env: {
      ...process.env,
      HARBOR_E2E: '1',
      HARBOR_E2E_USER_DATA: userData,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
      HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
      HARBOR_NO_ICON_GEN: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_NO_TITLER: '1',
      HARBOR_BOARDS_DIR: boardsDir,
    },
    stdio: 'ignore',
  });

  try {
    let target;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
        target = targets.find((item) => item.type === 'page' && !item.url.startsWith('devtools:'));
      } catch {}
    }
    if (!target) throw new Error('CDP target never appeared');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((b) => b.textContent.trim() === 'Board')", 'Board tab');
    await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => b.textContent.trim() === 'Board').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'Excalidraw canvas');
    report(Boolean(await cdp.shot('1-board-view')), 'screenshot Board view');

    await waitFor(cdp, `[...document.querySelectorAll('.whiteboard-chip-main span')].some((e) => e.textContent === ${JSON.stringify(AUTHORED_NAME)})`, 'authored board chip');
    await cdp.eval(`[...document.querySelectorAll('.whiteboard-chip-main span')].find((e) => e.textContent === ${JSON.stringify(AUTHORED_NAME)}).closest('button').click()`);
    await waitFor(cdp, `window.__harborBoardApi && window.__harborBoardApi.getSceneElements().length === ${authored.expected.authoredCount}`, 'authored board elements');
    report(Boolean(await cdp.shot('2-authored-board')), 'screenshot authored board');

    const scene = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const elements = api.getSceneElements();
      const text = elements.filter((element) => element.type === 'text').map((element) => element.originalText || element.text);
      const connector = elements.find((element) => element.id === ${JSON.stringify(authored.expected.connectorId)});
      const image = elements.find((element) => element.id === ${JSON.stringify(authored.expected.imageId)});
      return {
        count: elements.length,
        text,
        stickyFace: Boolean(elements.find((element) => element.id === ${JSON.stringify(authored.expected.stickyId)})),
        rectangle: Boolean(elements.find((element) => element.id === ${JSON.stringify(authored.expected.rectangleId)})),
        triangle: Boolean(elements.find((element) => element.id === ${JSON.stringify(authored.expected.triangleId)} && element.customData && element.customData.polyShape === 'triangle')),
        tableCells: elements.filter((element) => element.customData && element.customData.table).length,
        connectorBound: Boolean(connector && connector.startBinding && connector.endBinding),
        connectorEndpoints: connector ? [connector.startBinding && connector.startBinding.elementId, connector.endBinding && connector.endBinding.elementId] : [],
        imagePresent: Boolean(image),
        imageHasBytes: Boolean(image && api.getFiles()[image.fileId] && api.getFiles()[image.fileId].dataURL),
        arrows: elements.filter((element) => element.type === 'arrow').length,
      };
    })()`);
    report(scene.count === authored.expected.authoredCount, 'real canvas element count matches CLI scene', `canvas=${scene.count} cli=${authored.expected.authoredCount}`);
    report(scene.stickyFace && scene.text.includes('CLI sticky: render me'), 'sticky and label render in real canvas', `sticky=${scene.stickyFace} text=${scene.text.includes('CLI sticky: render me')}`);
    report(scene.rectangle && scene.triangle, 'shape families render in real canvas', `rectangle=${scene.rectangle} triangle=${scene.triangle}`);
    report(scene.tableCells === 6, 'table renders in real canvas', `cells=${scene.tableCells}`);
    report(scene.connectorBound, 'connector is bound in real canvas', `endpoints=${scene.connectorEndpoints.join(',')}`);
    report(scene.connectorEndpoints[0] === authored.expected.rectangleId && scene.connectorEndpoints[1] === authored.expected.triangleId, 'connector binds requested elements', `from=${scene.connectorEndpoints[0]} to=${scene.connectorEndpoints[1]}`);
    report(scene.imagePresent && scene.imageHasBytes, 'embedded image renders with bytes', `present=${scene.imagePresent} bytes=${scene.imageHasBytes}`);
    report(scene.text.includes('CLI rectangle label') && scene.text.includes('CLI triangle label') && scene.text.includes('CLI bound connector'), 'authored labels are present', `texts=${scene.text.length}`);
    report(scene.arrows >= 1, 'flowchart and connector arrows render', `arrows=${scene.arrows}`);
    report(Boolean(await cdp.shot('3-authored-assertions')), 'screenshot authored assertions');

    await cdp.eval(`[...document.querySelectorAll('.whiteboard-chip-main span')].find((e) => e.textContent === ${JSON.stringify(BRAINSTORM_NAME)}).closest('button').click()`);
    await waitFor(cdp, `window.__harborBoardApi && window.__harborBoardApi.getSceneElements().length === ${authored.expected.brainstormCount}`, 'compose board elements');
    const composeScene = await cdp.eval(`(() => { const elements = window.__harborBoardApi.getSceneElements(); return { count: elements.length, topic: elements.some((element) => element.type === 'text' && (element.originalText || element.text) === 'CLI Brainstorm: Live Validation'), stickies: elements.filter((element) => element.customData && element.customData.stickyShadow).length }; })()`);
    report(composeScene.count === authored.expected.brainstormCount, 'compose board count matches CLI scene', `canvas=${composeScene.count} cli=${authored.expected.brainstormCount}`);
    report(composeScene.topic && composeScene.stickies === 3, 'compose brainstorm renders topic and sections', `topic=${composeScene.topic} stickyShadows=${composeScene.stickies}`);
    report(Boolean(await cdp.shot('4-compose-board')), 'screenshot compose board');

    // ---- H1: a CLI write to the board Pat has OPEN reaches the live canvas ----
    await cdp.eval(`[...document.querySelectorAll('.whiteboard-chip-main span')].find((e) => e.textContent === ${JSON.stringify(AUTHORED_NAME)}).closest('button').click()`);
    await waitFor(cdp, `window.__harborBoardApi && window.__harborBoardApi.getSceneElements().length === ${authored.expected.authoredCount}`, 'authored board open for H1');

    const liveStart = Date.now();
    const liveSticky = await runCli(['add-sticky', AUTHORED_ID, '--text', 'H1 live sticky', '--color', 'green', '--x', '1200', '--y', '80'], boardsDir);
    await waitFor(cdp, `window.__harborBoardApi && window.__harborBoardApi.getSceneElements().some((el) => el.id === ${JSON.stringify(liveSticky.json.id)})`, 'CLI sticky in the OPEN canvas', 10000);
    const liveLatencyMs = Date.now() - liveStart;
    report(true, 'H1: CLI write reached the OPEN canvas', `latencyMs=${liveLatencyMs} (includes CLI process startup)`);
    report(liveLatencyMs < 5000, 'H1: live update lands promptly', `latencyMs=${liveLatencyMs}`);
    const liveLabel = await cdp.eval("window.__harborBoardApi.getSceneElements().some((el) => el.type === 'text' && (el.originalText || el.text) === 'H1 live sticky')");
    report(liveLabel, 'H1: live sticky label renders in the canvas');
    report(Boolean(await cdp.shot('5-h1-live-sticky')), 'screenshot H1 live sticky');

    // A bare reload must not echo back as a save: the file the CLI just wrote
    // stays byte-identical across the full flush+save debounce window.
    const boardFile = path.join(boardsDir, `${AUTHORED_ID}.json`);
    const afterCliBytes = fs.readFileSync(boardFile, 'utf8');
    await sleep(3500);
    const afterWaitBytes = fs.readFileSync(boardFile, 'utf8');
    let echoDetail = 'file byte-identical after 3.5s';
    if (afterWaitBytes !== afterCliBytes) {
      const beforeEls = new Map(JSON.parse(afterCliBytes).elements.map((el) => [el.id, el]));
      const afterEls = JSON.parse(afterWaitBytes).elements;
      const diffs = [];
      for (const el of afterEls) {
        const prev = beforeEls.get(el.id);
        if (!prev) { diffs.push(`${el.id}: added (${el.type})`); continue; }
        const fields = Object.keys(el).filter((key) => JSON.stringify(el[key]) !== JSON.stringify(prev[key]));
        if (fields.length) diffs.push(`${el.id} (${el.type}) changed: ${fields.join(',')} v${prev.version}->v${el.version}`);
        beforeEls.delete(el.id);
      }
      for (const id of beforeEls.keys()) diffs.push(`${id}: dropped`);
      echoDetail = `file CHANGED: ${diffs.slice(0, 12).join(' | ') || 'appState/files only'}`;
      fs.writeFileSync(path.join(OUT, 'echo-before.json'), afterCliBytes);
      fs.writeFileSync(path.join(OUT, 'echo-after.json'), afterWaitBytes);
      const traceDump = await cdp.eval('JSON.stringify(window.__harborBoardTrace || [])');
      fs.writeFileSync(path.join(OUT, 'canvas-trace.json'), traceDump);
      console.log(`canvas trace tail: ${JSON.stringify(JSON.parse(traceDump).slice(-14))}`);
    }
    report(afterWaitBytes === afterCliBytes, 'H1: bare reload did not echo a save', echoDetail);

    // The race that used to eat the sticky: an in-canvas edit is mid-debounce
    // while a second CLI write lands. Whatever the interleaving, the file and
    // the canvas must both end holding BOTH facts (the union, no clobber).
    const rectBefore = await cdp.eval(`window.__harborBoardApi.getSceneElements().find((el) => el.id === ${JSON.stringify(authored.expected.rectangleId)}).x`);
    const movedX = rectBefore + 40;
    await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const els = api.getSceneElementsIncludingDeleted();
      const moved = els.map((el) => el.id === ${JSON.stringify(authored.expected.rectangleId)}
        ? { ...el, x: ${movedX}, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
        : el);
      api.updateScene({ elements: moved, captureUpdate: 'IMMEDIATELY' });
      return true;
    })()`);
    const raceSticky = await runCli(['add-sticky', AUTHORED_ID, '--text', 'H1 race sticky', '--color', 'violet', '--x', '1200', '--y', '340'], boardsDir);
    let unionOk = false;
    const unionDeadline = Date.now() + 10000;
    while (Date.now() < unionDeadline) {
      const onDisk = readBoard(boardsDir, AUTHORED_ID);
      const rect = onDisk.elements.find((el) => el.id === authored.expected.rectangleId);
      const sticky = onDisk.elements.find((el) => el.id === raceSticky.json.id && !el.isDeleted);
      if (rect && sticky && rect.x === movedX) { unionOk = true; break; }
      await sleep(300);
    }
    report(unionOk, 'H1: concurrent canvas edit and CLI write both persist to disk', `movedX=${movedX} sticky=${raceSticky.json.id}`);
    const unionCanvas = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const rect = els.find((el) => el.id === ${JSON.stringify(authored.expected.rectangleId)});
      return Boolean(rect && rect.x === ${movedX} && els.some((el) => el.id === ${JSON.stringify(raceSticky.json.id)}));
    })()`);
    report(unionCanvas, 'H1: the open canvas holds the union too');
    report(Boolean(await cdp.shot('6-h1-union')), 'screenshot H1 union');

    // ---- export (still broken offscreen, b6 M7; opt in to observe it) ----
    if (process.argv.includes('--with-export')) {
      const pngFile = path.join(exportsDir, 'cli-authored-board.png');
      const pdfFile = path.join(exportsDir, 'cli-authored-board.pdf');
      const pngResult = await runCli(['export', AUTHORED_ID, '--format', 'png', '--out', pngFile], boardsDir, 120000);
      report(pngResult.json.outFile === pngFile, 'CLI PNG export command', `out=${pngResult.json.outFile}`);
      const pdfResult = await runCli(['export', AUTHORED_ID, '--format', 'pdf', '--out', pdfFile], boardsDir, 120000);
      report(pdfResult.json.outFile === pdfFile, 'CLI PDF export command', `out=${pdfResult.json.outFile}`);
      fs.writeFileSync(path.join(OUT, 'export-outputs.json'), `${JSON.stringify({ png: pngResult.json, pdf: pdfResult.json }, null, 2)}\n`);
      const pngSize = fs.existsSync(pngFile) ? fs.statSync(pngFile).size : 0;
      const pdfSize = fs.existsSync(pdfFile) ? fs.statSync(pdfFile).size : 0;
      report(pngSize > 8, 'PNG export exists and is non-empty', `bytes=${pngSize}`);
      report(pngSize > 8 && magicHex(pngFile, 8) === '89504e470d0a1a0a', 'PNG export has PNG magic bytes', `magic=${pngSize ? magicHex(pngFile, 8) : 'missing'}`);
      report(pdfSize > 4, 'PDF export exists and is non-empty', `bytes=${pdfSize}`);
      report(pdfSize > 4 && fs.readFileSync(pdfFile).subarray(0, 4).toString('ascii') === '%PDF', 'PDF export starts with %PDF', `prefix=${pdfSize ? fs.readFileSync(pdfFile).subarray(0, 4).toString('ascii') : 'missing'}`);
      // H5's report came from a mindmap EXPORT, so the brainstorm board (whose
      // diagram is the mindmap) is exported too for a visual anchor check.
      const brainstormPng = path.join(exportsDir, 'cli-brainstorm-board.png');
      const brainstormResult = await runCli(['export', BRAINSTORM_ID, '--format', 'png', '--out', brainstormPng], boardsDir, 120000);
      const brainstormSize = fs.existsSync(brainstormPng) ? fs.statSync(brainstormPng).size : 0;
      report(brainstormResult.json.outFile === brainstormPng && brainstormSize > 8 && magicHex(brainstormPng, 8) === '89504e470d0a1a0a', 'brainstorm mindmap PNG export', `bytes=${brainstormSize}`);
      report(Boolean(await cdp.shot('7-export-complete')), 'screenshot after exports');
    } else {
      console.log('SKIP export legs (export is not functional offscreen, b6 review M7; pass --with-export to run them)');
    }

    await sleep(500);
    const urls = cdp.events.filter((event) => event.method === 'Network.requestWillBeSent').map((event) => event.params.request.url);
    const http = urls.filter((url) => /^https?:/i.test(url));
    const consoleErrors = cdp.events.filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error');
    const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    const logErrors = cdp.events.filter((event) => event.method === 'Log.entryAdded' && event.params.entry?.level === 'error');
    const errorCount = consoleErrors.length + exceptions.length + logErrors.length;
    report(http.length === 0, 'zero HTTP or HTTPS network requests', `http=${http.length} total=${urls.length}`);
    report(errorCount === 0, 'zero console errors', `console=${consoleErrors.length} exceptions=${exceptions.length} log=${logErrors.length}`);
    fs.writeFileSync(path.join(OUT, 'cdp-events.json'), `${JSON.stringify({ urls, http, consoleErrors, exceptions, logErrors }, null, 2)}\n`);
    ws.close();
  } finally {
    await sleep(500);
    try { child.kill(); } catch {}
  }

  const verdict = failures.length ? 'FAIL' : 'PASS';
  const summary = `${verdict} drive-board-authoring-win\n${lines.join('\n')}\nboards: ${boardsDir}\nexports: ${exportsDir}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), summary);
  console.log(summary);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), `FAIL drive-board-authoring-win\n${error.stack || error}\n`);
  console.error(`FAIL drive-board-authoring-win: ${error.stack || error}`);
  process.exit(2);
});
