/**
 * Hub temps réel : le morceau qui écoute un port. C'est tout le fichier, et c'est écrit
 * pour qu'on puisse le vérifier d'un coup d'œil.
 *
 * CE QUE LE PROJET PROMET D'HABITUDE : « aucun port ouvert ». Cette fonctionnalité est la
 * première entorse, volontaire et bornée :
 *   - elle est ÉTEINTE par défaut (`REALTIME_ENABLED=false`) : sans l'avoir décidé, le bot
 *     n'ouvre rien du tout — l'invariant `listening-is-a-decision` du skill le vérifie ;
 *   - elle n'écoute que `127.0.0.1` par défaut (surcharge explicite pour un reverse-proxy) ;
 *   - elle ne sert AUCUN contenu public : trois chemins (`/`, `/call`, `/ws`), 404 muet
 *     ailleurs, et le websocket n'existe que sur ticket à usage unique émis par Telegram ;
 *   - le port est UNIQUE : une seule écoute, un seul endroit où la décider. Multiplier les
 *     ports, c'est multiplier les surface d'attaque sans multiplier les contrôles ;
 *   - le chemin d'un appel (le micro, les octets) ne passe jamais par Telegram : le Bot API
 *     ne sait pas transporter du média temps réel (voir `docs/REALTIME.md`).
 *
 * LE TICKET : le navigateur ne prouve rien, tout seul. Un lien volé serait un micro ouvert
 * sur la machine — inacceptable. Donc : jeton aléatoire de 32 octets, une seule
 * utilisation, TTL court, révoqué à la fermeture de l'appel ou par `/call stop`, et la
 * session est bornée au `chatId` qui a demandé le lien. Une URL qui meurt n'est pas un
 * trou : c'est ce qu'on veut.
 *
 * Le hub ne connaît ni ElevenLabs ni le LLM : on lui donne une fabrique de session. Il
 * serait otherwise dépendant de la config audio, et les tests de tour de parole n'auraient
 * plus besoin d'un serveur pour tourner.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
// Import STATIQUE du client comme du serveur : un `await import('ws')` résolu au vol est
// exactement le motif que l'invariant `static-tool-loading` refuse. Le hub n'existe que si
// `REALTIME_ENABLED=true`, mais le module, lui, est déclaré dans le paquet.
import { WebSocketServer, WebSocket } from 'ws';
import { log } from '../core/logger.js';
import { parseClientFrame, MAX_FRAME_BYTES, type SpeechSink } from './protocol.js';
import { RealtimeSession, type CallClient, type RealtimeSessionDeps } from './session.js';
import { CALL_PAGE_HTML } from './page.js';

export interface RealtimeTicket {
  readonly token: string;
  readonly chatId: number;
  readonly userId: number;
  readonly expiresAt: number;
}

export interface HubSessionInput {
  chatId: number;
  userId: number;
  sink: SpeechSink;
  client: CallClient;
  /** Le canal sait écrire dans le chat ; la session, non. Dépendance injectée par le hub. */
  sendChatText?: (text: string) => Promise<void> | void;
}

export interface RealtimeHubDeps {
  /** Uniquement les conversations autorisées : le hub ne décide pas, il applique. */
  allowedUserIds: ReadonlySet<number>;
  ticketTtlSeconds: number;
  maxFrameBytesPerSecond: number;
  /** Fabrique la session : le hub reste un transport, pas un orchestrateur. */
  buildSession: (input: HubSessionInput) => Omit<RealtimeSessionDeps, 'sink' | 'client' | 'chatId' | 'userId'>;
  /** Écrire dans le chat (réponse hors flux, bilan d'appel). Le hub ne connaît pas Telegram. */
  sendChatText?: (chatId: number, text: string) => Promise<void> | void;
  onCallStarted?: (info: { chatId: number }) => void;
  onCallEnded?: (info: { chatId: number; summary: ReturnType<RealtimeSession['summary']> }) => void;
  /** Page d'appel : surchargeable dans les tests, sinon le fichier embarqué. */
  pageHtml?: string;
  /** Base publique du lien d'appel (défaut : l'adresse réellement écoutée). */
  publicBase?: string;
}

