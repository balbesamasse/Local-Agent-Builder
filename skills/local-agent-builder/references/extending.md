# Étendre sans réécrire

Sommaire : [canaux](#canaux) · [fournisseurs](#fournisseurs) · [outils-sensibles](#outils-sensibles-et-approbation) ·
[memoire](#mémoire-et-recherche) · [audio](#audio) · [cloud](#passer-cloud) · [dettes](#dettes-à-solder-avant-le-multi-instance)

## Canaux

Le contrat d'un canal tient en une interface :

```ts
interface ChannelReply {
  send(text: string, options?: { keyboard?: { inline_keyboard: unknown[][] } }): Promise<void>;
}
```

`core/agent.ts` ne rend qu'un objet `{ text, pending, iterations, toolCalls, provider, model }`.
Tout le reste — HTML, Markdown, boutons, découpe à 4096, « typing… », file par
conversation — appartient à l'adaptateur. Ajouter un canal = un dossier sous
`src/channels/<nom>/` avec un `bot.ts` qui appelle `runAgent(deps, {chatId, userId, text})`.

Quatre pièges par canal, à vérifier à chaque fois :

- **l'identité** : l'ID utilisateur doit venir de la signature du fournisseur (un
  webhook non signé permet de faire passer n'importe quel `user_id` → la liste blanche
  devient décorative) ;
- **le format** : ne pas réutiliser l'échappement Telegram pour Slack (`<https://…|texte>`)
  ou WhatsApp ; le `parse_mode` n'a aucun sens hors Telegram ;
- **la limite** : Telegram 4096 caractères, Slack 4000 par bloc, et la découpe doit
  rééquilibrer le balisage ;
- **la visibilité** : une commande que le client ne propose pas existe sans exister.
  Voir [Ajouter une commande de canal](#ajouter-une-commande-de-canal) ;
- **la capacité** : ce que le canal *transporte réellement* se vérifie avant de dessiner, pas
  après avoir écrit un demi-appel. Telegram (mesuré sur la doc, changelog 9.6 → 13) : aucun
  média temps réel montant ni descendant, types d'appel **retirés de l'API Bot en 2022** (les
  appels sont réservés aux comptes utilisateurs), pas de streaming de fichier, environ un
  message par seconde et par conversation, 50 Mo maximum en upload. Une fonctionnalité qui
  suppose autre chose n'échoue pas au démarrage : elle échoue chez l'utilisateur, et se
  présente comme un caprice du modèle.

Le long polling est un choix de sécurité, pas de simplicité : rien n'expose la machine.
Passer en webhook ajoute une surface à protéger (HTTPS, `secret_token` vérifié sur chaque
requête) — voir [cloud](#passer-cloud) ; l'unique autre entorse licite est le hub d'appel
vocal, et elle est déclarée (`listening-is-a-decision`, §20 de `security.md`).

## Ajouter une commande de canal

Un `bot.command('x')` qui répond parfaitement peut rester inutilisé : si le client ne
l'annonce pas, personne ne le tape. Le modèle a vécu les deux fautes dans le même mois.

1. **l'enregistrement** : chez grammy, `bot.command('x')` placé *après* le
   `bot.on('message:text')` de l'agent ne s'exécute jamais — les filtres sont appliqués
   dans l'ordre et le catch-all garde la mise à jour. Aucun message d'erreur, aucun log :
   le LLM répond à côté et on accuse le modèle.
2. **le menu** : `setMyCommands` recopié à la main dans le bootstrap finit par oublier la
   dernière commande ajoutée au canal. `/voice` répondait, était documentée dans `/help`,
   et n'apparaissait pas à côté des autres dans la conversation.

La parade n'est pas de mieux faire attention, c'est de n'avoir qu'une liste :

```ts
// src/channels/<canal>/bot.ts — une seule source pour l'aide ET le menu
export const CHANNEL_COMMANDS: ReadonlyArray<{
  command: string; args: string; help: string; menu: string;
}> = [
  { command: 'voice', args: '', help: 'toucher une voix du compte…', menu: 'Choisir ma voix' },
  { command: 'memory', args: '<mots-clés>', help: 'lire la mémoire…', menu: 'Mes souvenirs' },
];

export function menuCommands() {
  // Telegram refuse un nom avec espace ou `<` : les commandes à paramètre vivent
  // dans l'aide, pas dans le menu.
  return CHANNEL_COMMANDS.filter((c) => c.args === '')
    .map((c) => ({ command: c.command, description: c.menu }));
}
```

Le handler `/help` itère sur la même liste ; le bootstrap ne fait que
`setMyCommands(menuCommands().filter(...))` pour la ou deux commandes ouvertes
derrière un drapeau (`/id`). Trois vérifications ferment la boucle, et `check_invariants.py`
en reprise la moitié statique (`commands-reachable`) :

- tout `bot.command` enregistré figure dans `CHANNEL_COMMANDS` ;
- toute entrée de `CHANNEL_COMMANDS` a son `bot.command` ;
- le nom fait ≤ 32 caractères en `[a-z0-9_]`, la description ≤ 256, sans retour à la ligne.

Il reste le trajet réel, que seul un test bout-en-bout voit : la fausse API doit
**capturer `setMyCommands`** et le test assertir que `/voice` est dans le corps reçu.
Un menu qu'on ne lit pas côté client est un menu qu'on ne vérifie pas.

## Fournisseurs

Le contrat : `complete(request, signal) → { text, toolCalls, wantsTools, model, provider }`.
`providers.ts` construit une **liste ordonnée** et la chaîne applique une politique :

- on bascule au suivant sur erreur **transitoire** seulement : 429, 5xx, timeout,
  réponse vide ;
- on ne bascule **pas** sur 400/401/403 : un nom de modèle invalide ou une clé
  révoquée doit remonter, sinon on masque une régression derrière un modèle de secours
  moins bon et le diagnostic devient impossible.

Ollama / llama.cpp / LM Studio : même API compatible OpenAI, donc

```
GROQ_BASE_URL=http://127.0.0.1:11434/v1
GROQ_MODEL=llama3.1:8b
GROQ_API_KEY=local            # non utilisé, requis par la validation
```

et l'agent devient hors-ligne, sans toucher au code. C'est aussi la réponse à
« mes souvenirs partent chez un tiers ».

Un modèle sans `tools` dans sa réponse (petits modèles locaux) n'est pas une erreur :
`wantsTools=false`, l'agent répond sans capacités. Si c'est inacceptable, le détecter au
démarrage (`/stats`) plutôt que de laisser croire à l'utilisateur que l'agent « oublie ».

## Outils sensibles et approbation

Pour un outil qui écrit ailleurs que dans la base de l'agent (shell, fichier, envoi à un
tiers, achat) :

```ts
export const shellTool: Tool = {
  name: 'run_command',
  description: 'Exécute une commande système. Utiliser uniquement sur demande explicite.',
  parameters: { commande: { type: 'string', required: true, maxLength: 200 } },
  requiresApproval: true,
  dangerous: true,
  run: async (args) => { /* … */ },
};
```

Puis l'ajouter dans `buildRegistry()` **derrière** le portail
`config.dangerousToolsEnabled`. Effet : tant que `.env` ne dit pas `true`, l'outil
n'existe pas pour le modèle — il ne peut ni le nommer, ni être tenté.

Quatre garde-fous à ne pas oublier dans `run` :

1. **allowlist de commandes**, pas de blacklist : une liste noire se contourne par
   `;`, backticks, variable d'environnement, chemin absolu ;
2. refuser les métacaractères (`;|&><$\``) avant même de parser ;
3. `cwd` borné à `config.workspaceRoot`, avec vérification du chemin **réalisé**
   (`realpath`) pour exclure `..` et les liens symboliques ;
4. `timeout` dur + sortie tronquée ; journaliser la commande exacte.

L'approbation est déjà gérée par la boucle : `requiresApproval: true` suffit. Le
clavier de boutons est attaché à la **réponse du tour**, pas au prochain message :
sinon un message de l'arrivant entre les deux déplace le contexte du clic.

## Mémoire et recherche

Ordre d'ajout, du plus utile au plus coûteux :

1. **résumé automatique** : au-delà de N messages de la fenêtre, un appel LLM produit
   un résumé stocké en `memories` ; la fenêtre reste petite, le contexte long.
2. **FTS5** : `CREATE VIRTUAL TABLE memories_fts USING fts5(content, …)` + triggers.
   Le `LIKE` paramétré pondéré par la récence suffit jusqu'à quelques milliers de
   souvenirs ; au-delà il devient linéaire et ignore la morphologie.
3. **plongements (embeddings)** : utile seulement si les reformulations ratent déjà.
   Coût : un modèle d'embedding (local via Ollama, ou Groq n'en fournit pas), une
   colonne `BLOB`, et un index à recalculer si le modèle change. Ne pas commencer ici.
4. **récence comme score** : déjà en place ; à exposer dans `recall` quand la mémoire
   grossit (« les 5 plus proches et récents »).

Un point souvent raté : la mémoire doit rester **cloisonnée par conversation**. Un
index vectoriel global ferait fuiter le souvenir d'un chat privé dans un groupe.

## Audio (livré dans la référence — la recette, plus le projet)

Deux fournisseurs, deux sens, une couche. Ce qui suit a été construit et prouvé sur
OpenGravity ; les écarts entre cette version et la première sont instructifs, ils sont
signalés en fin de section.

**Forme retenue** — `src/audio/` ne connaît ni grammy ni Telegram (règle `layering`),
et le canal garde la connaissance du canal :

```
src/audio/types.ts        AudioError(message, retryable, status) — retryable pilote le basculement
src/audio/transcribe.ts   GroqWhisper · ElevenLabsScribe · TranscriberChain · buildTranscriber
src/audio/synthesize.ts   stripForSpeech · clampForSpeech · ElevenLabsTts · buildSynthesizer
src/audio/policy.ts       shouldSpeak(mode, {hadVoice, userText, hasPending, override})
src/audio/eleven-check.ts checkVoiceAvailability(config) — voix et modèles vérifiés au démarrage
src/channels/telegram/files.ts  isSafeTelegramPath · downloadTelegramFile   ← le seul qui fetch
```

**Sens et format.** Telegram attend de l'**OGG/Opus** pour un vocal :
Le nom de la partie envoyée au fournisseur de transcription doit porter une extension
qu'il accepte (`resolveAudioPart` la déduit du mime déclaré par le canal, puis refuse avant
l'appel si rien ne permet de la déduire) ; `files/voice_file_1`, le nom brut de Telegram,
est refusé par Groq sur ce seul critère.
`output_format=opus_48000_64`, et `sendVoice(chat_id, InputFile(buffer))` — pas de
MP3 (accepté, mais rendu comme fichier, pas comme message vocal). À l'entrée :
`POST /v1/audio/transcriptions` en `multipart/form-data` (Groq Whisper), ou Scribe
(`POST /v1/speech-to-text`, `xi-api-key`). Ne jamais fixer `content-type` à la main sur
un `FormData` : la frontière vient du moteur.

**Enchaînement.** Le secours ne se déclenche que sur une erreur `retryable`
(429/408/5xx) ; une 401 s'arrête là. Un basculement sur erreur de clé masquerait un
compte mal configuré derrière un second fournisseur, et la facture irait grossir
pendant qu'on cherche.

**Politique de prise de parole** (`VOICE_MODE`) : `off` · `mirror` (défaut : on répond
en vocal si on a reçu un vocal ou une demande explicite) · `always` · `on_request`.
Jamais de voix pendant qu'une approbation est en attente ; jamais sur un texte vide
après suppression du balisage ; le texte est **toujours** envoyé aussi, la voix est
additive.

**Budget aux deux bouts** : `MEDIA_MAX_BYTES` (déclaré + réel) à l'entrée,
`TTS_MAX_CHARS` à la sortie — ElevenLabs facture le texte synthétisé, pas la requête.
La coupe se fait sur une fin de phrase ; le caractère d'ellipse se déduit du budget, il
ne s'y ajoute pas.

**La transcription n'est pas un outil du modèle.** Elle a lieu avant la boucle, dans le
canal, et son résultat entre comme un message utilisateur ordinaire. Un outil
`transcribe_audio` permettrait au modèle de déclencher un appel payant de sa propre
initiative et ferait entrer un texte non fiable par un chemin non encadré.

Quatre erreurs de la première version, corrigées depuis : écrire le média dans un
fichier temporaire « nettoyé en `finally` » (remplacé par ne rien écrire) ; demander
le téléchargement avec le `file_path` cru (la forme doit être validée) ; croire que la
taille annoncée borne quelque chose ; envoyer `record_audio` comme action de clavier
(n'existe pas — `upload_voice`). Le plan initial prévoyait aussi 25 Mo de plafond :
c'est la limite Telegram, pas la nôtre, et un plafond de 8 Mo par défaut évite
d'allouer 20 Mo par tour à un bot qui tourne sur un Raspberry Pi.

### Laisser l'utilisateur choisir sa voix (sans jamais lui demander un identifiant)

Une voix se choisit dans le canal, pas dans un `.env` : `ELEVENLABS_VOICE_ID` n'est que le
défaut au démarrage. La forme qui a tenu :

- `audio/voices.ts` expose un **catalogue** (`buildVoiceCatalog`) : `GET /v1/voices`, trois
  formes de réponse tolérées, cache à TTL, un seul appel concurrent, et repli sur le dernier
  bon inventaire en cas de panne — avec une erreur explicite quand l'inventaire ne contient
  **aucune** voix exploitable (un `[]` muet se lit comme un succès).
- le clavier porte l'**identifiant**, pas un index : un index cesse de désigner la même voix
  si la liste se recharge entre l'affichage et l'appui. Le clic est une donnée extérieure :
  l'identifiant est revérifié présent dans le catalogue rechargé **avant** tout usage, sinon
  refus (`show_alert`) sans écriture ni appel.
- **choisir ne synthétise rien.** Un échantillon « pour voir » est un appel payant déclenché
  par de la curiosité ; c'est exactement ce que le budget `TTS_MAX_CHARS` existe à éviter.
  L'utilisateur entend la voix à la réponse suivante.
- l'écriture de la préférence passe par deux accesseurs injectés dans le canal
  (`preference.get/set`) : le canal ignore qu'il y a un SQLite derrière, et un test lui
  donne une Map.
- portées distinctes, assumées : le **mode** de réponse vocale est un réglage de session
  (mémoire seule, revient à `.env` au redémarrage) ; la **voix** est persistée (colonne
  additive `chats.voice_id`, migration `if (version < 2)`). Une identité qui s'évapore à
  chaque arrêt est un bug vécu, pas une simplicité.
- le texte ne montre **jamais** un identifiant brut : des noms, un ✓ sur la voix courante,
  et le reliquat au-delà des 24 boutons rattrapé par une recherche par sous-chaîne
  normalisée (accents et casse ignorés, minimum deux caractères — sinon « r » propose
  trente voix).

## Appel vocal en direct (la page est servie par l'agent)

**D'abord vérifier le canal, ensuite dessiner.** Un bot Telegram ne peut pas passer d'appel :
les types d'appel ont été retirés de l'API Bot en 2022, les appels sont réservés aux comptes
utilisateurs, et le Bot API ne transporte **aucun** média temps réel dans un sens ni dans
l'autre. Un agent qui ignore ça écrit un `startCall` qui n'existe pas, ou « améliore » la
demande en notes vocales (aller simple de 60 s, pas d'interruption possible) — ce qui n'est
pas ce qui a été demandé. La limite s'énonce **avant** le choix technique.

L'équivalent licite, et celui de la référence : une **page servie par l'agent** (`/call`
émet un lien, la page ouvre un websocket avec l'agent, le média ne touche pas Telegram). Coûts
à dire à l'utilisateur, à voix haute : il faut écouter un port, et le rendu dépend du client
(HTTPS ou `localhost` pour `getUserMedia`, fiabilité variable dans une webview de Mini App).

Ce qui est non négociable, sous peine de perdre ce que le reste du projet garantit :

- **un seul cerveau** : l'appel est une commande du même agent. Pas de prompt, d'outils, de
  file ni de mémoire parallèles. Le tour porte son canal (`channel: 'call'` → bloc oral dans
  le prompt système **et** colonne `messages.channel`, migration additive `v3`) : une réponse
  de 400 caractères lue à voix haute n'est pas la même réponse qu'un message écrit.
- **un seul port, déclaré** : le `listen()` vit dans `src/realtime/`, porte la mention
  `LISTEN-EXCEPTION:` avec son motif et ses bornes, est coupé par `REALTIME_ENABLED` (lu
  **avant** `listen()`, `false` par défaut), écoute `127.0.0.1` par défaut, exige la liste
  blanche à la poignée de main, et n'accepte qu'un billet à usage unique (32 octets, TTL,
  transmis dans le **fragment** d'URL, révoqué au handshake). C'est `listening-is-a-decision`
  qui le vérifie ; multiplier les ports multiplierait les surfaces sans multiplier les contrôles.
- **la page embarque tout** : script, styles, AudioWorklet en `blob:`, aucune URL externe, CSP
  `default-src 'none'`, `Permissions-Policy: microphone=(self)` — `call-page-isolated`.
- **la fin de tour reste locale** : VAD à énergie dans l'agent, `commit_strategy` manuel côté
  fournisseur, pré-roll d'environ 200 ms, seuil de barge-in **relevé** pendant que l'agent
  parle (sinon le haut-parleur s'auto-interrompt), et le `partial_transcript` ne décide jamais
  un tour. Une grâce courte, puis repli sur la transcription en blocs pour CE tour : une
  dégradation n'est pas un échec d'appel.
- **le canal sortant est entretenu, pas rouvert** : les fournisseurs de flux coupent
  l'inactivité (Scribe : 20 s), donc un keep-alive sous cette limite (18 s) et **une seule**
  reconnexion ; `abort()` interrompt la synthèse sans fermer la websocket, sinon chaque
  interruption paie une poignée de main TLS (≈ 200 ms) ;
- **remplaçable, pas adossé à un fournisseur** : deux contrats (`LiveListener`,
  `LiveSpeaker`) et une `SocketFactory` injectable ; les tests tournent contre un faux
  serveur local (`src/testing/fake-realtime-providers.ts`), sans clé ni appel payant. C'est
  aussi ce qui rend le test honnête : un double qui lit un champ mal nommé (`audio_base64` au
  lieu de `audio_base_64`) ne rend jamais de texte final, et la panne ressemble alors à s'y
  méprendre à une course de timing.
- **zéro octet audio sur disque** (anneaux en mémoire), clé fournisseur en **en-tête** et non
  en query string, rétention fournisseur coupée (`enable_logging=false`), plafonds de durée,
  d'échanges et de débit (`REALTIME_MAX_MINUTES`, `REALTIME_MAX_TURNS`, `REALTIME_MAX_KBPS`).
- **clôture propre et idempotente** : `sink.close()` **avant** `session.end()`, avis de
  fermeture envoyé **avant** de couper le socket, `terminate()` côté serveur,
  `closeIdle/AllConnections()`, bilan par `chatId` une seule fois. Une écriture HTTP
  silencieuse ne remonte pas dans `close()` : si l'écoute refuse de démarrer, c'est
  `RealtimeUnavailableError` → code `75` (le superviseur relance), jamais un bot qui fait
  semblant d'être vivant.

## Rendre inarrêtable (garde, journal, superviseur, veille)

Cinq gestes, dans cet ordre — l'ordre compte parce que chacun rend le précédent utile.

1. **Journal** — `core/logger.ts` ajoute une destination fichier (`LOG_FILE`), en
   `appendFileSync` (rien à-flusher pendant qu'on meurt), `mkdir` du dossier, rotation à
   4 Mio vers `.1`, droits `600` **réparés à l'ouverture** (un `cp` ou une restauration
   d'instantané ramène du 644), et la mention `DISK-WRITE-OK:` exigée par
   `media-no-residue`. Le sink ne doit jamais devenir mortel : un `catch` qui désactive
   l'écriture, jamais un `throw`.
2. **Garde** — `core/guard.ts` : `unhandledRejection` journalisé et survécu,
   `uncaughtException` journalisé avec la trame puis `onFatal` (fermer la base) puis
   `process.exit(75)`, avec un drapeau anti-ré-entrée pour qu'une exception dans la
   fermeture ne boucle pas. Exposer `dispose()` pour les tests.
3. **Codes** — `index.ts` ne sort plus jamais en `1` : `exitCodeFor(error, e => e instanceof
   ConfigError)` → `78` si la configuration est en cause, `75` sinon. Sans cette
   distinction, un repreneur automatique relance à l'infini un bot dont le token est faux.
4. **Superviseur** — `src/supervise.ts` : boucle `spawn` + `exit`, `delayFor()` exponentiel
   plafonné, remise à zéro du compteur quand l'enfant a tenu plus longtemps que
   `unhealthyRunMs` (sinon un bot qui vit deux semaines avant de tomber repartrait 60 s
   plus tard pour une seule panne), la décision `shouldRestart(code, stoppedByRequest, politique,
   duréeDeVie)` — **jamais** prise sur le signal de l'enfant, qui est justement le signe d'une
   mort brutale, et le quatrième argument compte : un `0` rendu en vingt millisecondes n'est pas
   un arrêt voulu, c'est un enfant qui n'a jamais démarré (voir §18 de `security.md`) — et
   `readLock()` sur `logs/supervisor.pid` avec reprise si le détenteur est mort. `ensureEnvironment()` répare un
   `node_modules` ou un `dist` absents *avant* de lancer : une dépendance manquante n'est pas
   une panne de l'agent, et la traiter comme telle ferait tourner la boucle.
5. **Veille** — le superviseur n'a personne au-dessus de lui, et sa mort est silencieuse. Un
   troisième étage (`scripts/keepalive.sh`) pose une seule question — le verrou
   `logs/supervisor.pid` désigne-t-il un vivant ? — et, avant de répondre par une relance,
   **répare** (dépendances, build) puis **réape** l'agent orphelin qui tiendrait encore le
   port. Lancé par launchd (`KeepAlive`) ou systemd (`Restart=always`) ; les unités prêtes à
   éditer sont dans `deploy/`. Motif de cet étage, mesuré : `node dist/supervise.js` sur un
   build absent meurt en `MODULE_NOT_FOUND` dans la milliseconde, et la boucle relançait
   alors une commande inexistante toutes les 20 s, journal propre à l'appui, sans aucun bot.
   Deux détails de ce troisième étage sont des règles, pas du style : **un arrêt se vérifie, il
   ne se proclame pas** (`stop` attend la mort réelle de la boucle et des enfants, puis ne rend
   `0` que si `pgrep` ne trouve plus rien — dire « arrêté » après un `pkill` envoyé laissait
   l'agent vivant jusqu'à un cycle complet) ; et **une `sleep` ordinaire avale le signal**,
   parce que bash ne court un `trap` qu'entre deux commandes — la sieste se fait donc en
   arrière-plan avec `wait`, seule façon de réagir à `TERM` dans la seconde. Mesuré sur les deux
   formes, même script, même `INTERVAL=30` : 1 s avec `sleep & wait`, 30 s avec `sleep` seule.

Puis `npm run check` **hors pipeline** (un `| tail` masque l'échec), les trois gestes du
tableau de `references/verification.md` §8 sur le processus réel, et cinq mutations pour
prouver que les règles modifiées mordent encore.

## Brancher un compte externe (le gabarit Google Workspace)

Aussi utile pour Gmail/Drive qu'un futur accès GitHub, Notion ou facturation : la meme charpente en
sept gestes, avec le client en dependance epinglee (`@googleworkspace/cli@^0.22.5`) :

1. **contrat d'abord** : un module `transport.ts` qui décrit l'appel (`service`, `argv`,
   `write`, `label`, `maxOutputBytes`) et la liste close des services. Aucun appele ne construit
   d'argv librement.
2. **executeurs** : un fichier par capacite, pas un fichier par service. L'outil valide ses
   arguments, choisit le sous-ordre, et ne connait ni le binaire ni l'environnement.
3. **enveloppe d'echec** : un module qui convertit sortie brute + code en classe nommee, et une
   phrase de reparation par classe. C'est la moitie du travail, et celle qu'on oublie — un agent
   qui ne sait pas nommer « acces refuse » dit « je n'ai pas trouve ».
4. **verrous** : `dangerous: true` + `requiresApproval: true` sur chaque ecriture, plus un drapeau
   de config qui **retire** l'outil du registre quand il est faux (le modele ne doit pas pouvoir
   tenter ce qui est interdit, pas seulement echouer).
5. **isolat de test** : un double executable qui imite l'API reelle (modes erreur, latence, sortie
   enorme) et enregistre ce qu'on lui a demande. Sans lui, on ne peut pas ecrire un test sur
   l'environnement du fils, sur le plafond d'octets, ni sur le kill au timeout.
6. **doctor + chaine reelle** : `xxx:check` maillon par maillon (codes `0/1/78`) et `xxx:live` de
   bout en bout avec memoire jetable. Le premier se branche dans l'install, la seconde prouve ce que
   le faux ne peut pas prouver.
7. **doc de perimetre** : un `docs/<API>.md` qui se termine par la liste « verifie / non verifie ».
   C'est ce chapitre qui rend l'ensemble credible, pas le nombre de tests.

### Ajouter une operation (le geste courant)

```
src/google/tools.ts        + entree : description (QUAND appeler), schema d'arguments, argv
src/google/transport.ts    + service dans la liste blanche si le perimetre s'elargit
src/testing/fake-gws.mjs   + fixture sous la cle = argv exact
src/test/google.test.ts    + 1 test de construction, + 1 test de refus classe
docs/GOOGLE.md             + la ligne du tableau des outils
```

Un invariant du verificator (`dangerous-requires-approval`) empeche d'enregistrer une ecriture sans
clic ; `contract-fields-read` empeche d'inventer un champ d'interface que le canal ne lit pas.

### Ce qu'il ne faut pas faire

- exposer le client sous la forme d'un outil `*_request` (n'importe qui, y compris une injection
  lue dans un mail, s'en sert comme d'un shell) ;
- laisser `GOOGLE_*` / `AWS_*` / `AZURE_*` passer en bloc a un fils — un prefixe est une
  autorisation, pas un filtre ;
- considerer qu'un `exit 0` est un succes, ni qu'une reponse « code 0 » est une reponse saine ;
- rejouer une ecriture, ou rejouer un timeout ;
- retirer les outils parce qu'aucun compte n'est connecte : la reparation devient invisible, et
  `login` exigerait un redemarrage de l'agent.

## Passer au cloud

**Premier choix : un conteneur, un service.** Cloud Run (ou Fly.io, Render) avec une
instance, et Telegram en webhook :

```ts
// src/channels/telegram/webhook.ts
export const handler = webhookCallback(bot, 'std/http', { secretToken });
```

grammY gère la vérification du `secret_token` — **obligatoire** : sans lui, n'importe
qui peut poster un `/updateUpdate` et forger un `from.id`, ce qui annule la liste
blanche. C'est le point sensible de toute migration webhook.

**Deuxième choix : Firebase** (si l'écosystème y est déjà).
`functions.https.onRequest` + le même callback ; `Store` réécrit sur Firestore ;
Cloud Scheduler pour les rappels ; Secret Manager pour les clés. Trois conséquences à
accepter :

- `Store` passe en asynchrone (les méthodes `better-sqlite3` sont synchrones) : d'où
  l'intérêt d'en faire une interface **avant** de partir, pas pendant ;
- pas d'état en mémoire : `setTimeout` (rappels), `Map` de la file par conversation et
  seau de jetons doivent devenir externes (verrou Firestore/Redis), sinon deux
  instances répondent en double et le rate-limit ne protège plus ;
- une function qui tourne 60 s pendant que l'agent fait 5 itérations, c'est normal ;
  prévoir l'idempotence par `update_id` déjà stockée dans le schéma.

Le test qui dit si l'architecture a tenu : `git grep -l grammy src/core src/tools
src/memory src/security` doit rester vide.

## Dettes à solder avant le multi-instance

| Dette | Effet si on l'ignore |
|---|---|
| file par conversation en mémoire | deux instances répondent dans le désordre, ou se répondent l'une à l'autre |
| rate-limit en mémoire | le quota est N fois plus élevé que voulu, par N instances |
| `setTimeout` pour les rappels | un redémarrage les perd tous |
| SQLite en WAL sur un volume partagé | verrous et corruptions ; une base locale ou un vrai SGBD |
| `.env` dans l'image | secret publié ; passer par le gestionnaire de secrets |
