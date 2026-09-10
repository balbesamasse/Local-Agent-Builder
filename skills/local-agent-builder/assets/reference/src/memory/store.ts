/**
 * Persistance SQLite (better-sqlite3, accès synchrone).
 *
 * Quatre jeux de données :
 *   messages        → historique de conversation (fenêtre glissante)
 *   memories        → mémoire à long terme, recherchable par mots-clés
 *   pending_approvals → actions en attente d'un accord humain
 *   tool_calls      → journal d'audit (qui a appelé quoi, quand, avec quel résultat)
 *
 * On ouvre la base en mode WAL et « restrictive » : pas de VACUUM automatique,
 * temps de verrouillage borné, et requêtes 100 % préparées (aucune concaténation
 * de SQL à partir d'entrées utilisateur).
 */
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from './schema.js';
import type { ApprovalRow, MemoryRow, StoredMessage, ToolStatus } from '../core/types.js';

type Db = Database.Database;

export class Store {
  private readonly db: Db;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      this.db.exec(SCHEMA_V1);
      if (version < 2) this.db.exec(SCHEMA_V2);
      if (version < 3) this.db.exec(SCHEMA_V3);
      // Les futures migrations s'ajoutent ici : if (version < 4) { ... }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------ chats ---
  touchChat(chatId: number, title: string | null, isGroup: boolean): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, created_at, updated_at, title, is_group)
         VALUES (@chatId, @now, @now, @title, @isGroup)
         ON CONFLICT(chat_id) DO UPDATE SET updated_at=@now, title=COALESCE(@title, title)`,
      )
      .run({ chatId, now, title, isGroup: isGroup ? 1 : 0 });
  }

  /**
   * Voix de synthèse de cette conversation (`/voice`). `null` = revenir au défaut du
   * `.env` : on efface la préférence plutôt que d'écrire la valeur par défaut, sinon le
   * `.env` n'aurait plus aucun effet pour les conversations anciennes.
   */
  setChatVoice(chatId: number, voiceId: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, created_at, updated_at, title, is_group, voice_id)
         VALUES (@chatId, @now, @now, NULL, 0, @voiceId)
         ON CONFLICT(chat_id) DO UPDATE SET updated_at=@now, voice_id=@voiceId`,
      )
      .run({ chatId, now, voiceId });
  }

  getChatVoice(chatId: number): string | null {
    const row = this.db
      .prepare(`SELECT voice_id FROM chats WHERE chat_id = @chatId`)
      .get({ chatId }) as { voice_id: string | null } | undefined;
    return row?.voice_id ?? null;
  }

  // ------------------------------------------------- messages ---
  addMessage(input: {
    chatId: number;
    role: StoredMessage['role'];
    content: string;
    toolName?: string;
    channel?: 'telegram' | 'call';
  }): void {
    this.db
      .prepare(
        `INSERT INTO messages (chat_id, role, content, tool_name, token_est, created_at, channel)
         VALUES (@chatId, @role, @content, @toolName, @tokenEst, @now, @channel)`,
      )
      .run({
        chatId: input.chatId,
        role: input.role,
        content: input.content,
        toolName: input.toolName ?? null,
        channel: input.channel ?? 'telegram',
        tokenEst: Math.ceil(input.content.length / 4),
        now: Date.now(),
      });
  }

  /** Fenêtre glissante : les N derniers messages, dans l'ordre chronologique. */
  recentMessages(chatId: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, chat_id, role, content, tool_name, created_at, channel
         FROM (SELECT * FROM messages WHERE chat_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?)
         ORDER BY id ASC`,
      )
      .all(chatId, limit) as Array<{
      id: number;
      chat_id: number;
      role: StoredMessage['role'];
      content: string | null;
      tool_name: string | null;
      created_at: number;
      channel: 'telegram' | 'call';
    }>;
    return rows.map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      role: r.role,
      content: r.content,
      toolName: r.tool_name,
      createdAt: r.created_at,
      // La ligne est rendue AVEC son canal : sans ça, `priorHistory` perdrait l'information
      // qu'on vient justement de faire exister en base.
      channel: r.channel,
    }));
  }

  clearHistory(chatId: number): number {
    const info = this.db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chatId);
    return info.changes;
  }

  /** Supprime les très vieux messages pour borner la taille du fichier. */
  pruneMessages(chatId: number, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM messages WHERE chat_id = ? AND id NOT IN
         (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(chatId, chatId, keep);
  }

  // ------------------------------------------------ memories ---
  addMemory(input: { chatId: number; content: string; kind?: string; source?: string }): MemoryRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO memories (chat_id, kind, content, source, created_at, updated_at)
         VALUES (@chatId, @kind, @content, @source, @now, @now)`,
      )
      .run({
        chatId: input.chatId,
        kind: input.kind ?? 'fact',
        content: input.content,
        source: input.source ?? 'agent',
        now,
      });
    const row = this.db
      .prepare(`SELECT id, chat_id, kind, content, source, created_at, updated_at FROM memories WHERE id = ?`)
      .get(info.lastInsertRowid as number) as MemorySqlRow;
    return toMemory(row);
  }

  countMemories(chatId: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE chat_id = ?`).get(chatId) as { n: number };
    return r.n;
  }

  /** Recherche par mots-clés (FTS5 serait le sur-qualificatif pour un usage personnel). */
  searchMemories(chatId: number, query: string, limit = 5): MemoryRow[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3)
      .slice(0, 8);

    let rows: MemorySqlRow[];
    if (terms.length === 0) {
      rows = this.db
        .prepare(
          `SELECT id, chat_id, kind, content, source, created_at, updated_at
           FROM memories WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(chatId, limit) as MemorySqlRow[];
    } else {
      // Score = nombre d'occurrences de chaque terme. Paramétré, jamais concaténé.
      const like = terms.map(() => `(LOWER(content) LIKE '%' || ? || '%')`).join(' + ');
      // Récence en jours, calculée en millisecondes : updated_at est un epoch-ms, et
      // julianday() sur un nombre renvoie NULL — ce qui anéantissait tout le score (le tri
      // retombait silencieusement sur updated_at seul). Le diviseur 21 600 000 = une journée / 4.
      const recency = `1.0 / (1.0 + (MAX(strftime('%s','now') * 1000 - updated_at, 0) / 21600000.0))`;
      rows = this.db
        .prepare(
          `SELECT id, chat_id, kind, content, source, created_at, updated_at,
                  (${like}) * 2.0 + ${recency} AS score
           FROM memories
           WHERE chat_id = ? AND (${like}) > 0
           ORDER BY score DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(...terms, chatId, ...terms, limit) as MemorySqlRow[];
    }
    return rows.map(toMemory);
  }

  recentMemories(chatId: number, limit: number): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, chat_id, kind, content, source, created_at, updated_at
         FROM memories WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(chatId, limit) as MemorySqlRow[];
    return rows.map(toMemory);
  }

  listMemories(chatId: number, limit = 50): MemoryRow[] {
    return this.recentMemories(chatId, limit);
  }

  deleteMemory(id: number, chatId: number): boolean {
    const info = this.db.prepare(`DELETE FROM memories WHERE id = ? AND chat_id = ?`).run(id, chatId);
    return info.changes > 0;
  }

  getMemory(id: number): MemoryRow | null {
    const row = this.db
      .prepare(`SELECT id, chat_id, kind, content, source, created_at, updated_at FROM memories WHERE id = ?`)
      .get(id) as MemorySqlRow | undefined;
    return row ? toMemory(row) : null;
  }

  /** Utilisé par le plafond et par les tests : repositionne un souvenir en tête de récence. */
  touchMemory(id: number, at: number): void {
    this.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run(at, id);
  }

  /** Applique le plafond de mémoire : on garde les plus récemment touchés. */
  enforceMemoryCap(chatId: number, keep: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM memories WHERE chat_id = ? AND id NOT IN
         (SELECT id FROM memories WHERE chat_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`,
      )
      .run(chatId, chatId, keep);
    return info.changes;
  }

  // ------------------------------------------------ approvals ---
  createApproval(input: {
    chatId: number;
    userId: number;
    toolName: string;
    args: Record<string, unknown>;
    reason: string;
    ttlMinutes: number;
    tokenFingerprint: string;
  }): ApprovalRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO pending_approvals
           (chat_id, user_id, tool_name, args_json, reason, status, token_fp, created_at, expires_at)
         VALUES (@chatId, @userId, @toolName, @argsJson, @reason, 'pending', @tokenFp, @now, @expires)`,
      )
      .run({
        chatId: input.chatId,
        userId: input.userId,
        toolName: input.toolName,
        argsJson: JSON.stringify(input.args),
        reason: input.reason,
        tokenFp: input.tokenFingerprint,
        now,
        expires: now + input.ttlMinutes * 60_000,
      });
    return this.getApproval(info.lastInsertRowid as number)!;
  }

  getApprovalTokenFingerprint(id: number): string | null {
    const row = this.db.prepare(`SELECT token_fp FROM pending_approvals WHERE id = ?`).get(id) as
      | { token_fp: string | null }
      | undefined;
    return row?.token_fp ?? null;
  }

  /** Efface l'empreinte : le jeton ne peut plus resservir, même si le clic est rejoué. */
  consumeApprovalToken(id: number): void {
    this.db.prepare(`UPDATE pending_approvals SET token_fp = NULL WHERE id = ?`).run(id);
  }

  decideApproval(id: number, status: ApprovalRow['status']): void {
    this.db.prepare(`UPDATE pending_approvals SET status = ? WHERE id = ?`).run(status, id);
  }

  getApproval(id: number): ApprovalRow | null {
    const row = this.db.prepare(`SELECT * FROM pending_approvals WHERE id = ?`).get(id) as ApprovalSqlRow | undefined;
    return row ? toApproval(row) : null;
  }

  pendingApprovalsForChat(chatId: number): ApprovalRow[] {
    this.expireStale(chatId);
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_approvals WHERE chat_id = @chatId AND status = 'pending' AND expires_at > @now ORDER BY id`,
      )
      .all({ chatId, now: Date.now() }) as ApprovalSqlRow[];
    return rows.map(toApproval);
  }

  private expireStale(chatId: number): void {
    this.db
      .prepare(`UPDATE pending_approvals SET status = 'expired' WHERE chat_id = ? AND status = 'pending' AND expires_at <= ?`)
      .run(chatId, Date.now());
  }

  // ------------------------------------------------ audit ---
  logToolCall(input: {
    chatId: number;
    userId?: number;
    toolName: string;
    args: unknown;
    status: ToolStatus;
    output?: string;
    error?: string;
    durationMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (chat_id, user_id, tool_name, args_json, status, output, error, duration_ms, created_at)
         VALUES (@chatId, @userId, @toolName, @argsJson, @status, @output, @error, @durationMs, @now)`,
      )
      .run({
        chatId: input.chatId,
        userId: input.userId ?? null,
        toolName: input.toolName,
        argsJson: safeJson(input.args),
        status: input.status,
        output: truncate(input.output, 2000),
        error: truncate(input.error, 1000),
        durationMs: input.durationMs ?? null,
        now: Date.now(),
      });
  }

  recentAudit(chatId: number, limit = 10): Array<{ toolName: string; status: string; createdAt: number }> {
    const rows = this.db
      .prepare(`SELECT tool_name, status, created_at FROM tool_calls WHERE chat_id = ? ORDER BY id DESC LIMIT ?`)
      .all(chatId, limit) as Array<{ tool_name: string; status: string; created_at: number }>;
    return rows.map((r) => ({ toolName: r.tool_name, status: r.status, createdAt: r.created_at }));
  }
}

// --- helpers de mapping (colonnes SQL snake_case → objets camelCase) ---

interface MemorySqlRow {
  id: number;
  chat_id: number;
  kind: string;
  content: string;
  source: string;
  created_at: number;
  updated_at: number;
  score?: number;
}

function toMemory(r: MemorySqlRow): MemoryRow {
  return {
    id: r.id,
    chatId: r.chat_id,
    kind: r.kind,
    content: r.content,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface ApprovalSqlRow {
  id: number;
  chat_id: number;
  user_id: number;
  tool_name: string;
  args_json: string;
  reason: string;
  status: ApprovalRow['status'];
  created_at: number;
  expires_at: number;
}

function toApproval(r: ApprovalSqlRow): ApprovalRow {
  return {
    id: r.id,
    chatId: r.chat_id,
    userId: r.user_id,
    toolName: r.tool_name,
    argsJson: r.args_json,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function truncate(value: string | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max)}…[tronqué]` : value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '"[non sérialisable]"';
  }
}
