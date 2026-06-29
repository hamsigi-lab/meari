// 3사 프로바이더 추상화 레이어 (plan v3.2 §14.5)
// 통합 인터페이스 + 429/5xx 백오프 + 프로바이더 간 폴백(§14.3)
// MVP는 비스트리밍(전체 텍스트 반환) — 클라이언트가 도착 딜레이 연출.
// 스트리밍은 후속(§M-6 실측 후).

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  qwen: 'https://openrouter.ai/api/v1/chat/completions', // OpenRouter 경유
  gemini: (model, key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
};

// 프로바이더별 환경변수 키 이름
const ENV_KEY = { groq: 'GROQ_API_KEY', qwen: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' };

// 폴백 기본 모델 (한도 여유 순: gemini > groq > qwen, §14.3)
// 모델 ID는 2026-06 기준.
const FALLBACK_MODEL = {
  gemini: 'gemini-2.5-flash-lite',
  groq: 'llama-3.1-8b-instant',
  qwen: 'qwen/qwen3-next-80b-a3b-instruct:free',
};
const FALLBACK_ORDER = ['gemini', 'groq', 'qwen'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 한자(중국어 간체 포함)·일본어 가나 탐지 — 누출 시 재생성용
const CJK = /[㐀-鿿぀-ヿ]/;

// OpenAI 호환(Groq·OpenRouter) 호출
async function callOpenAICompat(provider, model, system, userText, maxTokens, env) {
  const key = env[ENV_KEY[provider]];
  if (!key) throw new ProviderError(provider, 'missing_key', `${ENV_KEY[provider]} 미설정`);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ],
    max_tokens: maxTokens,
    temperature: 0.7, // 자유롭게(0.6은 사고가 납작해짐). 외국어 누출은 프롬프트로 관리
  };
  if (provider === 'qwen') {
    // OpenRouter 식별 헤더(권장). (현재는 폴백 경로로만 사용)
    headers['HTTP-Referer'] = 'https://meari.pages.dev';
    headers['X-Title'] = 'Meari';
    // 베타: 개인정보 미입력 전제로 :free(학습 허용) 모델 허용.
    // ⚠️ 본격 공개(plan §14.7) 시: body.provider = { data_collection: 'deny' };
  }
  // Groq reasoning 모델: 추론 최소화(토큰 절약 + <think> 방지). gpt-oss는 'none' 불가 → 'low'.
  if (provider === 'groq') {
    if (/qwen/i.test(model)) body.reasoning_effort = 'none';
    else if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';
  }

  const res = await fetch(ENDPOINTS[provider], { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new ProviderError(provider, res.status, await safeText(res));
  const json = await res.json();
  let text = json?.choices?.[0]?.message?.content || '';
  text = stripThink(text).trim();
  if (!text) throw new ProviderError(provider, 'empty', 'empty response');
  return text;
}

// Gemini 호출 (별도 API 형태)
async function callGemini(model, system, userText, maxTokens, env) {
  const key = env[ENV_KEY.gemini];
  if (!key) throw new ProviderError('gemini', 'missing_key', 'GEMINI_API_KEY 미설정');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    // thinkingBudget:0 → 2.5 Flash 내부 추론이 출력 토큰을 잡아먹어 잘리는 문제 방지
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
  };
  const res = await fetch(ENDPOINTS.gemini(model, key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError('gemini', res.status, await safeText(res));
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!text) throw new ProviderError('gemini', 'empty', 'empty response');
  return text;
}

// 단일 (provider, model) 호출 + 429/5xx 백오프 (§14.3-2)
async function callModel(provider, model, system, userText, maxTokens, env) {
  const delays = [0, 500, 1000, 2000]; // 최초 + 3회 재시도
  let lastErr;
  for (const d of delays) {
    if (d) await sleep(d);
    try {
      return provider === 'gemini'
        ? await callGemini(model, system, userText, maxTokens, env)
        : await callOpenAICompat(provider, model, system, userText, maxTokens, env);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ProviderError && isRetryable(e.status);
      if (!retryable) break; // 429/5xx만 재시도
    }
  }
  throw lastErr;
}

// 페르소나 1명 호출: 기본 프로바이더 → 실패 시 폴백 체인 (§14.3-1)
export async function callPersona(persona, system, userText, env) {
  const tried = new Set();
  const chain = [persona.provider, ...FALLBACK_ORDER.filter((p) => p !== persona.provider)];
  let lastErr;
  for (const provider of chain) {
    if (tried.has(provider)) continue;
    tried.add(provider);
    const model = provider === persona.provider ? persona.model : FALLBACK_MODEL[provider];
    try {
      let text = await callModel(provider, model, system, userText, persona.maxTokens, env);
      // 외국어(중국어/일본어) 누출 시 1회만 재생성 (확률적 — 보통 깨끗해짐)
      if (CJK.test(text)) {
        try {
          const t2 = await callModel(provider, model, system, userText, persona.maxTokens, env);
          if (!CJK.test(t2)) text = t2;
        } catch { /* 재시도 실패 무시 */ }
      }
      return { text, provider, fellBack: provider !== persona.provider };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('all providers failed');
}

class ProviderError extends Error {
  constructor(provider, status, message) {
    super(`[${provider}:${status}] ${message}`);
    this.provider = provider;
    this.status = status;
  }
}
function isRetryable(status) {
  return status === 429 || (typeof status === 'number' && status >= 500);
}
async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}
// reasoning 모델의 <think>…</think> 흔적 제거(안전장치)
function stripThink(s) {
  return String(s).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<\/?think>\s*/i, '');
}
