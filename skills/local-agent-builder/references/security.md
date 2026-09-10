# Invariants de sécurité

Dix-sept règles, chacune vérifiée par `check_invariants.py`. Elles ne sont pas
esthétiques : chaque ligne correspond à un défaut rencontré en construisant
l'implémentation de référence, avec sa conséquence concrète.

## 1. `deny-by-default`, avant tout le reste

```ts
bot.use(allowlistMiddleware(config));   // puis les commandes, puis les handlers
```

Un update dont l'auteur n'est pas dans la liste ne doit **pas** atteindre le LLM, la
mémoire, ni un outil. Trois détails comptent :

- la décision est une fonction pure (`authorize`) : le refus est identique quel que
  soit le canal, donc testable sans Telegram ;
- le message de refus est générique (`Message non traité.`) : « vous n'êtes pas
  autorisé » confirme à un attaquant qu'un bot réel écoute et pourquoi il échoue ;
- un `from.id` **signé par le fournisseur du canal** est la seule identité admise.
  Un ID passé dans le texte du message, un @username, un champ `user_id` dans un
  payload JSON : aucun de ces trois-là n'est une identité.

Un @username est revendable, un identifiant numérique non : la liste blanche porte des
entiers.

## 2. Config nulle part ailleurs

`process.env` n'apparaît que dans `config.ts`. Sinon une clé est lue à trois
endroits, validée à zéro, et se retrouve dans un log par un chemin non audités.
Le projet modèle enregistre les secrets auprès du logger (`registerSecrets`) **avant**
le premier log, avec un filet regex sur les motifs `gsk_…`, `sk-or-…`, `\d{8,}:…` :
une valeur non déclarée reste masquée.

`process.env` se lit aussi pour **filtrer** ce que recevra un processus fils — un transport
d'API externe ne peut pas passer par `AppConfig` sans que les secrets de l'agent y entrent. La
levée (`// invariant: env-enfant`) exige la même preuve structurelle que la règle
« aucune exécution » : l'environnement du fils sort d'un filtre, et aucun objet d'environnement
n'est un étalement du père. Un préfixe d'environnement est une **autorisation**, pas un filtre :
transmettre `GOOGLE_*` en bloc faisait passer `GOOGLE_APPLICATION_CREDENTIALS`, dont la seule
présence invalide l'authentification du CLI Google (il cherche un compte de service qui n'existe
pas et échoue avant de regarder ses propres credentials). Le projet ne définit donc pas cette
variable, et le transport signale un pointeur mort au démarrage, dans `/google` et dans le doctor.

Une autre exception, assumée : le **bootstrap du superviseur** (`src/supervise.ts`) lit
`process.env` avant toute config validée, puisqu'il doit connaître le chemin de son journal
et le nom du fichier de verrou pour exister. L'exception est conditionnelle et vérifiable :
ce fichier doit appeler `registerSecrets` sur les variables qu'il hérite, sinon son journal
de décisions de relance recopierait le token du bot à chaque ligne.

## 3. Sens des dépendances

`core/`, `tools/`, `memory/`, `security/` n'importent ni `grammy`, ni un module de
`channels/`. Cette règle est ce qui rend le passage à un second canal ou à un cloud
possible sans réécrire le raisonnement. Elle a été violée pour un simple
`import type { MiddlewareFn }` — un type suffit à coupler : la décision de sécurité se
retrouvait inféodée à Telegram.

## 4. Aucune exécution de code

Interdits : `eval`, `new Function`, `vm`, et tout `import()` dont le chemin vient d'une
chaîne — ces trois-là ne se lèvent jamais. `child_process` a deux tolérances, chacune
assortie de contreparties **contrôlées dans le code** :

1. le **superviseur**, qui lance le point d'entrée de l'agent : pas de `shell: true`, pas
   d'`execSync`, pas d'`execFile` avec shell, et la commande enfant sort d'un parseur de
   flags (`--command`), jamais d'un texte fourni par le modèle ;
