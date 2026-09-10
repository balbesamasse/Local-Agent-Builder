---
name: local-agent-builder
description: >-
  Construire, sécuriser ou étendre un agent d'IA personnel qui tourne en local et se pilote
  depuis un canal de messagerie (Telegram, WhatsApp, Slack) : liste blanche d'utilisateurs,
  boucle d'agent à itérations bornées, outils à arguments validés, mémoire persistante SQLite,
  fournisseur LLM principal avec secours automatique, approbation humaine des actions sensibles.
  Utiliser ce skill dès que l'utilisateur veut créer un assistant/agent personnel local, un bot LLM
  avec outils et mémoire, un clone ou une nouvelle itération d’OpenGravity, ajouter un outil, un canal,
  de la transcription audio (et la réponse en vocal) ou une mémoire persistante à un bot
  existant, de brancher un compte externe (Gmail, Drive, Docs, Sheets, Calendrier) sans ouvrir
  un accès libre au fournisseur, brancher un appel vocal en direct (page servie par l'agent, websocket, barge-in,
  oreille/bouche remplaçables), ou auditer la sécurité d'un
  tel agent. Déclencher aussi pour les formulations indirectes : « je veux un bot qui me répond sur
  Telegram et retient mes préférences », « sécurise mon agent », « mon agent peut exécuter n'importe
  quoi, comment je le borne », « passe mon agent sur Firebase/cloud ».
license: MIT
metadata:
  version: "1.8.0"
  basedOn: "implémentation de référence OpenGravity v0.2 (TypeScript/ESM, grammy, better-sqlite3, ws, Groq + OpenRouter, ElevenLabs voix et temps réel, supervision à trois étages)"
  statut: "évolutif — il reflète l'état validé du projet, pas sa version d'origine"
  protocoleDeMiseAJour: "references/evolution.md"
  historique: "CHANGELOG.md"
  empreinteDeReference: "91 fichiers · tree 991edf6a693a"
compatibility: >-
  Node 20.11+, npm, python3 3.9+ pour les scripts de vérification.
  L'implémentation de référence est en TypeScript/ESM ; les invariants, eux, sont
  indépendants du langage et s'appliquent aussi à un agent Python ou Go.
---

# Constructeur d'agents personnels locaux

Un agent personnel, ce n'est pas « un bot qui parle à une API ». C'est un programme qui
**lit du texte non fiable et peut agir**. Tout ce skill découle de cette phrase : chaque
capacité est une surface d'attaque, chaque capacité doit donc être déclarée, validée,
bornée et journalisée.

Ce skill produit un agent **terminé et prouvé**, pas un squelette décoratif :
projet qui compile, suite de tests verte, invariants de sécurité vérifiés par un
script, et un bot réellement joignable sur Telegram après avoir collé trois valeurs
dans `.env`.

## De quoi je dispose déjà

`assets/reference/` contient une implémentation complète : 91 fichiers, 11 326 lignes de
production, 5 261 lignes de tests, 65 clés de configuration, 12 commandes dont 10 au menu
Telegram, 5 tables (une colonne de préférence de voix **et** une colonne de canal par
message : ce qui répond à un appel n'arrive pas par le même tuyau), 233 tests dont 6
bout-en-bout, et deux branches optionnées : `src/audio/` (voix) et `src/google/`
(Workspace — 9 fichiers, 12 outils typés dont 5 sensibles derrière un clic).

Ces chiffres sont **contrôlés** par
`detect_drift.py`, qui compare ce que cette page annonce à ce que le projet fait — un
chiffre de doc n'est pas une décoration. La couche `src/audio/` (voix : transcription et
synthèse) y est, et le premier tour a été validé en réel sur
Telegram avec appel d'outil et écriture relue. La couche `src/google/` y est aussi, validée
jusqu'au refus : le vrai binaire `gws` est lancé, le vrai code de sortie est classé, la vraie
URL est construite (`--dry-run`), et le trajet complet question → modèle → outil → binaire →
modèle → Telegram a été parcouru par `npm run google:live`. Le skill ne réinvente pas : il **génère à
partir de cette base**, puis on personnalise. Quatre scripts l'accompagnent :

