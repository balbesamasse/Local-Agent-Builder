# Historique du skill

Le skill représente **l'état actuellement validé** d'OpenGravity, pas son archive.
Une entrée ne raconte donc pas « ce qu'on a fait » mais « ce qui change dans la façon
de construire le prochain agent ». Barème et procédure : `references/evolution.md`.

## v1.8.0 — 2026-09-03

- **à partir de** : v1.7.1
- **intégrations** (une capacité nouvelle — l'agent lit et, sur clic, écrit dans Google Workspace —
  et cinq règles durables sorties du chantier) :
  - **une API externe s'expose en opérations, jamais en passe-plat** : douze outils nommés et typés
    (`gmail_search` … `calendar_create`), arguments validés par schéma, et un transport qui ne sait
    construire qu'une forme d'appel par outil. Un `google_request` (argv ou requête libre) rend au
    modèle la surface d'exécution que l'absence de `run_command` venait de fermer — et une injection
    lue dans un mail l'emprunterait. Le périmètre est une liste blanche de config (`GWS_SERVICES`)
    dont un nom inconnu ou une liste vide **refusent le démarrage** (code 78) : une liste blanche ne
    se prolonge pas par un `*`.
  - **un préfixe d'environnement est une autorisation, pas un filtre** : l'agent charge `.env` dans
    `process.env`, donc un fils héritait du token Telegram et des clés de fournisseurs ; et
    transmettre `GOOGLE_*` en bloc faisait passer `GOOGLE_APPLICATION_CREDENTIALS`, dont la seule
    présence invalide l'authentification du CLI Google. Le fils ne reçoit plus que `PATH`, `HOME`,
    le fuseau et `GOOGLE_WORKSPACE_*` / `GWS_*` destinés par ce projet ; une clé étrangère détectée
    **ferme le transport** au lieu d'être un avertissement. Le projet ne définit aucune variable
    qu'il ne câble pas.
  - **une capacité dont le moyen d'accès existe se déclare** : binaire présent → outils présents ;
    compte non connecté → avertissement au démarrage, réponse d'outil qui nomme `npm run
    google:login`, ligne dans `/google`. La règle héritée du travail sur la voix (« ne pas promettre
    ce qui ne peut pas répondre ») est restreinte à ce qui **n'existe pas** : retirer les outils
    faute de connexion rendait le refus invisible à l'usage, interdisait toute preuve en direct, et
    imposait un redémarrage après chaque login.
  - **un champ de contrat sans lecteur est un défaut** : `ToolResult.userNotice` était déclaré,
    documenté, rempli par chaque outil en refus — et jeté par le canal. 22e invariant,
    `contract-fields-read`, sur les interfaces de contrat ; la correction câblée côté Telegram dans
    un message **séparé** (mélangé à la réponse, l'avis serait prononcé en appel).
  - **une exemption se prouve dans le code, pas dans la prose** : les deux levées
    (`invariant: exec-transport`, `invariant: env-enfant`) exigent `shell: false`, un environnement
    fils issu du filtre et l'absence d'étalement du père — contrôlés sur le source
    commentaires-déduits. La première version cherchait `childEnvironment(` dans le fichier : la
    définition de la fonction suffisait à faire passer un transport qui ne l'appelait pas.
  - **la preuve se cherche en réel, et un ✓ doit dire ce qu'il contrôle** : `npm run google:check`
    (onze maillons contre le vrai binaire, codes `0/1/78`, aucun contenu privé imprimé) et `npm run
    google:live` (mémoire jetable hors historique, livraison canalaire contrôlée). Deux étiquettes du
    doctor ont été réécrites : « extracteur ✓ » posé sur un appel refusé (401), et « outils déclarés
    ✓ » à côté de « capacité désactivée » — même famille qu'un test qui passe à côté.
  - **un timeout ne se rejoue pas** : le budget déjà consommé est exactement celui qu'on repayerait.
    Le symptôme « le fils n'est pas mort en 1,8 s » était en réalité un réessai (500 + 800 + 500) ;
    la sonde isolée tuait un fils détaché en 204 ms. Avant d'accuser un mécanisme, mesurer le chemin.
- **pourquoi** : un agent qui lit la messagerie d'un tiers tient en main la donnée la plus sensible de
  l'utilisateur et un canal d'écriture vers l'extérieur. Les règles ci-dessus sont ce qui empêche
  cette capacité de redevenir un shell déguisé, et ce qui fait qu'un refus s'explique au lieu de se
  taire — la conversation avec l'utilisateur est le seul endroit où une réparation peut être lue.
- **remplacé / supprimé** : dans `SKILL.md`, les lignes « `child_process` réservé au superviseur,
  sans `shell: true` » et « `process.env` lu dans `config.ts` (seule exception : le bootstrap du
  superviseur) » sont **remplacées** par les énoncés à deux exceptions contrôlées (pas ajoutées en
  face : la version absolue est fausse depuis qu'un transport métier existe). Dans `security.md`, le
  §4 « Interdits : `eval`, `new Function`, `child_process`, `vm` » devient une liste où `child_process`
  est toléré sous marqueur + contreparties, `eval`/`new Function`/`vm` restant sans levée. Chiffres
  du projet de référence corrigés partout où ils décrivent l'état courant : 78 → 91 fichiers, 9 162 →
  11 326 lignes de production, 4 666 → 5 261 lignes de tests, 55 → 65 clés, 11 commandes dont 8 au
  menu → 12 dont 10, 204 → 233 tests, 21 → 22 invariants (y compris dans `evals.json` ; la ligne
  historique de `evolution.md` garde 21/21 avec mention de sa version).
- **preuve** : `npm run check` → `ℹ tests 233 / pass 233 / fail 0` (27 tests Google ajoutés, dont
  isolation d'environnement mesurée sur l'env **reçu** par le fils, plafond d'octets, kill au timeout
  `assert < 1400` ms) · `npm run typecheck` → 0 erreur · `check_invariants.py` sur OpenGravity →
  **22/22** · mutations du transport : marqueur retiré → `FAIL no-code-execution` ; filtre remplacé
  par `{ ...parentEnv, ...overrides }` → **2 FAIL** ; le seul mot en commentaire, spawn sur env brut
  → `FAIL` ; `shell: true` réintroduit → `FAIL` · `npm run google:check` contre `gws 0.22.5` réel →
  exit 1, cinq maillons nommés avec la commande qui répare chacun, URL `gmail.googleapis.com/…`
  réellement construite en `--dry-run` · `npm run google:live` → `gmail_search` appelé par le modèle,
  `auth`/`code 2`/« No credentials provided » classés, audit `unavailable`, avis opératif délivré
  dans son propre message Telegram, exit 0 · sonde de kill : `SIGTERM` sur un fils détaché → mort en
  **204 ms** · faux en mode `hang` : `timeout 2` → **124** (il pend bien).
- **empreinte de référence** : 91 fichiers, tree `991edf6a693a` — la branche `src/google/` (9
  fichiers), `src/testing/{google-check.ts,live-chain.ts,fake-gws.mjs}`, `src/test/google.test.ts`,
  `docs/GOOGLE.md`, les 11 clés de config et les six scripts `google:*` entrent dans le miroir.


## v1.7.1 — 2026-09-03

- **à partir de** : v1.7.0
- **intégrations** :
  - **un arrêt se vérifie, il ne se proclame pas** : `keepalive.sh stop` envoyait un `pkill`,
    dormait une seconde, puis écrivait « veille, superviseur et agent arrêtés ». Constaté au
    contrôle suivant (≈4 s plus tard) : la boucle de veille était encore vivante — donc prête à
    relancer un superviseur au cycle d'après, exactement la concurrence que l'utilisateur
    cherchait à éviter en demandant l'arrêt de l'instance distante. `stop` attend maintenant la
    mort réelle (10 s de bornes, `pgrep` par paliers), rend `1` si la boucle survit, et ne dit
    « arrêté » qu'après l'avoir constaté.
  - **une `sleep` ordinaire avale le signal** : bash ne court un `trap` qu'entre deux commandes,
    si bien que la veille réagissait à `TERM` ou `Ctrl+C` avec jusqu'à un cycle complet de retard.
    La sieste passe par un `sleep` en arrière-plan suivi de `wait`. Mesuré sur le même script,
    `INTERVAL=30` : réaction en **1 s** avec `sleep & wait`, en **30 s** avec `sleep` seule.
- **pourquoi** : c'est la famille de « un envoi qui échoue en silence n'est pas un envoi », côté
  arrêt cette fois. Une action non vérifiée n'est pas une action ; et un journal qui ment sur un
  point ne rassure plus sur les autres — celui qui lit « arrêtés » alors que le bot tourne range
  le 409 qu'il reçoit du côté du réseau et cherche ailleurs.
- **remplacé / supprimé** : dans `extending.md`, le geste « Superviseur » enseignait encore la
  signature à deux arguments `shouldRestart(code, stoppedByRequest)` **à côté** de la forme à
  quatre imposée en 1.6.1. Doublon que l'audit de 1.7.0 devait supprimer et qui avait survécu
  parce qu'il logeait dans une phrase et non dans un titre. Un seul énoncé subsiste, à quatre
  arguments, avec l'interdit de lire l'intention dans le signal de l'enfant écrit en ligne.
- **preuve** : `/tmp/nap_test.sh` (deux formes, même `INTERVAL=30`) → `00:23:45.438 début de la
  sieste` / `00:23:46.438 piège reçu` contre `00:23:46.445 début` / `00:24:16.449 piège reçu` ·
  `bash -n scripts/keepalive.sh` → 0 erreur · arrêt de l'instance de test puis `pgrep -af
  "keepalive.sh loop|dist/(index|supervise).js"` → aucune ligne et `curl` sur `:8790/call` →
  HTTP 000 · `npm run check` sur OpenGravity → `ℹ tests 204 / pass 204 / fail 0` ·
  `check_invariants.py` → **21/21** sur le projet et sur un projet témoin régénéré ·
  `detect_drift.py` → aucune dérive.
- **empreinte de référence** : 78 fichiers, tree `536eb2ccb542` (relue dans
  `assets/skill_state.json`) — déplacée par le seul correctif de `scripts/keepalive.sh` dans le
  projet, et rien d'autre.


## v1.7.0 — 2026-09-03

- **à partir de** : v1.6.2
- **intégrations** (audit rétrospectif de la conversation entière — six itérations validées, relues une par une contre le miroir) :
  - **la capacité du canal se vérifie avant de dessiner** : `extending.md` « Canaux » avait quatre pièges (identité, format, limite, visibilité), il en a cinq. Le cinquième est écrit avec les chiffres relevés sur la doc Telegram (aucun média temps réel montant ni descendant, types d'appel **retirés de l'API Bot en 2022**, ~1 message/s par conversation, 50 Mo d'upload) et l'ordre imposé : énoncer la limite **avant** de proposer l'architecture. C'est la vérification qui a produit tout le mode appel en direct ; elle n'existait nulle part sous forme transmissible.
  - **un double de test doit lire les mêmes champs que le client** : nouvelle section dans `verification.md`, partie du faux service STT qui lisait `audio_base64` là où le client envoie `audio_base_64` — une soirée à « fiabiliser un test de latence », trois rustines appliquées au mauvais fichier. La section nomme les trois réflexes interdits (ajouter de la marge, espacer les cadres, forcer le fournisseur à parler) et les deux obligatoires (imprimer la trame reçue **et** la valeur du champ lu ; faire échouer le double sur une clé inconnue).
  - **un envoi qui échoue en silence n'est pas un envoi** : la section « un refus doit nommer sa cause » gagne le cas du `.catch(() => {})` posé sur un `ctx.reply()` de canal. C'est lui qui a fait passer « le lien d'appel n'est jamais arrivé » pour un utilisateur distrait : le bot, lui, n'écrivait rien.
  - **la veille répare avant de relancer** : `extending.md` « Rendre inarrêtable » passe de quatre à **cinq** gestes (veille, plus `deploy/launchd` et `deploy/systemd`), et la signature enseignée de la décision devient `shouldRestart(code, arrêtDemandé, politique, duréeDeVie)` — la forme à deux arguments que le fichier portait est la règle fausse (un `0` immédiat n'est pas un arrêt voulu).
  - **les faits de protocole du temps réel deviennent transmissibles** : keep-alive sous la limite d'inactivité du fournisseur (18 s sous 20 s), reconnexion unique, `abort()` qui ne ferme pas la websocket, seuil de barge-in relevé pendant que l'agent parle.
  - **l'outillage du skill se plie aux règles qu'il énonce** : `scaffold.py` ne renommait que
    `.ts/.md/.json/.example/.sql`, et un projet « Témoin » partait avec
    `Label com.opengravity.keepalive` dans son plist et `deploy/systemd/opengravity.service`
    dans son dossier — le nom d'un autre agent, actif sur la machine de l'utilisateur. La liste
    des cibles de renommage et celle de l'audit anti-fuite sont désormais les mêmes
    (`.plist`, `.service`, `.sh`), et les fichiers d'`deploy/` sont renommés avec le projet.
  - **une seule liste d'exclusion pour le miroir et pour le détecteur** : `detect_drift.py`
    signalait `logs/supervisor.pid` comme « capacité nouvelle » (bump `patch` recommandé) parce
    qu'il avait sa propre liste d'ignorance ; il lit désormais celle de `refresh_reference.py`.
    Contrôle : un `src/tools/drift-probe.ts` créé dans le projet est toujours signalé en
    `fichier-ajouté` avec bump `minor` — débruitage sans aveuglement.
  - **le miroir voit le runtime** : `refresh_reference.py` ignore `logs/` (un dossier de runtime n'a rien à faire dans un gabarit ; il y traînait vide), et l'empreinte couvre bien `scripts/*.sh`, `deploy/`, les dix fichiers `src/realtime/` et `docs/REALTIME.md`.
- **pourquoi** : la demande n'était pas « rafraîchis les chiffres » mais « représente la version la plus mature ». Le miroir était à jour sur les nombres (aucune dérive) et en retard sur **les règles** : les trois leçons les plus chères de la session — vérifier la capacité du canal, se méfier d'un double muet, journaliser un envoi qui échoue — vivaient dans le CHANGELOG, c'est-à-dire dans l'histoire du projet. Une leçon rangée dans l'histoire ne se transmet pas : le prochain agent repartirait sans elle.
- **remplacé / supprimé** :
  - `SKILL.md` : la réponse faite « Telegram en long polling (défaut, aucun port ouvert) » est **remplacée** par « aucun port écouté par défaut ; un port est une décision — drapeau de config, écoute locale, liste blanche à l'entrée », assortie de l'obligation de vérifier la capacité du canal. La métadonnée `basedOn`, épinglée à « OpenGravity v0.1 », dit v0.2 avec ses dépendances réelles (grammy, better-sqlite3, ws, Groq + OpenRouter, ElevenLabs, trois étages de supervision) ; « Ce skill n'est pas une photo de la v0.1 » ne nomme plus de version.
  - Dans « Ce qui ne doit jamais bouger » : le doublon de la ligne de sélection payante (« voix, et demain : voix, modèle, langue » → « voix, modèle, langue ») ; la ligne de supervision intègre la réparation **dans** son énoncé au lieu d'une ligne ajoutée à côté.
  - `blueprint.md` : le bloc `src/` s'arrête à `test/*.test.ts` — la veille y figurait en `src/scripts/keepalive.sh`, chemin qui n'existe pas. L'arborescence décrit maintenant la racine réelle (`scripts/`, `deploy/launchd`, `deploy/systemd`, `docs/`) et cite `testing/fake-realtime-providers.ts`, sans quoi un projet généré ne peut pas tester l'appel sans clé.
  - `extending.md` : « Quatre gestes » → « Cinq gestes » ; la phrase qui attribuait la réparation d'environnement au seul superviseur est corrigée (elle est fausse quand le superviseur est lui-même le fichier absent).
  - `evals/evals.json` : l'assertion périmée « `check_invariants.py` doit annoncer **17/17** » → **21/21** ; le scénario `appel-vocal-en-direct` gagne une 13ᵉ assertion sur le diagnostic des doubles.
  - Aucune règle n'a été laissée vivante à côté de sa remplaçante : les six corrections ci-dessus sont des réécritures, pas des ajouts. **[Cette ligne était fausse à la publication]** : le geste « Superviseur » de `extending.md` portait encore les deux signatures de `shouldRestart`, côte à côte dans la même phrase — un contrôle par titre n'attrape pas un doublon logé dans une ligne. Corrigé en 1.7.1 ; la leçon de méthode est que « doublon supprimé » se vérifie par `grep` de l'ancienne forme dans tout le miroir, pas en relisant les titres.
- **preuve** : `check_invariants.py .` sur OpenGravity → **21/21** · projet témoin régénéré
  après le correctif de `scaffold.py` : `81 fichiers, 17 renommés` (contre 13 avant), zéro
  occurrence de `opengravity` dans `deploy/` et `scripts/`, `check_invariants.py` → 21/21 sur
  le projet généré · `npm run check` → `ℹ tests 204 / pass 204 / fail 0` (le code du projet n'a pas bougé pendant l'audit : ce qui a changé est dans le miroir, et rien d'autre) · `detect_drift.py` → « aucune dérive », bump recommandé `none` avant cette publication · `refresh_reference.py --project opengravity` rejoué → le miroir ne recrée pas `logs/` · `scaffold.py` sur un projet neuf → 81 fichiers, aucun `logs/`, puis `check_invariants.py` sur ce projet → 21/21 (le gabarit reste conforme avec le nouveau filtre) · `ast.parse` sur `refresh_reference.py`, `scaffold.py` et `check_invariants.py` → 0 erreur.
- **empreinte de référence** : 78 fichiers, tree `a5afdcb49b7c`

## v1.6.2 — 2026-09-03

- **à partir de** : v1.6.1
- **intégrations** :
  - **un étage de veille doit pouvoir réparer celui qu'il veille** : `scripts/keepalive.sh`
    appelle maintenant `prepare()` avant de relancer le superviseur — `npm ci` si
    `node_modules/better-sqlite3` manque, `npm run build` si `dist/supervise.js` ou
    `dist/index.js` manque. Sans ça, la veille se comporte comme un gardien qui sonne à la
    porte d'une maison démolie : `node dist/supervise.js` sur un build absent échoue en
    `MODULE_NOT_FOUND` dans la milliseconde, et la boucle relance la même commande
    inexistantes toutes les 20 s, avec un journal propre et aucun bot.
  - **piège mesuré, pas théorique** : la réparation du build est la responsabilité du
    *superviseur* (`ensureEnvironment`). Or le superviseur EST le fichier absent. La
    chaîne « le bas se relève tout seul » ne tenait donc que si le milieu existait —
    d'où la règle : chaque étage répare celui du dessus **et** vérifie qu'il existe avant
    de le relancer, sinon sa tolérance aux pannes est une dépendance déguisée.
- **pourquoi** : un agent « inarrêtable » se juge à son pire scénario, pas au crash de
  l'agent. Les deux vrais pires scénarios d'un déploiement local sont le dossier de build
  disparu (clonage neuf, `git clean`, machine conteneurisée restaurée sans `dist/` ni
  `node_modules/`) et la mort du gardien. Traiter le second sans le premier laisse une
  panne totale déguisée en service : le journal dit « superviseur relancé (pid …) » pour
  un processus qui n'a jamais existé.
- **remplacé / supprimé** : dans `security.md` §18, la description du troisième étage
  (« vérifier le verrou, relancer, réaper ») est **remplacée** par une version à trois
  gestes — vérifier, **réparer** (dépendances et build), relancer — et la phrase qui
  attribuait la réparation de l'environnement au seul superviseur a été corrigée : elle
  était fausse pour le cas qui compte (le superviseur lui-même absent). Rien d'ajouté à
  côté : la propriété reste une seule liste dans une seule section.
- **preuve** : `npm run check` → `ℹ tests 204 / pass 204 / fail 0`, typecheck et build
  propres · `check_invariants.py .` → `21/21` · `detect_drift.py` → aucune dérive ·
  test de réalité : `dist/` supprimé pendant l'arrêt, veille redémarrée →
  `00:05:42 build absent — npm run build` puis `00:05:46 superviseur relancé (pid 8677)`,
  `00:05:47 appel live prêt`, hub `HTTP 200`, agent unique `8692` sous superviseur `8677` ;
  avant le correctif, la même séquence produisait `MODULE_NOT_FOUND` et trois relances
  identiques (`8074`, `8472`) sans jamais réparer.
- **empreinte de référence** : 78 fichiers, tree `a5afdcb49b7c`

## v1.6.1 — 2026-09-02

- **à partir de** : v1.6.0
- **intégrations** :
  - **un `0` n'est un arrêt voulu que si l'enfant a duré** : `shouldRestart` prend une
    quatrième entrée, la durée de vie. Un enfant qui rend `0` en vingt millisecondes n'a pas
    décidé de s'arrêter, il n'a jamais démarré. Découvert en voulant rendre le bot persistant :
    le superviseur lancé avec `--command node --env-file=.env dist/index.js` n'a reçu que `node`
    (la collecte des arguments s'arrête au premier `--`), node a lu un stdin fermé, est sorti `0`,
    et le père a écrit « pas de relance, code 0 » avec le plus grand calme pendant que le bot
    n'existait pas — trois minutes de « rien ne se passe » côté utilisateur, zéro ligne d'erreur.
  - **le gardien a un gardien** : `scripts/keepalive.sh`, troisième étage, une seule question
    (« le verrou `logs/supervisor.pid` désigne-t-il un vivant ? »), trois sous-commandes
    (`loop` / `status` / `stop`). Il ne juge pas l'intention de la mort (même règle qu'au premier
    étage, appliquée à soi-même), il relance.
  - **réaper avant de relancer, et attendre la mort réelle** : un superviseur tué de l'extérieur
    laisse son agent orphelin ; l'orphelin tient le port ; le nouvel agent échoue en `EADDRINUSE`
    → code 75 → palier de backoff → plusieurs minutes de silence. La veille tue l'orphelin,
    attend jusqu'à 6 s (SIGKILL au-delà), puis démarre. Mesuré : 0 `EADDRINUSE` après le correctif.
  - **reconnaître ses processus par la ligne de commande exacte** : `pgrep -x node` puis filtre,
    jamais `pkill -f dist/index.js` — ce dernier matchait le shell de celui qui tapait la
    recherche, et la veille aurait SIGTERM un curieux. Le premier `status` du script comptait
    d'ailleurs deux agents là où il y en avait un seul + lui-même.
  - **l'empreinte de référence voit les scripts d'exploitation** : `.sh` entre dans le filtre de
    `refresh_reference.py` (empreinte **et** analyse anti-fuite) ; un projet dont la surveillance
    tient dans un script shell ne doit pas pouvoir changer ce script sans que le miroir le voie.
- **pourquoi** : la règle « un agent qui doit tenir des jours est supervisé » était incomplète
  tant qu'elle s'arrêtait au superviseur : elle garantissait la reprise après un crash de
  l'agent, pas après la mort de celui qui est censé la garantir. Et surtout, elle laissait au
  code 0 le statut d'intention — or un code de sortie n'est pas une déclaration, c'est un
  constat : la seule chose qu'un `0` immédiat prouve, c'est que rien n'a eu lieu. Les trois
  leçons se retrouvent dans tous les agents de ce gabarit, pas seulement dans OpenGravity.
- **remplacé / supprimé** :
  - l'assertion de test « `shouldRestart(EX_OK, false, p)` vaut `false` — arrêt propre demandé
    par l'agent » est **remplacée** par trois assertions (0 après 10 min = non relancé ; 0 à
    18 ms = relancé ; arrêt demandé = jamais relancé), et le test
    « un enfant qui sort proprement ne mérite pas d'être relancé » est scindé en deux —
    l'ancien portait la règle fausse. Une troisième durée explicite
    (`policy.unhealthyRunMs: 0`) remplace le repos silencieux sur l'horloge du test.
  - dans `security.md` §18, « Quatre propriétés, aucune optionnelle » → **six** (durée de vie
    sur le `0`, et troisième étage avec réapage) ; dans `SKILL.md`, la ligne de supervision du
    tableau « Ce qui ne doit jamais bouger » est **réécrite** (pas de ligne ajoutée à côté).
  - dans `blueprint.md`, l'arborescence gagne `scripts/keepalive.sh` ; les chiffres de `SKILL.md`
    suivent le projet (78 fichiers, 9 162 / 4 666 lignes, 204 tests) — la règle
    `chiffre-périmé-du-skill` de `detect_drift.py` avait trois écarts à signaler, elle n'en a
    plus aucun.
- **preuve** :
  - `npm run check` → typecheck 0 erreur, `ℹ tests 204 / pass 204 / fail 0`, build 0 ;
    `check_invariants.py .` → `21/21`.
  - `detect_drift.py` → « aucune dérive : le skill décrit l'état réel du projet », bump `none`.
  - tests de réalité (pas de simulation) : `kill -9` de l'agent 6098 → nouvel agent 6172 en
    moins de 8 s (relance par le superviseur) ; `kill -9` du superviseur 6459 → nouvelle
    veille → superviseur 6556 → « agent sans père légitime (pid 6474) — arrêté AVANT toute
    nouvelle instance » → un seul agent, hub `HTTP 200`, `EADDRINUSE` 0 occurrence.
  - la règle du `0` est prouvée par le défaut lui-même : avant le correctif, la même séquence
    produisait « pas de relance {raison: code 0} » et un bot inexistant, ce qui est exactement
    le « rien ne se passe » rapporté par l'utilisateur.


## v1.6.0 — 2026-09-02

- **à partir de** : v1.5.0
- **intégrations** :
  - **une capacité qui dépend du transport se vérifie contre la doc du canal AVANT d'être
    dessinée** : l'appel vocal en direct partait de l'intuition « un bot Telegram passe un
    appel ». Elle est fausse — les types d'appel ont été retirés de l'API Bot en 2022, les
    appels sont réservés aux comptes utilisateurs, et il n'existe aucun média temps réel
    montant ou descendant. Cette vérification a décidé de toute l'architecture (page servie
    par l'agent, websocket, billet émis par Telegram) et de sa doc (`docs/REALTIME.md` §1,
    qui table l'intuition contre la réalité). Un livrable qui n'énonce pas ses limites
    **avant** le choix technique se les fait énoncer par un échec.
  - **le temps réel est un module de plus, pas un second cerveau** : `/call` est une commande
    du même agent, avec ses outils, sa mémoire, son ordonnancement ; l'appel n'ajoute qu'une
    entrée (la voix) et une sortie (la parole). Le canal est **tracé** (`messages.channel`,
    migration additive `v3`) pour que le prompt et la mémoire sachent d'où vient le tour —
    une réponse de 400 caractères lue à voix haute n'est pas la même réponse qu'un message.
  - **`listening-is-a-decision` (20ᵉ invariant)** : un port écouté n'est jamais une habitude.
    Le fichier qui appelle `createServer()`/`server.listen()` doit vivre sous `src/realtime/`
    (ou n'être que le point d'entrée qui délègue), porter `LISTEN-EXCEPTION:` avec son motif,
    être coupé par `REALTIME_ENABLED` **lu avant** `listen()`, et confronter `allowedUserIds` à
    la poignée de main. **Un seul port**, un seul endroit où la décider.
  - **`call-page-isolated` (21ᵉ invariant)** : une page qui ouvre un micro embarque tout
    (script, styles, worklet en `blob:`), n'affiche aucune `src`/`href` `http(s)`, aucun
    `@import`/`@font-face`, et nomme `microphone=(self)` dans sa `Permissions-Policy`. Un CDN
    dans la page d'appel = l'agent muet derrière un pare-feu, et `getUserMedia` exige HTTPS ou
    `localhost`.
  - **la décision de fin de tour reste locale** : VAD à énergie dans l'agent, `commit_strategy`
    manuel côté fournisseur, pré‑roll de 200 ms, et le `partial_transcript` nourrit
    l'affichage **jamais** la décision. Un tour déclenché sur un partiel échoit sur une phrase
    inachevée ; attendre que le fournisseur annonce la fin de phrase ajoute son aller‑retour à
    chaque tour.
  - **un double de test qui ne valide pas les noms de champs ne prouve rien** : le faux
    service STT lisait `audio_base64` là où le client envoie `audio_base_64`. Il n'a donc
    jamais vu d'audio, n'a jamais répondu de texte final, et le tour a basculé sur le repli
    blocs — ce qui **ressemblait exactement** à une course réseau. Quatre correctifs plausibles
    ont été appliqués au test (marge de grâce, espacement des cadres, forçage du texte final)
    avant que la cause soit lue. La règle : sur un test « de latence » qui échoue, prouver
    d'abord que le double reçoit et lit les mêmes champs que le client (imprimer la trame
    reçue **et** la valeur du champ), et seulement ensuite parler de timing. Ajouter de la
    marge à un test qui échoue pour une autre raison fabrique un test qui passe pour la
    mauvaise raison — le pire livrable du lot.
- **pourquoi** : trois des décisions ci-dessus ne sont pas des goûts, ce sont des classes de
  bug rendues impossibles. Sans énoncé de limites vérifié, un agent promet un appel vocal que
  son canal ne sait pas transporter. Sans invariants sur l'écoute et sur la page, un port
  micro se banalise (une habitude, pas une décision) et la page se met à dépendre d'un CDN.
  Sans discipline de diagnostic sur les doubles, l'équipe passe une soirée à « stabiliser un
  test fragile » qui était un test correct tombant sur une vraie régression — ici, un test
  correct qui tombait sur un faux serveur sourd.
- **remplacé / supprimé** :
  - la règle implicite « aucun serveur web » n'est plus absolue ni abandonnée : elle devient
    `listening-is-a-decision`. Dans le projet, deux commentaires (en-tête de `src/realtime/hub.ts`,
    bloc de clés de `src/config.ts`) pointaient un invariant nommé `no-listening-port`, qui
    n'existe plus — **cassés le même commit** (une référence de règle morte fait chercher une
    règle qui n'existe pas). Le même bloc de `config.ts` promettait « page WebRTC/websocket » :
    le flux est du PCM sur websocket, **sans WebRTC** ; le mensonge a été retiré plutôt
    qu'annoté.
  - `security.md` §15 (`media-no-residue`) : la règle, déjà restreinte en 1.4 à « aucune
    écriture *non déclarée* », couvre explicitement un **flux entrant continu** (l'appel) :
    anneau en mémoire, rien au cas où, et la page n'a pas de serveur de fichiers à tromper.
  - `security.md` : sections 16 et 17 remises dans l'ordre (elles avaient été insérées après
    19), et §19 garde sa portée de 1.5 (menu **ou** aide, handler derrière drapeau pour le
    hors-menu) — inchangée, donc non réécrite.
  - `blueprint.md` : `SCHEMA_VERSION` passait pour « v2 = `chats.voice_id` » →
    « v2 = `chats.voice_id`, v3 = `messages.channel` » ; le bloc `src/realtime/` (10 fichiers)
    entre dans l'arborescence de référence avec ses contrats.
  - `SKILL.md` : « 19 invariants » et le rapport « `<X>/19` » → **21** ; deux lignes ajoutées
    au tableau « Ce qui ne doit jamais bouger » (port déclaré, page autonome + média hors
    canal de messagerie) ; la description du skill déclare l'appel vocal en direct comme
    déclencheur (c'est une capacité, pas un détail). `verification.md` : « Quatorze règles
    statiques » → vingt et une, avec les nouvelles familles, et `17/17` → `21/21` dans le
    critère d'acceptation.
  - supprimé du harnais : l'option `commitAfterChunks` du faux fournisseur, ajoutée pendant le
    diagnostic pour forcer un texte final « pour que le test passe » — une béquille de test
    masquant un faux serveur sourd ; retirée une fois la clé corrigée.
- **preuve** :
  - `npm run check` → `tsc --noEmit` 0 erreur, `ℹ tests 203 / pass 203 / fail 0`, build 0 ;
    realtime : protocole 11 ✔, VAD 10 ✔, session 17 ✔, fournisseurs 10 ✔, hub 20 ✔, bout-en-bout
    `/call` 2 ✔.
  - `check_invariants.py .` → `21/21`, avec `listening-is-a-decision  1 module(s) d'écoute,
    tous sous src/realtime/ avec mention, bascule et liste blanche` et
    `call-page-isolated  page d'appel autonome : src/realtime/page.ts`.
  - mutations (une règle qui n'a jamais échoué est décorative) : (a) retirer la mention
    `LISTEN-EXCEPTION:` de `hub.ts` → `20/21`, « écoute sans porter la mention » ;
    (b) créer `src/leak.ts` avec `createServer().listen(9001)` → `20/21`, « ouvre un port hors
    de src/realtime/ » ; (c) injecter `<link href="https://cdn…">` dans la page d'appel →
    `20/21`, « 1 ressource(s) externe(s) référencée(s) ». Trois restaurations → `21/21`.
  - `[non prouvé]` : le rendu de la page d'appel dans un vrai client Telegram (aucun
    navigateur dans cet environnement) — la page est validée statiquement, pas affichée. Le
    cheminement complet micro → STT réel → cerveau → TTS réel avec une clé ElevenLabs live
    reste à valider sur la machine de l'utilisateur ; l'écriture en `Limites` du livrable vaut
    mieux qu'un « ça devrait marcher ».


## v1.5.0 — 2026-09-02

- **à partir de** : v1.4.0
- **intégrations** :
  - **une commande doit être annoncée au client, pas seulement implémentée** : `/voice`
    répondait, figurait dans `/help`, et n'apparaissait pas à côté des autres commandes dans
    la conversation Telegram. Le menu (`setMyCommands`) était recopié à la main dans le
    bootstrap, et cette liste n'avait pas suivi l'ajout. La correction n'est pas « penser à l'ajouter » :
    `CHANNEL_COMMANDS` devient la source unique du canal (nom, arguments, aide, libellé de
    menu) et `menuCommands()` en dérive le menu — ajouter une commande l'annonce
    mécaniquement, et l'oublier est impossible sans que ça se voie.
  - **une commande à paramètre ne peut pas être au menu** (Telegram refuse un nom contenant
    un espace ou `<`) : `/memory` et `/forget_memory` vivent donc dans `/help`. La règle est
    « au menu **ou** dans l'aide », jamais « les deux obligatoirement ».
  - **le harnais doit capturer ce qu'il avalait** : la fausse API renvoyait `true` à
    `setMyCommands` sans rien noter, donc aucun test ne pouvait voir un menu incomplet.
    Elle enregistre maintenant le corps reçu, et le bout-en-bout asserte la présence de
    `/voice` — le trajet complet, pas une liste relue à côté.
- **pourquoi** : une commande invisible ne produit ni erreur, ni log, ni test rouge — le
  seul qui la voit est l'utilisateur, qui conclut qu'elle n'existe pas. Toute doc ou règle
  qui traite le menu comme un détail de confort laisse cette classe de bug ouverte.
- **remplacé / supprimé** : la liste `lines` de `/help` dans le handler (une recopie
  manuelle — supprimée) ; les neuf entrées littérales de `setMyCommands` dans `index.ts` (remplacées
  par `menuCommands()` filtré sur le drapeau `/id`) ; dans `security.md` §19,
  « l'inverse est licite » est **restreint** : hors menu n'est licite que si le *handler*
  est lui-même derrière un drapeau, plus « une commande peut rester hors menu » sans
  condition ; « deux choses sont vérifiées » → trois (ordre d'enregistrement, menu→handler,
  handler→liste partagée) ; dans `extending.md`, « Trois pièges par canal » → quatre
  (visibilité ajoutée).
- **preuve** : `npm run check` → typecheck 0 erreur, `tests 133 / pass 133 / fail 0`, build 0 ;
  `check_invariants.py .` → `19/19`, ligne `commands-reachable … menu et aide cohérents` ;
  mutation (retirer `/voice` de `CHANNEL_COMMANDS`) → test unitaire `commandes invisibles
  dans le client : /voice` (2 échecs) et `check_invariants` → `exit=1`, puis restauration
  `OK` ; preuve live, sans appel payant : `getMyCommands` sur le bot réel renvoie
  `/start /help /tools /forget /stats /pending /voice` (7 entrées, `/id` absente car
  désactivée).
- **empreinte de référence** : 59 fichiers, tree `12faea772531`


## v1.4.0 — 2026-09-02

- **à partir de** : v1.3.0
- **intégrations** :
  - **le choix d'une ressource payante se fait dans le canal, jamais dans un `.env`** :
    `audio/voices.ts` sert l'inventaire réel du compte (cache à TTL, un seul appel concurrent,
    repli sur le dernier bon inventaire, erreur explicite si aucune voix exploitable), le
    clavier porte l'**identifiant** et non un index, et l'identifiant d'un clic est revérifié
    présent dans le catalogue avant tout usage.
  - **explorer ne consomme pas** : choisir une voix ne synthétise rien (`tts.length === 0`
    est asserté au clic), la voix ne s'entend qu'à la réponse suivante.
  - **deux portées assumées** : le mode vocal reste un réglage de session en mémoire, la
    voix devient une préférence persistée (`chats.voice_id`, migration additive `v2`) — une
    identité qui s'évapore à l'arrêt est un bug vécu, pas une simplification.
  - **`commands-reachable` (19ᵉ invariant)** : toute `bot.command` doit être enregistrée
    avant le handler texte du canal, et le menu `setMyCommands` ne peut promettre une
    commande qu'aucun handler n'enregistre.
- **pourquoi** : trois leçons transférables, pas une fonctionnalité de plus.
  1. *Une commande peut être écrite, documentée, annoncée dans le menu — et morte.* grammy
     applique les filtres dans l'ordre d'enregistrement : `bot.on('message:text')` placé avant
     `bot.command('voice')` avale la mise à jour, et le symptôme est un modèle qui répond à
     côté d'une barre oblique. Aucun message d'erreur, aucun test rouge : c'est le genre de
     défaut qui survit des mois parce que la route n'est pas testable telle qu'emballée.
  2. *Le harnais doit imiter le protocole, pas mes hypothèses.* Le harnais d'intégration
     n'envoyait pas les `entities` que Telegram attache aux commandes : aucune commande
     n'était reconnue **en test**, ce qui rendait le bug ci-dessus invisible. Depuis,
     `messageUpdate` annote tout `/something`, et la file d'`getUpdates` n'avance plus sur
     une file vide (elle fit sauter un callback et accusa le bot d'ignorer les clics).
  3. *Une préférence d'identité se persiste ; un réglage de session non.* La frontière vaut
     d'être écrite dans la doc du projet, sinon le prochain réglage est persisté par erreur
     (et pollue la base de données de conversation) ou l'identité est oubliée au redémarrage.
- **remplacé / supprimé** :
  - supprimé dans `.env.example` : l'instruction d'aller chercher l'identifiant de voix à la
    main (`curl …/v1/voices`) — elle est remplacée par `/voice`, qui liste les voix du
    compte dans Telegram. Une consigne obsolète fait exactement ce qu'elle prétend éviter :
    recoller une valeur dans un fichier au lieu de la choisir.
  - remplacé : le texte de `/help` « état et réglage de la voix (on/off/mode) » devient
    « toucher une voix du compte pour la changer » ; la ligne de démarrage « aucun fichier
    écrit sur disque » devient « aucun **média** écrit sur disque » plus une ligne `journal`,
    pour ne plus contredire `logs/agent.log` ; `describeConfig` gagne la ligne `sélection`.
  - retirée aussi : l'idée (présente un instant dans le blueprint) que le catalogue de voix
    vivrait dans `core/` — il est dans `audio/`, seule couche à connaître le fournisseur.
- **preuve** : `npm run check` → `exit=0` ; suite → `# tests 126 / # pass 126 / # fail 0`
  (110 → 126 : 15 sur le catalogue et la persistance, 1 bout-en-bout de sélection) ;
  `check_invariants` → `19/19`. Mutations : `/voice` repassé après le handler texte →
  `[ FAIL] commands-reachable … /voice enregistré après le handler texte qui l'avale` ;
  `{ command: 'fantome' }` ajouté au menu → `FAIL` aussi, puis revert et `19/19`.
  Migration rejouée sur une **copie de la base réelle** : `user_version 1 → 2`, colonne
  `voice_id` ajoutée, `messages = 26`, `memories = 2` intacts. Catalogue vivant sur le vrai
  compte : 22 voix, la courante en tête. Bout-en-bout : `harness.tts.length === 0` au clic,
  puis `voiceInUrl.startsWith('/text-to-speech/<voix choisie>')` à la réponse suivante,
  préférence relue dans le fichier SQLite, clic forgé et clic d'un hors-liste tous deux
  sans effet.
- **empreinte de référence** : 58 fichiers, tree `40ea921d8c19`


## v1.3.0 — 2026-09-02

- **à partir de** : v1.2.2
- **intégrations** : garde d'os + journal sur disque + superviseur à backoff et verrou d'instance ; codes 0/75/78 ; trois invariants élargis et re-éprouvés par mutation
- **pourquoi** : un agent sans spectateur qui meurt en silence n'a pas de bug, il a une
  absence de témoin. Le skill doit donc imposer une *propriété de continuité*, et pas
  seulement une absence de crash : journal sur disque (la cause survit au terminal), garde
  d'os (un rejet de promesse ne tue plus, une exception synchrone tue *vite* et explique),
  codes de sortie comme contrat (`0`/`75`/`78`) pour qu'un repreneur sache s'il faut repartir,
  verrou d'instance parce que deux pollers sur le même token se tuent par `409`.
  Concrètement, quiconque construit un agent avec le skill doit maintenant livrer
  `src/supervise.ts` + `src/core/guard.ts` et prouver la reprise en tuant l'enfant.
- **remplacé / supprimé** :
  - l'invariant `media-no-residue` n'interdit plus **toute** écriture dans `src/` — il
    interdisait de fait le journal, c'est-à-dire le seul moyen de comprendre un arrêt. La
    règle est resserrée sur ce qu'elle visait (les octets de media reçus ou produits) et
    l'exception devient vérifiable : le fichier doit porter `DISK-WRITE-OK:`, sinon FAIL.
  - `env-single-point` et `no-code-execution` admettent le bootstrap du superviseur, à
    condition qu'appelle `registerSecrets` et n'use ni de `shell: true` ni d'`execSync`.
  - supprimé dans `SKILL.md` : le compte « 63 tests » du projet généré (il bougeait à chaque
    évolution de la référence et n'était plus vrai) ; la phrase se passe de chiffre.
  - corrigé ici et là : le `README.md` d'OpenGravity qui présentait `npm run dev` comme le
    mode de service, et `process.exit(1)` qui aplatisisait config invalide et panne.
- **preuve** : `npm run check` → `exit=0` ; `node --test … --test-reporter=tap` → `# tests
  110 / # pass 110 / # fail 0` (89 → 110) ; `check_invariants.py .` → `18/18 invariants
  vérifiés` ; cinq mutations (mention retirée, `installCrashGuards` débranché, retour à
  `process.exit(1)`, `shell: true`, `registerSecrets` retiré) → cinq `FAIL`, un par règle
  visée ; sur le processus réel : `kill -9 6025` → `enfant tué par un signal {signal:SIGKILL,
  vecu_ms:24216}` → `redémarrage programmé {dans_ms:1000, raison:"code null"}` → nouvel
  enfant `6288` reconnecté 2,7 s plus tard ; `kill -TERM 6013` → `arrêté proprement`,
  `pas de relance {raison:"code 0", arret_demande:true}`, verrou supprimé ; second
  superviseur → `deuxième instance refusée`, `exit=78`.
- **empreinte de référence** : 56 fichiers, tree `92c1615c2247`


## v1.2.2 — 2026-09-02

- **à partir de** : v1.2.1
- **intégrations** :
  - **le nom présenté à un fournisseur de média est un champ sémantique** :
    `resolveAudioPart` garantit une extension parmi celles que le fournisseur accepte, en
    la déduisant du mime déclaré par le canal (`files/voice_file_1` → `voice_file_1.ogg`),
    et refuse avant l'appel quand rien ne permet de la déduire.
  - **le canal déclare, l'audio interprète** : `downloadTelegramFile` accepte
    `declaredMime` (le `mime_type` de la pièce jointe) et le fait passer avant toute
    déduction depuis le nom ; pour un `voice` Telegram, l'absence de déclaration retombe
    sur la garantie du protocole (OGG/Opus), pas sur une supposition.
  - **un refus nomme sa cause** : le journal porte le motif interne et le statut HTTP ;
    l'erreur fabriquée avant appel se reconnaît à `status === null` — comparer un
    `number | null` à `undefined` rend une branche muette sans que le typecheck s'en
    plaigne.
  - **les tests rejouent la forme réelle** : le harnais bout-en-bout sert désormais
    `files/voice_file_1`, la forme que le monde produit, et non `files/file_1.ogg`, celle
    que j'avais inventée.
- **pourquoi** : ce n'est pas une amélioration, c'est une panne. Aucun vocal n'a jamais pu
  être transcrit sur l'installation réelle — l'utilisateur envoyait un message vocal,
  l'agent répondait « ça n'a pas abouti », le journal disait `AudioError`. Trois causes
  indépendantes se masquaient l'une l'autre : un nom sans extension rejeté par le
  fournisseur, une chaîne de secours qui n'essaye pas après un 400 (à juste titre), un log
  sans motif. La leçon dépasse l'audio : un bord externe juge parfois sur un champ qu'on
  tenait pour cosmétique, et un test qui partage les hypothèses du code ne prouve rien.
- **remplacé / supprimé** : la recette audio de `references/extending.md` ne dit plus que
  le `Content-Type` de la partie multipart suffit à identifier le format ;
  `references/verification.md` retire l'idée qu'un log « typé » (le nom de la classe
  d'erreur) constitue un diagnostic ; le harnais ne sert plus une forme de `file_path` que
  personne n'a observée.
- **preuve** : sonde sur l'API réelle avec le module compilé du produit —
  `resolveAudioPart({mime:'audio/ogg', fileName:'files/voice_file_1'})` donne
  `fileName: voice_file_1.ogg, mime: audio/ogg` ; appel Groq avec un WAV valide sous un nom
  sans extension → `HTTP accepté · fournisseur groq-whisper · texte "you"` (artefact
  classique de Whisper sur du silence, qui prouve le franchissement de la barque de type) ;
  témoin négatif `mime: application/octet-stream` → `AudioError: format audio non
  reconnu` avec `statut null → aucun appel émis`. `npm run check` (code de sortie 0 vérifié
  hors pipeline) → `tests 89 / pass 89 / fail 0` ; `check_invariants.py` → `17/17`.
- **empreinte de référence** : 53 fichiers, tree `5501a7fdc521`

## v1.2.1 — 2026-09-02

- **à partir de** : v1.2.0
- **intégrations** :
  - **une garde de média ne liste pas blanchement la forme du jour** : `isSafeTelegramPath`
    n'accepte plus une nomenclature, elle refuse ce qui sort de la racine (chemin absolu,
    segment `..`, double slash, segment commençant par un point, deux-points en tête,
    tout caractère hors `[A-Za-z0-9._/:-]`, plus de 180 caractères). Motif : la version
    précédente a REFUSÉ LES VOCAUX RÉELS d'un utilisateur (`files/AgentAudioFile/…`,
    horodatages en `19:32:00`).
  - **un refus s'explique sans déballer la pièce jointe** : `describeTelegramPathIssue`
    journalise le motif, la racine et la longueur, jamais le nom complet.
  - **herméticité des tests bout-en-bout** : `ENV_FILE` surcharge le chemin du fichier de
    variables, lu à la CONSTRUCTION de la config et non à l'import du module ; le harnais
    le passe à `/dev/null`. Un test de config prouve les deux sens (le fichier comble les
    absences, une variable exportée gagne).
  - **les inventaires de fournisseurs n'ont pas la même forme** : `extractItems` accepte
    le tableau nu (ElevenLabs `GET /v1/models`, relevé sur compte réel), l'objet enveloppant
    la liste, et l'enveloppe `data` (compatible OpenAI). Le modèle de transcription n'est
    plus jugé sur un inventaire de synthèse — le contraire refusait des configurations
    valides.
  - **preuve séparée par bord externe** : `npm run voice:check` (et son option `--mute`)
    distingue « le fournisseur répond » de « le canal répond », en appelant les modules
    livrés plutôt qu'un équivalent jeté pour l'occasion.
- **pourquoi** : trois de ces points viennent d'une panne vécue sur le trajet, pas d'une
  intuition. Un agent qui refuse les vocaux de son unique utilisateur pour une histoire de
  nomenclature n'est pas prudent, il est inutilisable ; et en miroir, un parseur qui lit
  un inventaire vide comme une validation silencieuse fait croire qu'un identifiant
  épinglé est bon. Les deux se corrigent au même endroit : la garde porte sur ce qui fait
  mal, et l'absence de preuve doit être bruyante.
- **remplacé / supprimé** : la phrase affirmant « on n'accepte que la forme
  `files/<nom>.<ext>` » est retirée de `docs/SECURITY.md` et de `references/security.md`
  (elle décrivait la garde fautive). La vérification du modèle STT contre `/v1/models` est
  supprimée. La pratique « le fils hérite de l'environnement du testeur » est abandonnée au
  profit d'un environnement fabriqué.
- **preuve** : `npm run check` sur OpenGravity → `tests 87 / pass 87 / fail 0`, typecheck et
  build sans erreur ; `check_invariants.py` → `17/17` sur OpenGravity et sur `beacon` ;
  `npm run voice:check` sur le compte réel → « synthèse ElevenLabs : 173165 octets,
  audio/ogg, reponse.ogg, 0.91 s, coupée=non » puis « envoyé dans le chat 8295237112 » ;
  recherche de fichiers `*.ogg`/`*.opus`/`*.mp3` après le test → aucun. Constat annexe :
  `GET /v1/user/subscription` répond `401` avec une clé API standard (elle exige une
  Accounts key) — d'où l'absence volontaire de sonde de quota dans le produit.
- **empreinte de référence** : 53 fichiers, tree `c7e5e6750a29`

## v1.2.0 — 2026-09-02

- **à partir de** : v1.1.0
- **intégrations** :
  - **la couche média devient une pièce du patron** : `src/audio/`
    (`types · transcribe · synthesize · policy · eleven-check`) pour ce qui ignore le
    canal, et `src/channels/<canal>/files.ts` pour ce qui le connaît. Chaîne de
    transcription Groq Whisper → secours ElevenLabs Scribe, **uniquement** sur erreur
    `retryable` : basculer sur une 401 masquerait un compte mal configuré.
  - **la prise de parole est une politique, pas un choix du modèle** :
    `shouldSpeak(mode, {hadVoice, userText, hasPending, override})`, `VOICE_MODE` par
    défaut `mirror`, jamais de voix pendant une approbation en attente, le texte reste
    toujours envoyé.
  - **budget borné aux deux bouts** : `MEDIA_MAX_BYTES` (annonce + flux réel) à
    l'entrée, `TTS_MAX_CHARS` à la sortie, coupe sur fin de phrase, l'ellipse déduite
    du budget et non ajoutée.
  - **trois invariants de plus** (14 → 17) : `media-no-residue`,
    `media-download-bounded`, `voice-decision-input`.
  - **un documenté ≠ un fait** : `GROQ_FALLBACK_MODEL=""` promettait « désactivé » et
    réarmait le modèle par défaut. `readStringDisableEmpty` distingue désormais absent et
    vide, et un test de config hermétique (qui retire les clés avant de charger) le
    verrouille dans les deux sens.
  - **l'outillage se corrige lui-même** : `refresh_reference.py` plaçait l'entrée de
    CHANGELOG au-dessus du paragraphe d'introduction et laissait `empreinteDeReference`
    du frontmatter se désaligner de `assets/skill_state.json`. Les deux sont maintenant
    écrits par le script, plus le champ `preuve` des six champs de traçabilité.
- **pourquoi** : un agent local sans voix est un agent qu'on n'utilise que devant un
  clavier ; mais la voix ajoute deux surfaces d'attaque (un `file_path` venu d'un
  service externe, un texte non fiable venu d'une légende) et une facture à la
  caractère. Le patron doit donc imposer *le* point qui rend le reste trivial : les
  octets ne touchent jamais le disque, et ce qui est généré ne pilote jamais ce qui est
  déclenché. Sans ces deux règles, chaque implémentation réinvente — et rate — le
  nettoyage.
- **remplacé / supprimé** : la section « Audio » de `references/extending.md` n'est plus
  un plan mais la recette vécue ; sont supprimés le fichier temporaire nettoyé en
  `finally`, le `sendVoice` en MP3 (Telegram rend un vocal en **OGG/Opus**,
  `output_format=opus_48000_64`), l'action de clavier `record_audio` (inexistante,
  `upload_voice`) et le plafond de 25 Mo hérité de Telegram (le nôtre est 8 Mo).
  `references/security.md` passe de douze à dix-sept règles. La promesse « supprimer
  après usage » est retirée du vocabulaire : on ne promet pas un nettoyage, on n'écrit
  pas.
- **preuve** : `npm run check` sur `/home/user/opengravity` → `tests 82 / pass 82 /
  fail 0` (typecheck et build sans erreur) ; `check_invariants.py` → `17/17` sur
  OpenGravity **et** sur `beacon` (agent sans voix, les trois règles se taisent à
  juste titre) ; mutations sur copies temporaires : écriture réelle d'un vocal →
  `media-no-residue`, `redirect:'follow'` → `media-download-bounded`, `if (true)` à la
  place de la garde de chemin → `media-download-bounded`, suppression de la comparaison
  au flux → `media-download-bounded`, `shouldSpeak(safeReply, …)` →
  `voice-decision-input` (5/5 mutations signalées, témoin intact 17/17). Le test
  bout-en-bout vocal prouve en plus : un seul appel de transcription (le vocal d'un
  non-autorisé n'est jamais écouté), `output_format` et `voice_id` corrects sur la
  requête TTS, et `readdirSync` du répertoire de données ne contenant que `memory.db`.
- **empreinte de référence** : 52 fichiers, tree `75a50e056f89`

## v1.1.0 — 2026-09-02

- **à partir de** : v1.0.0
- **intégrations** :
  - **une valeur par défaut n'est pas une vérité** : la sonde d'inventaire
    `src/llm/model-check.ts` interroge `GET <base>/models` au démarrage et refuse de
    lancer le bot sur un modèle absent du compte. Réglable par `LLM_VALIDATE_MODELS`
    (défaut `true`).
  - **les identifiants de modèles épinglés partout dans le skill sont remplacés** par la
    consigne de vérification, avec les valeurs réellement validées sur le compte de
    référence : `openai/gpt-oss-120b` (principal), `qwen/qwen3.8-27b` (secours),
    `openrouter/free` (troisième rang).
  - **deux invariants de plus** (12 → 14) : `env-doc-sync` (toute clé lue est documentée,
    toute clé documentée est lue ou annoncée non câblée) et `model-inventory-probe`
    (un modèle épinglé suppose une sonde branchée sur le démarrage).
  - **la pertinence d'une recherche se prouve par l'ordre contraire** : le classement des
    souvenirs était silencieusement réduit à la récence parce que `julianday()` appliqué à
    un epoch en millisecondes renvoie `NULL`, ce qui annulait tout le score. Correction en
    millisecondes + test construit pour échouer dans le cas cassé.
  - **la découverte du chat id passe par le journal, pas par une commande ouverte** :
    un refus d'accès journalise l'identifiant de l'expéditeur. `TELEGRAM_ID_COMMAND_ENABLED`
    repasse à `false` après installation, et le dit.
  - **l'outillage de synchro est devenu une pièce du skill** : `detect_drift.py`
    (classe les écarts, qualifie les réglages locaux, compare les chiffres annoncés par
    le SKILL.md à ceux du projet) et `refresh_reference.py` (re-capture + bump + analyse
    anti-fuite). Trois choix de conception y sont gravés, chacun après un défaut vu en
    direct : hachage **normalisé par le nom de l'agent** (sinon tout projet généré par
    `scaffold.py` crie une fausse dérive), **échappatoire typée** pour les modèles
    `*.example` (un garde-fou qui sonne à chaque exécution légitime sera désactivé), et
    **document `--json` unique** (un second objet en fin de flux rend le rapport
    illisible par `jq`, donc sautable en CI).
  - **le premier tour a été validé en réel** : message Telegram entrant, appel d'outil
    `remember`, écriture relue dans `memory.db`. Ce qui, en v1.0.0, était déclaré comme
    limite (« jamais appelé le vrai fournisseur »).
  - **lecture des journaux d'un agent vivant** : se fier au fichier de journal, pas à un
    extrait de panneau qui peut être périmé — une conclusion erronée (« le bot n'a rien
    reçu ») a été produite exactement comme ça.
- **pourquoi** : trois incidents réels, un seul commun dénominateur — *un fait documenté
  pris pour un fait vérifié*. Un nom de modèle recopié depuis une doc a failli faire
  échouer le premier message de l'utilisateur ; une valeur SQL fausse mais silencieuse a
  fait passer six semaines un classement par pertinence inerte ; un extrait de journal
  périmé a fait conclure à un arrêt alors que l'agent répondait. Chacun devient ici un
  geste systématique (sonder, ordonner à l'envers pour prouver, lire la source) plutôt
  qu'une anecdote de plus.
- **remplacé / supprimé** :
  - *supprimés* : `llama-3.3-70b-versatile` et `llama-3.1-8b-instant` en tant que défauts
    recommandés — **8 occurrences**, y compris dans la capture de référence, `SKILL.md`,
    le `README.md` et le `ROADMAP.md` du projet. Non pas « dépréciés » : le compte visé ne
    les propose pas, la consigne était donc inapplicable telle quelle.
  - *remplacée* : l'étape d'installation qui faisait reposer la récupération du chat id
    sur la commande `/id` seule, désormais secondée par la lecture du journal (meilleure
    posture de sécurité, même résultat).
  - *reprise* : la limite « intégration fournisseur non prouvée » disparaît du rapport
    type — elle est prouvée depuis, et la maintenir serait fausse en l'autre sens.
- **impact sur la construction** : une génération d'agent n'est plus recevable sans
  `npm run check`, `check_invariants.py` à 14/14 **et** une sonde de modèles réussie ;
  `scaffold.py` produit désormais un projet qui contient `model-check.ts` et ses 7 tests ;
  la capture de référence est rafraîchie **par script** (`refresh_reference.py`, 44 fichiers)
  et non plus à la main, avec analyse anti-fuite qui refuse de publier un projet contaminé ;
  les chiffres du skill sont vérifiés mécaniquement par `detect_drift.py`.
- **preuve** : `check_invariants.py /home/user/opengravity` → `14/14` ; sur la capture
  d'**avant** correctif → `12/14` avec les deux nouveaux motifs qui nomment d'eux-mêmes les
  modèles morts ; fixture `/tmp/broken` → 10 violations ; `npm run check` sur OpenGravity →
  63/63, typecheck et build propres ; sonde sur nom bidon → refus listant les modèles
  proches, sans clé dans le message ; `detect_drift.py` après synchro → dérive résiduelle
  limitée aux chiffres du SKILL.md (depuis repris).
- **empreinte de référence** : 44 fichiers, tree `96579dbfdf15`

## v1.0.0 — 2026-09-02

- **à partir de** : rien — première version, écrite pendant la construction d'OpenGravity.
- **intégrations** : le squelette complet du skill. Architecture en couches (`core`,
  `tools`, `memory`, `security`, `llm`, `channels`) avec dépendances à sens unique ;
  liste blanche d'utilisateurs antérieure à tout handler ; `process.env` confiné à
  `config.ts` ; boucle d'agent bornée avec itération de clôture qui retire les outils ;
  schémas d'arguments fermés refusant les champs inconnus ; sorties d'outils encadrées
  comme données non fiables ; outil sensible impossible à enregistrer sans approbation
  humaine (garde dans le constructeur, pas dans l'appelant) ; générateur de projet
  `scaffold.py` ; vérificateur d'invariants à 12 règles ; capture de référence embarquée.
- **pourquoi** : chaque règle correspond à un défaut réellement rencontré pendant la
  construction — cadre anti-injection qui ne neutralisait rien, échappement HTML
  incomplet autorisant un `</a>` orphelin, mélange de paramètres `?` et `@nommés` faisant
  planter une requête, message d'erreur brut du fournisseur renvoyé dans la conversation.
- **remplacé / supprimé** : n/a. Écart connu dès l'origine : les noms de modèles par défaut
  n'avaient pas été confrontés au catalogue réel d'un compte (corrigé en 1.1.0), et la
  séparation `security`/`channels` n'était pas respectée avant que le vérificateur ne le
  fasse apparaître.
- **impact sur la construction** : le skill produit un projet compilé, testé et audité,
  plus un rapport qui écrit noir sur blanc **ce qui n'a pas été prouvé**.
- **preuve** : `quick_validate.py` → « Skill is valid! » ; génération de démonstration
  (`atlas`) typecheck propre et 56/56 ; fixture volontairement cassée → 9 violations
  détectées, code de sortie 1.
- **empreinte de référence** : 42 fichiers (capture d'origine, depuis remplacée)
