import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { Engine } from './engine.js';
import { applySettings, aiHooks } from './settings.js';

// 保存済みの案件に今の指示で PM の判定だけをやり直し、結果を表示する。案件・Discord・GitHub には書き込まない
const limit = Number(process.argv[2]) || 10;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
try {
  applySettings(store, config);
  const engine = new Engine(config,store,new AI(config, root, aiHooks(store)),null,{});
  const tickets = store.list().filter(ticket => ticket.summary).slice(0,limit);
  for (const ticket of tickets) {
    try {
      const result = await engine.pmReview({id:ticket.id,title:ticket.title,summary:ticket.summary,criteria:ticket.criteria,history:''},config.repo);
      console.log(JSON.stringify({id:ticket.id,title:ticket.title,status:ticket.status,verdict:result.verdict,reason:result.reason,proposal:result.proposal}));
    } catch (error) { console.log(JSON.stringify({id:ticket.id,title:ticket.title,error:error.message})); }
  }
} finally { store.close(); }
