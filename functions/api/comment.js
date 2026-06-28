// POST /api/comment — 내 글 작성 → 5명 페르소나 fan-out 댓글 (plan §6.3 사용자 글 반응 루프)
// body: { body, mood }  →  { postId, comments[], errors[] }
import { json, uuid, nowISO, LIMITS, getAccount, moodInstruction, usageStatement, dailyPostCount, DAILY_POST_CAP } from '../_lib/util.js';
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
  try {
    if ((await dailyPostCount(env, accountId)) >= DAILY_POST_CAP) {
      return json({ error: 'daily_cap', message: '오늘 무료 한도에 도달했어요. 내일 다시 또는 본인 키 등록.' }, 429);
    }
  } catch (e) {
    console.error('dailyPostCount', e);
    return json({ error: 'db_error' }, 500);
  }

  const postId = uuid();
  const createdAt = nowISO();
  const moodSys = moodInstruction(mood);

  // 5명 병렬 fan-out (3사 라우팅 + 폴백). 일부 실패해도 나머지는 진행.
  const settled = await Promise.allSettled(
    PERSONAS.map((p) => callPersona(p, p.system + moodSys, body, env))
  );

  // 글 저장 + 댓글 + 사용량을 한 배치(트랜잭션)로 — 원자성·라운드트립 절감(QA C-3)
  const stmts = [
    env.DB.prepare(
      "INSERT INTO posts (id, author_type, author_id, body, source_type, created_at) VALUES (?, 'user', ?, ?, 'user_written', ?)"
    ).bind(postId, accountId, body, createdAt),
  ];
  const comments = [];
  const errors = [];

  for (let i = 0; i < PERSONAS.length; i++) {
    const persona = PERSONAS[i];
    const s = settled[i];
    if (s.status !== 'fulfilled') {
      errors.push({ personaId: persona.id, error: String(s.reason).slice(0, 160) });
      continue;
    }
    const r = s.value;
    const commentId = uuid();
    const needsVerification = /\[검증 필요\]/.test(r.text) ? 1 : 0;
    const commentType = persona.isSynthesizer ? 'synthesis' : 'reaction';
    comments.push({
      id: commentId, personaId: persona.id, body: r.text, provider: r.provider,
      fellBack: r.fellBack, needsVerification: !!needsVerification, arrivalDelayMs: persona.arrivalDelayMs,
    });
    stmts.push(
      env.DB.prepare(
        `INSERT INTO comments (id, post_id, author_persona_id, depth, body, comment_type, needs_verification, arrival_delay_ms, provider, generated_by, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'user_post_reaction', ?)`
      ).bind(commentId, postId, persona.id, r.text, commentType, needsVerification, persona.arrivalDelayMs, r.provider, nowISO())
    );
    const usage = usageStatement(env, accountId, r.provider);
    if (usage) stmts.push(usage);
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    console.error('comment batch', e);
    return json({ error: 'db_error' }, 500);
  }

  comments.sort((a, b) => a.arrivalDelayMs - b.arrivalDelayMs);
  return json({ postId, createdAt, comments, errors });
}
