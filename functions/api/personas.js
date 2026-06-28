// GET /api/personas — 페르소나 공개 메타(아바타·도착딜레이 등). 시스템 프롬프트는 미노출.
import { json } from '../_lib/util.js';
import { publicPersonaMeta } from '../_lib/personas.js';

export async function onRequestGet() {
  return json({ personas: publicPersonaMeta() }, 200, {
    'Cache-Control': 'public, max-age=3600',
  });
}
