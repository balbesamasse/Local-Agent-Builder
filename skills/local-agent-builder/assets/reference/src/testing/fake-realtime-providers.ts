/**
 * Faux serveurs ElevenLabs (temps réel STT + voix TTS) pour les tests du canal de voix.
 *
 * Pourquoi de vrais websockets et pas des objets truqués : les adaptateurs du dépôt ne
 * testent rien s'ils parlent à un mock qui connaît déjà la réponse. Ici ils rencontrent un
 * serveur qui applique le PROTOCOLE — `session_started` avant tout texte, `commit_strategy`
 * respecté, `isFinal` après `{text:'',flush:true}` — donc un changement de notre client qui
 * casserait le vrai fournisseur casse aussi ces tests.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RealtimeSocket, SocketFactory } from '../realtime/protocol.js';

export interface FakeSttTurn {
  /** Nombre de trames `input_audio_chunk` reçues. */
  chunks: number;
  /** Ce qu'on a demandé au fournisseur pour le premier cadre. */
  firstMessage: Record<string, unknown> | null;
  /** Le texte qu'a vu le fournisseur avant chaque commit. */
  commits: number;
  maxChunkBytes: number;
}

export interface FakeProviders {
  /** Base websocket à passer aux adaptateurs (sans le `/v1` : ils l'ajoutent). */
  wsUrl: string;
  stt: FakeSttTurn;
  /** true = le service ne rend JAMAIS de texte final (il hoquette) : le repli blocs doit prendre le relais. */
  muteCommits: boolean;
  /** Motif du refus éventuel côté voix (`detail` renvoyé par le fournisseur). */
  failSpeech: boolean;
  /** Clé attendue en en-tête ; `''` = on ne vérifie pas. */
  requiredKey: string;
  close(): Promise<void>;
}

const TONE_CHUNKS = 3;

/** Un PCM16 24 kHz de 40 ms, encodé en base64 comme le renvoie ElevenLabs. */
function toneBase64(ms = 40, sampleRate = 24_000, level = 0.2): string {
  const samples = Math.floor((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin(i / 7) * level * 32767), i * 2);
  }
  return buf.toString('base64');
}

