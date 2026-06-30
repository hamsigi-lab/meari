// GET /api/feed — 공유 발화 피드 읽기 (plan §14.8). 베타 사용자 공유.
import { json, getAccount } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const accountId = await getAccount(request, env);
  if (!accountId) return json({ error: 'unauthorized' }, 401);

  const posts = (await env.DB.prepare(
    "SELECT id, author_id, body, topic_tags, category, created_at FROM posts WHERE is_shared_feed = 1 ORDER BY created_at DESC LIMIT 20"
  ).all()).results || [];

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
    posts: posts.map((p) => ({
      id: p.id,
      authorId: p.author_id,        // persona id
      body: p.body,
      topicTags: safeParse(p.topic_tags),
      category: p.category,
      createdAt: p.created_at,
      comments: byPost[p.id] || [],
    })),
  });
}

function safeParse(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }
