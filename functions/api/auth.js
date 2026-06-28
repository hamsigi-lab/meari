// POST /api/auth — 소수 초대 베타 로그인 (초대코드 기반)
// body: { inviteCode }  →  { token, accountId }
import { json, uuid, nowISO } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  let inviteCode = '';
  try {
    ({ inviteCode = '' } = await request.json());
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  // INVITE_CODES 미설정 시 개발 모드(누구나 허용). 설정 시 일치 필수.
  const allowed = (env.INVITE_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(inviteCode.trim())) {
    return json({ error: 'invalid_invite' }, 403);
  }

  const accountId = uuid();
  const token = uuid() + uuid().replace(/-/g, '');
  const now = nowISO();
  const expires = new Date(Date.now() + 30 * 864e5).toISOString(); // 30일

  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO accounts (id, invite_code, created_at) VALUES (?, ?, ?)')
        .bind(accountId, inviteCode.trim() || null, now),
      env.DB.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(token, accountId, now, expires),
      env.DB.prepare('INSERT INTO user_prefs (account_id, interests, muted_personas, mood) VALUES (?, ?, ?, ?)')
        .bind(accountId, '[]', '[]', 'balanced'),
    ]);
  } catch (e) {
    console.error('auth db_error', e); // 서버 로그에만 — 클라이언트엔 코드만(QA C-2)
    return json({ error: 'db_error' }, 500);
  }

  return json({ token, accountId });
}
