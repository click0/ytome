/**
 * Smoke-тест зібраного сервера (dist/): обидва транспорти MCP.
 *
 *   node scripts/smoke.mjs                 # поточний checkout (після npm run build)
 *   node scripts/smoke.mjs --dir ./ytome-0.90.0   # розпакований реліз
 *
 * stdio: initialize + tools/list. Кожен рядок stdout мусить бути JSON-RPC —
 *        лог чи підказка в stdout ламає з'єднання з Claude Desktop.
 * HTTP:  /health і /tools відповідають, версія = package.json.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
const ROOT = path.resolve(dirIdx >= 0 ? argv[dirIdx + 1] : '.');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TMP = mkdtempSync(path.join(tmpdir(), 'ytome-smoke-'));

const env = {
  ...process.env,
  STORAGE_PATH: TMP,
  DB_PATH: path.join(TMP, 'archive.db'),
  LOG_PRETTY: 'false',
  LOG_LEVEL: 'warn',
};

function fail(msg) {
  console.error(`::error::${msg}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout ${ms}ms`)), ms)),
  ]);
}

async function smokeStdio() {
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/mcp/index.js')], { cwd: ROOT, env });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });

  const responses = new Map();
  let buffer = '';
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
          return reject(new Error(`stdout is not pure JSON-RPC, got: ${line.slice(0, 120)}`));
        }
        if (msg.jsonrpc !== '2.0') return reject(new Error(`not a JSON-RPC message: ${line.slice(0, 120)}`));
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(2)) resolve();
      }
    });
    child.on('exit', code => reject(new Error(`stdio server exited (${code}) early\n${stderr}`)));
  });

  const send = m => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
  } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  try {
    await withTimeout(done, 20_000, 'stdio');
  } finally {
    child.kill();
  }

  const init = responses.get(1)?.result;
  if (init?.serverInfo?.version !== PKG.version) {
    fail(`stdio serverInfo.version ${init?.serverInfo?.version} != package.json ${PKG.version}`);
  }
  const tools = responses.get(2)?.result?.tools || [];
  if (tools.length === 0) fail('stdio tools/list returned no tools');
  console.log(`stdio: ${init.serverInfo.name} ${init.serverInfo.version}, ${tools.length} tools, stdout clean`);
  return tools.length;
}

async function smokeHttp(expectedTools) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/mcp/server-http.js')], {
    cwd: ROOT, env: { ...env, MCP_HTTP_PORT: String(port), MCP_HOST: '127.0.0.1' },
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;

  try {
    const deadline = Date.now() + 20_000;
    let health;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) { health = await res.json(); break; }
      } catch { /* ще не слухає */ }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!health) fail(`HTTP /health did not answer on ${base}\n${stderr}`);
    if (health.version !== PKG.version) fail(`/health version ${health.version} != package.json ${PKG.version}`);
    if (health.tools !== expectedTools) fail(`/health reports ${health.tools} tools, stdio listed ${expectedTools}`);

    const tools = (await (await fetch(`${base}/tools`)).json()).tools;
    if (tools.length !== expectedTools) fail(`/tools lists ${tools.length} tools, stdio listed ${expectedTools}`);
    console.log(`http:  /health ok (${health.service} ${health.version}), /tools ${tools.length}`);
  } finally {
    child.kill();
  }
}

try {
  const toolCount = await smokeStdio();
  await smokeHttp(toolCount);
  rmSync(TMP, { recursive: true, force: true });
  console.log('smoke: OK');
} catch (e) {
  fail(e.message);
}
