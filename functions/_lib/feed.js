// 발화 피드 생성 로직 (plan §14.8) — 공유 피드, Worker/Cron이 주기 호출.
// 전체 사용자 관심사 합집합에서 주제 균등 순환 → 1명 자체 글 + 1~3명 댓글.
import { uuid, nowISO } from './util.js';
import { PERSONAS, COMMON_RULES } from './personas.js';
import { callPersona } from './providers.js';

const DEFAULT_TOPICS = ['오늘 저녁 메뉴', '요즘 뉴스', '요리', '일상 딜레마', '새 아이디어', '주말 계획'];

// KST 야간(23~07시) 억제
function isNightKST() {
  const h = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
  return h >= 23 || h < 7;
}

async function pickTopic(env) {
  // 전체 사용자 관심사 합집합 (없으면 기본 풀)
  try {
    const rows = await env.DB.prepare('SELECT interests FROM user_prefs').all();
    const pool = new Set(DEFAULT_TOPICS);
    for (const r of rows.results || []) {
      try { (JSON.parse(r.interests || '[]')).forEach((t) => t && pool.add(t)); } catch {}
    }
    const arr = [...pool];
    return arr[Math.floor(Math.random() * arr.length)];
  } catch {
    return DEFAULT_TOPICS[Math.floor(Math.random() * DEFAULT_TOPICS.length)];
  }
}

// 한 사이클: 자체 글 1 + 댓글 1~3 (캡 내). 성공 시 생성 요약 반환.
export async function generateFeedCycle(env, { force = false } = {}) {
  if (!force && isNightKST()) return { skipped: 'night' };

  const cfg = await env.DB.prepare('SELECT * FROM system_feed_config WHERE id = 1').first();
  // 일일 캡 확인 (오늘 생성된 공유 글 수)
  const todayCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE is_shared_feed = 1 AND substr(created_at,1,10) = ?"
  ).bind(nowISO().slice(0, 10)).first();
  if (cfg && (todayCount?.n ?? 0) >= cfg.daily_ai_post_cap) return { skipped: 'daily_cap' };

  const topic = await pickTopic(env);

  // 1) 자체 글 작성자: 비종합자 중 무작위
  const authors = PERSONAS.filter((p) => !p.isSynthesizer);
  const author = authors[Math.floor(Math.random() * authors.length)];
  const postPrompt = `다음 주제로 짧은 글을 네가 직접 한 편 올려줘(댓글이 아니라 게시물). 주제: "${topic}". 너의 평소 말투·관점 그대로, 2~4문장. 인사말·메타발언 없이 본문만.`;

  let postText;
  try {
    const r = await callPersona(author, author.system + COMMON_RULES, postPrompt, env);
    postText = r.text;
  } catch (e) {
    return { error: 'author_failed', detail: String(e).slice(0, 160) };
  }

  const postId = uuid();
  const createdAt = nowISO();
  const category = ['노을', '이루리'].includes(author.name) ? 'fun' : 'mixed';
  const stmts = [
    env.DB.prepare(
      `INSERT INTO posts (id, author_type, author_id, body, topic_tags, category, source_type, is_shared_feed, created_at)
       VALUES (?, 'persona', ?, ?, ?, ?, 'ai_generated', 1, ?)`
    ).bind(postId, author.id, postText, JSON.stringify([topic]), category, createdAt),
  ];

  // 2) 댓글: 작성자 외 1~3명 (depth=1)
  const others = PERSONAS.filter((p) => p.id !== author.id && !p.isSynthesizer);
  shuffle(others);
  const commenters = others.slice(0, 1 + Math.floor(Math.random() * 3));
  const settled = await Promise.allSettled(
    commenters.map((p) => callPersona(p, p.system + COMMON_RULES, postText, env).then((r) => ({ p, r })))
  );
  const comments = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const { p, r } = s.value;
    const cid = uuid();
    comments.push({ personaId: p.id, body: r.text, provider: r.provider });
    stmts.push(
      env.DB.prepare(
        `INSERT INTO comments (id, post_id, author_persona_id, depth, body, comment_type, arrival_delay_ms, provider, generated_by, created_at)
         VALUES (?, ?, ?, 1, ?, 'reaction', ?, ?, 'ai_post_reaction', ?)`
      ).bind(cid, postId, p.id, r.text, p.arrivalDelayMs, r.provider, nowISO())
    );
  }

  stmts.push(env.DB.prepare('UPDATE system_feed_config SET last_generated_at = ? WHERE id = 1').bind(createdAt));
  await env.DB.batch(stmts);
  return { postId, author: author.id, topic, comments: comments.length };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
