# OpenGravity

Agent d'IA personnel, écrit de toutes pièces, qui tourne sur votre machine et se
pilote **uniquement** depuis Telegram. Ni fork, ni dépendance d'un projet
existant : le code tient dans `src/`, se lit en une soirée, vous appartient.

```
Telegram ──long polling──▶ bot.ts ─▶ liste blanche ─▶ rate-limit ─▶ agent (boucle bornée)
                                                                        │
                          SQLite (mémoire, historique, audit) ◀── tools ┴──▶ Groq → OpenRouter
```

## Ce qui est livré

- Bot Telegram fonctionnel en long polling — **aucun port ouvert, aucun serveur web**.
- **Voix** : les vocaux que tu envoies sont transcrits (Groq Whisper, secours
  ElevenLabs Scribe) et les réponses peuvent revenir en vocal (ElevenLabs, format
  OGG/Opus attendu par Telegram). Mode par défaut `mirror` : tu parles, il répond en
  parlant ; tu écris, il écrit. `/voice on|off|mode <x>` règle ça par conversation.
- Liste blanche stricte d'IDs utilisateurs (`deny-by-default`).
- Boucle d'agent avec plafond d'itérations, déduplication des appels, retrait
  forcé des outils en fin de boucle.
- Groq en principal, bascule automatique sur le modèle de secours en cas de quota,
  puis OpenRouter si une clé est fournie. Les identifiants de modèles sont **à
  vérifier sur ton compte** (`GET /v1/models`) : une sonde le fait au démarrage et
  refuse de lancer le bot sur un nom inexistant — le cas s'est produit, deux noms
  documentés n'existaient pas sur le compte utilisé.
- Mémoire persistante SQLite : historique fenêtré, souvenirs à long terme,
  journal d'audit des appels d'outils.
