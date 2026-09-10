# Appel vocal en direct (Live Voice)

Ce document répond à trois questions, dans cet ordre : **ce que la plateforme autorise**
(ça conditionne toute l'architecture), **comment le flux est découplé** (pour que l'oreille
et la bouche soient remplaçables), **ce qui est borné** (un micro qui écoute est une
fuite potentielle). Il ne raconte pas le code ligne à ligne : `src/realtime/*.ts` porte sa
propre explication en en-tête.

## 1. Ce que Telegram autorise — vérifié avant d'écrire une ligne

| Intuition | Reality (2026‑09) |
|---|---|
| « Un bot peut passer/recevoir un appel vocal » | **Non.** Les types d'appel vocal (`Call`, `Voip…`) ont été **retirés de l'API Bot en 2022**. Les appels sont réservés aux **comptes utilisateurs** (MTProto/tdlib), pas aux bots. |
| « On peut streamer de l'audio pendant un appel » | **Non.** L'API Bot ne transporte **aucun média temps réel** : pas de `sendVoice` en flux, pas de canal montant. Au mieux, `getVoiceChat…` côté compte utilisateur, hors de portée d'un bot. |
| « Alors on s'envoie des notes vocales » | C'est **autre chose** (un aller simple de 60 s, une latence de plusieurs secondes, pas d'interruption possible). Ce n'est pas ce qui a été demandé, et ce n'est pas ce qui est construit ici. |
| « Une Mini App Telegram peut ouvrir le micro » |Techniquement `getUserMedia` est exposé dans la webview, mais **peu fiable** (implémentations natives divergentes, refus sur Android selon les versions) **et** le navigateur n'autorise un micro que **en HTTPS ou sur `localhost`** : une Mini App servie en clair depuis un VPS se fait refuser le micro. |

**Conséquence retenue** : le média ne peut pas transiter par Telegram. C'est **l'agent qui
ouvre le canal audio**, dans sa propre page, et Telegram ne sert que de **porte d'entrée
authentifiée** : c'est la commande `/call` du même agent — pas un service vocal à côté. Le
cerveau, les outils, la mémoire, l'ordonnancement restent ceux du bot : l'appel ajoute une
**entrée** (la voix) et une **sortie** (la parole), jamais un second agent.

Ce choix a un prix : il faut écouter un port. C'est une entorse à la règle « aucun serveur web
dans un agent local », donc elle est **nommée et bornée** (§6), et vérifiée par le skill
(`listening-is-a-decision`).

## 2. Le flux, de bout en bout

```
  Micro (navigateur)
    │  getUserMedia + AudioWorklet « og-pcm »  →  resample 16 kHz, cadres de 40 ms
    ▼
  WebSocket /ws   binaire : [0x42][t:u32LE][pcm s16 mono]        texte : contrôle JSON
    ▼
  hub.ts          billets, liste blanche, budget de débit, un socket par chatId
    ▼
  session.ts      machine à états : idle · listening · thinking · speaking · muted · ended
    │             file sérielle par appel, barge-in, fin de tour
    ├── listener.ts ─ vad.ts (énergie locale) ─ elevenlabs-stt.ts  ← l'OREILLE, remplaçable
    │        │  partiel → sous-titres · texte final → tour
    ▼        ▼
  core/agent.ts  (la boucle existante : LLM → outils → réponse, mémoire, garde-fous)
    │           channel: 'call' → bloc oral dans le prompt système, trace en base (migration v3)
    ▼
  audio/policy.ts  doit-on parler ? (décision pure, budget de caractères)
    ├── oui → elevenlabs-tts.ts  cadres [0x41][u32 rate][u32 len][pcm] → sink → client
    └── non → sendChatText (réponse écrite dans Telegram, sous-titres dans la page)
```

Le **chemin audio descendant** ne passe jamais par le disque ni par Telegram : les octets
vont du fournisseur au client via le sink. La **trace** de l'appel, elle, est écrite :
transcription, réponse, et le fait que le tour venait d'un appel (`messages.channel = 'call'`).

## 3. Les modules et leurs contrats

| Fichier | Responsabilité | Contrat à respecter pour un remplaçant |
|---|---|---|
| `protocol.ts` | Constantes, encodages, unions, **contrats** | source unique des types : `LiveListener`, `LiveSpeaker`, `SpeechSink`, `ListenerEvent`, `RealtimeSocket`, `SocketFactory` |
| `vad.ts` | `UtteranceVad` : début/fin de parole à énergie, seuil de barge-in relevé pendant que l'agent parle | local, synchrone, sans dépendance réseau — c'est lui qui décide du **fin de tour** |
| `listener.ts` | `RealtimeListener` : oreille. Temps réel, **repli blocs** si le fournisseur hoquette | `LiveListener` : `feed(pcm)`, `flush()`, `close()`, `setAgentSpeaking()`, `setMuted()`, `on(handler)` |
| `elevenlabs-stt.ts` | `RealtimeSttClient` : Scribe, `commit_strategy=manual`, keep‑alive, 1 reconnexion | aucun nom de champ de fournisseur ne sort de ce fichier |
| `elevenlabs-tts.ts` | `ElevenLabsSpeechStream implements LiveSpeaker` | `begin/write/end/abort/close`, toutes en `Promise` ; `abort()` **ne ferme pas** la socket |
| `session.ts` | Ordonnance l'appel : un tour à la fois, interruption, latences, clôture | ne parle à aucun fournisseur directement ; reçoit une `buildListener`/`buildSpeaker` |
| `hub.ts` | Écoute, billets, HTTP durci, budget, bilans | `RealtimeHubDeps` injecte `buildSession` ; seul fichier qui appelle `listen()` |
| `page.ts` | La page d'appel (une chaîne, aucune ressource externe) | doit rester autonome : `call-page-isolated` la surveille |
| `channel.ts` / `wire.ts` | cassent le cycle `bot.ts ⇄ hub.ts` ; assemblent le bundle depuis la config | le câblage ne décide pas d'écouter : il délègue, et c'est tout ce qu'on lui demande |

## 4. Latence : ce qui a été décidé pour la payer une fois

Budget mesuré par étape, pas espéré :

- **cadres de 40 ms** (1 280 o de PCM) : assez fins pour que l'arrêt de parole soit vu vite,
  assez gros pour ne pas noyer la boucle d'événements ;
- **VAD local, commit manuel** : attendre que le fournisseur annonce la fin de phrase, c'est
  ajouter son aller‑retour à chaque tour. Le fournisseur ne fait que **transcrire** ; c'est le
  client qui dit « commit » ;
- **pré‑roll 200 ms** : on renvoie les 5 cadres avant le déclenchement, sinon la première
  consonne est mangée — une erreur qui se traduit par « il a mal entendu » ;
- **`partial_transcript` → sous‑titres uniquement** : le partiel ne décide jamais d'un tour.
  Un tour déclenché sur un partiel échoit sur une phrase inachevée ;
- **grâce de 1 200 ms** sur le texte final, puis repli sur les blocs : la latence n'est pas
  payée par un échec ;
- **TTS au premier octet mesuré** (`SpeakResult.firstByteMs`) et flux **par cadres de 3 840 o** :
  la lecture démarre avant la fin de la synthèse ;
- **`waitForPlayback`** attend le `t:'stop'`/la fin de buffer côté client, pas une temporisation :
  une interruption « au sentiment » coupe le milieu d'une phrase ;
- **un seul socket par appel**, keep‑alive STT à 18 s (la limite fournisseur est à 20 s) ;
- **`abort()` sans fermeture de socket** : une interruption ne doit pas coûter une nouvelle
  poignée de main TLS (≈ 200 ms de pénalité à chaque fois).

Le bilan d'un appel (`summary()`) donne durée, échanges, réponses parlées, motif de fin et
**état de l'oreille** — si le temps réel a été abandonné en cours de route, ça se voit.

## 5. Interruption

Pendant que l'agent parle, `setAgentSpeaking(true)` **relève** le seuil VAD (0,05 contre 0,014) :
sinon le haut‑parleur du portable se réentend lui‑même et s'interrompt en boucle. Au‑delà du
seuil, pendant plus de 160 ms : `interrupt` → `sink` coupé, **anneau de lecture vidé**, phrase
d'agent marquée inachevée, `speaker.abort()`, et le micro de l'utilisateur devient la source.
La reprise est naturelle : le tour suivant part du cadre où l'on est.

Un faux positif d'interruption est moins cher qu'une phrase non finie : la barre est donc
volontairement haute, et `speechBudget` (côté hub) plafonne le débit pour qu'un micro
glouton ne sature pas la boucle.

## 6. Bornes de sécurité

- **Un seul port, nommé** : `LISTEN-EXCEPTION:` est écrit dans `hub.ts` avec son motif, son
  éteignoir (`REALTIME_ENABLED=false` par défaut) et son mode d'emploi. Le vérificateur du
  skill refuse tout `createServer`/`server.listen` **ailleurs** que sous `src/realtime/` (ou
  dans `index.ts`, qui ne fait que déléguer), sans mention, sans bascule, ou sans liste
  blanche confrontée à la poignée de main.
- **Écoute locale par défaut** (`127.0.0.1`) : exposer le micro sur le LAN est une décision,
  pas un effet de bord. Pour un usage hors machine, on met un reverse‑proxy **devant** et on
  règle `REALTIME_PUBLIC_URL` — le hub ne fait pas de TLS.
- **Billet à usage unique** : 32 octets aléatoires, TTL (`REALTIME_TICKET_TTL_SECONDS`, 120 s
  par défaut), transmis dans le **fragment** d'URL (`/#t=`) pour ne jamais atterrir dans un
  `Referer` ni un journal de proxy, **révoqué dès la poignée de main**, purge toutes les 30 s,
  révoquable par `/call stop`.
- **Liste blanche** : la session est construite **après** vérification du billet, et le
  `chatId` du billet est celui qui a demandé le lien. Un billet volé ne donne pas accès à la
  conversation d'un autre, et un billet vieux de 2 minutes ne donne rien du tout.
- **HTTP durci** : trois chemins seulement, `405` hors `GET`, `404` muet partout ailleurs ;
  `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' blob:`,
  `Permissions-Policy: microphone=(self)`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- **Budget de débit** : `REALTIME_MAX_KBPS` (128 par défaut) comparé à la taille **du PCM seul** ;
  au‑delà, la trame est abandonnée et l'utilisateur est prévenu — silencieusement pour le
  fournisseur, bruyamment dans le journal interne.
- **Plafonds d'appel** : `REALTIME_MAX_MINUTES` et `REALTIME_MAX_TURNS` coupent l'appel de
  lui‑même (coût et attention, pas paranoïa).
- **Zéro octet audio sur disque** : ni montage temporaire, ni cache, ni « au cas où ». Les
  anneaux sont en mémoire et meurent avec la session. C'est `media-no-residue` qui le
  vérifie ; la page, elle, ne peut pas tricher puisqu'elle ne téléverse rien.
- **Journaux** : ni contenu de conversation, ni corps de réponse fournisseur. Un refus dit
  le **motif** (statut, phase), jamais le payload.
- **Clé ElevenLabs** : en **en‑tête** `xi-api-key`, jamais en query string (une query string
  se logge). `enable_logging=false` côté STT et côté TTS = pas de rétention fournisseur.

## 7. Pannes, et ce qui continue de marcher

| Ce qui casse | Ce qui se passe |
|---|---|
| Le hub refuse de démarrer (port pris, config coupée) | `RealtimeUnavailableError` → code **75** : le superviseur relance. `/call` répond « mode appel indisponible » et **les vocaux continuent de marcher** (chemin `audio/`), sans hub. |
| Le websocket STT tombe | 1 reconnexion ; si elle échoue, `degrade()` : **CE tour** et les suivants passent par `Transcriber` (blocs, `muxWav` en mémoire). L'appel continue, la note dit « oreille en mode blocs ». |
| Le fournisseur rend un partiel mais jamais de final | grâce écoulée → texte des blocs. Le tour n'est pas perdu, il est en retard. |
| La synthèse échoue en cours de phrase | `SpeakResult` en échec → la **suite** part au chat écrit ; on ne rejoue pas un demi‑mot. |
| Le navigateur perd le réseau | `sink.close()` puis `session.end()` : bilan envoyé, mémoire écrite, socket fermé (`terminate()`, `closeIdle/AllConnections`, `keepAliveTimeout: 250`). |
| L'utilisateur clique « Raccrocher » deux fois | `end(reason)` est **idempotent** par `chatId`. |

L'avis de fermeture part **avant** la coupure du socket : un client qui apprend la fin par un
`close` sans motif affiche une erreur ; un client qui a reçu `{t:'note', why:'…'}` affiche la
vraie raison.

## 8. Config (12 clés, toutes promises dans `.env.example`)

| Clé | Défaut | Rôle |
|---|---|---|
| `REALTIME_ENABLED` | `false` | l'interrupteur du port. Le hub n'existe pas sans lui |
| `REALTIME_PORT` | `8790` | `0` = port libre attribué (utilisé par les tests) |
| `REALTIME_BIND` | `127.0.0.1` | seule raison de le changer : un reverse‑proxy devant |
| `REALTIME_PUBLIC_URL` | *(vide)* | base publique pour construire le lien de la page |
| `REALTIME_MAX_MINUTES` | `10` | plafond de durée, puis clôture propre |
| `REALTIME_MAX_TURNS` | `40` | plafond d'échanges |
| `REALTIME_TICKET_TTL_SECONDS` | `120` | validité du billet (bornes 15–3600) |
| `REALTIME_VAD_SILENCE_MS` | `450` | silence qui clôt un énoncé (bornes 200–2000) |
| `REALTIME_MAX_KBPS` | `128` | budget de débit du micro |
| `REALTIME_STT_MODEL` | `scribe_v2_realtime` | modèle d'oreille |
| `REALTIME_TTS_MODEL` | `eleven_flash_v2_5` | modèle de voix |
| `ELEVENLABS_WS_URL` | `wss://api.elevenlabs.io/v1` | **le point de branchement** : tout fournisseur qui parle le même dialecte se branche là |

## 9. Changer d'oreille ou de bouche

C'est le motif principal de la découpe en modules. Trois niveaux, du moins au plus cher :

1. **Un autre fournisseur qui parle le même dialecte** : changer `ELEVENLABS_WS_URL` (et le
   modèle). Aucune ligne de `src/realtime/` à toucher. C'est ce que prouve le test
   « oreille et bouche se branchent sur n'importe quel serveur : la fabrique est un paramètre ».
2. **Un autre fournisseur, autre protocole** : implémenter `LiveListener` (5 méthodes) et/ou
   `LiveSpeaker` (5 méthodes), les retourner depuis `RealtimeListener.create` / le `buildSink`
   de la session. `RealtimeSocket`/`SocketFactory` existent pour qu'un `WebSocket` natif, un
   `ws` d'un autre paquet ou un double de test soient interchangeables.
3. **Un autre mode de transport** (WebRTC/Opus, SIP, téléphone) : seul `hub.ts` et `page.ts`
   bougent. `session.ts` ne sait pas d'où viennent les cadres ; `core/agent.ts` ne le sait
   toujours pas.

Ce qui **ne** se négocie pas, parce que c'est là que les bugs de latence et de vie privée se
cachent : la décision de fin de tour reste locale (VAD), la clé reste en en-tête, le média ne
touche pas le disque, le canal est tracé en base, et l'exception d'écoute reste nommée.

## 10. Comment c'est testé, sans fournisseur ni navigateur

`src/testing/fake-realtime-providers.ts` monte un **faux serveur STT + TTS** sur `127.0.0.1`
et rend une `socketFactory` : les tests d'oreille, de voix, de session et de hub tournent
contre lui, avec les vrais cadres, la vraie trame, le vrai ticket, **zéro appel payant** et
zéro clé. Le harnais (`realtime-harness.ts`) fournit `frame`, `utteranceFrames`, `until`,
`makeSink`, `makeListener`, `makeSessionHarness`. Ce qui est asserté, entre autres :

- `realtime-protocol` (11) : bornes de trame sur le PCM seul, contrôle ≤ 4 000 caractères,
  `rms16`, `muxWav`, `PcmRing`, `SpeechBudget`, `clampForSpeech` ;
- `realtime-vad` (10) : ouverture au 4ᵉ cadre voiced, clôture après 11 cadres de silence,
  pré‑roll, seuil relevé quand l'agent parle, `flush` forcé ;
- `realtime-session` (17) : un tour à la fois, barge‑in, repli texte, clôture idempotente,
  bilan ;
- `realtime-providers` (10) : la clé en en‑tête, le `commit` → texte **final** (jamais le
  partiel), la dégradation en cours d'appel, `abort()` qui ne ferme pas, la fabrique de
  sockets comme paramètre ;
- `realtime-hub` (20) : ticket à usage unique, `401`/`403`/`404`/`405`, budget de débit, un
  socket par `chatId`, arrêt propre ;
- `integration` : `/call` dans le menu, lien émis, `stop`/`status`.

La page, elle, est vérifiée **statiquement** (pas de ressource externe, worklet en `blob:`,
`permissions-policy` qui nomme le micro) — `call-page-isolated` dans le vérificateur du skill.
Son rendu réel dans un navigateur reste à valider à la main : c'est la limite honnête de ce
qui a pu être prouvé ici.

## 11. Où l'appel peut réellement avoir lieu

Le navigateur n'autorise un micro que sur `https://` **ou** `http://localhost` /
`http://127.0.0.1`. Donc :

| Où tourne l'agent | Où s'ouvre le lien | Micro |
|---|---|---|
| Ton ordinateur | le même ordinateur (`http://127.0.0.1:8790`) | **oui** |
| Ton ordinateur | ton téléphone, en `http://192.168.x.x` | **non** — origine non sécurisée, refusé par le navigateur |
| Ton ordinateur | ton téléphone via un tunnel qui fournit du TLS (`cloudflared`, `tailscale serve`) | oui, à condition que `REALTIME_PUBLIC_URL` soit le `https://` du tunnel |
| Un bac à sable distant | n'importe quel navigateur | **non** si le proxy de la machine exige un en-tête que le navigateur ne sait pas envoyer — et une page en `frame-ancestors 'self'` refuse d'être affichée dans un cadre d'un autre site |

Cet environnement est la dernière ligne : le hub répond bien (page 200, billet refusé 401),
mais son adresse publique est gardée par un jeton d'accès que seul un client HTTP peut poser,
et le micro de toute façon ne s'accorde pas dans un cadre tiers. **L'appel se prouve en local,
pas ici** — c'est écrit sans détour pour qu'on ne nous le reproche pas comme un bug du bot.

## 12. Ce qui n'est pas fait, et ne le sera pas ici

- **Pas de TLS, pas de HTTP/2, pas d'Opus/WebRTC** : le flux est du PCM brut sur websocket,
  réservé à une boucle locale ou à un proxy qui assume le reste. Un agent local n'a pas à
  devenir un serveur média.
- **Pas d'appel téléphonique sortant** (SIP/Twilio) : ce serait un autre budget, un autre
  numéro, une autre surface. La place est prise dans `src/realtime/` si on le veut un jour.
- **Pas de second cerveau** : l'appel n'a ni prompt, ni outils, ni mémoire à lui.
- **Pas d'annulation à la demi‑seconde près côté client** : l'écho est traité par les
  contraintes du navigateur (`echoCancellation: true`) et par le seuil de barge‑in ; une
  vraie annulation acoustique est un chantier de serveur média.
