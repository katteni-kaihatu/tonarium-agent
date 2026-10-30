const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const PERM_LABELS = { admin: '管理', character: 'キャラプロフィール変更', project: 'プロジェクト管理' };
const PERMS = ['admin', 'character', 'project'];

let state = null;
let decisionIds = [];

async function api(path, method = 'GET', body = undefined) {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function showMsg(id, text, isError = false) {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.className = `msg${isError ? ' err' : ''}`;
}

function checksHtml(prefix, selected, disabled = []) {
  return PERMS.map(perm => `<label><input type="checkbox" data-check="${prefix}" value="${perm}" ${selected.includes(perm) ? 'checked' : ''} ${disabled.includes(perm) ? 'disabled' : ''} /> ${esc(PERM_LABELS[perm])}</label>`).join('');
}
const checkedValues = prefix => [...document.querySelectorAll(`[data-check="${prefix}"]:checked`)].map(input => input.value);

async function load() {
  let me;
  try { me = await api('/api/admin/me'); }
  catch { $('login-view').hidden = false; $('main-view').hidden = true; return; }
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  state = await api('/api/admin/state');
  const user = me.user;
  $('me-line').textContent = `${user.displayName || user.username || user.misskeyId}（@${user.username || '-'} / ${user.misskeyId}）${me.isInitialAdmin ? '・初期管理者' : ''}`;
  $('me-perms').textContent = `あなたの権限: ${me.permissions.length ? me.permissions.map(perm => PERM_LABELS[perm]).join('、') : 'なし（閲覧のみ）'}`;
  render();
}

function render() {
  const perms = state.me.permissions;
  $('sec-admin').hidden = !perms.includes('admin');
  $('sec-personas').hidden = !perms.includes('character');
  $('sec-members').hidden = !perms.includes('project');
  $('sec-prompts').hidden = !perms.includes('project');
  $('sec-decision').hidden = !perms.includes('project');
  if (perms.includes('admin')) renderAdmins();
  if (perms.includes('character')) renderPersonas();
  if (perms.includes('project')) { renderMembers(); renderPrompts(); renderDecision(); }
}

function renderAdmins() {
  $('base-checks').innerHTML = PERMS.filter(perm => perm !== 'admin')
    .map(perm => `<label><input type="checkbox" data-check="base" value="${perm}" ${state.basePermissions.includes(perm) ? 'checked' : ''} /> ${esc(PERM_LABELS[perm])}</label>`).join('')
    + '<span class="note">管理はベース権限に含められません</span>';
  $('new-admin-checks').innerHTML = checksHtml('new-admin', []);
  $('admins-body').innerHTML = state.admins.map(admin => `<tr>
    <td><code>${esc(admin.misskeyId)}</code>${admin.isInitial ? '<span class="badge">初期管理者</span>' : ''}</td>
    <td>${esc(admin.displayName || admin.username || '')}</td>
    <td><div class="checks">${checksHtml(`admin-${admin.misskeyId}`, admin.permissions, admin.isInitial ? PERMS : [])}</div></td>
    <td>${admin.isInitial ? '' : `<button class="btn sub" data-admin-save="${esc(admin.misskeyId)}">保存</button> <button class="btn danger" data-admin-del="${esc(admin.misskeyId)}">削除</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="4">まだ登録がありません（初期管理者はログイン時に自動で表示されます）</td></tr>';
  for (const button of document.querySelectorAll('[data-admin-save]')) button.addEventListener('click', async () => {
    const id = button.dataset.adminSave;
    try { await api(`/api/admin/admins/${encodeURIComponent(id)}`, 'PUT', { permissions: checkedValues(`admin-${id}`) }); showMsg('msg-admin', '保存しました'); }
    catch (error) { showMsg('msg-admin', error.message, true); }
  });
  for (const button of document.querySelectorAll('[data-admin-del]')) button.addEventListener('click', async () => {
    const id = button.dataset.adminDel;
    if (!confirm(`${id} を管理者から削除しますか？`)) return;
    try { await api(`/api/admin/admins/${encodeURIComponent(id)}`, 'DELETE'); await load(); }
    catch (error) { showMsg('msg-admin', error.message, true); }
  });
}

function renderPersonas() {
  $('persona-list').innerHTML = state.personas.map(persona => `<div class="persona">
    <div><img src="/avatars/${esc(persona.id)}.png?t=${Date.now()}" alt="" /><label style="margin-top:6px">アイコン（PNG）<input type="file" accept="image/*" data-icon="${esc(persona.id)}" /></label></div>
    <div>
      <label>名前</label><input type="text" data-persona-name="${esc(persona.id)}" value="${esc(persona.name)}" />
      <label>人格プロンプト（Discord で話すときだけ使われます）</label>
      <textarea data-persona-prompt="${esc(persona.id)}">${esc(persona.prompt)}</textarea>
      <p style="margin-top:8px">
        <button class="btn" data-persona-save="${esc(persona.id)}">保存</button>
        <button class="btn danger" data-persona-del="${esc(persona.id)}">削除</button>
      </p>
    </div>
  </div>`).join('') || '<p class="note">人格がまだありません。</p>';
  for (const button of document.querySelectorAll('[data-persona-save]')) button.addEventListener('click', async () => {
    const id = button.dataset.personaSave;
    try {
      await api(`/api/admin/personas/${encodeURIComponent(id)}`, 'PUT', {
        name: document.querySelector(`[data-persona-name="${CSS.escape(id)}"]`).value,
        prompt: document.querySelector(`[data-persona-prompt="${CSS.escape(id)}"]`).value
      });
      showMsg('msg-persona', '保存しました');
      await load();
    } catch (error) { showMsg('msg-persona', error.message, true); }
  });
  for (const button of document.querySelectorAll('[data-persona-del]')) button.addEventListener('click', async () => {
    const id = button.dataset.personaDel;
    if (!confirm('この人格を削除しますか？')) return;
    try { await api(`/api/admin/personas/${encodeURIComponent(id)}`, 'DELETE'); await load(); }
    catch (error) { showMsg('msg-persona', error.message, true); }
  });
  for (const input of document.querySelectorAll('[data-icon]')) input.addEventListener('change', async () => {
    const id = input.dataset.icon;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const base64 = await fileToPngBase64(file);
      await api(`/api/admin/personas/${encodeURIComponent(id)}/icon`, 'POST', { image: base64 });
      showMsg('msg-persona', 'アイコンを変更しました');
      await load();
    } catch (error) { showMsg('msg-persona', error.message, true); }
  });
}

// 選ばれた画像を PNG に変換して base64 で返す（サーバー側でも PNG 署名と容量を検証する）
function fileToPngBase64(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 512 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('画像を変換できませんでした'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:image\/png;base64,/, ''));
        reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
        reader.readAsDataURL(blob);
      }, 'image/png');
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    image.src = url;
  });
}

