const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '..');
  const box = path.join(root, '.test-sandbox', `host-${Date.now()}`);
  const harness = await import(pathToFileURL(path.join(__dirname, 'backend-fixture.mjs')));
  const { resolveEngine } = require(path.join(root, 'out/src/backend/engine.js'));
  const binary = await resolveEngine(process.env.MUSE_TEST_ENGINE, process.env);
  const env = harness.isolatedEnv(path.join(box, 'muse'));
  const keys = ['HOME','USERPROFILE','XDG_DATA_HOME','XDG_CONFIG_HOME','LOCALAPPDATA','APPDATA'];
  for (const key of keys) await fs.mkdir(env[key], { recursive: true });
  const config = { enginePath: binary, env: Object.fromEntries(keys.map(key => [key, env[key]])), extraArgs: ['--provider', 'echo', '--trust-workspace', '--disable-sandbox'] };
  const seeds = [];
  for (const name of ['A', 'B']) {
    const workspace = path.join(box, `workspace-${name}`);
    await fs.mkdir(workspace, { recursive: true });
    const host = harness.createHost({ binary, workspace, env, extraArgs: ['--trust-workspace','--disable-sandbox'] });
    await host.connect();
    try {
      const started = await host.request('session/start', { commandId: harness.uuidv7(), workspaceRoot: workspace });
      const session = started.session;
      await harness.turn(host, session.sessionId, `EXTENSION_HOST_${name}_ECHO_SYNTHETIC`);
      seeds.push(session);
    } finally { await host.stop(); }
  }
  const configPath = path.join(box, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(box, 'seed.json'), JSON.stringify(seeds, null, 2));
  const userdata = path.join(box, 'user-data');
  const extensions = path.join(box, 'extensions');
  await fs.mkdir(path.join(userdata, 'User'), { recursive: true });
  await fs.mkdir(extensions, { recursive: true });
  await fs.writeFile(path.join(userdata, 'User', 'settings.json'), JSON.stringify({ 'chat.disableAIFeatures': true, 'terminal.integrated.enablePersistentSessions': true, 'terminal.integrated.confirmOnExit': 'never', 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false }));
  const code = process.env.VSCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  for (const phase of (process.env.MUSE_HISTORY_TEST_PHASES || 'primary,persistence,reload').split(',')) {
    const runEnv = { ...env, MUSE_HISTORY_TEST_BOOTSTRAP: '1', MUSE_HISTORY_TEST_CONFIG: configPath, MUSE_HISTORY_TEST_BOX: box, MUSE_HISTORY_TEST_PHASE: phase };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'VSCODE_CWD']) delete runEnv[key];
    const args = ['--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', userdata, '--extensions-dir', extensions, '--extensionDevelopmentPath', root, seeds[0].workspaceRoot];
    const child = spawn(code, args, { env: runEnv, stdio: ['ignore','pipe','pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    await fs.writeFile(path.join(box, `${phase}-launch.log`), output);
    if (exit !== 0) throw new Error(`VS Code ${phase} failed, exit ${exit}; evidence ${box}`);
    const result = JSON.parse(await fs.readFile(path.join(box, `${phase}-result.json`), 'utf8'));
    if (!result.passed) throw new Error(`VS Code ${phase} failed: ${result.error}; evidence ${box}`);
    console.log(`VS Code ${phase}: passed`);
  }
  console.log(`EXTENSION_HOST_EVIDENCE=${box}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