export async function startFakeProviders(options: { transcript?: string; speech?: string } = {}): Promise<FakeProviders> {
  const transcript = options.transcript ?? 'il est quelle heure';
  const stt: FakeSttTurn = { chunks: 0, firstMessage: null, commits: 0, maxChunkBytes: 0 };
  const state = { failSpeech: false, requiredKey: 'test-key', muteCommits: false };

  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Seule la TRANSCRIPTION s'authentifie à l'en-tête (c'est ce que fait notre client : la clé
    // ne transite jamais par l'URL). Côté voix, la clé vit dans le PREMIER MESSAGE — c'est la
    // doc ElevenLabs, et c'est ce qu'on vérifie dans serveSpeech, pas ici.
    if (url.pathname.startsWith('/v1/speech-to-text/realtime') && state.requiredKey !== '' && req.headers['xi-api-key'] !== state.requiredKey) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname.startsWith('/v1/speech-to-text/realtime')) {
      wss.handleUpgrade(req, socket, head, (ws) => void serveStt(ws));
      return;
    }
    if (/^\/v1\/text-to-speech\/[^/]+\/stream-input$/.test(url.pathname)) {
      wss.handleUpgrade(req, socket, head, (ws) => void serveSpeech(ws, url));
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  /** Le vrai ElevenLabs n'accepte AUCUN texte avant `session_started` : le faux non plus. */
  function serveStt(ws: WebSocket): void {
    let started = false;
    let pendingText = '';
    // Le vrai service envoie `session_started` de lui-même dès la poignée de main ; le client,
    // lui, n'écrit RIEN avant de l'avoir reçu. Ce délai est ce qu'on reproduit ici.
    setTimeout(() => {
      ws.send(JSON.stringify({ message_type: 'session_started', session_id: 'fake-session', config: { commit_strategy: 'manual' } }));
      started = true;
    }, 0);
    ws.on('message', (raw: Buffer) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ message_type: 'input_error', error: 'json attendu' }));
        return;
      }
      if (payload['message_type'] === 'keep_alive') return;
      if (payload['message_type'] !== 'input_audio_chunk') {
        ws.send(JSON.stringify({ message_type: 'invalid_request_error', error: `message_type inconnu : ${String(payload['message_type'])}` }));
        return;
      }
      if (!started) return;
      // Le champ s'appelle `audio_base_64` (doc ElevenLabs ET client du depot) : lire
      // `audio_base64` renvoyait une chaine vide, le faux service ne voyait jamais d'audio —
      // et repondait donc toujours « pas de texte final ». Un faux serveur qui ne valide pas
      // le nom des champs ne prouve rien : c'est exactement ce que ce test vient de montrer.
      const audio = typeof payload['audio_base_64'] === 'string' ? (payload['audio_base_64'] as string) : '';
      stt.chunks += 1;
      stt.maxChunkBytes = Math.max(stt.maxChunkBytes, Buffer.from(audio, 'base64').byteLength);
      if (stt.firstMessage === null) stt.firstMessage = payload;
      const bytes = Buffer.from(audio, 'base64');
      if (bytes.byteLength > 0) pendingText += 'a';
      if (payload['commit'] === true) {
        stt.commits += 1;
        // `commit` sans audio neuf ne rend RIEN (comportement du vrai service, et c'est le
        // contrat `manual`) : notre écouteur peut clôturer deux tours d'affilée, il ne doit
        // pas recevoir le même texte deux fois — un cerveau qui répète la même réponse, ça
        // ne se voit que sur un appel réel, donc ça se teste ici.
        if (pendingText === '') return;
        pendingText = '';
        if (state.muteCommits) return; // le fournisseur a compris le commit, mais ne répond pas
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: transcript }));
        return;
      }
      // Le partiel est émis À CHAQUE CADRE (comme le ferait un service bavard) : c'est ce qui
      // permet de tester que le sous-titre bouge sans qu'un tour soit déclenché par là.
      ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'il est' }));
    });
  }

  function serveSpeech(ws: WebSocket, url: URL): void {
    let initialised = false;
    let spoken = 0;
    if (url.searchParams.get('output_format') !== 'pcm_24000') {
      ws.send(JSON.stringify({ detail: 'output_format doit être pcm_24000' }));
      ws.close();
      return;
    }
    ws.on('message', (raw: Buffer) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!initialised) {
        // La doc est explicite : le premier message porte `text: " "` ET les réglages. Les
        // envoyer plus tard est ignoré silencieusement par le vrai service — donc par celui-ci.
        const text = payload['text'];
        if (typeof text !== 'string' || text.trim() !== '') {
          ws.send(JSON.stringify({ detail: 'premier message attendu (text " " + réglages)' }));
          return;
        }
        if (payload['voice_settings'] === undefined || payload['generation_config'] === undefined) {
          ws.send(JSON.stringify({ detail: 'réglages manquants dans le premier message' }));
          return;
        }
        if (payload['xi-api-key'] !== state.requiredKey) {
          ws.send(JSON.stringify({ detail: 'clé absente du premier message' }));
          return;
        }
        initialised = true;
        return;
      }
      if (payload['text'] === '' && payload['flush'] === true) {
        if (state.failSpeech) {
          ws.send(JSON.stringify({ detail: 'quota de voix atteint' }));
          return;
        }
        for (let i = spoken; i < TONE_CHUNKS; i += 1) ws.send(JSON.stringify({ audio: toneBase64() }));
        spoken = TONE_CHUNKS;
        ws.send(JSON.stringify({ isFinal: true }));
        return;
      }
      const text = typeof payload['text'] === 'string' ? (payload['text'] as string) : '';
      if (text === '') return;
      if (!/ $/.test(text)) {
        // ElevenLabs exige un texte terminé par une espace ; un client qui l'oublie perd la fin
        // de phrase dans le tampon. Le faux serveur le dit, comme le ferait le vrai.
        ws.send(JSON.stringify({ detail: 'texte non terminé par une espace' }));
        return;
      }
      if (state.failSpeech) return;
      ws.send(JSON.stringify({ audio: toneBase64() }));
      spoken += 1;
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    wsUrl: `ws://127.0.0.1:${port}/v1`,
    stt,
    get failSpeech() {
      return state.failSpeech;
    },
    set failSpeech(value: boolean) {
      state.failSpeech = value;
    },
    get muteCommits() {
      return state.muteCommits;
    },
    set muteCommits(value: boolean) {
      state.muteCommits = value;
    },
    get requiredKey() {
      return state.requiredKey;
    },
    set requiredKey(value: string) {
      state.requiredKey = value;
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** Un adaptateur `RealtimeSocket` branché sur le serveur de test (le vrai `ws`, pas un bouchon). */
export function socketFactoryFor(): SocketFactory {
  return (url, headers) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    return {
      get readyState() {
        return ws.readyState;
      },
      send: (data: string) => ws.send(data),
      close: () => ws.close(),
      on: (event: string, handler: (arg?: unknown) => void) => {
        if (event === 'message') {
          ws.on('message', (data: Buffer) => handler(data.toString('utf8')));
          return;
        }
        if (event === 'error') {
          ws.on('error', (error: Error) => handler(error));
          return;
        }
        ws.on(event, (arg?: unknown) => handler(arg));
      },
    } satisfies RealtimeSocket;
  };
}
