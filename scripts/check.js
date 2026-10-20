import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
async function check(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) await check(path);
    else if (e.name.endsWith('.js'))
      execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
}
await check('src');
await check('test');
await check('scripts');
console.log('Sintaxis correcta');