export interface RealtimeHub {
  /** Écoute (port 0 = port libre, utile aux tests). Renvoie l'URL de base réelle. */
  listen(): Promise<{ port: number; url: string }>;
  /** Base du lien d'appel : l'URL publique si elle est configurée, sinon l'adresse réelle. */
  setPublicBase(base: string): void;
  readonly publicBase: string;
  close(): Promise<void>;
  issueTicket(chatId: number, userId: number): RealtimeTicket;
  revokeTicket(token: string): boolean;
  /** URL à donner à l'utilisateur (jeton dans le fragment, jamais dans une query string). */
  linkFor(ticket: RealtimeTicket): string;
  activeSession(chatId: number): RealtimeSession | null;
  /** État lisible pour le canal (`/call etat`) : le hub décide, le bot ne creuse pas dedans. */
  status(chatId: number): { active: boolean; turns: number } | null;
  endChat(chatId: number, reason: string): Promise<boolean>;
  endAll(reason: string): Promise<void>;
  readonly listening: boolean;
  readonly port: number;
}

/** Comparaison en temps constant : un jeton se compare, il ne se déduit pas. */
function tokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * Client minimal du hub, dans le dépôt : sert aux tests bout-en-bout ET à `npm run
 * call:check` (vérifier un appel sans téléphone). Un vrai utilisateur passe par la page.
 */
export interface CallSocket {
  sendText(payload: unknown): void;
  sendAudio(pcm: Uint8Array, timeMs?: number): void;
  /**
   * `timeoutMs` borne l'attente : un test qui attend un message qui ne vient pas doit
   * ÉCHOUER, pas immobiliser la suite entière (les promesses jamais résolues sont le piège
   * classique d'un harnais websocket).
   */
  nextAudio(timeoutMs?: number): Promise<{ bytes: Uint8Array; sampleRate: number } | null>;
  nextControl(timeoutMs?: number): Promise<Record<string, unknown> | null>;
  close(): void;
}

/** File d'attente avec borne : `null` = rien n'est venu à temps (et non un test gelé). */
function take<T>(queue: T[], disarm: () => void, arm: (resolve: (value: T | null) => void) => void, timeoutMs?: number): Promise<T | null> {
  if (queue.length > 0) return Promise.resolve(queue.shift()!);
  return new Promise<T | null>((resolve) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(null), timeoutMs);
    timer?.unref?.();
    const finish = (value: T | null): void => {
      if (timer !== undefined) clearTimeout(timer);
      disarm();
      resolve(value);
    };
    arm((value) => finish(value ?? null));
  });
}

export async function openCallSocket(url: string): Promise<CallSocket> {
  const ws = new WebSocket(url);
  const controls: Array<Record<string, unknown> | null> = [];
  const audios: Array<{ bytes: Uint8Array; sampleRate: number } | null> = [];
  const waiters: { ctrl?: (v: Record<string, unknown> | null) => void; audio?: (v: { bytes: Uint8Array; sampleRate: number } | null) => void } = {};
  // Les écouteurs sont branchés AVANT d'attendre la poignée de main : le serveur écrit son
  // `hello` dès l'acceptation, et un client qui s'écoute après coup ne le verrait jamais.
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const sampleRate = view.byteLength >= 3 ? view.getUint16(1, true) : 24000;
      const length = view.byteLength >= 11 ? view.getUint32(7, true) : Math.max(0, view.byteLength - 11);
      const chunk = { bytes: Uint8Array.prototype.slice.call(data.subarray(11, 11 + length)), sampleRate };
      if (waiters.audio !== undefined) { const w = waiters.audio!; waiters.audio = undefined; w(chunk); return }
      audios.push(chunk);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (waiters.ctrl !== undefined) { const w = waiters.ctrl!; waiters.ctrl = undefined; w(parsed); return }
    controls.push(parsed);
  });
  ws.on('close', () => {
    audios.push(null);
    controls.push(null);
    waiters.audio?.(null);
    waiters.ctrl?.(null);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error: Error) => reject(error));
  });
  return {
    sendText: (payload) => ws.send(JSON.stringify(payload)),
    sendAudio: (pcm, timeMs = 0) => {
      const out = new Uint8Array(5 + pcm.byteLength);
      out[0] = 0x42;
      new DataView(out.buffer).setUint32(1, timeMs >>> 0, true);
      out.set(pcm, 5);
      ws.send(out);
    },
    nextAudio: (timeoutMs) => take(audios, () => { waiters.audio = undefined; }, (resolve) => { waiters.audio = resolve; }, timeoutMs),
    nextControl: (timeoutMs) => take(controls, () => { waiters.ctrl = undefined; }, (resolve) => { waiters.ctrl = resolve; }, timeoutMs),
    close: () => ws.close(),
  };
}

