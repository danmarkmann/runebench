import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { bun, localEnv, root, run, runtime, sdkRoot, setup } from './setup.mjs';

const port = 4317;
const origin = `http://127.0.0.1:${port}`;
const sessionFile = path.join(runtime, 'session.json');
const task = process.argv.slice(2).join(' ').trim() || 'Explore Lumbridge, chop normal trees, and bank the logs. Adapt to what you find.';
const minutes = 5;
let agent;
let agentStatus = 'starting';
let shuttingDown = false;
let log;
let deadline;

async function main() {
  const existing = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
  if (existing?.ok && (await existing.json()).app === 'runebench-playground') {
    console.log(`A session is already running. Watch: ${origin}\nStop it with npm stop.`);
    return;
  }
  const bot = await setup();
  try {
    await run(process.env.CODEX_BIN || 'codex', ['login', 'status'], { quiet: true });
  } catch {
    throw new Error('Codex is not ready. Install the Codex CLI and run codex login, then try npm start again.');
  }
  const credentialsText = await readFile(path.join(sdkRoot, 'bots', bot.name, 'bot.env'), 'utf8');
  const credentials = Object.fromEntries(credentialsText.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#')).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  const gameUrl = new URL('https://rs-sdk-demo.fly.dev/bot');
  gameUrl.searchParams.set('bot', bot.name);
  gameUrl.searchParams.set('password', credentials.PASSWORD);
  const stopToken = randomBytes(24).toString('hex');
  const startedAt = new Date().toISOString();
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/status' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ app: 'runebench-playground', bot: bot.name, status: agentStatus, startedAt, task }));
    } else if (request.url === '/' && request.method === 'GET') {
      response.writeHead(302, { Location: gameUrl.href });
      response.end();
    } else if (request.url === '/stop' && request.method === 'POST' && request.headers.authorization === `Bearer ${stopToken}`) {
      response.end('Stopped.');
      void shutdown();
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await writeFile(sessionFile, JSON.stringify({ origin, stopToken }, null, 2) + '\n');
  const runDir = path.join(runtime, 'runs');
  await mkdir(runDir, { recursive: true });
  const runName = startedAt.replace(/[:.]/g, '-');
  log = createWriteStream(path.join(runDir, `${runName}.jsonl`));
  console.log(`Bot: ${bot.name}\nWatch: ${origin}\nTask: ${task}\nThe agent will play for about ${minutes} minutes. Stop: Ctrl+C or npm stop.\n`);

  const config = {
    command: bun,
    args: ['run', path.join(sdkRoot, 'mcp', 'server.ts')],
    cwd: sdkRoot,
    startup_timeout_sec: 60,
    tool_timeout_sec: 90,
    required: true,
    default_tools_approval_mode: 'approve',
    enabled_tools: ['execute_code', 'list_bots', 'disconnect_bot'],
  };
  const toml = `{ ${Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`;
  const prompt = `Play the RuneScape research game using the rs-agent MCP tools. Your bot_name is ${bot.name}.\n` +
    `Goal: ${task}\nPlay for about ${minutes} minutes, then summarize skill XP, inventory changes, and what you learned.\n` +
    'First call execute_code to inspect the world and skip the tutorial with await bot.skipTutorial() if needed. ' +
    'MCP execute_code provides bot and sdk globals. Each result already includes world state. ' +
    'Use short snippets, usually 10 to 30 seconds, and inspect their results before adapting your plan. ' +
    'Read the rs-agent SDK API resource if you need exact method signatures. ' +
    'Useful methods: sdk.getInventory(), sdk.getSkill("Woodcutting"), sdk.findNearbyLoc(/^tree$/i), ' +
    'await bot.chopTree(), await bot.walkTo(x,z), await bot.openBank(), await bot.depositItem(target,amount), await bot.closeBank(). ' +
    'Announce each next step briefly so the user can follow along. Judge success from observed game state. ' +
    'Stay in the game: do not send public or private messages, file bug reports, change infrastructure, or operate other bots. ' +
    'Do not disconnect the game client when finished; the user is watching it. Stop if the game cannot connect and explain the failure.';
  agent = spawn(process.env.CODEX_BIN || 'codex', [
    'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--json',
    '--disable', 'shell_tool', '--disable', 'shell_snapshot', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
    '-c', 'web_search="disabled"', '-c', `mcp_servers.rs-agent=${toml}`, '-C', root, '-'
  ], { cwd: root, env: localEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  agent.stdin.on('error', () => {});
  agent.stdin.end(prompt);
  agent.once('spawn', () => { agentStatus = 'running'; });
  agent.once('error', error => { agentStatus = 'failed'; console.error(`Could not start Codex: ${error.message}`); void shutdown(1); });
  const lines = createInterface({ input: agent.stdout });
  lines.on('line', line => {
    if (!shuttingDown) log.write(line + '\n');
    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (item?.type === 'agent_message' && event.type === 'item.completed') console.log(item.text);
      if (item?.type === 'mcp_tool_call' && event.type === 'item.started') console.log(`\n[Action] ${item.tool}: ${String(item.arguments?.code ?? '').slice(0, 180)}`);
      if (item?.type === 'mcp_tool_call' && event.type === 'item.completed') console.log(`[Action] ${item.status ?? 'completed'}`);
      if (event.type === 'error' || event.type === 'turn.failed') console.error(event.message ?? event.error?.message ?? 'The agent run failed.');
    } catch {}
  });
  agent.stderr.on('data', chunk => process.stderr.write(chunk));
  agent.once('close', code => {
    clearTimeout(deadline);
    if (!shuttingDown) {
      if (agentStatus === 'running' || agentStatus === 'starting') agentStatus = code === 0 ? 'finished' : 'failed';
      console.log(`\nAgent ${agentStatus}. The game tab can stay open. Start another task after npm stop.`);
    }
    log.end();
  });
  deadline = setTimeout(() => {
    console.log('\nSession time limit reached. Stopping the agent.');
    agentStatus = 'timed out';
    stopAgent();
  }, (minutes + 3) * 60_000);
  deadline.unref();
}

function stopAgent() {
  if (!agent || agent.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(agent.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => agent.kill());
  } else agent.kill('SIGTERM');
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(deadline);
  stopAgent();
  await rm(sessionFile, { force: true });
  log?.end();
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
main().catch(error => { console.error(error.message); void shutdown(1); });
