# Google Workspace dans OpenGravity

L'agent lit votre Gmail, vos Docs, vos Sheets, votre Drive et votre calendrier. Il peut
écrire, mais seulement après un clic de vous. Ce document tient les trois choses qui comptent :
ce qui est promis, comment un refus se lit, et ce qui a été **vérifié** — y compris ce qui ne l'a
pas été.

## La règle qui structure tout le reste

**Le modèle ne nomme que des opérations enregistrées et typées.** Il n'existe aucun outil
`google_request`, ni « exécute cette commande gws », ni « passe cet argv ». Chaque capacité est un
outil du registre, avec son propre schéma d'arguments validés, et le transport ne sait construire
qu'une forme d'appel par outil.

Trois conséquences, voulues :

- une capacité nouvelle s'écrit, elle ne se configure pas : outil + fixture du double + test ;
- une injection de prompt qui lirait « envoie ce mail à X » ne peut pas devenir un argv, seulement
  un appel à `gmail_send` — qui n'existe que si les trois verrous sont ouverts, et qui meurt dans
  une demande d'approbation ;
- ce que l'agent sait faire de Google se lit dans une liste de onze lignes, pas dans une
  surface de commande sans fond.

## Ce qui est exposé

| Outil | Service | Écriture | Arguments |
|---|---|---|---|
| `gmail_search` | Gmail | non | `query`, `maxResults` |
| `gmail_read` | Gmail | non | `id` |
| `gmail_send` | Gmail | **oui** | `to`, `subject`, `body` |
| `drive_search` | Drive | non | `query`, `maxResults` |
| `drive_read_text` | Drive | non | `fileId` |
| `drive_delete` | Drive | **oui** | `fileId` |
| `docs_read` | Docs | non | `documentId` |
| `docs_append` | Docs | **oui** | `documentId`, `text` |
| `sheets_read` | Sheets | non | `spreadsheetId`, `range` |
| `sheets_append` | Sheets | **oui** | `spreadsheetId`, `range`, `values` |
| `calendar_next` | Agenda | non | `maxResults`, `days` |
| `calendar_create` | Agenda | **oui** | `summary`, `start`, `end` |

Un service non listé dans `GWS_SERVICES` n'est pas « désactivé », il est **absent** : ses outils ne
sont pas enregistrés, et `GWS_SERVICES` refuse un nom inconnu au démarrage (`ConfigError`, code 78)
plutôt que de l'ignorer. Les outils marqués *oui* n'existent que sous `GWS_ALLOW_WRITES=true` **et**
`DANGEROUS_TOOLS_ENABLED=true`, et chaque appel passe par un clic Telegram.

## Trajet d'un appel

```
modèle → registry (schéma, arguments inconnus refusés)
       → outil : vérifie le service autorisé, construit argv (tableau, jamais une ligne)
       → transport : sémaphore (GWS_MAX_IN_FLIGHT), spawn gws { shell: false, env filtré,
                     plafond d'octes, SIGTERM→SIGKILL du groupe au timeout }
       → enveloppe : code de sortie → JSON → scan de texte
       → extrait borné → modèle
       → refus ? → userNotice → message Telegram séparé (jamais lu à voix haute)
```

L'enveloppe est le morceau délicat, et elle a une raison d'être aussi détaillée : `gws` ne répond
pas de la même façon selon la source de l'erreur. Un appel REST renvoie
`{"error":{"code":401,…}}` avec un code de sortie 1 ; un helper renvoie un objet dont le message
contient du JSON **échappé**, parfois avec le code 0. Ordre retenu : code de sortie, puis enveloppe,
puis scan de texte. Un `exit 0` ne prouve jamais une réponse saine — `gws auth status` sur un compte
`none` sort 0 avec un refus dedans.

Les classes d'échec nommées : `auth`, `accessNotConfigured`, `projectNotLinked`, `rate_limit`,
`dailyLimitExceeded`/`quotaExceeded`, `notFound`, `forbidden`, `timeout`, `transport`,
`credentialsMissing`, `unparseable`. Chacune porte une phrase de réparation ; `explainFailure`
conserve la cause spécifique (un timeout n'est pas un refus d'accès, et l'utilisateur n'a pas à
deviner lequel des deux).

