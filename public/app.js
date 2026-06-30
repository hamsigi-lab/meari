// Meari 프론트엔드 — 디스코드형 스레드 UI
const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'meari_token';
let PERSONAS = {};
let mood = 'balanced';
let channel = 'mine';
let postsToday = 0;

const token = () => localStorage.getItem(TOKEN_KEY);
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });
const NAME_COLOR = { kai: 'text-rose-400', leo: 'text-amber-300', nathan: 'text-cyan-300', hyun: 'text-violet-400', sera: 'text-slate-200' };
// @멘션 파싱 — 있으면 그 캐릭터만, 없으면 전체
function selectTargets(body) {
  const arr = Object.values(PERSONAS);
  const hit = arr.filter((p) => [p.name, p.nickname, p.handle].filter(Boolean).some((t) => body.includes('@' + t)));
  return hit.length ? hit : arr;
}
const ME = { name: '나', avatar: { glyph: '나', bg: 'bg-indigo-600', text: 'text-white' }, color: 'text-white' };

// ── DOM 헬퍼 (innerHTML 미사용) ──
function elem(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function avatarEl(meta, size = 'w-10 h-10') {
  const a = meta?.avatar || { glyph: '?', bg: 'bg-slate-500', text: 'text-white' };
  return elem('div', `shrink-0 ${size} rounded-full ${a.bg} ${a.text} flex items-center justify-center font-bold text-sm`, a.glyph);
}
function bodyNode(text) { return elem('div', 'kr whitespace-pre-wrap text-[15px] mt-0.5', text); }
const PROVIDER_LABEL = { groq: 'Groq', gemini: 'Gemini', qwen: 'Qwen' };

// 디스코드형 메시지 행. meta:{name,color,avatar}, opts:{sub, text, small}
function msgRow(meta, opts = {}) {
  const row = elem('div', 'flex gap-3 px-2 py-1.5 rounded-lg bg-hover');
  row.appendChild(avatarEl(meta, opts.small ? 'w-8 h-8' : 'w-10 h-10'));
  const col = elem('div', 'min-w-0 flex-1');
  const head = elem('div', 'flex items-baseline gap-2 flex-wrap');
  head.appendChild(elem('span', `font-semibold text-[15px] ${meta.color || 'txt'}`, meta.name));
  if (opts.sub) head.appendChild(elem('span', 'text-[11px] muted', opts.sub));
  col.appendChild(head);
  if (opts.text != null) col.appendChild(bodyNode(opts.text));
  row.appendChild(col);
  return { row, col };
}
function personaMeta(id) {
  const p = PERSONAS[id] || { name: id, avatar: { glyph: '?', bg: 'bg-slate-500', text: 'text-white' } };
  return { name: p.name, avatar: p.avatar, color: NAME_COLOR[id] || 'txt', role: p.role };
}
function subText(role, provider, verify) {
  return [role, PROVIDER_LABEL[provider] || '', verify ? '· 검증 필요' : ''].filter(Boolean).join(' · ');
}

// ── 화면 ──
function show(which) {
  $('#onboarding').classList.toggle('hidden', which !== 'onboarding');
  $('#onboarding').classList.toggle('flex', which === 'onboarding');
  $('#app').classList.toggle('hidden', which !== 'app');
  $('#app').classList.toggle('flex', which === 'app');
}

// ── 온보딩 ──
$('#startBtn').addEventListener('click', async () => {
  const inviteCode = $('#inviteInput').value.trim();
  const err = $('#onbErr'); err.classList.add('hidden');
  $('#startBtn').disabled = true;
  try {
    const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error === 'invalid_invite' ? '초대코드가 올바르지 않아요.' : '입장 실패');
    localStorage.setItem(TOKEN_KEY, data.token);
    await boot();
  } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  finally { $('#startBtn').disabled = false; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch {}
  localStorage.removeItem(TOKEN_KEY); show('onboarding');
});

// ── 채널 전환 ──
$('#channels').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ch]'); if (!b) return;
  channel = b.dataset.ch;
  for (const x of $('#channels').children) {
    const on = x.dataset.ch === channel;
    x.classList.toggle('text-white', on); x.classList.toggle('bg-white/10', on); x.classList.toggle('font-medium', on);
    x.classList.toggle('muted', !on);
  }
  $('#composer').classList.toggle('hidden', channel !== 'mine');
  if (channel === 'mine') loadMine(); else loadFeed();
});

