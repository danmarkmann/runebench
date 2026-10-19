import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtime = path.join(root, '.runtime');
export const sdkRoot = path.join(runtime, 'rs-sdk');
export const sdkCommit = 'b565f2d920bf6f5ec427bc6f66dc6fd64a2e15c1';
export const bun = path.join(root, 'node_modules', 'bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');

export function localEnv() {
  const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', TELEMETRY: 'false' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${path.dirname(bun)}${path.delimiter}${env[pathKey] ?? ''}`;
  return env;
}

export function run(command, args, { cwd = root, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: localEnv(), windowsHide: true, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (quiet) {
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${path.basename(command)} failed (${code}).${quiet ? `\n${output}` : ''}`)));
  });
}

export async function setup() {
  if (!existsSync(bun)) throw new Error('Run npm install first.');
  await mkdir(runtime, { recursive: true });
  if (!existsSync(path.join(sdkRoot, '.git'))) {
    console.log('Downloading RS-SDK…');
    await run('git', ['clone', '--no-checkout', '--filter=blob:none', 'https://github.com/MaxBittker/rs-sdk.git', sdkRoot]);
    await run('git', ['checkout', '--detach', sdkCommit], { cwd: sdkRoot });
  }
  const actualCommit = await run('git', ['rev-parse', 'HEAD'], { cwd: sdkRoot, quiet: true });
  if (actualCommit !== sdkCommit) throw new Error('The local RS-SDK version differs from the pinned version. Restore it before starting.');

  const readyFile = path.join(runtime, 'dependencies.json');
  let ready;
  try { ready = JSON.parse(await readFile(readyFile, 'utf8')); } catch {}
  if (ready?.sdkCommit !== sdkCommit || !existsSync(path.join(sdkRoot, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    console.log('Installing game dependencies…');
    await run(bun, ['install', '--frozen-lockfile'], { cwd: sdkRoot });
    await writeFile(readyFile, JSON.stringify({ sdkCommit }, null, 2) + '\n');
  }

  const botFile = path.join(runtime, 'bot.json');
  let bot;
  try { bot = JSON.parse(await readFile(botFile, 'utf8')); } catch {}
  if (!bot) {
    bot = { name: `rune${randomBytes(3).toString('hex')}` };
    await run(bun, ['bots/create-bot.ts', bot.name, '--no-chat'], { cwd: sdkRoot, quiet: true });
    const credentialsFile = path.join(sdkRoot, 'bots', bot.name, 'bot.env');
    const credentials = await readFile(credentialsFile, 'utf8');
    await writeFile(credentialsFile, credentials.replace(/^TELEMETRY=.*$/m, 'TELEMETRY=false'));
    await writeFile(botFile, JSON.stringify(bot, null, 2) + '\n');
  }
  if (!/^[a-zA-Z0-9]{1,12}$/.test(bot.name)) throw new Error('Invalid local bot name.');
  return bot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().then(bot => console.log(`Ready: ${bot.name}. Run npm start.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
