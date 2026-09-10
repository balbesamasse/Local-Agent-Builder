/**
 * Schéma SQLite. `user_version` sert de n° de migration : on ajoute des
 * blocs `if (version < n)` sans jamais casser une base existante.
 */
export const SCHEMA_VERSION = 3;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id      INTEGER PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  title        TEXT,
  is_group     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content    TEXT,
  tool_name  TEXT,
  token_est  INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'fact',
  content    TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'agent',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, id DESC);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  tool_name   TEXT    NOT NULL,
  args_json   TEXT    NOT NULL,
  reason      TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','denied','expired')),
  token_fp    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON pending_approvals(status, chat_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  user_id      INTEGER,
  tool_name    TEXT    NOT NULL,
  args_json    TEXT,
  status       TEXT    NOT NULL,
  output       TEXT,
  error        TEXT,
  duration_ms  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_chat ON tool_calls(chat_id, id DESC);
`;

/**
 * v2 — la voix choisie par `/voice` survit au redémarrage.
 *
 * Contrairement au mode miroir (réglage de session, en mémoire à dessein), une voix est
 * une identité : la perdre au premier arrêt est un bug vécu par l'utilisateur, pas une
 * simplicité. Et contrairement aux messages, ce n'est pas du contenu privé — un identifiant
 * opaque de 22 caractères. La colonne est additive, jamais supprimée : `user_version` ne
 * revient jamais en arrière.
 */
export const SCHEMA_V2 = `
ALTER TABLE chats ADD COLUMN voice_id TEXT;
`;

/**
 * v3 — un message reçu pendant un appel garde la TRACE du canal.
 *
 * Pas de caprice de normalisation : la façon dont une phrase est arrivée change ce qu'on
 * doit en faire. Une dictée vocale est plus hachée, plus approximative (le STT entend
 * « vingt » pour « dix »), et une réponse parlée ne se relit pas comme un texte — dire
 * « tu me l'as demandé oralement » au tour suivant évite de redemander la même précision.
 * Colonne additive à défaut explicite : une base v2 existante garde sa valeur 'telegram'
 * sur les lignes anciennes, ce qui est exactement le vrai.
 */
export const SCHEMA_V3 = `
ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'
  CHECK (channel IN ('telegram','call'));
`;
