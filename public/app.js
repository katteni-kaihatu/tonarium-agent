const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = time => new Date(time).toLocaleString('ja-JP', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const statusIcons = {intake:'📝',waiting_info:'❓',decision:'❓',proposal:'💡',declined:'🚫',planning:'📝',queued:'⏳',coding:'🛠️',pr_ready:'🧪',integrating:'🔀',merged:'✅',resolved_existing:'✅',failed:'⚠️'};
const statusLabels = {intake:'聞き取り中',waiting_info:'回答待ち',decision:'判断待ち',proposal:'提案中',declined:'見送り',planning:'計画中',queued:'実装待ち',coding:'実装中',pr_ready:'PR確認待ち',integrating:'マージ作業中',merged:'マージ済み',resolved_existing:'既存機能を案内',failed:'要対応'};
const lanes = [
  { name:'聞き取り', statuses:['intake','waiting_info','decision','proposal'] },
  { name:'計画', statuses:['planning','queued'] },
  { name:'実装', statuses:['coding'] },
  { name:'統合・出荷', statuses:['pr_ready','integrating'] },
  { name:'対応済み', statuses:['merged','resolved_existing','declined'] },
  { name:'要対応', statuses:['failed'] }
];
function render(state) {
  $('connection').className = `connection ${state.mode === 'live' ? '' : 'setup'}`;
  $('connection').innerHTML = `<i></i>${state.mode === 'live' ? 'LIVE SYSTEM' : 'SETUP MODE'}`;
  $('stat-open').textContent = String(state.tickets.filter(x => !['merged','resolved_existing','grouped','declined'].includes(x.status)).length).padStart(2,'0');
  $('stat-progress').textContent = String(state.tickets.filter(x => ['planning','queued','coding','integrating'].includes(x.status)).length).padStart(2,'0');
  $('stat-ready').textContent = String(state.tickets.filter(x => x.status === 'pr_ready').length).padStart(2,'0');
  const latest = state.releases.find(x => x.status === 'merged');
  $('stat-release').textContent = latest ? fmt(latest.updated_at).replace(' ',' / ') : '—';
  $('main-link').href = state.mainUrl;
  $('main-link').firstChild.textContent = `${state.releaseBranch.toUpperCase()} を開く `;
  $('team').innerHTML = state.roles.map(role => { const avatarId = role.avatarId || role.id; const icon = avatarId ? `<img src="/avatars/${encodeURIComponent(avatarId)}.png${role.avatarVersion ? `?v=${encodeURIComponent(role.avatarVersion)}` : ''}" alt="" loading="lazy" onerror="this.remove()" />` : ''; return `<article class="agent-card ${escape(role.color)}"><div class="agent-top"><div class="avatar" aria-hidden="true"><span>${escape(role.name.slice(0,1))}</span>${icon}</div><span class="agent-status">${role.ticket ? 'WORKING' : 'STANDBY'}</span></div><h3>${escape(role.name)}</h3><div class="agent-job">${escape(role.job)}</div><p class="agent-task">${escape(role.ticket || '次の仕事を待っています')}</p></article>`; }).join('');
  $('board').innerHTML = lanes.map(lane => { const tickets = state.tickets.filter(ticket => lane.statuses.includes(ticket.status)); return `<div class="lane"><div class="lane-header"><span class="lane-title">${lane.name}</span><span class="lane-count">${String(tickets.length).padStart(2,'0')}</span></div><div class="lane-cards">${tickets.length ? tickets.slice(0,8).map(ticket => `<article class="ticket"><span class="ticket-id">#${escape(ticket.issue_number || ticket.id.slice(-6))} · ${statusIcons[ticket.status] || '•'} ${escape(ticket.status === 'merged' ? `${ticket.merged_branch || 'main'}へマージ済み` : statusLabels[ticket.status] || ticket.status)}</span><strong>${escape(ticket.title)}</strong><p>${escape(ticket.summary.slice(0,70))}</p></article>`).join('') : '<p class="lane-empty">いまは空です</p>'}</div></div>`; }).join('');
  $('activity').innerHTML = state.events.length ? state.events.slice(0,10).map(event => `<div class="activity-row"><time>${fmt(event.created_at)}</time><span class="actor">${escape(event.actor)}</span><span class="detail">${escape(event.text)}</span></div>`).join('') : '<div class="empty">動きがあると、ここに表示されます。</div>';
  $('releases').innerHTML = state.releases.length ? state.releases.slice(0,8).map(release => `<div class="release-row"><span class="release-status">${escape(release.status)}</span><span class="detail">${fmt(release.created_at)} · ${release.tickets.length} 件 ${release.commit_sha ? `· ${escape(release.commit_sha.slice(0,8))}` : ''}${release.error ? `<br>${escape(release.error.slice(0,150))}` : ''}</span></div>`).join('') : '<div class="empty">最初の PR マージを待っています。</div>';
  let banner = document.querySelector('.setup-banner');
  if (state.mode === 'setup' && !banner) { banner = document.createElement('div'); banner.className='setup-banner'; banner.textContent='セットアップ中です。.env に Discord Bot の設定を追加すると、実際の活動がここに表示されます。'; document.querySelector('.hero-copy').append(banner); }
  if (state.mode === 'live' && banner) banner.remove();
}
const refresh = () => fetch('/api/state').then(response => response.json()).then(render).catch(console.error);
refresh();
const events = new EventSource('/api/events');
events.onmessage = message => render(JSON.parse(message.data));
setInterval(refresh, 15_000);
setInterval(() => { $('clock').textContent = new Date().toLocaleString('ja-JP', { timeZone:'Asia/Tokyo', hour:'2-digit',minute:'2-digit',hour12:false }) + ' JST'; }, 1000);
