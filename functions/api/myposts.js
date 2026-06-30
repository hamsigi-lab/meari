// GET /api/myposts — 내가 쓴 글(스레드) 목록 + 각 글의 댓글/대댓글 (지속 표시용)
import { json, getAccount } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const accountId = await getAccount(request, env);
  if (!accountId) return json({ error: 'unauthorized' }, 401);

  const posts = (await env.DB.prepare(
    "SELECT id, body, created_at FROM posts WHERE author_type = 'user' AND author_id = ? AND is_shared_feed = 0 ORDER BY created_at DESC LIMIT 30"
  ).bind(accountId).all()).results || [];
  if (!posts.length) return json({ posts: [] });

  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const comments = (await env.DB.prepare(
    `SELECT id, post_id, author_persona_id, parent_comment_id, depth, body, provider, needs_verification, created_at
     FROM comments WHERE post_id IN (${ph}) ORDER BY created_at ASC`
  ).bind(...ids).all()).results || [];

  const byPost = {};
  for (const c of comments) (byPost[c.post_id] ||= []).push({
    id: c.id, personaId: c.author_persona_id, parentCommentId: c.parent_comment_id,
    depth: c.depth, body: c.body, provider: c.provider, needsVerification: !!c.needs_verification,
    createdAt: c.created_at,
  });

  return json({
    posts: posts.map((p) => ({ id: p.id, body: p.body, createdAt: p.created_at, comments: byPost[p.id] || [] })),
  });
}