## Secrets

`.env` est chargé dans `process.env` par l'agent. Un fils hériterait donc de `TELEGRAM_BOT_TOKEN`
et des clés de fournisseurs — et un outil qui imprime une erreur de transport imprime ce qu'on lui a
donné. Le fils ne reçoit donc que `PATH`, `HOME`, le fuseau, et les variables `GOOGLE_*` / `GWS_*`
que **ce** projet lui destine : `GOOGLE_WORKSPACE_*`, `GWS_*`.

Un préfixe d'environnement est une autorisation, pas un filtre de confort : transmettre `GOOGLE_*`
en bloc faisait passer `GOOGLE_APPLICATION_CREDENTIALS`, dont la seule présence invalide
l'authentification du CLI (il cherche un compte de service qui n'existe pas, et échoue avant de
regarder ses propres credentials). Ce projet ne définit donc pas cette variable ; le transport
signale un pointeur mort (`staleAdcPointer`) au démarrage, dans `/google`, et dans `google:check`.

Au démarrage, `assertNoForeignSecretsFor` compare l'environnement réellement destiné au fils avec
celui du père : une clé de fournisseur qui s'y promènerait est une faute de câblage, elle est criée,
et le transport se ferme au lieu d'émettre des appels.

Rien n'est écrit sur disque : pas d'`--output` Drive, pas de fichier temporaire, les réponses sont
bornées à `GWS_MAX_OUTPUT_BYTES` et tronquées avec mention de la troncature. Les journaux ne
contiennent ni secret ni corps de message — `redact.ts` s'y applique avant `log`, et la liste des
valeurs à masquer est enregistrée depuis `.env`.

## Authentification

```
npm run google:setup    # crée le client OAuth (console.google.com autrement, à la main)
npm run google:login    # consentement dans VOTRE navigateur, services de GWS_SERVICES
npm run google:status   # ce que l'agent voit, sans contenu
npm run google:revoke   # retire l'accord
```

Le flux `gws auth login` n'a ni mode `--no-browser` ni flux device : **l'étape de consentement se
fait dans un navigateur, et c'est le vôtre.** C'est le seul maillon que l'agent ne peut pas faire à
votre place ; `google:live` et `google:check` le disent au lieu de le contourner.

Scopes attendus par service : `gmail.readonly` (+`gmail.send` en écriture), `drive.readonly`
(+`drive.file`), `documents.readonly` (+`documents`), `spreadsheets.readonly` (+`spreadsheets`),
`calendar.readonly` (+`calendar.events`). Un compte non vérifié refuse le préréglage complet : on
requeste les services listés, pas tout. `gws auth status` ne liste pas les scopes — d'où
`google:check`, qui lit l'état et les compte.

Sur une machine sans trousseau système : `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file`, la clé de
chiffrement atterrit dans `~/.config/gws/.encryption_key`, à protéger en 600.

## Réessai : quand on rejoue, et pourquoi rarement

- `rate_limit` en **lecture** seulement, une fois, après temporisation (`GWS_READ_ATTEMPTS`, 3 max) ;
- `discovery` (schéma non encore en cache) ;
- **jamais** une écriture : sur une déconnexion on ignore si Google a appliqué la modification, et
  rejouer un `+send` enverrait deux mails ;
- **jamais un timeout** : le budget déjà consommé est exactement celui qu'on repayerait. Un agent qui
  dit « la lecture a dépassé `GWS_TIMEOUT_MS`, voici ce que j'ai pu savoir » vaut mieux qu'un agent
  qui insiste et double la latence de la conversation.

## Une capacité déclarée n'est pas une capacité prête

Les outils Google sont déclarés dès que le **binaire** répond. L'état du compte est vérifié à l'usage
et annoncé : warning au démarrage, réponse d'outil nommée (`npm run google:login`), ligne dans
`/google`.