2. un **transport métier** — un module dont le seul rôle est de lancer un binaire installé
   (le client `gws` de Google Workspace, par exemple). Il doit porter le marqueur
   `// invariant: exec-transport` **et** respecter, dans son code et non dans ses
   commentaires : `shell: false`, un environnement fils produit par un filtre
   (`childEnvironment(…)`), et l'interdiction d'aucun étalement du père
   (`{ ...process.env }`). argv est un tableau de jetons, jamais une ligne construite à partir
   de ce que le modèle a dit. Une calculatrice « pratique » écrasée en trois lignes
(`new Function(expr)`) est une exécution de code arbitraire dont le LLM — ou le texte
qu'il lit — choisit la chaîne. Le projet modèle lui préfère un parseur récursif fermé
(déclarations d'expressions, opérateurs, fonctions nommées dans une table explicite) :
environ 200 lignes, et `process.exit(1)` y est une erreur de parsing, pas une exécution.

## 5. Valider les arguments, refuser l'inconnu

Le JSON des `tool_calls` sort d'un modèle. Le schéma est dérivé du même objet que la
validation (impossible de déclarer un champ que la validation rejetterait), et tout
champ absent du spec est refusé. Sans ce refus, un prompt injecté ajoutant
`{"chatId": 999}` à un outil d'écriture peut cibler la conversation d'un autre
utilisateur. Le message d'erreur est renvoyé **au modèle** — il se corrige presque
toujours à l'itération suivante, ce qui coûte un appel LLM et non un plantage.

## 6. Liste close de capacités

Un outil s'enregistre dans `buildRegistry()`. Pas de découverte, pas de plugin chargé
depuis le disque, pas de nom de module calculé. Le modèle peut donc seulement nommer
ce qui existe ; un nom inventé (`read_file`) est refusé et journalisé. C'est la
différence entre « l'agent peut faire 5 choses » et « l'agent peut faire ce qu'un
texte qu'il lit décide de lui faire faire ».

## 7. Boucle bornée, et fin forcée

`AGENT_MAX_ITERATIONS` borne le nombre d'appels ; `AGENT_FORCE_FINAL_ITERATION` retire
la liste d'outils à partir d'une itération donnée pour que la sortie soit une réponse,
pas un message d'erreur. Deux bornes parce que l'une sans l'autre laisse l'utilisateur
avec un échec.

## 8. Données ≠ instructions

Toute sortie d'outil et tout bloc de mémoire passent par un cadre :

```
<BEGIN_TOOL_OUTPUT_get_current_time> … <END_TOOL_OUTPUT_get_current_time>
```

avec neutralisation du chevron ouvrant de toute occurrence d'un marqueur dans la charge
utile. Cette neutralisation est la partie qu'on écrit vite et qu'on teste mal : dans le
modèle, `payload.replace(/<\/?(BEGIN|END)_/gi, '<$1_')` **ne changeait rien** (le
remplacement réémettait le chevron). Un test qui vérifie « le cadre ne peut pas être
fermé depuis l'intérieur » est le seul qui valide cette ligne.

## 9. Approbation humaine pour l'irréversible

`requiresApproval: true` ⇒ l'outil n'est pas exécuté sur la seule parole du LLM. Le
flux, et ses trois garde-fous :

- le ticket est lié à `chat_id` **et** `user_id` : ni un autre utilisateur autorisé, ni
  un autre chat ne peut le consommer ;
- un jeton aléatoire, stocké **sous forme d'empreinte** et effacé avant exécution : un
  double-clic ou une capture du bouton ne rejoue rien ;
- TTL court (défaut 15 min) et jeton non persisté en clair : un redémarrage invalide
  les demandes en attente — jamais l'inverse.

Et l'invariant d'enregistrement : `dangerous: true` impose `requiresApproval: true`,
vérifié dans le **constructeur** du registre. Placé dans l'appelant, il eût suffi qu'un
futur `buildRegistry2()` l'oublie.

## 10. Sorties bornées

`maxOutputChars` par outil (défaut 1200), plus une troncature à l'écriture de l'audit.
Une sortie de 200 ko dans le contexte coûte le quota du jour et fait divaguer les
modèles 8B.

## 11. Secrets hors des réponses et des journaux

Le message d'erreur d'un fournisseur peut contenir des éléments de la requête. La
règle : **journaliser le détail, renvoyer une phrase générique**. Le projet modèle
disait `Je n'ai pas pu interroger le modèle (${error.message})` — un test a montré
que la chaîne remontait telle quelle jusqu'à Telegram. Remplacé par un message
neutre ; le `error.message` complet part dans le log scrubé.

## 12. Traçabilité

`tool_calls` (qui, quoi, quand, statut, durée) est écrit **à chaque refus** aussi : un
`denied` pour outil inconnu est le signal le plus précoce d'une tentative d'injection
réussie au niveau du prompt et ratée au niveau du registre. Sans journal, on ne le
voit jamais.

## 13. `env-doc-sync` — le contrat de configuration ne ment nulle part

Deux moitiés, toutes deux mécaniques : toute clé que `src/config.ts` lit doit apparaître
dans `.env.example`, et toute clé de `.env.example` doit être lue — sauf annonce explicite.
Un fichier d'exemple est un **contrat d'installation** : une clé fantôme y fait remplir un
champ qui ne servira jamais, une clé oubliée produit un bot qui démarre et ne répond pas.

L'échappatoire est typée, pas absente : une clé volontairement non câblée (une intégration
future déjà déclarée pour que `.env` reste la source unique) porte la mention
`non câblée` dans son bloc de commentaires, et la règle l'accepte. Sans mention, la règle
sonne. C'est ce qui a fait apparaître `GOOGLE_APPLICATION_CREDENTIALS` comme dette assumée
au lieu d'un silence.

