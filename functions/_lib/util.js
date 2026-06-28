// 공통 유틸 (응답·인증·사용량·분위기)

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export const uuid = () => crypto.randomUUID();
export const nowISO = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

// 입력 길이 제한 (plan §4.6)
export const LIMITS = { post: 2000, comment: 500 };

// 세션 토큰 검증 → account_id 반환 (없으면 null)
export async function getAccount(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT account_id, expires_at FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row.account_id;
}

// 분위기 다이얼 → 시스템 프롬프트 보강 (plan §3.2) — 단 역할/캐릭터는 유지
export function moodInstruction(mood) {
  if (mood === 'critical') return '\n[이번 분위기] 비판을 평소보다 한 단계 강하게. 단 네 역할/말투는 유지.';
  if (mood === 'support') return '\n[이번 분위기] 평소보다 따뜻하고 격려 위주로. 단 네 역할/말투는 유지.';
  return '';
}

// 일일 사용량 카운터 증가 (plan §14.3 / UsageCounter)
export async function bumpUsage(env, accountId, provider) {
  const col = { groq: 'groq_calls', gemini: 'gemini_calls', qwen: 'qwen_calls' }[provider] || 'groq_calls';
  await env.DB.prepare(
    `INSERT INTO usage_counters (account_id, date, calls, ${col})
     VALUES (?, ?, 1, 1)
     ON CONFLICT(account_id, date) DO UPDATE SET calls = calls + 1, ${col} = ${col} + 1`
  ).bind(accountId, today()).run();
}

// 일일 글 상한 확인 (plan §14.3: 사용자별 30글/일 [추정])
export const DAILY_POST_CAP = 30;
export async function dailyPostCount(env, accountId) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND author_type = "user" AND substr(created_at,1,10) = ?'
  ).bind(accountId, today()).first();
  return row?.n ?? 0;
}
