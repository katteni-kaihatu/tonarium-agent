const states = {
  intake:['📝','聞き取り中'], waiting_info:['❓','回答待ち'], decision:['❓','判断待ち'],
  planning:['📝','計画中'], queued:['⏳','実装待ち'], coding:['🛠️','実装中'],
  pr_ready:['🧪','PR確認待ち'], integrating:['🔀','マージ作業中'],
  merged:['✅','mainへマージ済み'], resolved_existing:['✅','既存機能を案内'],
  grouped:['🔗','他案件に統合'], failed:['⚠️','要対応']
};
const prefixes = [...new Set(Object.values(states).map(([emoji]) => emoji)), '🔄','🙋'];
const labels = new Set(Object.values(states).map(([,label]) => label).concat(['再試行待ち','出荷を再試行','指示待ち','要件整理済み','完了']));

export function threadStatusFor(ticket, store) {
  if (!ticket) return null;
  if (ticket.status === 'waiting_info' && store.getKv(`awaiting-instruction:${ticket.id}`) === '1') return {emoji:'🙋',label:'指示待ち'};
  return states[ticket.status] ? {emoji:states[ticket.status][0],label:states[ticket.status][1]} : null;
}

export function threadStatusName(currentName, {emoji,label}) {
  let title = String(currentName || '');
  const previous = prefixes.find(prefix => title.startsWith(`${prefix} `));
  if (previous) {
    title = title.slice(previous.length + 1);
    const separator = title.indexOf('｜');
    if (separator > 0 && separator <= 20 && labels.has(title.slice(0,separator))) title = title.slice(separator + 1);
  }
  return `${emoji} ${label}｜${title}`.slice(0,100);
}

export async function syncThreadStatus(config,store,id,fetcher = fetch) {
  const desired = threadStatusFor(store.get(id),store);
  if (!desired) return true;
  if (Date.now() < Number(store.getKv(`thread-status-retry-after:${id}`) || 0)) return false;
  const url = `https://discord.com/api/v10/channels/${id}`;
  const headers = {Authorization:`Bot ${config.discordToken}`};
  const currentResponse = await fetcher(url,{headers,signal:AbortSignal.timeout(10_000)});
  if (!currentResponse.ok) throw new Error(`Discord thread fetch failed: ${currentResponse.status}`);
  const current = await currentResponse.json();
  const latest = threadStatusFor(store.get(id),store) || desired;
  const name = threadStatusName(current.name,latest);
  if (current.name !== name) {
    const response = await fetcher(url,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({name}),signal:AbortSignal.timeout(10_000)});
    if (response.status === 429) {
      const limit = await response.json();
      store.setKv(`thread-status-retry-after:${id}`,Date.now() + Math.max(1000,Number(limit.retry_after || 15) * 1000) + 1000);
      return false;
    }
    if (!response.ok) throw new Error(`Discord thread rename failed: ${response.status}`);
  }
  const now = threadStatusFor(store.get(id),store);
  if (now?.emoji === latest.emoji && now?.label === latest.label) store.setKv(`thread-status-dirty:${id}`,'0');
  return true;
}
