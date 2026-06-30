// GET/POST /api/profile — 내 표시 이름 + 아바타 이미지(data URL)
import { json, getAccount } from '../_lib/util.js';

const MAX_AVATAR = 200 * 1024; // 200KB (data URL 길이 기준)
const MAX_NAME = 20;

export async function onRequestGet({ request, env }) {
  const accountId = await getAccount(request, env);
  if (!accountId) return json({ error: 'unauthorized' }, 401);
  const row = await env.DB.prepare('SELECT display_name, avatar FROM user_prefs WHERE account_id = ?').bind(accountId).first();
  return json({ displayName: row?.display_name || '', avatar: row?.avatar || '' });
}

export async function onRequestPost({ request, env }) {
  const accountId = await getAccount(request, env);
  if (!accountId) return json({ error: 'unauthorized' }, 401);
  let displayName = '', avatar = '';
  try { ({ displayName = '', avatar = '' } = await request.json()); } catch { return json({ error: 'bad_request' }, 400); }
  displayName = String(displayName).trim().slice(0, MAX_NAME);
  avatar = String(avatar || '');
  if (avatar && !avatar.startsWith('data:image/')) return json({ error: 'bad_avatar' }, 400);
  if (avatar.length > MAX_AVATAR) return json({ error: 'avatar_too_large', message: '이미지가 너무 큽니다(200KB 이하).' }, 413);
  try {
    await env.DB.prepare(
      `INSERT INTO user_prefs (account_id, interests, muted_personas, mood, display_name, avatar)
       VALUES (?, '[]', '[]', 'balanced', ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET display_name = ?, avatar = ?`
    ).bind(accountId, displayName, avatar, displayName, avatar).run();
  } catch (e) { console.error('profile', e); return json({ error: 'db_error' }, 500); }
  return json({ ok: true, displayName, avatar });
}