Le piège de fabrication, rencontré en écrivant cette règle : collecter toute chaîne
`MAJUSCULE` en premier argument d'appel credit `token.startsWith('REMPLACEZ_PAR_LE_VOTRE')`
pour une lecture de config, et proclamer une violation inventée. Filtrer les méthodes de
comparaison (`startsWith`, `includes`, `match`…) plutôt que d'énumérer les noms de nos
helpers : une règle qui suppose l'API actuelle casse au premier refactor, ce qui est
particulièrement grave pour une règle chargée de détecter les refactors.

## 14. `model-inventory-probe` — un modèle épinglé suppose une sonde

Si `config.ts` contient une valeur par défaut pour une clé `*MODEL`, alors une requête
d'inventaire (`GET <base>/models`) doit exister quelque part dans les sources de production
**et** être importée par `src/index.ts`. Cette dernière condition est la seule qui compte :
un module de vérification que personne n'appelle est du code mort qui rassure.

Pourquoi un invariant et pas un conseil : le coût d'un nom de modèle erroné n'est pas
supporté par celui qui l'écrit, mais par l'utilisateur final, devant un bot muet. La sonde
déplace l'échec du premier message vers le démarrage, où le journal est lu.

## 15. `media-no-residue` — ce qui est reçu ne s'écrit pas

Un agent qui transcrit des vocaux fait passer des conversations privées par son
disque. La recette intuitive — « on télécharge dans un fichier temporaire, on
supprime dans le `finally` » — est une **promesse**, pas une propriété : elle se brise
à la première exception mal placée, au refactor qui oublie le bloc, au `.gitignore`
qui ne couvre pas le mauvais dossier. Le contrôle réel est l'absence d'API d'écriture
dans `src/` (`writeFileSync`, `createWriteStream`, `openSync`), SQLite écrivant son
propre fichier sans qu'on y touche.

La portée exacte de la règle est **les octets reçus ou produits** : un journal applicatif
et un fichier de verrou d'instance sont des écritures légitimes, et les interdire avait pour
seul effet de pousser l'agent à être muet sur sa propre mort. Le contrôle n'est donc pas
« aucune écriture dans `src/` » mais « aucune écriture *non déclarée* » : chaque fichier
autorisé porte une mention `DISK-WRITE-OK:` qui explique ce qu'il écrit, et le vérificateur
refuse l'exception sans la mention. Un fichier qui se met à écrire du media sans le dire
tombe quand même.