- 5 outils : `get_current_time` (l'exigence), `remember`, `recall`, `forget`,
  `calculator`.
- Approbation humaine par boutons Telegram pour tout outil marqué sensible.
- 82 tests, dont **3 bout-en-bout** qui lancent le vrai processus avec un faux
  serveur Telegram, un faux Groq et un faux ElevenLabs.

## Installation

### 1. Prérequis

Node ≥ 20.11 (le code utilise `fetch` natif et `AbortSignal`). `better-sqlite3`
apporte un binaire précompilé ; s'il doit compiler : `python3`, `make`, `g++`.

### 2. Créer le bot

1. Dans Telegram, parlez à **@BotFather** → `/newbot` → copiez le token.
2. Lancez l'agent (étape 3) avec `TELEGRAM_ALLOWED_USER_IDS="0"` temporairement et
   écrivez une fois au bot. Deux chemins pour récupérer ton identifiant :
   - `/id` s'il est activé (`TELEGRAM_ID_COMMAND_ENABLED="true"`) : il te répond ;
   - sinon, **lis le journal** : un refus y enregistre l'ID de l'expéditeur, par
     exemple `accès refusé {"userId":8295237112}`. C'est la voie recommandée, elle
     ne laisse aucune commande ouverte à l'extérieur de la liste blanche.
3. Reporte l'ID dans `.env`, puis repasse `TELEGRAM_ID_COMMAND_ENABLED="false"`
   et redémarre : la liste blanche doit être la seule porte d'entrée.

### 3. Configurer

```bash
cp .env.example .env      # puis remplir les valeurs
chmod 600 .env
```

| Clé | Rôle | Défaut |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | token @BotFather | — (obligatoire) |
| `TELEGRAM_ALLOWED_USER_IDS` | IDs autorisés, séparés par des virgules | — (obligatoire) |
| `GROQ_API_KEY` | clé console.groq.com | — (au moins une clé LLM) |
| `GROQ_MODEL` / `GROQ_FALLBACK_MODEL` | principal / secours Groq — **IDs propres au compte** | `openai/gpt-oss-120b` / `qwen/qwen3.8-27b` |
| `LLM_VALIDATE_MODELS` | vérifie ces IDs chez le fournisseur au démarrage | `true` |
| `OPENROUTER_API_KEY` | si défini, secours OpenRouter | vide (désactivé) |
| `OPENROUTER_MODEL` | modèle OpenRouter | `openrouter/free` |
| `DB_PATH` | fichier SQLite | `./memory.db` |
| `AGENT_MAX_ITERATIONS` | budget de la boucle | `6` |
| `AGENT_FORCE_FINAL_ITERATION` | itération où les outils sont retirés | `5` |
| `SYSTEM_TIMEZONE` | fuseau par défaut (IANA) | `Africa/Bamako` |
| `RATE_LIMIT_PER_MIN` | anti-abus par utilisateur | `12` |
| `DANGEROUS_TOOLS_ENABLED` | portail des outils sensibles | `false` |
| `GOOGLE_ENABLED` | accès Google Workspace via le CLI `gws` (lecture, écritures verrouillées) | `false` |
| `GWS_SERVICES` | liste blanche des services joignables | `gmail,drive,docs,sheets,calendar` |
| `GWS_ALLOW_WRITES` | écritures Google, avec `DANGEROUS_TOOLS_ENABLED` et un clic | `false` |

La validation est stricte et précoce : une liste blanche vide, un token mal formé
ou un fuseau inexistant **empêchent le démarrage** avec un message explicite, au
lieu de laisser tourner un agent mal sécurisé. Un service Google hors de `GWS_SERVICES`
est refusé de la même façon : une liste blanche ne se prolonge pas par un `*`.

Accès Google Workspace : les onze outils typés, le périmètre, la gestion des secrets et — surtout —
la liste de ce qui a été vérifié en réel et de ce qui ne l'a pas été dans
[`docs/GOOGLE.md`](docs/GOOGLE.md).

### 4. Lancer

```bash
npm install
npm run dev       # développement, rechargement à chaque sauvegarde
```

Production :

```bash
npm run build && npm start
```

Vérifications disponibles à tout moment :

```bash
npm run check     # typecheck + 56 tests + build
npm run typecheck # seul
npm test          # seuls les tests
```

## Utiliser

Écrivez normalement. L'agent appelle les outils quand c'est utile :

> « Quelle heure il est ? » → `get_current_time`
> « Combien font 18 % de 249 € ? » → `calculator`
> « Retiens que je préfère les réponses courtes » → `remember`
> « Tu te souviens de mes préférences ? » → `recall`

Commandes (aucune ne passe par le LLM) : `/start` `/help` `/id` `/tools`
`/memory [mots-clés]` `/forget_memory <id>` `/forget` `/stats` `/pending`
`/voice` (mode vocal et choix de la voix).

Celles sans paramètre apparaissent aussi dans le menu de Telegram (bouton « / ») : il
est dérivé de la même liste que `/help`, donc une commande ajoutée au canal est
annoncée au client sans rien avoir à recopier dans le bootstrap.

La mémoire **longue** (souvenirs) survit à `/forget`, qui n'efface que
l'historique de la conversation. Pour tout repartir de zéro : arrêter l'agent et
supprimer `memory.db`.

## Le garder vivant : supervision et journal

`npm run dev` (avec `tsx watch`) redémarre sur changement de fichier, pas sur une panne durable. Pour un bot qui doit tenir des jours :

```bash
npm run build && npm run supervise:dist   # ou npm run supervise pour partir des sources
```

Le superviseur (`src/supervise.ts`) ne fait pas semblant d'empêcher les crashes : il les
**digère**. Un enfant qui meurt repart, avec un délai qui croît (1 s, 2 s, 4 s… jusqu'à
60 s, puis 5 min) pour ne pas marteler un fournisseur en panne. Trois codes de sortie
tiennent lieu de contrat :

| Code | Sens | Réaction du superviseur |
|---|---|---|
| `0` | arrêt demandé (`SIGINT`/`SIGTERM`, `/stop`) | ne relance pas |
| `75` | panne temporaire (réseau, fournisseur, bug) | relance après délai |
| `78` | configuration invalide | **ne relance pas** — un humain doit lire le message |

Le journal vit dans `logs/agent.log` (l'agent) et `logs/supervisor.log` (le
superviseur, qui recopie aussi le stdout de l'enfant : une mort avant la lecture de la
config laisse donc une trace). Droits `600`, rotation à 4 Mio en une seule archive. Un
fichier `logs/supervisor.pid` empêche deux superviseurs de cohabiter — deux instances à
poller le même token se répondent par un `409 Conflict` et se tuent, ce qui est un cas
réel d'« il s'est arrêté tout seul ».

Rien dans ces fichiers ne doit jamais contenir un contenu de message privé ni une clé :
uniquement des compteurs, des identifiants de chat et des motifs d'erreur tronqués.

### Qui garde le gardien ?

Le superviseur digère les crashes de l'agent. Personne ne digère ceux du superviseur : un
`kill -9` qui le tombe lui, un OOM qui le choisit, une session qui ferme, et le bot est arrêté
sans journal ni cause — le symptôme exact qu'on avait corrigé au premier étage. `scripts/keepalive.sh`
est le troisième étage, et il ne fait qu'une chose : vérifier que le verrou `logs/supervisor.pid`
désigne un processus vivant, et relancer sinon.

```bash
bash scripts/keepalive.sh loop     # au premier plan : c'est ce que launchd/systemd doit lancer
bash scripts/keepalive.sh status   # les trois étages (veille, superviseur, agent) + sonde du hub
bash scripts/keepalive.sh stop     # arrête tout, dans l'ordre (veille, puis superviseur, puis agent)
```

Il **réapare** aussi avant de relancer : un superviseur tué de l'extérieur laisse son agent
orphelin, et un orphelin qui tient encore le port fait échouer le démarrage suivant en
`EADDRINUSE` (donc en code 75, donc en backoff, donc en minutes de silence). Deux règles de
ce troisième étage, apprises en le testant :

- il ne juge jamais l'intention sur le mode de mort — il relance, un point c'est tout ;
- il ne reconnaît ses processus qu'à leur ligne de commande exacte (`pgrep -x node` + filtre),
  jamais à un `pkill -f dist/index.js` qui tuerait au passage le shell de quiconque tape cette
  chaîne dans un `grep`.

Sur macOS, l'équivalent de « lance `loop` pour toujours » est un LaunchAgent fourni en
`deploy/launchd/com.opengravity.keepalive.plist` (`KeepAlive`, `RunAtLoad`, deux chemins à
remplacer) ; sur Linux, une unit systemd fournie en
`deploy/systemd/opengravity.service` (`Restart=always`, `NoNewPrivileges`, aucune clé à y poser). Dans les deux cas l'agent doit rester l'enfant du superviseur, pas un
quatrième étage : chaque étage n'a qu'une responsabilité, sinon personne ne sait qui a tué qui.

**Le code 0 n'est pas un permis de mourir.** Un enfant qui rend `0` après vingt millisecondes
n'a pas décidé de s'arrêter : il n'a jamais démarré (c'est comme ça qu'un
`--command node --env-file=.env dist/index.js` — dont la collecte de arguments s'arrête au
premier `--` — a laissé un superviseur poli annoncer « pas de relance, code 0 » pendant que le
bot n'existait pas). `shouldRestart` ne croit donc un arrêt propre que si l'enfant a duré au
moins `unhealthyRunMs` ; en dessous, il relance, et il l'écrit en `WARN` avec la commande exacte.

## Architecture en 30 secondes

```
src/
├── config.ts                  # lit et valide tout process.env, masque les secrets
├── index.ts                   # câblage + long polling + arrêt propre
├── channels/telegram/         # bot.ts (adaptateur) · format.ts (HTML sûr)
├── core/                      # agent.ts (boucle) · prompts.ts · types.ts · logger.ts
├── llm/                       # openai-compat.ts (client) · providers.ts (chaîne + secours)
├── tools/                     # registry.ts · args.ts · calculator.ts · builtin/*
├── memory/                    # schema.ts · store.ts (seul fichier qui touche au SQL)
├── security/                  # allowlist.ts · rate-limit.ts · sanitizer.ts · approvals.ts
├── testing/                   # fabriques (exclues du build)
└── test/                      # 56 tests, dont l'intégration bout-en-bout
```

Le noyau (`core/`, `tools/`) n'importe **jamais** `grammy` ni Telegram : c'est ce
qui permet d'ajouter un canal ou de passer au cloud sans retoucher le
raisonnement. Détails dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Sécurité — l'essentiel

- **Deny-by-default** : sans ID dans la liste blanche, aucun octet n'atteint le
  LLM. Testé bout-en-bout.
- **Capacités closes** : le modèle ne peut nommer que les outils du registre ; un
  nom inventé est refusé et journalisé.
- **Validation avant exécution** : arguments typés, bornés, champs inconnus
  refusés (un `{chatId: 999}` injecté ne peut pas écrire chez un autre utilisateur).
- **Injection de prompt** : sorties d'outils et souvenirs sont encadrés comme
  *données* et tronqués ; le cadre ne peut pas être fermé depuis l'intérieur.
- **Boucle finie** : `AGENT_MAX_ITERATIONS`, plus retrait des outils pour forcer
  une conclusion ; doublons d'appels ignorés ; 4 appels maximum par tour.
- **Aucune exécution de code** : pas d'`eval`, pas de `new Function`, pas de shell.
  La calculatrice est un parseur récursif.
- **Approbation humaine** : un outil `dangerous` est invisible tant que
  `DANGEROUS_TOOLS_ENABLED=false`, et exige sinon un clic ✅ (jeton à usage
  unique, TTL, lié à un user + chat).
- **Secrets** : dans `.env` (ignoré par Git), masqués dans les logs, absents des
  réponses ; `remember` refuse d'écrire ce qui ressemble à une clé ou un mot de passe.
- **Audit** : chaque appel d'outil est journalisé en base (arguments, statut, durée).

Tour d'horizon complet dans [docs/SECURITY.md](docs/SECURITY.md).

## Étendre

| Besoin | Fichier à toucher | Doc |
|---|---|---|
| Nouvel outil | `src/tools/builtin/*` + `coreTools()` | [docs/TOOL-DEVELOPMENT.md](docs/TOOL-DEVELOPMENT.md) |
| Nouveau canal (webhook, CLI, cloud) | `src/channels/<nom>/` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Audio (transcription, ElevenLabs) | `src/media/` + canal | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Passer sur Firebase / Cloud Run | `Store` (interface) + webhook | [docs/ROADMAP.md](docs/ROADMAP.md) |

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `TELEGRAM_BOT_TOKEN n'a pas le format attendu` | guillemets ou copier-coller incomplet dans `.env` |
| `liste blanche` au démarrage | `TELEGRAM_ALLOWED_USER_IDS` vide ou non numérique |
| Bot muet | vous n'êtes pas dans la liste blanche → `/id`, puis ajoutez l'ID |
| `⚠️ Quota atteint` | plafond Groq gratuit : attendez, ou laissez tomber sur le 8B, ou renseignez OpenRouter |
| `Erreur d'outillage : 400` | le modèle demandé n'existe pas sous ce nom chez Groq : vérifiez `GROQ_MODEL` |
| Deux réponses en double | second processus lancé : un seul à la fois (le verrou `logs/supervisor.pid` protège les superviseurs, pas deux `npm run dev`) |
| Le bot ne répond plus | `tail -20 logs/supervisor.log` — s'il est écrit « pas de relance » avec `code 78`, c'est la configuration, pas le réseau |
| « il s'est arrêté tout seul » | regardez d'abord `logs/agent.log` : s'il est absent, `LOG_FILE` n'est pas câblé et le processus n'a laissé aucun témoin |

## Licences et dépendances

Runtime : `grammy`, `better-sqlite3`, `dotenv`. C'est tout. Développement :
`typescript`, `tsx`, `@types/*`. Aucune compétence externe non vérifiée n'est
chargée à l'exécution, et rien n'est téléchargé au démarrage.

## Voix

Trois décisions valent d'être écrites, parce qu'elles seront tentantes à annuler :

1. **La transcription n'est pas un outil du modèle.** Elle a lieu *avant* la boucle
   d'agent, dans le canal, et son résultat entre comme un simple message utilisateur.
   Un outil `transcribe_audio` aurait permis au modèle de choisir d'écouter — donc
   d'appeler un fournisseur payant sans qu'on le lui demande, et de recevoir un texte
   non fiable par un chemin distinct de celui qui est déjà encadré.
2. **Rien du média n'est écrit sur le disque.** Les octets du vocal, comme ceux de la
   réponse synthétisée, vivent en mémoire et y meurent. « Supprimer après usage » est une
   promesse qu'un refactor peut oublier ; ne rien écrire est une propriété du code. (Le
   journal, lui, est bien un fichier — voir « Le garder vivant » — et ne contient ni audio
   ni texte de message.)