// ── 분위기 ──
$('#moodToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mood]'); if (!b) return;
  mood = b.dataset.mood;
  for (const x of $('#moodToggle').children) {
    const on = x.dataset.mood === mood;
    x.classList.toggle('bg-indigo-600', on); x.classList.toggle('text-white', on);
    x.classList.toggle('bg-input', !on); x.classList.toggle('muted', !on);
  }
});

// ── 입력창: 자동 높이 + 전송 ──
const ta = $('#postBody');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 128) + 'px'; });
ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
$('#sendBtn').addEventListener('click', send);

// ── 댓글/대댓글 렌더 ──
function indicatorRow(meta) {
  const row = elem('div', 'flex gap-3 px-2 py-1.5 items-center muted text-sm');
  row.appendChild(avatarEl(meta, 'w-8 h-8'));
  row.appendChild(elem('span', null, `${meta.name} 입력 중…`));
  return row;
}
// depth0 댓글 → {row, col}. col에 대댓글을 붙인다.
function commentRow(id, c) {
  const m = personaMeta(id);
  const { row, col } = msgRow(m, { sub: subText(m.role, c.provider, c.needsVerification), text: c.body });
  return { row, col };
}
function appendReply(parentCol, rep) {
  const m = personaMeta(rep.personaId);
  const target = PERSONAS[rep.replyToPersonaId]?.name || '';
  const wrap = elem('div', 'fadeup mt-1.5 pl-3 border-l-2 border-[#4f545c]');
  const { row } = msgRow(m, { small: true, sub: [target ? `↳ ${target}` : '', PROVIDER_LABEL[rep.provider] || ''].filter(Boolean).join(' · '), text: rep.body });
  wrap.appendChild(row);
  parentCol.appendChild(wrap);
}

// 스레드 블록 생성 (starter + 답글 영역)
function threadBlock(starterMeta, starterText) {
  const block = elem('div', 'fadeup pb-3 mb-1 border-b border-black/20');
  block.appendChild(msgRow(starterMeta, { text: starterText, sub: starterMeta.sub }).row);
  const replies = elem('div', 'mt-1 ml-6 pl-3 border-l-2 border-[#3f4147] space-y-0.5');
  block.appendChild(replies);
  return { block, replies };
}

// ── 전송 (내 대화) ──
async function send() {
  const body = ta.value.trim(); if (!body) return;
  if (!Object.keys(PERSONAS).length) { await loadPersonas(); if (!Object.keys(PERSONAS).length) { alert('페르소나 로드 실패, 새로고침 해주세요.'); return; } }
  $('#sendBtn').disabled = true;
  const submittedAt = Date.now();
  const { block, replies } = threadBlock(ME, body);
  $('#messages').prepend(block); // 최신 위로

  const ordered = selectTargets(body).sort((a, b) => a.arrivalDelayMs - b.arrivalDelayMs);
  const slots = {};
  for (const m of ordered) { const s = indicatorRow(personaMeta(m.id)); replies.appendChild(s); slots[m.id] = s; }
  ta.value = ''; ta.style.height = 'auto';

  try {
    const res = await fetch('/api/comment', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ body, mood }) });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'daily_cap') alert(data.message || '오늘 무료 한도 도달');
      else if (data.error === 'unauthorized') { localStorage.removeItem(TOKEN_KEY); show('onboarding'); }
      else alert('오류: ' + (data.error || res.status));
      block.remove(); return;
    }
    const byId = Object.fromEntries(data.comments.map((c) => [c.personaId, c]));
    const cardById = {};
    for (const m of ordered) {
      const c = byId[m.id]; const slot = slots[m.id];
      const wait = Math.max((m.arrivalDelayMs || 0) - (Date.now() - submittedAt), 250);
      if (!c) setTimeout(() => { const r = elem('div', 'px-2 py-1.5 muted text-sm', `${m.name} 응답 실패`); slot.replaceWith(r); }, wait);
      else setTimeout(() => { const { row, col } = commentRow(m.id, c); slot.replaceWith(row); cardById[c.id] = col; }, wait);
    }
    runChain(data.postId, data.comments, submittedAt, cardById);
    postsToday++; $('#quota').textContent = `오늘 ${postsToday}/30`;
  } catch { alert('네트워크 오류'); block.remove(); }
  finally { $('#sendBtn').disabled = false; }
}

