// Meari 프론트엔드 (MVP) — 온보딩 + 내 글 → 5명 도착 연출 댓글
const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'meari_token';
let PERSONAS = {};      // id -> meta
let mood = 'balanced';
let postsToday = 0;

const token = () => localStorage.getItem(TOKEN_KEY);
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });

// ── DOM 헬퍼 (innerHTML 미사용 — XSS 차단, plan §4.6-3) ──
function elem(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
function avatarEl(meta) {
  const a = meta?.avatar || { glyph: '?', bg: 'bg-slate-400', text: 'text-white' };
  // bg/text/glyph는 서버 하드코딩 메타지만, 안전하게 textContent로만 삽입
  return elem('span', `shrink-0 w-9 h-9 rounded-lg ${a.bg} ${a.text} flex items-center justify-center font-bold text-sm`, a.glyph);
}
const PROVIDER_LABEL = { groq: 'Groq', gemini: 'Gemini', qwen: 'Qwen' };
function providerLabel(p) { return PROVIDER_LABEL[p] || ''; } // 미지 값은 표시 안 함(M-5)

// 안전한 본문 노드 (textContent + pre-wrap)
function bodyNode(text) {
  const div = elem('div', 'kr whitespace-pre-wrap text-[15px] mt-1');
  div.textContent = text;
  return div;
}

// ── 화면 전환 ──
function show(which) {
  $('#onboarding').classList.toggle('hidden', which !== 'onboarding');
  $('#onboarding').classList.toggle('flex', which === 'onboarding');
  $('#main').classList.toggle('hidden', which !== 'main');
}

// ── 온보딩 ──
$('#startBtn').addEventListener('click', async () => {
  const inviteCode = $('#inviteInput').value.trim();
  const err = $('#onbErr');
  err.classList.add('hidden');
  $('#startBtn').disabled = true;
  try {
    const res = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error === 'invalid_invite' ? '초대코드가 올바르지 않아요.' : '로그인 실패');
    localStorage.setItem(TOKEN_KEY, data.token);
    await boot();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    $('#startBtn').disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch { /* 무시 */ }
  localStorage.removeItem(TOKEN_KEY);
  show('onboarding');
});

// ── 분위기 토글 ──
$('#moodToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mood]');
  if (!btn) return;
  mood = btn.dataset.mood;
  [...$('#moodToggle').children].forEach((b) => {
    const on = b === btn;
    b.classList.toggle('bg-white', on);
    b.classList.toggle('dark:bg-slate-700', on);
    b.classList.toggle('shadow-sm', on);
    b.classList.toggle('font-medium', on);
  });
});

// ── 글자 수 / 단축키 ──
$('#postBody').addEventListener('input', (e) => { $('#charCount').textContent = `${e.target.value.length}/2000`; });
$('#postBody').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
$('#sendBtn').addEventListener('click', send);

// ── 전송 ──
async function send() {
  const ta = $('#postBody');
  const body = ta.value.trim();
  if (!body) return;
  if (!Object.keys(PERSONAS).length) { // 메타 미로드 — 재시도(m-4)
    await loadPersonas();
    if (!Object.keys(PERSONAS).length) { alert('페르소나 정보를 불러오지 못했어요. 새로고침 해주세요.'); return; }
  }
  $('#sendBtn').disabled = true;
  const submittedAt = Date.now();

  const thread = $('#thread');
  thread.innerHTML = ''; // 정적 비우기(사용자 입력 미포함)

  // 내 글 카드
  const myCard = elem('div', 'rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4');
  myCard.appendChild(elem('div', 'text-xs text-slate-400', '내 글'));
  myCard.appendChild(bodyNode(body));
  thread.appendChild(myCard);

  // 도착 대기 인디케이터(도착 딜레이 순)
  const ordered = Object.values(PERSONAS).sort((a, b) => a.arrivalDelayMs - b.arrivalDelayMs);
  const slots = {};
  for (const m of ordered) {
    const slot = elem('div', 'rounded-2xl bg-slate-100/60 dark:bg-slate-800/60 p-4 flex items-center gap-2 text-slate-400 text-sm');
    slot.appendChild(avatarEl(m));
    slot.appendChild(elem('span', null, `${m.name} 생각 중 · · ·`));
    thread.appendChild(slot);
    slots[m.id] = slot;
  }

  try {
    const res = await fetch('/api/comment', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ body, mood }) });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'daily_cap') alert(data.message || '오늘 무료 한도 도달');
      else if (data.error === 'unauthorized') { localStorage.removeItem(TOKEN_KEY); show('onboarding'); }
      else alert('오류: ' + (data.error || res.status));
      Object.values(slots).forEach((s) => s.remove());
      return;
    }

    const byId = Object.fromEntries(data.comments.map((c) => [c.personaId, c]));
    for (const m of ordered) {
      const c = byId[m.id];
      const slot = slots[m.id];
      const wait = Math.max((m.arrivalDelayMs || 0) - (Date.now() - submittedAt), 250);
      if (!c) setTimeout(() => replaceWithError(slot, m), wait); // 실패 카드로 교체(m-6)
      else setTimeout(() => revealComment(slot, m, c), wait);
    }
    postsToday++;
    $('#quota').textContent = `오늘 ${postsToday}/30`;
    ta.value = '';
    $('#charCount').textContent = '0/2000';
  } catch (e) {
    alert('네트워크 오류. 다시 시도해주세요.');
    Object.values(slots).forEach((s) => s.remove());
  } finally {
    $('#sendBtn').disabled = false;
  }
}

function replaceWithError(slot, meta) {
  if (!slot) return;
  const card = elem('div', 'rounded-2xl bg-slate-100/60 dark:bg-slate-800/60 p-4 flex items-center gap-2 text-slate-400 text-sm');
  card.appendChild(avatarEl(meta));
  card.appendChild(elem('span', null, `${meta.name} 응답 실패 — 잠시 후 다시 시도`));
  slot.replaceWith(card);
}

function revealComment(slot, meta, c) {
  if (!slot) return;
  const synth = meta.isSynthesizer;
  const card = elem('div', synth
    ? 'fadeup rounded-2xl bg-slate-900 text-slate-100 p-4'
    : 'fadeup rounded-2xl bg-white dark:bg-slate-800 border-l-2 border-slate-200 dark:border-slate-700 p-4');

  const header = elem('div', 'flex items-center gap-2');
  header.appendChild(avatarEl(meta));
  header.appendChild(elem('span', 'font-semibold text-sm', meta.name));
  header.appendChild(elem('span',
    `text-[11px] px-1.5 py-0.5 rounded ${synth ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300'}`,
    meta.role));
  const right = elem('span', 'ml-auto flex items-center gap-1');
  if (c.needsVerification) right.appendChild(elem('span', 'text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700', '검증 필요'));
  const pl = providerLabel(c.provider);
  if (pl) right.appendChild(elem('span', 'text-[10px] text-slate-400', pl));
  header.appendChild(right);

  card.appendChild(header);
  card.appendChild(bodyNode(c.body));
  slot.replaceWith(card);
}

// ── 페르소나 메타 로드 ──
async function loadPersonas() {
  try {
    const res = await fetch('/api/personas');
    const data = await res.json();
    PERSONAS = Object.fromEntries(data.personas.map((p) => [p.id, p]));
  } catch { /* 다음 전송에서 재시도 */ }
}

// ── 부팅 ──
async function boot() {
  show('main');
  await loadPersonas();
}

if (token()) boot(); else show('onboarding');
