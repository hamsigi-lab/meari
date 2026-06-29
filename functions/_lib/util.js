// 공통 유틸 (응답·인증·사용량·분위기)

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export const uuid = () => crypto.randomUUID();
export const nowISO = () => new Date().toISOString();
// 한국(KST, UTC+9) 기준 날짜 — 일일 한도가 사용자 체감 "오늘"과 일치(QA M-4)
export const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
// KST 오늘 자정(00:00 KST)을 UTC ISO로 — created_at(UTC ISO)과 사전식 비교용
export function kstDayStartUTCISO() {
  const kstNow = Date.now() + 9 * 3600 * 1000;
  const kstMidnight = Math.floor(kstNow / 864e5) * 864e5; // shifted-ms 기준 자정
  return new Date(kstMidnight - 9 * 3600 * 1000).toISOString();
}

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
  if (mood === 'critical')
    return '\n\n[이번 분위기: 비판 강화] 평소보다 확실히 더 날카롭고 냉정하게. 좋게 포장하지 말고 약점·허점·반론을 강하게 짚어라. (단 네 고유 역할과 말투는 그대로 유지)';
  if (mood === 'support')
    return '\n\n[이번 분위기: 응원 위주] 평소보다 확실히 더 따뜻하고 너그럽게. 가능성·좋은 점·다음 한 걸음을 부각해 힘을 실어줘라. (단 네 고유 역할과 말투는 그대로 유지)';
  return '';
}

// 일일 사용량 카운터 증가 (plan §14.3 / UsageCounter)
// 컬럼명은 화이트리스트로만 — 동적 SQL 식별자 인젝션 차단(QA M-2)
const USAGE_COL = { groq: 'groq_calls', gemini: 'gemini_calls', qwen: 'qwen_calls' };
export function usageStatement(env, accountId, provider) {
  const col = USAGE_COL[provider];
  if (!col) return null; // 알 수 없는 프로바이더는 무시
  return env.DB.prepare(
    `INSERT INTO usage_counters (account_id, date, calls, ${col})
     VALUES (?, ?, 1, 1)
     ON CONFLICT(account_id, date) DO UPDATE SET calls = calls + 1, ${col} = ${col} + 1`
  ).bind(accountId, today());
}

// 일일 글 상한 확인 (plan §14.3: 사용자별 30글/일 [추정])
export const DAILY_POST_CAP = 30;
export async function dailyPostCount(env, accountId) {
  // 작은따옴표(문자열 리터럴) + KST 자정 경계로 카운트(QA M-7/M-4)
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND author_type = 'user' AND created_at >= ?"
  ).bind(accountId, kstDayStartUTCISO()).first();
  return row?.n ?? 0;
}