| Script | Usage | Sortie |
|---|---|---|
| `scripts/scaffold.py` | génère un projet neuf, renommé, sans secret ni base copiée | 0 + arborescence |
| `scripts/check_invariants.py` | vérifie les 22 invariants de sécurité du projet | 0 propre, 1 avec la liste des correctifs |
| `scripts/detect_drift.py` | compare le projet vivant à la capture du skill et aux chiffres qu'il annonce | 0 aligné, 1 avec le bump recommandé |
| `scripts/refresh_reference.py` | régénère la capture + l'empreinte, bump optionnel, refus d'un projet contaminé | 0 publié, 1 secret détecté |

## Déroulé

### Étape 0 — Cadrer en une fois (puis avancer)

Cinq questions, avec un défaut pour chacune. Si l'utilisateur répond « par défaut » ou
ne répond pas, on prend le défaut et on **le dit** — ne pas bloquer un projet sur une
question à trois secondes. Les réponses déterminent le nom, le canal, le modèle, les
outils et la durée de vie des données.

1. **Nom d'affichage** de l'agent ? (défaut : `Atlas`) — il apparaîtra dans le prompt
   système, `/start` et les journaux. Demander le nom : il sert aussi à éviter
   l'amalgame avec un projet existant.
2. **Canal** : Telegram en long polling (défaut : **aucun port écouté**) — ou webhook, CLI,
   WhatsApp/Slack via un pont. Un port est une décision, pas un détail : le webhook comme le
   mode appel vocal en direct ouvrent une surface, donc un drapeau de config, une écoute
   locale par défaut et une liste blanche confrontée à l'entrée (`listening-is-a-decision`).
   Avant de dessiner une fonctionnalité qui s'appuie sur le canal, vérifier **ce que ce canal
   transporte réellement** (un bot Telegram ne passe pas d'appel et ne streame aucun média) et
   l'énoncer à l'utilisateur dans la même respiration que la proposition.
3. **Fournisseur LLM** : Groq en principal avec un modèle de secours puis OpenRouter si
   une clé existe (défaut) — ou un modèle local (Ollama) via `GROQ_BASE_URL`, qui change
   `baseUrl` et rien d'autre. **Ne pas épingler un nom de modèle depuis la doc** : le
   catalogue est propre à chaque compte et bouge sans prévenir. La bonne séquence, avant
   d'écrire quoi que ce soit dans `.env` : `GET /v1/models`, retenir un id, puis **une
   complétion réelle avec `tools`** pour vérifier que le modèle sait appeler un outil
   (certains répondent à côté). `src/llm/model-check.ts` rejoue ce contrôle à chaque
   démarrage — un nom fantaisiste sinon ne se voit qu'au premier message de
   l'utilisateur, sous forme de 400 opaque après dix secondes de silence.
4. **Outils de départ** : horloge + mémoire (`remember`/`recall`/`forget`) +
   calculatrice (défaut, aucun risque). Un outil sensible (shell, fichier, achat,
   message à un tiers) demande `requiresApproval` — voir `references/security.md`.
5. **Mémoire** : SQLite local (défaut). Combien de temps on la garde ? Que se
   passe-t-il si le fichier est volé (il n'est pas chiffré) ?

Vérifier l'accès réseau et le contexte existant avant de promettre une étape : un dépôt
déjà présent se corrige sur place (`check_invariants.py` d'abord, `scaffold.py`
seulement pour un projet neuf).

### Étape 1 — Générer la base

```bash
python3 scripts/scaffold.py --name "Atlas" --out ../atlas --timezone "Africa/Bamako"
cd ../atlas && npm install && cp .env.example .env && chmod 600 .env
npm run check
```

`npm run check` enchaîne typecheck, suite de tests et build : si c'est vert, la base est
saine avant toute personnalisation. Le script refuse de copier `.env`, `memory.db*`,
`service-account.json` et scanne la sortie à la recherche de valeurs type clé : une
génération qui trouverait un secret **s'annule elle-même**.

Options : `--no-tests` (démarrage minimal, sans suite de tests), `--force` (ecrase).

### Étape 2 — Choisir les capacités

C'est la seule étape vraiment créative. Lire `references/blueprint.md` pour le plan
fichier par fichier, puis pour chaque outil voulu :

- il a une `description` qui dit **quand** l'appeler (le modèle ne voit que ça) ;
- ses arguments sont validés par un spec, champs inconnus refusés ;
- sa sortie est bornée (`maxOutputChars`) et encadrée comme donnée non fiable ;
- si elle est irréversible ou coûteuse : `requiresApproval: true, dangerous: true`.

Le registre refuse d'enregistrer un outil `dangerous` sans `requiresApproval` — cette
vérification est dans le **constructeur**, donc aucun futur appelant ne peut l'oublier.
Ne pas retirer ce garde-fou pour « aller vite » : c'est lui qui a empêché, sur
l'implémentation de référence, qu'un outil sensible soit branché sans accord humain.

Pour un outil déjà écrit dans le projet modèle qui ne sert à rien ici : le **retirer**.
Une capacité inutilisée est une surface d'attaque inutilisée.

Pour brancher une **API externe** (mail, disque, agenda, paiement) : ne jamais exposer le
client, exposer des **opérations**. Douze outils nommés et typés plutôt qu'un `google_request`,
un service autorisé par liste blanche de config (`GWS_SERVICES`, refus au démarrage si un nom est
inconnu ou la liste vide), et le contrat `docs/GOOGLE.md` du projet : environnement du fils filtré,
rien sur disque, refus expliqué avec la commande qui répare. Détail et contre-exemples dans
`references/security.md`.

Une capacité dont **le moyen d'accès** existe se déclare même si l'état du compte empêche de
répondre : le retrait rend le refus invisible à l'usage et impose un redémarrage après chaque
réparation. Ce qui n'existe pas (binaire absent, service hors liste) se retire ; ce qui existe mais
refuse se nomme, s'explique et se diagnostique (`/google`, `npm run google:check`).

### Étape 3 — Faire parler le bot

1. @BotFather → `/newbot` → token dans `.env`.
2. Déterminer l'identifiant numérique, **par le journal de préférence** : démarrer avec
   `TELEGRAM_ALLOWED_USER_IDS="0"`, écrire une fois au bot, lire la ligne
   `accès refusé {"userId":…}` — la liste blanche enregistre l'expéditeur de tout refus.
   Alternative : `/id`, qui répond hors liste blanche — donc à couper juste après.
3. Reporter l'identifiant dans `.env`, s'assurer que `TELEGRAM_ID_COMMAND_ENABLED=false`,
   redémarrer : après installation, la liste blanche doit être la seule porte d'entrée.
4. Test fonctionnel : « quelle heure est-il ? » (outil horloge), « retiens que… » puis
   `/memory` (persistance vérifiée dans le fichier), « combien font 18 % de 249 ? »
   (calculatrice, pas de calcul mental du modèle).

### Étape 4 — Vérifier, ou ce n'est pas fini

```bash
npm run check
python3 scripts/check_invariants.py .
```

Puis **les trois preuves qui comptent**, détaillées dans `references/verification.md` :

- un **test bout-en-bout** qui démarre le vrai processus contre un faux serveur de canal
  et un faux fournisseur LLM. C'est lui qui a prouvé qu'un expéditeur non autorisé ne
  déclenche *aucun* appel LLM ; il a aussi révélé quatre bugs que chaque test unitaire
  laissait passer ;
- **relire le fichier de données** après un tour (SQLite en lecture seule) : la mémoire
  est soit persistée, soit inexistante. « Ça a l'air de marcher » ne suffit pas ;
- **tuer le processus pour de vrai** : `kill -9` sur l'enfant (il doit repartir), `SIGTERM`
  sur le superviseur (il doit *ne pas* relancer et libérer son verrou), second superviseur
  lancé en parallèle (refus, code `78`). Une politique de reprise testée uniquement sur des
  faux enfants garde des inverses de règle intacts — c'est comme ça qu'un bot « réparé »
  restait mort après un `kill -9` alors que 110 tests étaient au vert.

Sur l'implémentation de référence, les tests ont trouvé : un cadre anti-injection qui
ne neutralisait rien, un échappement HTML incomplet qui autorisait un `</a>` orphelin,
un mélange de paramètres SQL qui faisait planter une requête, et un message d'erreur
brut du fournisseur renvoyé dans la conversation. Écrire les tests **après** le code
n'a de valeur que si on les croit quand ils échouent.

### Étape 5 — Livrer

```
## Rapport
Projet      : <chemin>, <n> fichiers, npm run check : <résultat brut>
Sécurité    : check_invariants : <X>/22 invariants — <liste des écarts restants>
Outils      : <noms> — sensibles : <noms ou « aucun»> ; approuvés par clic : oui/non
Bout-en-bout: <résultat des tests d'intégration>
Branchements: <ce qui reste à faire côté utilisateur : token, ID, clé API>
Démarrage   : <commande à laisser tourner — `npm run supervise`, pas `npm run dev`>
Limites      : <ce qui n'a PAS été prouvé ici, ex. appel réel au fournisseur>
```

Toujours écrire la ligne **Limites**. Un agent qui n'a jamais appelé le vrai fournisseur
(« testé contre un double scripté ») n'est pas « intégré et validé » ; le dire évite à
l'utilisateur un appel coûteux surprise ou une erreur de modèle introuvable.

## Ce qui ne doit jamais bouger

| Invariant | Pourquoi |
|---|---|
| Liste blanche avant tout handler | sinon n'importe qui pilote l'agent et vide le quota |
| `process.env` lu dans `config.ts` — exceptions : le bootstrap du superviseur (à condition qu'il enregistre les secrets à masquer) **et** le filtreur d'environnement d'un transport fils (à condition que l'env du fils sorte réellement du filtre) | la validation et le masquage des secrets n'ont qu'un point ; et un fils construit sur `{ ...process.env }` hérite des clés de l'agent, y compris d'un `GOOGLE_APPLICATION_CREDENTIALS` dont la seule présence casse l'outil qu'on vient de lancer |
| `core/`, `tools/`, `memory/` n'importent pas le canal | sinon changer de canal = réécrire le raisonnement |
| Aucun `eval`, `new Function`. `child_process` réservé au superviseur **et** à un transport métier marqué `invariant: exec-transport`, qui doit prouver dans son code `shell: false` et un environnement issu du filtre | le LLM ne doit jamais choisir le code exécuté ; un binaire métier installé, lui, peut l'être — mais la levée se contrôle dans le code, jamais dans un commentaire qui dirait « ici on filtre » |
| Arguments validés, champs inconnus refusés | `{chatId: 999}` injecté ne doit pas écrire chez autrui |
| Boucle bornée + retrait des outils en fin de boucle | un modèle qui boucle coûte indéfiniment |
| Sorties d'outils encadrées comme données | un fichier lu ne doit pas devenir une consigne |
| Secret jamais loggé ni renvoyé | le message d'erreur du fournisseur peut contenir la requête |
| Tout ce que `.env.example` promet est lu ; tout ce qui est lu est promis | une clé fantôme fait remplir des champs inutiles, une clé oubliée fait un bot muet |
| Un modèle épinglé est vérifié contre le catalogue du compte | un nom recopié d'une doc n'est pas une garantie ; l'erreur arrive chez l'utilisateur, pas chez nous |
| Un agent destiné à tourner des jours est gardé, journalisé sur disque, et son code de sortie est un contrat (`0`/`75`/`78`) ; un `0` n'est un arrêt voulu que si l'enfant a duré ; et le gardien a un gardien, qui **répare** (dépendances, build) avant de relancer | sinon « il s'est arrêté tout seul » n'a ni cause ni reprise possible — et un « arrêt propre » inventé par le père laisse le bot mort en silence |
| Toute commande d'un canal est enregistrée avant son handler texte, et menu + aide sont dérivés d'une seule liste | grammy applique les filtres dans l'ordre : une commande avalée ne plante pas, elle répond à côté ; un menu recopié à la main, lui, fait une commande qui n'existe pas |
| Une sélection payante ne déclenche aucun appel payant (voix, modèle, langue) | l'exploration ne doit pas consommer le budget que l'utilisateur a plafonné |
| Un port écouté est **déclaré** : sous `src/realtime/`, avec mention `LISTEN-EXCEPTION:`, bascule de config et liste blanche à la poignée de main | « aucun serveur » est la promesse d'un agent local ; l'entorse licite (appel vocal) doit être coupable nommément, sinon elle devient une habitude |
| Une page qui ouvre un micro ne charge rien d'ailleurs, et ne reçoit le média par le canal de messagerie | un CDN = un bot muet derrière un pare-feu ; et l'API Bot ne transporte pas de média temps réel — le canal doit être à l'agent |
| Tout champ d'une interface de contrat (`ToolResult`, `AgentReply`) a un lecteur, contrôlé par `contract-fields-read` | un champ produit et jamais lu est une promesse fausse : l'agent écrivait ses explications de refus dans `userNotice`, que le canal jetait |
| Une API externe ne s'expose **jamais** par un outil passe-plat (`google_request`, `run_command`-like) : opérations enregistrées, arguments typés, service hors liste blanche refusé au démarrage | un passe-plat redonne au modèle la surface d'argv qu'on vient de fermer ; et une capacité qui ne se lit pas dans une liste de douze lignes n'est pas auditable |
| Une écriture n'est jamais rejouée, et un timeout n'est jamais rejoué non plus | sur déconnexion on ignore si l'effet a été appliqué : rejouer un envoi double l'action ; rejouer un timeout repaie le budget déjà consommé — un refus franc vaut mieux qu'un insistant |

Le détail, les contre-exemples et les correctifs : `references/security.md`.

## Le skill évolue avec le projet

Ce skill n'est la photo d'aucun jalon : il doit représenter **le meilleur état validé**
du projet — y compris ce que la version courante a rendu faux dans les sections précédentes. Le contrat, quand une évolution est retenue :

```bash
python3 scripts/detect_drift.py --project ../opengravity   # ce qui a changé, et où le dire
# décider si la règle du skill doit changer (la plupart du temps : non)
python3 scripts/refresh_reference.py --project ../opengravity --bump minor --summary "…"
python3 scripts/detect_drift.py --project ../opengravity   # attendu : plus rien, ou des chiffres
```

Quatre règles commandent le reste, détaillées dans `references/evolution.md` : une décision
validée **remplace** la règle qu'elle contredit au lieu de s'y ajouter ; rien n'entre dans
le skill qui n'ait été éprouvé (une règle de vérification qui n'a jamais échoué est
décorative) ; le bump est `patch`/`minor`/`major` selon que l'évolution touche un chiffre,
une capacité, ou la philosophie ; chaque entrée de `CHANGELOG.md` cite sa **preuve**.

## Étendre

Canaux, fournisseurs, outils sensibles, cloud (Cloud Run/Firebase, où `Store` devient
une interface), audio (Groq Whisper, ElevenLabs) : `references/extending.md`. Les
dettes connues à solder avant le multi-instance (file par conversation et rate-limit en
mémoire) y sont listées — c'est le piège le plus probable d'une migration « ça
marchait en local ».
