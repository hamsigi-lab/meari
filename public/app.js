// Meari 프론트엔드 (MVP) — 온보딩 + 내 글 → 5명 도착 연출 댓글
const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'meari_token';
let PERSONAS = {};      // id -> meta
let mood = 'balanced';
let postsToday = 0;

const token = () => localStorage.getItem(TOKEN_KEY);
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });

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

$('#logoutBtn').addEventListener('click', () => {
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

// ── 글자 수 ──
$('#postBody').addEventListener('input', (e) => {
  $('#charCount').textContent = `${e.target.value.length}/2000`;
});
// Ctrl/Cmd+Enter 전송
$('#postBody').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
});
$('#sendBtn').addEventListener('click', send);

// ── 아바타 배지 ──
function avatarHTML(meta) {
  const a = meta?.avatar || { glyph: '?', bg: 'bg-slate-400', text: 'text-white' };
  return `<span class="shrink-0 w-9 h-9 rounded-lg ${a.bg} ${a.text} flex items-center justify-center font-bold text-sm">${a.glyph}</span>`;
}
function providerBadge(p) {
  const map = { groq: 'Groq', gemini: 'Gemini', qwen: 'Qwen' };
  return `<span class="text-[10px] text-slate-400">${map[p] || p || ''}</span>`;
}

// 안전한 본문 노드 (innerHTML 금지 — textContent + pre-wrap, plan §4.6-3)
function bodyNode(text) {
  const div = document.createElement('div');
  div.className = 'kr whitespace-pre-wrap text-[15px] mt-1';
  div.textContent = text;
  return div;
}

// ── 전송 ──
async function send() {
  const ta = $('#postBody');
  const body = ta.value.trim();
  if (!body) return;
  $('#sendBtn').disabled = true;
  const submittedAt = Date.now();

  const thread = $('#thread');
  thread.innerHTML = '';

  // 내 글 카드
  const myCard = document.createElement('div');
  myCard.className = 'rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4';
  myCard.appendChild(Object.assign(document.createElement('div'), { className: 'text-xs text-slate-400', textContent: '내 글' }));
  myCard.appendChild(bodyNode(body));
  thread.appendChild(myCard);

  // 도착 대기 인디케이터(도착 딜레이 순)
  const ordered = Object.values(PERSONAS).sort((a, b) => a.arrivalDelayMs - b.arrivalDelayMs);
  const slots = {};
  for (const m of ordered) {
    const slot = document.createElement('div');
    slot.className = 'rounded-2xl bg-slate-100/60 dark:bg-slate-800/60 p-4 flex items-center gap-2 text-slate-400 text-sm';
    slot.innerHTML = `${avatarHTML(m)}<span>${m.name} 생각 중 · · ·</span>`;
    thread.appendChild(slot);
    slots[m.id] = slot;
  }

  try {
    const res = await fetch('/api/comment', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ body, mood }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'daily_cap') alert(data.message || '오늘 무료 한도 도달');
      else if (data.error === 'unauthorized') { localStorage.removeItem(TOKEN_KEY); show('onboarding'); }
      else alert('오류: ' + (data.error || res.status));
      Object.values(slots).forEach((s) => s.remove());
      return;
    }

    // 댓글을 도착 딜레이에 맞춰 공개(제출 시점 기준)
    const byId = Object.fromEntries(data.comments.map((c) => [c.personaId, c]));
    for (const m of ordered) {
      const c = byId[m.id];
      const slot = slots[m.id];
      const elapsed = Date.now() - submittedAt;
      const wait = Math.max((m.arrivalDelayMs || 0) - elapsed, 250);
      if (!c) {
        // 실패한 페르소나
        setTimeout(() => { if (slot) { slot.querySelector('span:last-child').textContent = `${m.name} 응답 실패`; } }, wait);
        continue;
      }
      setTimeout(() => revealComment(slot, m, c), wait);
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

function revealComment(slot, meta, c) {
  const synth = meta.isSynthesizer;
  const card = document.createElement('div');
  card.className = synth
    ? 'fadeup rounded-2xl bg-slate-900 text-slate-100 p-4'
    : 'fadeup rounded-2xl bg-white dark:bg-slate-800 border-l-2 border-slate-200 dark:border-slate-700 p-4';
  const header = document.createElement('div');
  header.className = 'flex items-center gap-2';
  header.innerHTML =
    `${avatarHTML(meta)}<span class="font-semibold text-sm">${meta.name}</span>` +
    `<span class="text-[11px] px-1.5 py-0.5 rounded ${synth ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300'}">${meta.role}</span>` +
    `<span class="ml-auto flex items-center gap-1">${c.needsVerification ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">검증 필요</span>' : ''}${providerBadge(c.provider)}</span>`;
  card.appendChild(header);
  card.appendChild(bodyNode(c.body));
  slot.replaceWith(card);
}

// ── 부팅 ──
async function boot() {
  show('main');
  try {
    const res = await fetch('/api/personas');
    const data = await res.json();
    PERSONAS = Object.fromEntries(data.personas.map((p) => [p.id, p]));
  } catch { /* 무시: 다음 전송에서 재시도 */ }
}

if (token()) boot(); else show('onboarding');