3. **Le quota est borné à deux endroits** : `MEDIA_MAX_BYTES` à l'entrée (un fichier
   de 20 Mo autorisé par Telegram, c'est 20 Mo alloués par tour), `TTS_MAX_CHARS` à la
   sortie (ElevenLabs facture la voix, pas la requête).

### Changer de voix depuis Telegram

`/voice` seul répond l'état **et** un clavier de voix, construit sur l'inventaire réel du
compte (`GET /v1/voices`, mis en cache dix minutes) : rien à recoller, aucun identifiant à
connaître. Touche une voix, et la réponse parlée suivante sort dans cette voix.

- `/voice` — état, voix courante marquée d'un ✓, liste à toucher
- `/voice roger` — par nom, en sous-chaîne tolérante aux accents (utile au-delà des
  24 boutons affichés : `Élodie` se trouve en tapant `elodie`)
- `/voice par-defaut` — efface la préférence, `ELEVENLABS_VOICE_ID` reprend la main
- `/voice rafraichir` — force la relecture de l'inventaire du compte
- `/voice on|off`, `/voice mode always|on_request|mirror|off` — le réglage de session

Deux portées différentes, volontairement : **le mode** est un réglage de session en mémoire
seule (un redémarrage revient à `VOICE_MODE`), **la voix** est persistée dans
`chats.voice_id` — une identité qui s'évapore à chaque arrêt est un bug vécu, pas une
simplification.

