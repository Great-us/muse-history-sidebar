/** Test-only synthetic fixture client using the official public MSP and local echo provider. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function uuidv7() {
  const bytes = randomBytes(16);
  let now = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) { bytes[i] = Number(now & 255n); now >>= 8n; }
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function isolatedEnv(base) {
  const home = path.join(base, 'home');
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home,'.local','share'), XDG_CONFIG_HOME: path.join(home,'.config'), LOCALAPPDATA: path.join(base,'appdata-local'), APPDATA: path.join(base,'appdata-roaming'), MUSE_NO_AUTO_UPDATE: '1' };
}

export function createHost({ binary, workspace, env, extraArgs = [] }) {
  if (!binary || !path.isAbsolute(binary)) throw new Error('Synthetic fixture needs an explicit absolute native engine path.');
  for (const key of ['HOME','USERPROFILE','XDG_DATA_HOME','XDG_CONFIG_HOME','APPDATA','LOCALAPPDATA']) {
    if (!env[key] || !path.isAbsolute(env[key])) throw new Error(`Synthetic fixture requires isolated absolute ${key}.`);
  }
  const child = spawn(binary, ['serve','--provider','echo','--sandbox-network','restricted',...extraArgs], { cwd: workspace, env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  child.stderr.resume();
  let nextId = 1;
  let closed = false;
  let stopping;
  const pending = new Map();
  const listeners = new Set();
  const fail = error => {
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const exited = new Promise(resolve => {
    child.once('error', fail);
    child.once('exit', () => fail(new Error('Synthetic MSP host exited.')));
    child.once('close', resolve);
  });
  child.stdin.on('error', fail);
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    let frame;
    try { frame = JSON.parse(line); }
    catch (error) { fail(error); child.kill(); return; }
    if (frame.method) {
      if (frame.id !== undefined && frame.id !== null) child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:frame.id, error:{code:-32601,message:'Synthetic fixture does not handle server requests.'} })+'\n');
      else for (const listener of listeners) listener(frame);
      return;
    }
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id); clearTimeout(request.timer);
    if (frame.error) {
      const error = new Error(frame.error.message);
      error.code = frame.error.code; error.kind = frame.error.data?.kind;
      request.reject(error);
    } else request.resolve(frame.result);
  });
  const host = {
    child,
    request(method, params = {}) {
      if (closed) return Promise.reject(new Error('Synthetic MSP host is closed.'));
      const id = nextId++;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Synthetic ${method} timed out.`)); },60_000);
        pending.set(id,{resolve,reject,timer});
        child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      });
    },
    onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async connect() {
      const result = await host.request('initialize',{clientInfo:{name:'muse_history_fixture',version:'0.1.0'}});
      if (result.serverInfo?.name !== 'muse' || result.schema?.version !== 1) throw new Error('Unsupported fixture MSP host.');
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}})+'\n');
      return result;
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        fail(new Error('Synthetic MSP host stopped.'));
        if (child.exitCode !== null || child.signalCode !== null) { await exited; return; }
        child.stdin.end();
        let timer;
        await Promise.race([exited,new Promise(resolve => {timer=setTimeout(resolve,1500);})]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      })();
      return stopping;
    },
  };
  return host;
}

export async function turn(host, sessionId, text) {
  let timer;
  let unsubscribe;
  const completed = new Promise((resolve,reject) => {
    timer = setTimeout(() => reject(new Error('Synthetic echo turn did not complete.')),30_000);
    unsubscribe = host.onNotification(frame => {
      if (frame.method === 'turn/completed' && frame.params?.sessionId === sessionId) resolve(frame.params);
    });
  });
  completed.catch(() => undefined);
  try {
    await host.request('turn/start',{sessionId,commandId:uuidv7(),input:[{type:'text',text}]});
    const result = await completed;
    return { sent:'accepted',turnId:result.turnId,terminal:result.terminal };
  } finally { clearTimeout(timer); unsubscribe(); }
}

export async function createSyntheticSession({ binary, workspace, env, extraArgs = [], text = 'Synthetic history fixture. Echo locally.' }) {
  const host = createHost({binary,workspace,env,extraArgs});
  try {
    await host.connect();
    const result = await host.request('session/start',{commandId:uuidv7(),workspaceRoot:workspace});
    const completed = await turn(host,result.session.sessionId,text);
    if (completed.terminal !== 'completed') throw new Error(`Synthetic echo turn ended as ${completed.terminal}.`);
    return result.session;
  } finally { await host.stop(); }
}
