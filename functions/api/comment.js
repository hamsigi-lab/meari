// POST /api/comment — 내 글 작성 → 5명 페르소나 fan-out 댓글 (plan §6.3 사용자 글 반응 루프)
// body: { body, mood }  →  { postId, comments[], errors[] }
import { json, uuid, nowISO, LIMITS, getAccount, moodInstruction, bumpUsage, dailyPostCount, DAILY_POST_CAP } from '../_lib/util.js';
import { PERSONAS } from '../_lib/personas.js';
import { callPersona } from '../_lib/providers.js';

export async function onRequestPost({ request, env }) {
  const accountId = await getAccount(request, env);
  if (!accountId) return json({ error: 'unauthorized' }, 401);

  let body = '', mood = 'balanced';
  try {
    ({ body = '', mood = 'balanced' } = await request.json());
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  body = String(body).trim();
  if (!body) return json({ error: 'empty' }, 400);
  if (body.length > LIMITS.post) return json({ error: 'too_long', limit: LIMITS.post }, 413);

  // 일일 무료 한도 (plan §14.3)
  if ((await dailyPostCount(env, accountId)) >= DAILY_POST_CAP) {
    return json({ error: 'daily_cap', message: '오늘 무료 한도에 도달했어요. 내일 다시 또는 본인 키 등록.' }, 429);
  }

  // 1) 글 저장
  const postId = uuid();
  const createdAt = nowISO();
  await env.DB.prepare(
    'INSERT INTO posts (id, author_type, author_id, body, source_type, created_at) VALUES (?, "user", ?, ?, "user_written", ?)'
  ).bind(postId, accountId, body, createdAt).run();

  const moodSys = moodInstruction(mood);

  // 2) 5명 병렬 fan-out (3사 라우팅 + 폴백). 일부 실패해도 나머지는 진행.
  const results = await Promise.allSettled(
    PERSONAS.map((p) => callPersona(p, p.system + moodSys, body, env).then((r) => ({ p, r })))
  );

  const comments = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const persona = PERSONAS[i];
    const settled = results[i];
    if (settled.status !== 'fulfilled') {
      errors.push({ personaId: persona.id, error: String(settled.reason).slice(0, 160) });
      continue;
    }
    const { r } = settled.value;
    const commentId = uuid();
    const needsVerification = /\[검증 필요\]/.test(r.text) ? 1 : 0;
    const commentType = persona.isSynthesizer ? 'synthesis' : 'reaction';
    comments.push({
      id: commentId,
      personaId: persona.id,
      body: r.text,
      provider: r.provider,
      fellBack: r.fellBack,
      needsVerification: !!needsVerification,
      arrivalDelayMs: persona.arrivalDelayMs,
    });
    // 3) 저장 + 사용량 (대기 없이)
    await env.DB.prepare(
      `INSERT INTO comments (id, post_id, author_persona_id, depth, body, comment_type, needs_verification, arrival_delay_ms, provider, generated_by, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'user_post_reaction', ?)`
    ).bind(commentId, postId, persona.id, r.text, commentType, needsVerification, persona.arrivalDelayMs, r.provider, nowISO()).run();
    await bumpUsage(env, accountId, r.provider);
  }

  // 페르소나 정의 순서대로(=도착 딜레이 순) 정렬해 반환
  comments.sort((a, b) => a.arrivalDelayMs - b.arrivalDelayMs);
  return json({ postId, createdAt, comments, errors });
}