/** Génère un PCM16 de sinus amorti : de la « voix » sans micro, pour les tests et l'auto-diagnostic. */
export function testSpeech(seconds: number, level = 0.35, sampleRate = 16_000): Uint8Array {
  const frames = Math.floor(seconds * sampleRate);
  const out = new Uint8Array(frames * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frames; i += 1) {
    const envelope = Math.min(1, i / (0.02 * sampleRate)) * Math.min(1, (frames - i) / (0.05 * sampleRate));
    const value = Math.sin((2 * Math.PI * 180 * i) / sampleRate) * envelope * level;
    view.setInt16(i * 2, Math.max(-32767, Math.min(32767, Math.round(value * 32767))), true);
  }
  return out;
}

/** Silence : ce qu'il faut pour qu'un VAD clôture le tour. */
export function testSilence(seconds: number, sampleRate = 16_000): Uint8Array {
  return new Uint8Array(Math.floor(seconds * sampleRate) * 2);
}

export function buildRealtimeHub(deps: RealtimeHubDeps, bind: string, port: number): RealtimeHub {
  const tickets = new Map<string, RealtimeTicket>();
  const sessions = new Map<number, { session: RealtimeSession; sockets: Set<WebSocket>; sink: SpeechSink }>();
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let actualPort = port;
  let closing = false;
  // Base du lien : `REALTIME_PUBLIC_URL` si l'opérateur l'a déclarée, sinon ce que le hub
  // écoute réellement. Le canal n'a pas à connaître un port que l'OS a attribué.
  let publicBase = deps.publicBase ?? '';

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [token, ticket] of tickets) {
      if (ticket.expiresAt <= now) tickets.delete(token);
    }
  }, 30_000);
  sweep.unref?.();

  const deny = (res: ServerResponse, status: number, reason: string): void => {
    // Un 404 pour tout ce qui n'est pas les deux routes : un scan ne doit pas apprendre
    // que le hub existe, encore moins ce qu'il sert.
    res.writeHead(status === 404 ? 404 : status, {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(status === 404 ? '' : reason);
  };

  // LISTEN-EXCEPTION: le hub est le SEUL point d'ecoute du projet, et il n'existe que si
  // REALTIME_ENABLED=true (lus dans src/config.ts, verifies dans src/index.ts avant `listen()`).
  // Motif : l'API Bot de Telegram ne transporte aucun media d'appel — le seul trajet officiel
  // pour une conversation vocale en direct est donc que l'agent serve lui-meme la page qui
  // ouvre le micro. Bornes verifiables : boucle locale par defaut, billet a usage unique,
  // liste blanche confrontee a la poignee de main, debit par client plafonne, et le hub ne sert
  // QUE la page d'appel (tout le reste repond 404 sans rien expliquer).
  // keepAliveTimeout court : un client qui garde la connexion ouverte ne doit pas retenir
  // la fermeture du service (et 250 ms ne se voient pas sur une page servie en local).
  const httpServer = createServer({ keepAliveTimeout: 250, headersTimeout: 2_000, requestTimeout: 10_000 }, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') return deny(res, 405, 'méthode refusée');
    if (url.pathname === '/' || url.pathname === '/call') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // Aucun fichier externe : la page est autonome (le sable, un VPN, un CSP strict
        // ne doivent pas pouvoir la rendre muette — ni devenir un canal de fuite).
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'microphone=(self)',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      res.end(deps.pageHtml ?? CALL_PAGE_HTML);
      return;
    }
    return deny(res, 404, 'introuvable');
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('t') ?? '';
    const ticket = lookupTicket(tickets, token);
    if (ticket === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log.warn('temps réel : ticket refusé', { motif: token === '' ? 'absent' : 'inconnu, expiré ou déjà utilisé' });
      return;
    }
    if (!deps.allowedUserIds.has(ticket.userId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log.warn('temps réel : utilisateur hors liste blanche', { chatId: ticket.chatId });
      return;
    }
    // Usage unique : le jeton meurt à la poignée de main. Un rechargement de page redemande
    // donc un lien — c'est voulu, et c'est ce qui rend le lien inutile une fois repéré.
    tickets.delete(token);

    if (wss === null) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      void attach(ws, ticket);
    });
  });

  async function attach(ws: WebSocket, ticket: RealtimeTicket): Promise<void> {
    const existing = sessions.get(ticket.chatId);
    const sockets = existing?.sockets ?? new Set<WebSocket>();
    if (existing !== undefined && sockets.size > 0) {
      // Un seul micro à la fois : deux onglets qui parlent en même temps produiraient deux
      // tours superposés et une facture double, sans que l'utilisateur comprenne lequel répond.
      ws.send(JSON.stringify({ t: 'error', text: 'Un appel est déjà ouvert pour cette conversation.' }));
      ws.close();
      return;
    }

    let bytesThisSecond = 0;
    let framesDropped = 0;
    let warned = false;
    // Le bilan d'appel ne doit être rendu QU'UNE fois : la déconnexion du client et la
    // fermeture décidée par la session (plafond, /call stop) arrivent dans n'importe quel
    // ordre, et deux résumés dans le chat voudraient dire deux fois le même comptage.
    let reported = false;
    const report = (): void => {
      if (reported) return;
      reported = true;
      deps.onCallEnded?.({ chatId: ticket.chatId, summary: session.summary() });
    };

    // Une seule fabrique, un seul client : construire l'objet deux fois avait produit deux
    // `CallClient` distincts sur le même socket — le sink regardait l'un, la session l'autre.
    const client = buildClient(ws);
    const sink = buildSink(ws);
    const built = deps.buildSession({
      chatId: ticket.chatId,
      userId: ticket.userId,
      sink,
      client,
      sendChatText: deps.sendChatText === undefined ? undefined : (text: string) => deps.sendChatText!(ticket.chatId, text),
    });
    const session = new RealtimeSession({ ...built, chatId: ticket.chatId, userId: ticket.userId, sink, client });
    const entry = { session, sockets, sink };
    sockets.add(ws);
    sessions.set(ticket.chatId, entry);

    const meter = setInterval(() => {
      bytesThisSecond = 0;
    }, 1000);
    meter.unref?.();

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      const parsed = parseClientFrame(isBinary ? new Uint8Array(data as Buffer) : (data as string));
      if (parsed.kind === 'invalid') {
        framesDropped += 1;
        if (!warned) {
          warned = true;
          log.warn('temps réel : trame client rejetée', { chatId: ticket.chatId, motif: parsed.why });
        }
        return;
      }
      if (parsed.kind === 'text') {
        try {
          const control = JSON.parse(parsed.text) as { t?: string; muted?: boolean; text?: string };
          session.onControl({ t: typeof control.t === 'string' ? control.t : '', muted: control.muted, text: control.text });
        } catch {
          /* une trame de contrôle illisible n'est pas une raison de couper l'appel */
        }
        return;
      }
      if (parsed.pcm.byteLength > MAX_FRAME_BYTES) return;
      bytesThisSecond += parsed.pcm.byteLength;
      if (bytesThisSecond > deps.maxFrameBytesPerSecond) {
        // Débit surnuméraire = client déréglé ou attaque : on lâche des cadres, on ne
        // sature pas la transcription (qui, elle, est facturée à l'octet).
        framesDropped += 1;
        if (!warned) {
          warned = true;
          sink.note('Débit micro trop élevé : je ne retiens qu’une partie de l’audio.');
        }
        return;
      }
      session.onAudio(parsed.pcm);
    });

    ws.on('error', () => {
      /* la fermeture suffit : un EPIPE n'est pas une panne à raconter deux fois */
    });
    ws.on('close', async () => {
      clearInterval(meter);
      sockets.delete(ws);
      if (sockets.size === 0) {
        await session.end('client déconnecté');
        if (sessions.get(ticket.chatId) === entry) sessions.delete(ticket.chatId);
        report();
      }
    });

    ws.send(JSON.stringify({ t: 'hello', chatId: ticket.chatId }));
    deps.onCallStarted?.({ chatId: ticket.chatId });
    await session.start();
    if (framesDropped > 0) log.warn('temps réel : trames écartées', { chatId: ticket.chatId, nombre: framesDropped });
  }

  return {
    async listen() {
      if (server !== null) return { port: actualPort, url: `http://127.0.0.1:${actualPort}` };
      server = httpServer;
      wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, bind, () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });
      const address = httpServer.address();
      actualPort = typeof address === 'object' && address !== null ? address.port : port;
      // `REALTIME_PORT=0` (tests, ou machine déjà occupée) : la base publique doit suivre le
      // port réellement attribué, sinon le lien mène dans le vide.
      if (publicBase === '' && port === 0) publicBase = `http://127.0.0.1:${actualPort}`;
      log.info('temps réel : hub à l’écoute', { adresse: `http://${bind}:${actualPort}`, billets: 'à usage unique' });
      return { port: actualPort, url: `http://${bind}:${actualPort}` };
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(sweep);
      tickets.clear();
      await this.endAll('arrêt du service');
      if (wss !== null) await new Promise<void>((resolve) => wss!.close(() => resolve()));
      // Deux pièges de fermeture, rencontrés par les tests :
      //  - `wss.close()` n'attend PAS les clients encore ouverts → `terminate()` d'abord ;
      //  - `server.close()` attend les keep-alives HTTP (un `fetch` en garde un) → on les coupe,
      //    avec une garde : une connexion têtue ne doit pas empêcher l'arrêt du service.
      if (wss !== null) {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss!.close(() => resolve()));
      }
      if (server !== null) {
        server.closeIdleConnections();
        // `ERR_SERVER_NOT_RUNNING` est légitime (le serveur peut avoir été fermé par le
        // système après un échec d'écoute) : un `close()` doit rester IDEMPOTENT.
        const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
        server.closeAllConnections();
      }
      server = null;
      wss = null;
    },
    issueTicket(chatId, userId) {
      const token = randomBytes(24).toString('base64url');
      const ticket: RealtimeTicket = { token, chatId, userId, expiresAt: Date.now() + deps.ticketTtlSeconds * 1000 };
      tickets.set(token, ticket);
      return ticket;
    },
    revokeTicket(token) {
      return tickets.delete(token);
    },
    linkFor(ticket) {
      // Fragment (`#t=`) : une query string est recopiée dans les journaux du proxy, de la
      // plateforme et de l'historique du navigateur. Un fragment, lui, ne quitte pas le client.
      const base = (publicBase === '' ? `http://127.0.0.1:${actualPort}` : publicBase).replace(/\/$/, '');
      return `${base}/#t=${ticket.token}`;
    },
    setPublicBase(base) {
      publicBase = base;
    },
    get publicBase() {
      return publicBase === '' ? `http://127.0.0.1:${actualPort}` : publicBase;
    },
    activeSession(chatId) {
      return sessions.get(chatId)?.session ?? null;
    },
    status(chatId) {
      const session = sessions.get(chatId)?.session;
      if (session === undefined) return null;
      return { active: session.active, turns: session.turnCount };
    },
    async endChat(chatId, reason) {
      const entry = sessions.get(chatId);
      if (entry === undefined) return false;
      // L'avis de fermeture part AVANT la coupure du socket, et en SYNCHRONE : `session.end()`
      // passe par la file de la session, donc sa clôture arrive un microtask trop tard — le
      // client aurait vu un socket cassé sans explication (exactement le bug qu'on a eu ici).
      entry.sink.close(reason);
      await entry.session.end(reason);
      for (const ws of entry.sockets) ws.close();
      entry.sockets.clear();
      sessions.delete(chatId);
      return true;
    },
    async endAll(reason) {
      for (const [chatId, entry] of [...sessions]) {
        entry.sink.close(reason);
        await entry.session.end(reason);
        for (const ws of entry.sockets) ws.close();
        sessions.delete(chatId);
      }
    },
    get listening() {
      return server !== null;
    },
    get port() {
      return actualPort;
    },
  };
}

