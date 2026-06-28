// POST /api/cron — 발화 피드 한 사이클 생성 (plan §14.8).
// CRON_SECRET 헤더로 보호. Cloudflare Cron Worker / GitHub Action / 수동 호출이 주기적으로 친다.
// (Pages file-기반 functions는 scheduled 핸들러 미지원 → 외부 트리거가 이 엔드포인트 호출.)
import { json } from '../_lib/util.js';
import { generateFeedCycle } from '../_lib/feed.js';

export async function onRequestPost({ request, env }) {
  const secret = env.CRON_SECRET;
  if (!secret) return json({ error: 'cron_disabled', message: 'CRON_SECRET 미설정' }, 403);
  if (request.headers.get('X-Cron-Secret') !== secret) return json({ error: 'forbidden' }, 403);

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1'; // 야간/캡 무시(테스트용)
  try {
    const result = await generateFeedCycle(env, { force });
    return json({ ok: true, result });
  } catch (e) {
    console.error('cron', e);
    return json({ error: 'generate_failed' }, 500);
  }
}
