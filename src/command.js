import { spawn } from 'node:child_process';

export async function command(file, args = [], { cwd, input, timeoutMs = 15 * 60_000, env = process.env, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); done(new Error(`${file} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(String(chunk)); });
    child.stderr.on('data', chunk => { stderr += chunk; onOutput?.(String(chunk)); });
    child.on('error', error => done(error));
    child.on('close', code => code === 0 ? done(null, { stdout: stdout.trim(), stderr: stderr.trim() }) : done(new Error(`${file} ${args.join(' ')} exited ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}`)));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function cleanModelEnv(env = process.env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/^(DISCORD_TOKEN|COOLIFY_|GITHUB_TOKEN|GH_TOKEN|NIGHTLY_URL)$/i.test(key)) delete copy[key];
  }
  return copy;
}