function renderMembers() {
  const personaOptions = selected => `<option value="">（なし）</option>` + state.personas.map(persona => `<option value="${esc(persona.id)}" ${persona.id === selected ? 'selected' : ''}>${esc(persona.name)}</option>`).join('');
  $('member-list').innerHTML = state.jobRules.map(rule => {
    const members = state.members.filter(member => member.job === rule.job);
    const count = members.length;
    return `<div class="member-job">
      <div class="member-job-head">
        <strong>${esc(rule.job)}</strong>
        <span class="count-ctl">
          <button data-count="${esc(rule.job)}" data-delta="-1" ${rule.locked || count <= rule.min ? 'disabled' : ''}>−</button>
          <span>${count}人</span>
          <button data-count="${esc(rule.job)}" data-delta="1" ${rule.locked || count >= rule.max ? 'disabled' : ''}>＋</button>
        </span>
        ${rule.locked ? '<span class="note">人数固定（変更不可）</span>' : `<span class="note">${rule.min}〜${rule.max}人</span>`}
      </div>
      ${members.map(member => `<div class="member-line"><code>${esc(member.id)}</code><select data-member-persona="${esc(member.id)}">${personaOptions(member.personaId)}</select></div>`).join('')}
    </div>`;
  }).join('');
  for (const button of document.querySelectorAll('[data-count]')) button.addEventListener('click', async () => {
    const job = button.dataset.count;
    const count = state.members.filter(member => member.job === job).length + Number(button.dataset.delta);
    try { await api('/api/admin/members/count', 'PUT', { job, count }); await load(); }
    catch (error) { showMsg('msg-member', error.message, true); }
  });
  for (const select of document.querySelectorAll('[data-member-persona]')) select.addEventListener('change', async () => {
    try {
      await api(`/api/admin/members/${encodeURIComponent(select.dataset.memberPersona)}/persona`, 'PUT', { personaId: select.value || null });
      showMsg('msg-member', '割り当てを変更しました');
      await load();
    } catch (error) { showMsg('msg-member', error.message, true); }
  });
}

