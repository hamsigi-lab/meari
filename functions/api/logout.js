// POST /api/logout — 서버 세션 무효화(QA M-6). 토큰 탈취 대비.
import { json } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    try {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    } catch (e) {
      console.error('logout', e);
    }
  }
  return json({ ok: true });
}