Choisir ne coûte rien : aucun échantillon n'est synthétisé au clic (un appel ElevenLabs
factoré par curiosité serait le bon moyen de griller un quota gratuit). La voix
s'entend à la réponse suivante.

### Vérifier la voix sans attendre un message

```bash
npm run voice:check            # synthétise une phrase et l'envoie dans ton chat
npm run voice:check -- --mute  # synthétise seul : isole le problème du canal
```

Séparer les deux pannes possibles vaut le coup : « la clé ElevenLabs est bonne » et
« l'envoi Telegram marche » n'ont rien à voir, et le bot les mélange dans ses logs.
Le script utilise les modules livrés (`buildSynthesizer`, `sendVoice`), pas une
réécriture de complaisance, et n'écrit rien sur le disque.

Note de quota : `GET /v1/user/subscription` répond `401` avec une clé API standard —
ce point exige une *Accounts API key*, distincte. L'agent ne l'appelle donc jamais ;
le budget se lit sur le tableau de bord ElevenLabs, et `TTS_MAX_CHARS` le borne à
chaque tour côté agent.

Variables concernées : `VOICE_MODE`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
`ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`, `TRANSCRIPTION_PROVIDERS`,
`GROQ_WHISPER_MODEL`, `TTS_MAX_CHARS`, `MEDIA_MAX_BYTES`.