function renderPrompts() {
  const select = $('prompt-file');
  select.innerHTML = state.prompts.map(entry => `<option value="${esc(entry.file)}">${esc(entry.file)}${entry.hasOverride ? '（上書き中）' : ''}</option>`).join('');
  select.onchange = () => loadPrompt().catch(error => showMsg('msg-prompt', error.message, true));
  loadPrompt().catch(error => showMsg('msg-prompt', error.message, true));
}

async function loadPrompt() {
  const file = $('prompt-file').value;
  if (!file) return;
  const data = await api(`/api/admin/prompts/${encodeURIComponent(file)}`);
  $('prompt-content').value = data.content;
  $('prompt-source').textContent = data.source === 'override' ? '現在は管理画面の上書きが使われています。' : '現在はリポジトリのファイルが使われています。';
}

function renderDecision() {
  decisionIds = [...(state.decisionUserIds || [])];
  const draw = () => {
    $('decision-list').innerHTML = decisionIds.length
      ? decisionIds.map(id => `<div class="member-line"><code>${esc(id)}</code><button class="btn danger" data-decision-del="${esc(id)}">削除</button></div>`).join('')
      : '<p class="note">まだ登録がありません。</p>';
    for (const button of document.querySelectorAll('[data-decision-del]')) button.addEventListener('click', async () => {
      decisionIds = decisionIds.filter(id => id !== button.dataset.decisionDel);
      try { await api('/api/admin/decision-users', 'PUT', { ids: decisionIds }); showMsg('msg-decision', '保存しました'); }
      catch (error) { showMsg('msg-decision', error.message, true); }
      draw();
    });
  };
  draw();
}

$('logout').addEventListener('click', async () => { await api('/api/admin/logout', 'POST').catch(() => {}); location.reload(); });
$('base-save').addEventListener('click', async () => {
  try { await api('/api/admin/base-permissions', 'PUT', { permissions: checkedValues('base') }); showMsg('msg-admin', 'ベース権限を保存しました'); }
  catch (error) { showMsg('msg-admin', error.message, true); }
});
$('admin-add').addEventListener('click', async () => {
  try {
    await api('/api/admin/admins', 'POST', {
      misskeyId: $('new-admin-id').value.trim(),
      username: $('new-admin-name').value.trim(),
      permissions: checkedValues('new-admin')
    });
    $('new-admin-id').value = ''; $('new-admin-name').value = '';
    showMsg('msg-admin', '追加しました');
    await load();
  } catch (error) { showMsg('msg-admin', error.message, true); }
});
$('persona-add').addEventListener('click', async () => {
  try {
    await api('/api/admin/personas', 'POST', { name: $('new-persona-name').value, prompt: $('new-persona-prompt').value });
    $('new-persona-name').value = ''; $('new-persona-prompt').value = '';
    showMsg('msg-persona', '追加しました');
    await load();
  } catch (error) { showMsg('msg-persona', error.message, true); }
});
$('prompt-save').addEventListener('click', async () => {
  try {
    await api(`/api/admin/prompts/${encodeURIComponent($('prompt-file').value)}`, 'PUT', { content: $('prompt-content').value });
    showMsg('msg-prompt', '上書きを保存しました');
    await load();
  } catch (error) { showMsg('msg-prompt', error.message, true); }
});
$('prompt-reset').addEventListener('click', async () => {
  try {
    await api(`/api/admin/prompts/${encodeURIComponent($('prompt-file').value)}`, 'DELETE');
    showMsg('msg-prompt', 'ファイルの内容に戻しました');
    await load();
  } catch (error) { showMsg('msg-prompt', error.message, true); }
});
$('decision-add').addEventListener('click', async () => {
  const id = $('new-decision-id').value.trim();
  if (!id) return;
  decisionIds = [...new Set([...decisionIds, id])];
  try {
    await api('/api/admin/decision-users', 'PUT', { ids: decisionIds });
    $('new-decision-id').value = '';
    showMsg('msg-decision', '保存しました');
    await load();
  } catch (error) { showMsg('msg-decision', error.message, true); }
});

load().catch(error => { $('login-view').hidden = false; console.error(error); });