Un flux **entrant** continu (l'appel vocal en direct) tombe sous la même règle : les cadres
de micro vivent dans un anneau en mémoire et meurent avec la session — rien n'est écrit « au
cas où l'on voudrait réécouter ». La page qui le reçoit ne peut même pas tricher : elle
n'enverrait de toute façon rien à un serveur de fichiers.

Si une rétention de media est un jour décidée, elle se **décide** : module dédié hors couche
canal, dossier ajouté au `.gitignore`, nettoyage prouvé par un test. Et la doc qui dit
« rien sur disque » est corrigée le même commit — une règle inapplicable vaut mieux
qu'une règle fausse.

## 16. `media-download-bounded` — le `file_path` vient d'ailleurs

`getFile()` renvoie un chemin choisi par le service de fichiers, pas par nous. Trois
choses sont exigées du module qui fait le `fetch` (et de lui seul — l'exiger de chaque
fichier mentionnant `file_path` ferait hurler la règle sur le code qui se contente de
transmettre, et une règle qui hurle toujours finit désactivée) :

- une **garde de forme** appelée, pas seulement définie : `if (!isSafe(path)) throw`,
  jamais `files/../../etc/passwd`, jamais un autre hôte ;
- `redirect: 'manual'` : un chemin qui redirige est un chemin qui sort du périmètre ;
- **deux plafonds comparés** : la taille annoncée (`content-length`, souvent masquée)
  puis la taille lue réellement — l'en-tête seul se ment gratuitement.

Le module ne renvoie que le statut HTTP : l'URL de téléchargement contient le token du
bot, donc un message d'erreur qui la recopie a fait fuiter la clé du compte.

**Ne pas lister blanchement la forme du jour.** La première version de cette garde
n'acceptait que `files/<nom>.<ext>` ; elle a refusé les vocaux réels d'un utilisateur
(`files/AgentAudioFile/…`, horodatages en `19:32:00`). Le risque n'a jamais été une
nomenclature inconnue mais une sortie de racine — donc on refuse ce qui sort (absolu,
`..`, double slash, point en tête de segment, deux-points en tête, caractères hors
`[A-Za-z0-9._/:-]`) et on ne promet aucune liste de préfixes valides. Un motif de refus
est journalisé **sans** le nom complet : les chemins Telegram portent parfois le nom
d'origine du fichier.

## 17. `voice-decision-input` — la sortie ne pilote pas l'entrée

Décider de parler (et donc d'appeler un fournisseur facturé à la caractère) à partir
d'un texte que le modèle vient d'écrire, ou d'une légende reçue en clair, revient à
donner à l'expéditeur un déclencheur d'appels payants. La détection du mode vocal ne
voit **que** le message de l'utilisateur autorisé. C'est le principe « données ≠
instructions » appliqué au budget : la boucle de contrôle ne lit jamais son propre
effet.
## 18. `supervised-and-guarded` — un agent qui doit tenir des jours est relevé

Un bot Telegram n'a pas de spectateur : il tourne pendant que l'utilisateur dort, et son
« il s'est arrêté tout seul » arrive sans témoin. Sept propriétés, aucune optionnelle :

- **journal sur disque**, en plus de stdout. Le stdout meurt avec le processus ; un agent
  qui n'a que lui efface sa propre cause. Écriture en `appendFileSync` (rien à-flusher au
  moment où le processus est en train de mourir), droits `600`, rotation bornée (4 Mio, une
  archive) — un journal infini est un incident de disque annoncé.
- **garde d'os** : `unhandledRejection` journalisé et **survécu** (Node 20 le considère
  fatal par défaut ; un `.catch()` oublié sur une écriture de log ne doit pas tuer le
  service), `uncaughtException` journalisée avec sa trame puis sortie **immédiate** — on ne
  sait pas dans quel état on est, ce n'est pas un `catch` qui fait semblant de réparer.
- **les codes de sortie sont une interface** : `0` arrêt voulu, `75` panne temporaire
  (relancer), `78` configuration invalide (ne pas relancer). Sortir en `1` dans les deux cas
  rend n'importe quel repreneur aveugle : il relance éternellement un bot mal configuré.
- **verrou d'instance** : deux pollers sur le même token reçoivent un `409 Conflict` et
  meurent. Le verrou se reprend si le pid détenteur est mort, sinon un crash condamnerait le
  bot jusqu'à une suppression manuelle.

Le backoff est exponentiel plafonné (1 s, 2 s, 4 s… 60 s, puis 5 min) : une panne de
fournisseur durable ne se soigne pas à coups de requêtes par seconde.

