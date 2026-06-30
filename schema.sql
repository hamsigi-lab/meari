-- Meari D1 스키마 (plan v3.2 §6.2 / §14)
-- 진실원본은 D1. 클라이언트 IndexedDB는 캐시.

-- 계정 (소수 초대 베타: 초대코드 또는 매직링크)
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,           -- uuid
  email        TEXT UNIQUE,                -- 매직링크용(선택)
  invite_code  TEXT,                       -- 초대코드(베타)
  created_at   TEXT NOT NULL
);

-- 세션 토큰 (경량 인증)
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- 사용자 취향 (개인) — plan §6.2 UserPrefs
CREATE TABLE IF NOT EXISTS user_prefs (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(id),
  interests       TEXT,    -- JSON 배열: 관심사 태그
  muted_personas  TEXT,    -- JSON 배열: 음소거 페르소나 id
  mood            TEXT DEFAULT 'balanced',  -- 'critical'|'balanced'|'support'
  display_name    TEXT,
  avatar          TEXT      -- data URL(소형) 또는 null
);

-- 글 (사용자 글 + AI 자체 글) — plan §6.2 Post
CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  author_type   TEXT NOT NULL,             -- 'user' | 'persona'
  author_id     TEXT NOT NULL,             -- account_id 또는 persona id
  body          TEXT NOT NULL,
  topic_tags    TEXT,                      -- JSON 배열
  category      TEXT DEFAULT 'mixed',      -- 'serious'|'fun'|'mixed'
  source_type   TEXT DEFAULT 'user_written', -- 'user_written'|'ai_generated'|'external_repost'
  origin_url    TEXT,
  platform      TEXT,                      -- 'youtube'|'news' (Phase 4)
  is_recomposed INTEGER DEFAULT 0,
  is_shared_feed INTEGER DEFAULT 0,        -- 공유 발화 피드 여부
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(is_shared_feed, created_at);

-- 댓글 — plan §6.2 Comment
CREATE TABLE IF NOT EXISTS comments (
  id                 TEXT PRIMARY KEY,
  post_id            TEXT NOT NULL REFERENCES posts(id),
  author_persona_id  TEXT NOT NULL,
  parent_comment_id  TEXT,                 -- null=원글 댓글
  depth              INTEGER DEFAULT 0,    -- 0|1|2 (3↑ 차단)
  body               TEXT NOT NULL,
  comment_type       TEXT,                 -- 'critique'|'extension'|'question'|'humor'|'synthesis'|'reaction'
  needs_verification INTEGER DEFAULT 0,
  arrival_delay_ms   INTEGER DEFAULT 0,
  provider           TEXT,                 -- 실제 호출된 3사: 'groq'|'gemini'|'qwen'
  generated_by       TEXT,                 -- 'user_post_reaction'|'ai_post_reaction'|'inter_ai_chain'
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

-- 사용량 카운터 (사용자별 일일 한도, plan §14.3) — UsageCounter
CREATE TABLE IF NOT EXISTS usage_counters (
  account_id   TEXT NOT NULL,
  date         TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  calls        INTEGER DEFAULT 0,
  groq_calls   INTEGER DEFAULT 0,
  gemini_calls INTEGER DEFAULT 0,
  qwen_calls   INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, date)
);

-- 전역 발화 피드 설정 (공유 피드, plan §6.2 SystemFeedConfig) — 1행
CREATE TABLE IF NOT EXISTS system_feed_config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  daily_ai_post_cap  INTEGER DEFAULT 20,
  daily_comment_cap  INTEGER DEFAULT 100,
  chain_depth_max    INTEGER DEFAULT 2,
  cycle_minutes      INTEGER DEFAULT 180,
  last_generated_at  TEXT
);
INSERT OR IGNORE INTO system_feed_config (id) VALUES (1);