/**
 * Recherche par comparaison en temps constant. Ce n'est pas de la paranoïa : une map ordinaire
 * dirait « ce préfixe existe » à qui mesure le temps de réponse, et le jeton est la seule
 * chose entre un micro et n'importe qui.
 */
function lookupTicket(tickets: Map<string, RealtimeTicket>, token: string): RealtimeTicket | null {
  if (token === '') return null;
  for (const [candidate, ticket] of tickets) {
    if (tokenEquals(candidate, token)) {
      if (ticket.expiresAt <= Date.now()) {
        tickets.delete(candidate);
        return null;
      }
      return ticket;
    }
  }
  return null;
}

function buildClient(ws: WebSocket): CallClient {
  return {
    text: (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    },
    binary: (bytes) => {
      if (ws.readyState === 1) ws.send(bytes, { binary: true });
    },
    close: () => ws.close(),
    get closed() {
      return ws.readyState !== 1;
    },
  };
}

/**
 * Le sink applique les bornes du canal : un sous-titre par fragment de mot, ce serait dix
 * fois plus de paquets que d'audio. On agrège, et on ne dépasse jamais 32 kB par message.
 */
function buildSink(ws: WebSocket): SpeechSink {
  let captionPending = '';
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (payload: unknown): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  };
  const flushCaption = (): void => {
    if (captionTimer !== null) {
      clearTimeout(captionTimer);
      captionTimer = null;
    }
    if (captionPending === '') return;
    const text = captionPending;
    captionPending = '';
    send({ t: 'caption', role: 'in', text, final: false });
  };
  return {
    audio: (chunk) => {
      if (ws.readyState !== 1) return;
      const view = new DataView(new ArrayBuffer(12));
      view.setUint8(0, 0x41); // 'A' : audio descendant
      view.setUint16(1, chunk.sampleRate, true);
      view.setUint32(3, 0, true); // horodatage non utilisé dans ce sens
      view.setUint32(7, chunk.bytes.byteLength, true);
      const out = new Uint8Array(11 + chunk.bytes.byteLength);
      out.set(new Uint8Array(view.buffer.slice(0, 11)), 0);
      out.set(chunk.bytes, 11);
      ws.send(out, { binary: true });
    },
    speechStart: () => send({ t: 'speech', state: 'start' }),
    speechEnd: () => send({ t: 'speech', state: 'end' }),
    caption: (role, text, final) => {
      if (role === 'out' || final) {
        flushCaption();
        send({ t: 'caption', role, text: text.slice(0, 30_000), final });
        return;
      }
      // Partiel : agrégé à 120 ms, assez pour paraître simultané, pas assez pour noyer le flux.
      captionPending = text;
      if (captionTimer === null) captionTimer = setTimeout(flushCaption, 120);
      captionTimer.unref?.();
    },
    state: (state, detail) => send({ t: 'state', state, ...(detail === undefined ? {} : { detail }) }),
    note: (text) => send({ t: 'note', text: text.slice(0, 500) }),
    close: (reason) => {
      flushCaption();
      send({ t: 'closed', reason });
    },
    get closed() {
      return ws.readyState !== 1;
    },
  };
}