**Un code 0 n'est un arrêt voulu que s'il a duré.** La première version traitait `0` comme une
preuve d'intention et se trompait dans un cas très précis et très laid : un enfant qui meurt en
vingt millisecondes n'a pas décidé de s'arrêter, il n'a **jamais démarré**. C'est comme ça qu'un
lanceur écrit `--command node --env-file=.env dist/index.js` (la collecte des arguments s'arrête
au premier `--`, donc l'enfant fut `node` seul, qui lit un stdin fermé et rend `0`) a produit un
superviseur parfaitement poli — « pas de relance, code 0 » — pendant que le bot n'existait pas.
La décision devient donc `shouldRestart(code, arrêtDemandé, politique, duréeDeVie)` : sur `0`, on
ne relance que si `duréeDeVie < unhealthyRunMs`, et on l'écrit en `WARN` avec la commande exacte,
parce que « l'enfant n'a pas démarré » sans la commande est un message qu'on relit sans rien voir.

**Et qui garde le gardien ?** Rien, par défaut : le superviseur n'a personne au-dessus de lui, et
sa mort est silencieuse (un `kill -9` qui le choisit lui, un OOM, une session qui tombe). Le
projet ajoute un troisième étage, `scripts/keepalive.sh`, réduit à une question : le verrou
`logs/supervisor.pid` désigne-t-il un processus vivant ? Deux propriétés de cet étage valent
d'être écrites parce qu'elles ont coûté :

- il **ne lit aucune intention** dans la mort du superviseur (la même règle qu'au premier étage,
  appliquée à soi-même) : il relance, point ;
- il **réape avant de relancer** : un superviseur tué de l'extérieur laisse son agent orphelin,
  l'orphelin tient encore le port, et le nouvel agent échoue en `EADDRINUSE` → code 75 → palier
  de backoff de plus → plusieurs minutes de silence. Tue l'orphelin, **attends sa mort réelle**,
  puis démarre.
- il **répare avant de relancer** : vérifier que le superviseur est vivant ne suffit pas, il
  faut vérifier qu'il **existe**. `node dist/supervise.js` sur un `dist/` absent échoue en
  `MODULE_NOT_FOUND` dans la milliseconde, et la boucle relance alors une commande morte toutes
  les 20 s — un journal impeccable, et aucun bot. La réparation d'environnement (dépendances,
  build) est bien la responsabilité du superviseur, mais elle ne peut pas être *la sienne*
  quand c'est lui le fichier manquant. D'où la règle : chaque étage répare celui du dessus,
  puis le démarre.

Ce troisième étage doit aussi être la seule chose bête du dispositif : pas de build, pas de
config, pas de logique métier — un `ps` et un `kill -0`. Et il reconnaît ses processus à leur
ligne de commande exacte (`pgrep -x node` puis filtre), jamais à un `pkill -f dist/index.js` :
un tueur qui matche n'importe quelle ligne de contenant ce texte signe des arrêts de mort contre
le shell de celui qui cherche le processus.

## 19. `commands-reachable` — une commande déclarée doit être joignable

Un handler enregistré après un `bot.on('message:text')` généraliste **ne s'exécute
jamais** : grammy applique les filtres dans l'ordre d'enregistrement et le premier qui
matche garde la mise à jour. Le bot modèle avait un `/voice` écrit, documenté dans `/help`,
annoncé dans le menu Telegram — et mort : chaque `/voice` partait tel quel au LLM, qui
répondait à côté. Corrigé, le même `/voice` est réapparu sous une autre forme : le handler
répondait, plus personne ne le voyait, parce que `setMyCommands` était recopié à la main
dans le bootstrap et avait oublié l'entrée. Le vérificateur contrôle donc trois choses :

- tout `bot.command('x')` d'un fichier de canal est enregistré **avant** le handler texte
  qui avale tout (`bot.on('message')`, `bot.on('message:text')`) ;
