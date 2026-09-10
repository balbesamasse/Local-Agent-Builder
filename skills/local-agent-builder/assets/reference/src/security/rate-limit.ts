/**
 * Anti-abus : seau de jetons par utilisateur, en mémoire.
 *
 * Objectif : empêcher qu'un compte compromis (ou un déni de service involontaire :
 * script, téléphone dans une poche) ne vide le quota Groq ou ne sature le LLM.
 * Volontairement local : si l'agent passe sur plusieurs instances, remplacer par
 * un compteur partagé (Firebase RTDB / Redis) — l'interface reste identique.
 */
export interface RateLimitOptions {
  burst: number;
  perMinute: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<number, Bucket>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly opts: RateLimitOptions) {}

  /** true = requête autorisée. */
  allow(key: number, now = Date.now()): boolean {
    const refillPerMs = this.opts.perMinute / 60_000;
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.opts.burst - 1, updated: now });
      return true;
    }
    const refilled = Math.min(this.opts.burst, bucket.tokens + (now - bucket.updated) * refillPerMs);
    if (refilled < 1) {
      bucket.updated = now;
      bucket.tokens = refilled;
      return false;
    }
    bucket.tokens = refilled - 1;
    bucket.updated = now;
    return true;
  }

  /** Secondes d'attente avant le prochain jeton (0 si disponible). */
  retryAfterSeconds(key: number, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const refillPerMs = this.opts.perMinute / 60_000;
    const tokens = Math.min(this.opts.burst, bucket.tokens + (now - bucket.updated) * refillPerMs);
    if (tokens >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - tokens) / this.opts.perMinute) * 60));
  }

  /** Les buckets inactifs sont supprimés pour ne pas croître indéfiniment. */
  startSweeping(intervalMs = 300_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - 3_600_000;
      for (const [key, bucket] of this.buckets) {
        if (bucket.updated < cutoff) this.buckets.delete(key);
      }
    }, intervalMs);
    this.sweeper.unref();
  }

  stopSweeping(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
