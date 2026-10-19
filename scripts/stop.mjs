import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runtime } from './setup.mjs';

try {
  const session = JSON.parse(await readFile(path.join(runtime, 'session.json'), 'utf8'));
  if (session.origin !== 'http://127.0.0.1:4317') throw new Error('Invalid local session address.');
  const response = await fetch(`${session.origin}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.stopToken}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Stop failed (${response.status}).`);
  console.log('Stopped.');
} catch (error) {
  if (error.code === 'ENOENT' || error.cause?.code === 'ECONNREFUSED') console.log('No session is running.');
  else { console.error(error.message); process.exitCode = 1; }
}