- le menu déclaré (`setMyCommands`) ne promet aucune commande qu'aucun handler n'enregistre ;
- tout handler enregistré figure dans la liste partagée du canal qui alimente menu **et**
  aide — le menu ne peut pas contenir de commande à paramètre, `/memory` passe donc par
  `/help`, mais l'une sans l'autre est une faute. Une commande n'a le droit d'être
  totalement hors menu que si son handler est lui-même derrière un drapeau (`/id` l'est).

Ce n'est pas une coquetterie d'ordre ni de menu : une commande morte ou invisible n'émet
aucune erreur. La première se manifeste comme un caprice du modèle, la seconde comme un
caprice de l'utilisateur — « la commande n'existe pas, tu l'as pourtant écrite ».



## 20. `listening-is-a-decision` — un port écouté est une décision nommée

Un agent local promet de ne rien écouter. Ouvrir un port, c'est faire entrer le réseau local
dans la confiance de l'utilisateur : n'importe qui sur le Wi-Fi se retrouve face à une surface
qui, ici, **tient un micro**. Le mode appel vocal en direct a eu besoin de le faire —
l'API Bot de Telegram ne transporte aucun média d'appel (les types d'appel ont été retirés de
l'API Bot en 2022 ; les appels sont réservés aux comptes utilisateurs), donc la page d'appel
doit être servie par l'agent lui-même. L'exception est licite. Elle n'est jamais **gratuite**.

Le vérificateur exige donc quatre choses de tout fichier qui appelle `createServer()` ou
`server.listen()` :

- vivre sous `src/realtime/` (ou être le point d'entrée, qui ne fait que déléguer) : **un seul
  endroit du projet décide d'écouter**, et un seul port est écouté — multiplier les ports
  multiplie les surfaces sans multiplier les contrôles ;
- porter la mention `LISTEN-EXCEPTION:` avec son motif, ses bornes et son éteignoir ;
- être coupée par une bascule de config (`REALTIME_ENABLED`, `false` par défaut) **lue avant**
  `listen()` — un drapeau lu après ne coupe rien ;
- confronter la liste blanche d'utilisateurs à la **poignée de main** : un port ouvert sans
  porte d'entrée, c'est un micro offert au LAN.

Le motif de détection est volontairement étroit. La première version de la règle cherchait
`.listen(` et hurlait sur `hub.listen()`, `realtime.listen()` et le wrapper de câblage — trois
faux positifs sur du code qui ne fait qu'appeler la méthode d'un objet. Une règle qui crie tout
le temps est ignorée au bout de deux semaines, donc fausse : on a resserré sur le `listen()`
d'un serveur, et le faux positif a disparu.

Ce que la règle ne couvre pas, et qui doit être dit : elle vérifie la **déclaration**, pas la
qualité du bornage (TTL d'un billet, usage unique, budget de débit vivent dans des tests
comportementaux, pas dans un `grep`).

## 21. `call-page-isolated` — la page qui tient le micro ne dépend de rien

Une page d'appel est une surface d'attaque et un point de panne. Trois exigences, contrôlées
sur le fichier qui appelle `getUserMedia` :

- **aucune ressource externe** (`src`/`href` en `http(s)`, `@import`, `@font-face`) : script,
  styles et AudioWorklet sont embarqués, le worklet étant chargé en `blob:`. Une dépendance
  CDN, c'est un agent muet derrière un pare-feu ou une connexion captive ;
- un CSP durci (`default-src 'none'; script-src 'unsafe-inline' blob:`) et
  `Permissions-Policy: microphone=(self)` — nommer le micro dans la politique, sinon le
  navigateur peut le refuser dans un contexte imbriqué ;
- HTTPS ou `localhost` : hors ces deux cas, `getUserMedia` est refusé, et le refus vient du
  navigateur, pas de nous — d'où l'écoute par défaut sur `127.0.0.1` et le reverse-proxy
  assumé **devant** l'agent, pas dedans.

La vérification est **statique** ici (aucun navigateur dans l'environnement de développement) :
le `<script>` et le worklet sont extraits puis passés au parseur pour prouver qu'ils se
compilent, et l'absence d'URL externe est vérifiée par le texte. Le rendu réel dans
l'application Telegram reste à valider à la main ; l'écrire dans les limites du livrable vaut
mieux que de le deviner.
## 22. `contract-fields-read` — un champ de contrat doit avoir un lecteur

Un champ d'interface que personne ne lit n'est pas un champ : c'est une promesse fausse.
Le projet modèle a porté ce défaut : `ToolResult.userNotice` était déclaré, documenté
(« message affiché tel quel à l'utilisateur »), rempli par chaque outil en refus — et jeté par
le canal, qui n'envoyait que `text`. Chaque utilisateur voyait donc une réponse polie qui
contournait le problème au lieu de la ligne de commande qui le réparait.

Deux corrections, dans cet ordre : lire le champ (le canal l'affiche dans son propre message — un
avis opératif ne se mélange pas à la réponse, sinon il est lu à voix haute pendant un appel), ou
**le retirer de l'interface**. La règle est vérifiée par `check_invariants.py` sur les interfaces
de contrat (`ToolResult`, `AgentReply`) : un champ sans lecteur fait tomber l'invariant.

Le même contrôle a un effet secondaire utile : il empêche de « réparer » un défaut en ajoutant un
champ que personne ne consultera.

## 23. Brancher une API externe : des opérations, pas le client

Un accès Gmail/Drive/Docs/Sheets/Calendrier est une capacité, pas un outil. Ce que le projet
modèle impose, et pourquoi :

- **le modèle ne nomme que des opérations enregistrées** (`gmail_search`, `sheets_append`, …) :
  chaque outil a son schéma d'arguments, et le transport ne sait construire qu'une forme d'appel.
  Un outil `google_request` (argv ou requête libre) rouvre exactement la surface fermée par
  l'absence de `run_command` ;
- **un service n'est joignable que s'il est dans la liste blanche de config** (`GWS_SERVICES`) ;
  un nom inconnu ou une liste vide refusent le démarrage (`ConfigError`, code 78) — une liste
  blanche ne se prolonge pas par un `*` ;
- **lire n'autorise pas à écrire** : les outils d'écriture n'existent que sous
  `GWS_ALLOW_WRITES` **et** `DANGEROUS_TOOLS_ENABLED`, et chaque appel passe par un clic ;
- **jamais de contenu privé sur le disque** : ni export, ni fichier temporaire, réponse bornée à
  la lecture et tronquée avec mention ;
- **l'enveloppe d'erreur se parse dans un ordre défini** — code de sortie, puis JSON, puis scan de
  texte : une API qui rend `{"error":{"code":0,…}}` avec un 401 échappé dans le message ne doit pas
  pouvoir se déguiser en succès, et un `exit 0` ne prouve jamais une réponse saine (`auth status`
  sur un compte `none` sort 0) ;
- **une capacité dont le moyen d'accès existe se déclare** : binaire présent → outils présents ;
  compte non connecté → avertissement au démarrage, réponse d'outil qui nomme la commande de
  réparation, `/google` qui explique. Retirer les outils faute de compte rend le refus invisible et
  oblige à redémarrer après la réparation ;
- **les limites se mesurent avant d'écrire** : `gws auth login` n'a ni `--no-browser` ni flux
  device → le consentement se fait dans le navigateur de l'utilisateur, et c'est écrit dans la doc
  au lieu d'être découvert en cours d'installation.

Le doctor (`npm run google:check`) et la chaîne réelle (`npm run google:live`) sont la partie de ce
chapitre qui ne peut pas être déléguée aux tests unitaires : voir `references/verification.md`.

## Ce qui n'est pas défendu (à dire à l'utilisateur)

- **La mémoire est en clair.** SQLite n'est pas chiffré. `remember` refuse ce qui
  ressemble à un mot de passe, une clé ou un numéro de carte (heuristique) : c'est un
  garde-fou, pas un chiffrement. Chiffrer le disque, pas la base.
- **Le modèle peut être induit en erreur** dans sa *conversation* : il ne peut pas
  appeler ce qui n'existe pas, mais il peut paraphraser un texte hostile.
- **Le LLM voit les souvenirs chargés** : tout ce qu'on écrit en mémoire part chez un
  service distant. Pour un agent strictement hors-ligne, brancher un modèle local via
  le `baseUrl` du fournisseur.
- **Un compromis de la machine** lit `.env` et `memory.db`. Hors périmètre.
