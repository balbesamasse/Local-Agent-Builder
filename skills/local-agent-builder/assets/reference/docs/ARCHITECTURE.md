# Architecture d'OpenGravity

## Principes

1. **Zéro surface d'écoute.** Pas de serveur web, pas de port ouvert : le bot sort
   vers Telegram en long polling (`grammy` → `getUpdates`). Éteindre la machine
   coupe tout ; il n'y a rien à exposer, rien à patcher en périphérie.
2. **Le noyau ignore Telegram.** `src/core/` ne connaît ni grammY, ni les types
   d'update. Un canal est un adaptateur : ajouter un webhook, un CLI ou un pont
   Firebase ne touche pas la boucle de raisonnement.
3. **Les capacités sont une liste close.** Un outil s'enregistre dans
   `buildRegistry()`. Il n'existe aucun mécanisme de découverte, d'import
   dynamique ou d'exécution de code fourni par le modèle.
4. **Validé avant d'être exécuté.** Les arguments viennent du LLM donc d'une
   entrée non fiable : schéma dérivé, types, bornes, champs inconnus refusés.
5. **Sortie bornée et encadrée.** Toute donnée renvoyée par un outil est tronquée
   puis placée dans un cadre `<BEGIN_TOOL_OUTPUT_*…END_*>` dont le modèle sait
   qu'il contient des données, pas des ordres.

## Flux d'un message

```
Telegram (update)
   │
   ▼
allowlist ──── ID absent de TELEGRAM_ALLOWED_USER_IDS ──→ refus générique + log
   │                                                       (le LLM n'est pas appelé)
   ▼
rate-limit ─── rafale dépassée ─────────────────────────→ « ⏳ Trop de requêtes »
   │
   ▼
commande (/memory, /forget, /stats…) ── oui ──→ réponse directe, pas de LLM
   │ non
   ▼
runAgent (src/core/agent.ts)
   │  1. sanitizeText(text)                ← contrôle, taille
   │  2. store.addMessage(user)             ← fenêtre glissante rechargée
   │  3. searchMemories(mots-clés)          ← injecté en bloc <BEGIN_MEMORY>
   │  4. prompt système (nom, fuseau, liste d'outils réels)
   │  5. boucle, i = 1..AGENT_MAX_ITERATIONS
   │        LlmChain.complete(messages, tools)
   │        ├─ tool_calls → ToolRegistry.executeToolCall
   │        │                 ├─ nom inconnu ─────────→ refusé
   │        │                 ├─ args invalides ──────→ message d'erreur au modèle
   │        │                 ├─ requiresApproval ────→ ApprovalGate (boutons Telegram)
   │        │                 └─ ok ──────────────────→ JSON tronqué + encadré
   │        └─ texte final → break
   │     à AGENT_FORCE_FINAL_ITERATION : la liste d'outils est vidée,
   │     une instruction de clôture est injectée → la boucle est finie.
   │  6. store.addMessage(assistant) + pruneMessages
   ▼
sendMessage (HTML échappé, découpé à ~3800 car., balises rééquilibrées)
```

## Responsabilités par dossier

| Dossier | Rôle | Dépend de |
|---|---|---|
| `src/config.ts` | lit et **valide** tout `process.env`, masque les secrets | dotenv |
| `src/core/` | prompt système, boucle d'agent, types partagés, logger | memory, llm, tools, security |
| `src/llm/` | client compatible OpenAI + enchaînement Groq → secours + sonde d'inventaire des modèles au démarrage | fetch natif |
| `src/audio/` | transcription (Groq → ElevenLabs), synthèse (ElevenLabs), politique de prise de parole | fetch natif, `FormData` |
| `src/media/` | *(aucun fichier)* — les octets audio ne touchent jamais le disque | — |
| `src/tools/` | registre, validation d'arguments, outils, calculatrice | memory (via ctx) |
| `src/memory/` | schéma SQLite + Store (messages, souvenirs, audit, approbations) | better-sqlite3 |
| `src/security/` | liste blanche, rate-limit, assainissement, approbations | config |
| `src/channels/telegram/` | adaptateur grammy : commandes, rendu HTML, boutons | core |
| `src/testing/` | fabriques pour tests, exclus du build de production | — |

## Points d'extension

**Un nouvel outil** → `src/tools/builtin/mon-outil.ts`, puis l'ajouter dans
`coreTools()`. Rien d'autre : description, schéma JSON et validation sont dérivés
du même objet, et `/tools` le montre aussitôt.

**Un nouveau canal** → `src/channels/mon-canal/bot.ts` qui appelle `runAgent(...)`.
Le harnais `AgentDeps` (config, store, llm, registry, gate) est construit dans
`src/index.ts` : il est réutilisable tel quel par un webhook, une Cloud Function
ou une boucle CLI.

**Un nouveau fournisseur de LLM** → une classe avec `complete(request, signal)`
(voir `OpenAiCompatProvider`) et l'ajouter dans `buildProviders()`. Un modèle
local (Ollama, llama.cpp) expose la même API compatible OpenAI : il suffit d'un
`baseUrl` et de la clé vide.

**Une base ailleurs que SQLite** → seul `src/memory/store.ts` touche au SQL. Les
fonctions de l'agent consomnent `Store` ; une implé Firestore remplace la classe,
pas l'appelant. Voir `docs/ROADMAP.md`.

## Pourquoi better-sqlite3 et non un ORM

Le volume est personnel (un utilisateur, quelques milliers de lignes). Le driver
synchrone retire toute la classe de bugs d'asynchronisme dans la boucle d'agent,
les requêtes préparées éliminent l'injection SQL par construction, et le fichier
unique se sauvegarde avec `cp`. Un ORM ajouterait ~2 Mo de dépendances et une
couche d'abstraction qui masque exactement les requêtes qu'on veut relire.

## Choix de sécurité structurants

- `user_version` dans SQLite : migration additive, aucune destruction silencieuse.
- `additionalProperties: false` sur tous les schémas d'outils.
- Invariant « `dangerous: true` impose `requiresApproval: true` » vérifié dans le
  **constructeur** du registre : il ne peut être contourné par un futur appelant.
- Jetons d'approbation en mémoire seule (empreinte SHA-256 en base) : un
  redémarrage invalide les demandes, jamais l'inverse.
- Aucun `eval`, aucune `child_process`, aucun `new Function` dans tout le projet
  (la calculatrice est un parseur récursif, `src/tools/calculator.ts`).