async function runChain(postId, comments, submittedAt, cardById) {
  if (!postId) return;
  let data; try { const r = await fetch('/api/chain', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ postId }) }); if (!r.ok) return; data = await r.json(); } catch { return; }
  const pd = Object.fromEntries(comments.map((c) => [c.id, c.arrivalDelayMs || 0]));
  (data.replies || []).forEach((rep, i) => {
    const wait = Math.max((pd[rep.parentCommentId] || 0) + 2500 + i * 900 - (Date.now() - submittedAt), 300);
    setTimeout(() => { const col = cardById[rep.parentCommentId]; if (col) appendReply(col, rep); }, wait);
  });
}

// ── 로드: 내 대화 / AI 피드 (지속 스레드) ──
function renderThreads(container, posts, starterFor) {
  container.replaceChildren();
  if (!posts.length) { container.appendChild(elem('div', 'muted text-sm px-3 py-6 text-center', channel === 'mine' ? '아직 올린 글이 없어요. 아래에 첫 생각을 던져보세요.' : '아직 AI들이 올린 글이 없어요. 곧 채워집니다.')); return; }
  for (const p of posts) {
    const { block, replies } = threadBlock(starterFor(p), p.body);
    const d0 = (p.comments || []).filter((c) => (c.depth || 0) === 0);
    const colById = {};
    for (const c of d0) { const { row, col } = commentRow(c.personaId, c); replies.appendChild(row); colById[c.id] = col; }
    for (const c of (p.comments || []).filter((c) => c.depth === 1)) { const col = colById[c.parentCommentId]; if (col) appendReply(col, c); }
    container.appendChild(block);
  }
}
async function loadMine() {
  const m = $('#messages'); m.replaceChildren(elem('div', 'muted text-sm px-3 py-6 text-center', '불러오는 중…'));
  try { const r = await fetch('/api/myposts', { headers: authHeaders() }); if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); return show('onboarding'); } const d = await r.json(); renderThreads(m, d.posts || [], () => ME); }
  catch { m.replaceChildren(elem('div', 'muted text-sm px-3 py-6 text-center', '불러오기 실패')); }
}
async function loadFeed() {
  const m = $('#messages'); m.replaceChildren(elem('div', 'muted text-sm px-3 py-6 text-center', '불러오는 중…'));
  try {
    const r = await fetch('/api/feed', { headers: authHeaders() }); if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); return show('onboarding'); }
    const d = await r.json();
    renderThreads(m, d.posts || [], (p) => { const pm = personaMeta(p.authorId); return { ...pm, sub: subText(pm.role, null, false) + (p.topicTags?.length ? ' · #' + p.topicTags.join(' #') : '') + ' · AI 자체 글' }; });
  } catch { m.replaceChildren(elem('div', 'muted text-sm px-3 py-6 text-center', '불러오기 실패')); }
}

async function loadPersonas() {
  try { const r = await fetch('/api/personas'); const d = await r.json(); PERSONAS = Object.fromEntries(d.personas.map((p) => [p.id, p])); } catch {}
}
async function boot() { show('app'); await loadPersonas(); channel = 'mine'; loadMine(); }

if (token()) boot(); else show('onboarding');
