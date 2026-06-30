// POST /api/chain — 첫 댓글 라운드 이후 AI끼리 서로의 댓글에 반응(논쟁 체이닝, plan §6.3).
// body: { postId }  →  { replies[] }   (depth=1, 최대 2개)
import { json, uuid, nowISO, getAccount, usageStatement } from '../_lib/util.js';
import { PERSONA_BY_ID, PERSONAS, COMMON_RULES, SYNTH_ID } from '../_lib/personas.js';
import { callPersona } from '../_lib/providers.js';

export async function onRequestPost({ request, env }) {
  const accountId = await getAccount(request, env);
  if (!accountId) return json({ error: 'unauthorized' }, 401);

  let postId = '';
  try { ({ postId = '' } = await request.json()); } catch { return json({ error: 'bad_request' }, 400); }
  if (!postId) return json({ error: 'bad_request' }, 400);

  const post = await env.DB.prepare('SELECT id, body FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return json({ error: 'not_found' }, 404);

  // 1라운드(depth 0) 댓글들 — 종합자(강세빈) 제외하고 대상/응답자 풀 구성
  const round0 = ((await env.DB.prepare(
    'SELECT id, author_persona_id, body, depth FROM comments WHERE post_id = ? AND depth = 0 ORDER BY created_at ASC'
  ).bind(postId).all()).results || []).filter((c) => c.author_persona_id !== SYNTH_ID);

  if (round0.length < 2) return json({ replies: [] });

  // 응답자(페르소나) 셔플, 각자 자기 것이 아닌 댓글 하나에 반응 — 최대 2쌍
  const repliers = shuffle(PERSONAS.filter((p) => !p.isSynthesizer));
  const targets = shuffle([...round0]);
  const used = new Set();
  const pairs = [];
  for (const replier of repliers) {
    const t = targets.find((c) => c.author_persona_id !== replier.id && !used.has(c.id));
    if (!t) continue;
    used.add(t.id);
    pairs.push({ replier, target: t });
    if (pairs.length >= 2) break;
  }
  if (!pairs.length) return json({ replies: [] });

  const settled = await Promise.allSettled(pairs.map(({ replier, target }) => {
    const tp = PERSONA_BY_ID[target.author_persona_id];
    const tName = tp?.name || target.author_persona_id;
    const tRole = tp?.role || '';
    const sys = replier.system + COMMON_RULES +
      `\n\n[지금 상황] 너는 원글 작성자가 아니라, 아래 ${tName}(${tRole})의 '댓글'에 반응한다. 네 성격대로 동의·반박·덧붙임 중 하나로, 대화하듯 1~2문장만 짧게. 필요하면 ${tName} 이름을 불러도 좋다. 원글에 대한 새 코멘트가 아니라 그 댓글에 대한 대화다.`;
    const userText = `[원글]\n${post.body}\n\n[${tName}의 댓글]\n"${target.body}"`;
    return callPersona({ ...replier, maxTokens: 160 }, sys, userText, env)
      .then((r) => ({ replier, target, r }));
  }));

  const replies = [];
  const stmts = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const { replier, target, r } = s.value;
    const id = uuid();
    replies.push({
      id, personaId: replier.id, parentCommentId: target.id,
      replyToPersonaId: target.author_persona_id, body: r.text, provider: r.provider,
    });
    stmts.push(env.DB.prepare(
      `INSERT INTO comments (id, post_id, author_persona_id, parent_comment_id, depth, body, comment_type, provider, generated_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, 'reaction', ?, 'inter_ai_chain', ?)`
    ).bind(id, postId, replier.id, target.id, r.text, r.provider, nowISO()));
    const u = usageStatement(env, accountId, r.provider);
    if (u) stmts.push(u);
  }
  if (stmts.length) {
    try { await env.DB.batch(stmts); } catch (e) { console.error('chain batch', e); return json({ error: 'db_error' }, 500); }
  }
  return json({ replies });
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
