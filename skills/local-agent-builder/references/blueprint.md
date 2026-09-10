# Plan de construction

Sommaire : [couches](#couches) · [format d'un outil](#format-dun-outil) ·
[mémoire](#mémoire-sqlite) · [score de recherche](#recherche-de-mémoire--le-score-doit-être-un-nombre) ·
[boucle](#boucle-dagent) · [config](#surface-de-configuration) ·
[sonde de modèles](#sonde-de-modèles-llmmodel-checkts) · [canal](#canal) ·
[prompt système](#prompt-système)

## Couches

```
src/
├── index.ts                  # câblage : config → store → llm → registry → gate → canal
├── supervise.ts              # relance l'enfant : backoff, verrou d'instance, codes 0/75/78
├── config.ts                 # lit et valide process.env (seul avec le bootstrap du superviseur)
├── core/
│   ├── types.ts              # types partagés, sans import du canal
│   ├── agent.ts              # boucle bornée : LLM → outils → LLM → réponse
│   ├── prompts.ts            # prompt système + encadrement des données non fiables
│   ├── guard.ts              # pièges unhandledRejection / uncaughtException, code de sortie
│   └── logger.ts             # journal + scrubbing, fichier en 600 avec rotation
├── llm/
│   ├── openai-compat.ts      # client fetch : timeout, retries, parse des tool_calls
│   └── providers.ts          # chaîne principal → secours, politique de bascule
├── audio/
│   ├── types.ts              # AudioError (retryable, statut), contrats minces
│   ├── transcribe.ts         # STT en chaîne ; `resolveAudioPart` garantit l'extension
│   ├── synthesize.ts         # TTS ; la voix peut être fournie par tour (choix /voice)
│   ├── voices.ts             # inventaire des voix du compte : cache, tri, zéro appel payant
│   ├── policy.ts             # doit-on parler ? (décision pure, jamais d'appel ici)
│   └── eleven-check.ts       # sonde de démarrage : voix et modèles sur CE compte
├── realtime/                 # appel vocal en direct — SEUL morceau qui écoute un port
│   ├── protocol.ts           # constantes, cadres, contrats (LiveListener/LiveSpeaker/SpeechSink)
│   ├── vad.ts                # début/fin de parole à énergie ; décide la fin de tour, localement
│   ├── listener.ts           # l'oreille : temps réel, repli blocs si le fournisseur hoquette
│   ├── elevenlabs-stt.ts     # un dialecte de fournisseur, un seul fichier
│   ├── elevenlabs-tts.ts     # la bouche, même discipline (abort() ne ferme pas le canal)
│   ├── session.ts            # machine à états, file sérielle, barge-in, bilan de clôture
│   ├── hub.ts                # écoute + billets + HTTP durci ; porte la mention LISTEN-EXCEPTION:
│   ├── page.ts               # la page d'appel, autonome (aucune ressource externe)
│   └── wire.ts               # assemble le bundle depuis la config ; ne décide jamais d'écouter
├── tools/
│   ├── registry.ts           # liste close + invariants d'enregistrement
│   ├── args.ts               # spec → validation ET → JSON Schema (une seule source)
│   ├── calculator.ts         # exemple : parseur fermé à la place de eval()
│   └── builtin/*.ts          # un fichier par capacité
├── memory/
│   ├── schema.ts             # DDL + SCHEMA_VERSION (migration additive ; v2 = chats.voice_id, v3 = messages.channel)
│   └── store.ts              # SEUL fichier qui touche au SQL
├── security/
│   ├── allowlist.ts          # décision pure, sans dépendance au canal
│   ├── rate-limit.ts         # seau de jetons par utilisateur
│   ├── sanitizer.ts          # nettoyage entrée, échappement, cadre asUntrusted
│   └── approvals.ts          # actions sensibles → clic humain, jeton à usage unique
├── channels/<canal>/         # adaptateur : bot.ts (transport), format.ts (rendu)
├── testing/fixtures.ts       # fabriques pour tests (exclues du build)
├── testing/fake-realtime-providers.ts   # faux STT + faux TTS : l'appel se teste sans clé
└── test/*.test.ts            # unitaires + intégration

src/, c'est tout ce qui compile. Le reste du dépôt est opérationnel, et il est là pour que
l'agent survive à autre chose qu'un bug de son code :

```
racine du projet/
├── scripts/keepalive.sh      # 3e étage : veille du superviseur (verrou, RÉPARATION, relance, réapage)
├── deploy/launchd/*.plist    # KeepAlive macOS (aucune clé dans le fichier)
├── deploy/systemd/*.service  # Restart=always Linux, NoNewPrivileges + ProtectSystem
└── docs/                   # ARCHITECTURE · ROADMAP · SECURITY · TOOL-DEVELOPMENT · REALTIME
```

Règle d'or des imports : une flèche `A → B` signifie « A peut importer B ».

```
channels → core → { tools, memory, llm, security }
tools   → memory, security          (jamais llm, jamais channels)
security → config                    (décide, ne parle à personne)
llm      → (rien de local, sauf types)
```

Le vérificateur (`check_invariants.py`, règle `layering`) échoue si quelqu'un
enfreint ce graphe. C'est cette règle qui a attrapé, sur l'implémentation de
référence, un `import { type MiddlewareFn } from 'grammy'` dans
`security/allowlist.ts` — le module de décision dépendait du transport, ce qui
rendait impossible de le rejouer pour un webhook ou un CLI. Correctif : la
décision devient une fonction pure `authorize(config, { userId, hasChat })` et
l'adaptation grammY vit dans `channels/telegram/bot.ts`.

## Format d'un outil

Un outil est un objet, pas un module découvert. La description est le **seul**
élément que le modèle lit pour décider d'appeler ou non.

```ts
import type { Tool } from '../registry.js';
import type { ToolContext, ToolResult } from '../../core/types.js';

export const myTool: Tool = {
  name: 'mon_outil',                                  // [a-z][a-z0-9_]{0,63}
  description: 'QUAND l’utiliser. QUOI il renvoie. Une à deux phrases.',
  parameters: {
    cible: { type: 'string', required: true, maxLength: 80, description: '…' },
    nombre: { type: 'integer', min: 1, max: 50 },
  },
  maxOutputChars: 800,                 // défaut 1200 ; la sortie va au contexte LLM
  requiresApproval: false,             // true = clic humain obligatoire
  dangerous: false,                    // true = masqué tant que le portail est fermé
  run(args, ctx): ToolResult {
    // ctx : { chatId, userId, config, store, requestApproval }
    //   → chatId/userId viennent du TRANSPORT, jamais du LLM : s'en servir pour
    //     cloisonner toute lecture ou écriture.
    return { status: 'ok', content: 'résultat court' };
  },
};
```

Le `status` conditionne la suite : `ok` (injecté), `invalid_args` (le modèle se
corrige), `denied` (refus assumé, visible de l'utilisateur), `error` (panne :
l'agent continue). Ne jamais jeter une exception pour un cas prévu.

Le schéma envoyé au fournisseur est **dérivé** du même `parameters`
(`toJsonSchema`) : déclarer un champ que la validation refuserait est donc
structurellement impossible. `additionalProperties: false` est posé par le
générateur, pas par l'auteur de l'outil.

Pour enregistrer : l'ajouter dans `coreTools()` (ou la liste de l'agent). Rien d'autre.

## Mémoire (SQLite)

Quatre tables, `user_version` pour les migrations :

| Table | Rôle | Points non négociables |
|---|---|---|
| `messages` | historique de la conversation | fenêtre glissante à la lecture (`recentMessages`) ; les messages `role='tool'` ne sont **jamais** rejoués au modèle |
| `memories` | souvenirs longue durée, recherchables | `chat_id` dans le WHERE de **toute** requête ; plafond `maxMemoryItems` appliqué à l'écriture ; empreinte du texte pour refuser le doublon |
| `pending_approvals` | actions en attente de clic | uniquement `status='pending' AND expires_at > now` ; empreinte SHA-256 du jeton, effacée à la consommation |
| `tool_calls` | journal d'audit | arguments, statut, durée ; sortie tronquée à 2000 car. |

Requêtes préparées partout, jamais de concaténation de texte utilisateur dans le SQL.
La recherche par mots-clés est un `LIKE` paramétré pondéré par la récence : suffisant
pour un usage personnel, et FTS5 est la suite naturelle si la mémoire grossit.

Le store est la **seule** interface vers la persistance. Pour passer sur Firestore, on
écrit une seconde implémentation de ces méthodes ; `core/agent.ts` ne change pas (ses
appels sont déjà `await`).

## Recherche de mémoire : le score doit être un nombre

Le projet modèle additionne occurrences de mots-clés et bonus de récence. Piège rencontré :
`julianday(updated_at/1000.0)` renvoie `NULL` sur un epoch en millisecondes, `NULL` se
propage à tout le score, et comme toutes les lignes se retrouvent à `NULL`, `ORDER BY score
DESC` ne départage plus rien — le tri retombe sur le critère de secours, la récence. La
recherche continue de renvoyer « les bonnes lignes », jamais dans le bon ordre : le test qui
vérifie la sélection passe, et la pertinence est morte.

Écrire `strftime('%s','now') * 1000` (mêmes unités que la colonne) et tester par **ordre
attendu**, avec un cas où le comportement faux donnerait l'ordre inverse.

## Boucle d'agent

Le cœur tient en trente lignes ; chaque branche est une décision de sécurité.

```
 sanitizerText(entree) → stocker le message user → charger fenêtre d'historique
 → charger les souvenirs pertinents (uniquement si la question semble personnelle)
 pour i = 1 .. maxIterations :
     outils = (i >= forceFinalIteration) ? [] : registre.definitions()
     réponse = llm.complete(messages, outils)
     si réponse.texte et pas de tool_calls : casser
     sinon :
        rejouer le tour assistant (tool_calls) au format du fournisseur
        pour chaque appel (max 4) :
            nom inconnu            → refus + message d'erreur au modèle
            args invalides         → idem (le modèle se corrige tout seul)
            requiresApproval       → créer un ticket, N'EXÉCUTE PAS, et somme le
                                     modèle de ne pas affirmer l'action faite
            sinon                  → exécuter, tronquer, encadrer, injecter
 échec LLM → phrase générique à l'utilisateur, détail dans le journal local
 stocker la réponse finale, borner l'historique
```

Trois protections qui ont chacune une raison d'être mesurée :

1. **`maxIterations`** — sans lui, un modèle obstiné appelle le fournisseur sans fin
   (coût + blocage). Avec un timeout dur, il ne reste qu'une réponse partielle.
2. **Retrait des outils à `forceFinalIteration`** — la borne seule produit un
   « j'ai dépassé mes itérations » inutilisable ; vider la liste d'outils *force* une
   conclusion exploitable. Cette instruction de clôture arrive comme message utilisateur
   encadré, pas comme message `system` : certains fournisseurs rejettent un `system` en
   milieu de conversation.
3. **Déduplication par `(nom, arguments)`** — un modèle en boucle rejoue le même appel ;
   chaque `tool_call_id` reçoit tout de même une réponse (le protocole OpenAI l'exige),
   mais l'effet de bord ne se produit qu'une fois.

## Surface de configuration

Tout est déclaré dans une interface unique, validé au démarrage, jamais relu plus tard.

```
Telegram   : token, allowedUserIds (vide = refus de démarrer), idCommandEnabled, apiRoot
LLM        : clés, modèle principal, modèle de secours, base URL (proxy/local), timeout,
             retries, validation d'inventaire au démarrage (LLM_VALIDATE_MODELS)
Agent      : maxIterations, forceFinalIteration, historyLimit, maxMessageChars, systemTimezone
Google     : GOOGLE_ENABLED, GWS_BIN, GWS_SERVICES, GWS_ALLOW_WRITES, GWS_TIMEOUT_MS,
             GWS_MAX_OUTPUT_BYTES, GWS_MAX_IN_FLIGHT, GWS_READ_ATTEMPTS, GWS_CREDENTIALS_FILE,
             GWS_KEYRING_BACKEND, GWS_PROJECT_ID (11 cles, 12 valeurs par defaut dont deux
             only-dangereuses : allowWrites et readAttempts > 1)
Mémoire    : dbPath, maxMemoryItems
Sécurité   : rateLimit (burst, perMinute), approvalTtlMinutes, workspaceRoot, dangerousToolsEnabled
```

Validation précoce et bavarde : le projet modèle refuse de démarrer si la liste
blanche est vide, si le token n'a pas le format `^\d{6,12}:[A-Za-z0-9_-]{30,}$`, si le
fuseau n'est pas un identifiant IANA, ou si aucune clé LLM n'est présente. Un message du
type `TELEGRAM_ALLOWED_USER_IDS est vide : par sécurité l'agent refuse de démarrer` vaut
mieux qu'un agent qui tourne ouvert. Ne jamais « réparer » une config invalide en
silence, et ne pas masquer un 400 fournisseur derrière un secours : une erreur de
requête doit remonter telle quelle.

Deux bornes supplémentaires, nées de dérives réelles, sont tenues par le vérificateur :
`.env.example` promet exactement ce que la config lit (une clé fantôme ou une clé oubliée
est une violation, sauf mention `non câblée`), et un modèle épinglé par défaut suppose une
sonde d'inventaire branchée sur le démarrage.

## Branche Google Workspace (`src/google/`)

Nouveauté v1.8 : l'agent peut lire et, sur clic, écrire dans le compte de l'utilisateur. Neuf
fichiers, une responsabilité chacun — et l'absence de tout outil « requête Google libre » :

| Fichier | Rôle | Ce qui l'empêche de dériver |
|---|---|---|
| `transport.ts` | le contrat (`GoogleCall`, `GoogleTransport`) et `GOOGLE_SERVICES` | un service hors liste n'a ni outil ni argv possible |
| `gws-cli-transport.ts` | un processus fils par appel : argv tableau, env filtré, plafond d'octes, sémaphore, timeout SIGTERM→SIGKILL | marqueurs `exec-transport` / `env-enfant`, contrôlés dans le code |
| `envelope.ts` | code de sortie → JSON → scan de texte ; classes d'erreur ; `explainFailure` | un `exit 0` ne vaut jamais preuve de succès ; timeout non rejoué |
| `tools.ts` | 12 outils typés (7 lectures, 5 écritures `dangerous` + `requiresApproval`) | le registre refuse un `dangerous` sans approbation |
| `auth.ts` | état du compte lu par le même transport, formaté pour `/google` | les diagnostics nomment la commande qui répare |
| `format.ts` | extraits bornés et lisibles (mail, fichier, doc, feuille, agenda) | truncate avec mention, jamais un corps entier |
| `redact.ts` | motifs secret-before-log | la liste à masquer vient de `.env`, pas d'un mot de passe connu |
| `secrets.ts` | contrôle de forme de l'env du fils au démarrage | une clé étrangère = transport fermé, pas un avertissement |
| `index.ts` | câblage : ce qui est déclaré, ce qui est averti | le binaire conditionne la déclaration, l'état du compte ne la conditionne pas |

`src/testing/` ajoute le doctor (`google-check.ts`), la chaîne réelle (`live-chain.ts`) et le double
(`fake-gws.mjs`, dix modes). Le périmètre se règle dans `GWS_SERVICES` ; `auth` y est ajouté
d'office parce que `/google` en a besoin pour expliquer.

Ce que la branche ne fait **pas** : stocker un mot de passe, accepter un argv du modèle, écrire
sans trois verrous (`GWS_ALLOW_WRITES` + `DANGEROUS_TOOLS_ENABLED` + clic), poser un fichier sur
disque, ni promettre un service absent de `GWS_SERVICES`.

## Sonde de modèles (`llm/model-check.ts`)

Un fichier, une question : « le modèle annoncé par la config existe-t-il chez ce
fournisseur ? ». Une requête au démarrage, quatre issues :

| Issue | Comportement | Pourquoi |
|---|---|---|
| modèle présent | log `modèles vérifiés` | rien de plus |
| modèle absent du catalogue | **échec fatal**, message listant les identifiants les plus proches | l'erreur doit tuer le démarrage, pas la première conversation |
| fournisseur injoignable | **avertissement** et démarrage | un agent doit pouvoir vivre hors ligne (dev, réseau capricieux) |
| clé refusée (401/403) | **échec fatal** | inutile d'ouvrir un canal sur une identité invalide |

Deux détails qui ont coûté une itération chacun : la sonde doit interroger **la même** base
que le client (les deux lisent `GROQ_BASE_URL`/`OPENROUTER_BASE_URL`, d'où les constantes
exportées par `providers.ts`) ; et les alias de routage (`openrouter/*`) n'apparaissent pas
tous dans `/models` — `openrouter/alpha` en est absent tout en étant valide — donc une
absence chez ce fournisseur ne peut être qu'un avertissement. Le message ne contient que
des identifiants de modèles : ni clé, ni corps de réponse.

## Canal

Un adaptateur de canal fait quatre choses, et rien de plus : authentifier (via
`security/allowlist.ts`), limiter, traduire le format de sortie, sérialiser par
conversation.

```ts
const decision = authorize(config, { userId: ctx.from?.id, hasChat: chatId !== null });
if (!decision.allow) { if (decision.reply) await ctx.reply(decision.reply); return; }
await next();
```

Le rendu doit être **sûr par construction**, pas par confiance : échapper
intéralement la sortie du modèle (y compris les guillemets — un `"` non échappé suffit
à casser un attribut `href`), puis ne réautoriser qu'une liste courte de balises, en
traitant les paires ouvrante/fermante ensemble pour qu'une balise orpheline injectée
reste du texte. La découpe à 4096 caractères doit refermer les balises ouvertes avant
la coupe et les rouvrir après, sinon l'API renvoie une erreur de parsing HTML.

La file par conversation (`Map<chatId, Promise>`) évite que deux messages arrivant
ensemble se répondent l'un à l'autre. C'est en mémoire : à remplacer par un verrou
partagé avant toute mise à l'échelle multi-instance.

## Prompt système

Quatre blocs, dans cet ordre : identité et fuseau ; outils **réellement** déclarés
(liste générée depuis le registre, pas une phrase figée — une description qui promet
un outil absent fait halluciner des appels) ; consignes de sécurité (données ≠
instructions, jamais de secret, approbation) ; format de sortie du canal.

## Séparer « le fournisseur répond » de « le canal répond »

`src/testing/live-voice-check.ts` (exclu du build, typecheck inclus) synthétise une
phrase et, sauf `--mute`, l'envoie dans le chat autorisé. Valeur pédagogique : le bot
ne peut dire qu'une seule chose quand le vocal manque, alors que deux pannes distinctes
sont possibles (clé/modèle chez le fournisseur, ou token/chat id chez le canal). Un
script à deux modes les sépare en dix secondes, et il appelle les modules livrés — pas
une réécriture de complaisance, qui ne prouverait rien sur le produit.

Le même raisonnement s'applique à tout bord externe : une sonde de démarrage par
fournisseur (`model-check`, `eleven-check`) pour ce qui est *configuré*, un smoke test
manuel pour ce qui est *vivant*.