Retirer les outils faute de compte connecté semble plus sûr et casse trois choses : le modèle ne peut
plus même essayer, donc le refus ne s'affiche jamais ; la réparation devient invisible ; et
`google:login` obligerait à redémarrer l'agent. Un refus expliqué est un résultat.

## `npm run google:check`

Le doctor, maillon par maillon, contre le binaire réel. Il n'imprime **aucun contenu** : des comptes,
des formes, des commandes.

1. binaire résolu et version (`node_modules/.bin/gws` avant le PATH) ;
2. absence de pointeur ADC mort ;
3. `auth status` : méthode, compte, magasin, trousseau ;
4. client OAuth présent ;
5. scopes attendus pour les services listés ;
6. outils déclarés — et, si une capacité est éteinte, distinction entre « déclarés » et « prêts » ;
7. écritures : verrouillées ou derrière quel verrou ;
8. construction de requête en `--dry-run` (l'URL Gmail réellement formée est imprimée, pas un résultat) ;
9. lecture réelle si un compte est connecté, sinon la commande qui y mène ;
10. robustesse des extracteurs sur une réponse d'erreur ;
11. `formatAuthState` — ce que l'utilisateur lira.

Code de sortie : **0** tout est en place, **1** un maillon manque (et la commande qui le répare),
**78** configuration refusée. `--offline` saute les étapes 9 et 10.

## `npm run google:live`

Le trajet entier, sans filet : vraie config, vrai LLM, vrai `gws`, vrai Telegram. Une base de mémoire
jetable (`mkdtemp`) pour ne rien polluer, et un refus de parler à un chat hors liste blanche.

Il prouve ce que les tests unitaires ne peuvent pas prouver : que le modèle **choisit** l'outil, que
le transport construit un argv accepté par le binaire réel, qu'un refus traverse l'enveloppe, la
classification, le message d'avis, et arrive lisible dans Telegram. Sortie observée le 3 septembre
2026, sans compte connecté : `gmail_search` appelé, `auth`/`code 2`/« No credentials provided »
classés, audit `unavailable`, réponse livrée, exit 0 — donc **tout fonctionne sauf le compte**.

## Vérifié / non vérifié

| Affirmation | État |
|---|---|
| Onze outils, schémas validés, aucun argv construit hors de ces formes | ✓ `src/test/google.test.ts` (27 cas) |
| Le fils ne reçoit pas les clés de l'agent | ✓ par le double, qui enregistre l'env reçu |
| Un fils qui pend est tué au timeout, et l'appel n'est **pas** rejoué | ✓ le test mesure < 1,4 s : ce qui pendait, c'était le réessai |
| Réponses énormes bornées, JSON non parseable classé, 401 échappé reclassé | ✓ double en modes `huge` / `garbage` / `authfail-helper` |
| Une écriture n'est jamais rejouée, jamais sans clic | ✓ + `dangerous`/`requiresApproval` vérifiés par l'invariant `dangerous-requires-approval` |
| Un `userNotice` produit est **lu** par un canal | ✓ invariant `contract-fields-read` (le champ était déclaré et ignoré : la règle est née de là) |
| URL réellement acceptée par `gws` 0.22.5 | ✓ en `--dry-run`, hors token |
| Trajet complet jusqu'à Telegram | ✓ `google:live`, ci-dessus |
| Un appel qui **rapporte** une donnée réelle | ✗ — exige le consentement dans votre navigateur |
| Écriture réellement appliquée après un clic | ✗ — même raison ; le chemin d'approbation est testé, pas l'API |
| Comportement sous quota 429 réel, trousseau sous session réelle | ✗ non observés en conditions réelles |

## En cas de refus

```
npm run google:status   # ce que l'agent voit
npm run google:check    # quel maillon manque, et la commande qui le répare
```

Les causes fréquentes, dans l'ordre de probabilité : compte non connecté ; client OAuth absent ;
scope refusé au consentement (reloginer en ciblant les services, pas le préréglage complet) ;
pointeur ADC fantôme ; `gws` absent du `node_modules` (un `npm install` suffit, relancer l'agent
après `google:login` n'est **pas** nécessaire).
