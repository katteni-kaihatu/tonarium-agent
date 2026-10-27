import { open, readFile, rm, stat } from 'node:fs/promises';

// 定期タスクが重なって起動しても、同じ処理は一つだけ走らせる
export async function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path,'wx');
      await handle.writeFile(String(process.pid));
      return {release:async () => { await handle.close(); await rm(path,{force:true}); }};
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age < 10_000) return null;
      let alive = false;
      try { process.kill(Number(await readFile(path,'utf8')),0); alive = true; }
      catch (checkError) { alive = checkError.code === 'EPERM'; }
      if (alive) return null;
      await rm(path,{force:true});
    }
  }
  return null;
}
