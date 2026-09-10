# Vérifier un agent (ou ce n'est pas fini)

Quatre niveaux, du moins coûteux au plus probant. Les trois premiers ne prouvent pas
que l'agent fonctionne ; le quatrième si.

## 1. Compilation et typage

```bash
npm run typecheck          # tsc --noEmit, strict + noUncheckedIndexedAccess
```

`noUncheckedIndexedAccess` mérite d'être gardé : c'est lui qui force à traiter
`messages[0]` comme possiblement absent — exactement la classe de bug qui, dans un
parseur de réponse LLM, se traduit par un crash sur un modèle qui renvoie `choices: []`.

## 2. Tests unitaires sur les pièces qui décident

À écrire en priorité, dans cet ordre (rapport signal/effort) :

| Test | Ce qu'il échoue à détecter s'il manque |
|---|---|
| liste blanche : voisin d'un ID autorisé, `undefined`, chaîne | un `startsWith`, un `includes` sur une liste de strings, et tout ID « 11 » est accepté pour « 1 » |
| limiteur : rafale, refus, refill avec horloge injectée | une fuite de jetons ou un compteur qui ne se remplit jamais |
| `sanitizeText` : caractères de contrôle, bidi, taille | un `\u202E` qui inverse l'affichage d'une conversation, une entrée de 1 Mo dans le contexte |
| cadre anti-injection : la charge utile **ne peut pas** refermer le cadre | une injection qui transforme un fichier lu en consigne |
| validation d'arguments : JSON cassé, champ inconnu, hors bornes | un outil appelé avec des arguments que personne n'a validés |
| registre : nom inventé, outil `dangerous` sans approbation, panne d'outil | une capacité hors liste, un sensible non approuvé, un tour tué par une exception |
| liste blanche d'approbation : usurpation d'utilisateur, d'ID de chat, de jeton, rejeu, expiration | un ticket consommé deux fois, un clic d'un tiers qui déclenche l'action |
| fenêtrage mémoire : `historyLimit`, exclusion des messages d'outil | un contexte qui grossit sans borne et rejoue des `tool` orphelins |

Le plus rentable est celui sur le **cadre anti-injection** : quatre lignes, et il a
cassé une neutralisation qui paraissait écrite correctement.

## 3. Test d'intégration avec doubles locaux

Faux serveur de canal + faux fournisseur LLM dans le même processus, sur
`127.0.0.1:0`, sans réseau extérieur. Pattern qui a marché :

```ts
const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (url.endsWith('/getMe'))  return ok({ id: 1, is_bot: true, username: 'test_bot' });
  if (url.endsWith('/getUpdates')) {
    const update = queue[cursor++];
    if (update) return ok([update]);
    setTimeout(() => ok([]), 150);          // retient : sinon le client boucle à 100 % CPU
    return;
  }
  if (url.endsWith('/sendMessage')) { sent.push(body); return ok({...}); }
  if (url.endsWith('/chat/completions')) {
    // Detail qui coûte 30 minutes de debug : une API compatible OpenAI renvoie
    // l'objet NU, pas une enveloppe {ok, result} comme l'API Telegram. Emballée,
    // la réponse se parse en « réponse vide » et l'on suspecte le client à tort.
    res.end(JSON.stringify({ choices: [{ message: script.shift() }] }));
  }
});
```

On lance ensuite le **vrai** point d'entrée du projet, avec trois variables
d'environnement surchargées : l'URL de l'API du canal, celle du fournisseur, et un `DB_PATH`
vers un fichier temporaire. Les deux URL
surchargeables sont une **fonctionnalité** (relais, miroir local, self-hosting), pas un
hook de test.

Ce qu'on asserte, et seulement ça :

1. un message d'un ID non autorisé ne déclenche **aucun** appel du fournisseur ;
2. la sortie d'un outil traverse le cycle (on fait renvoyer par le double un
   `HORLOGE:` + le contenu reçu en message `tool` → la date réelle revient) ;
3. `remember` écrit sur **disque** : on rouvre le fichier SQLite en lecture seule et on
   lit `memories` et `tool_calls` ;
4. aucun secret dans la sortie du processus, aucun token dans une réponse ;
5. `SIGTERM` → code de sortie 0 (un arrêt propre qui ne casse pas la base en cours).

Le point 3 est celui que tout le monde saute, et c'est celui qui distingue « la
mémoire a affiché un message » de « la mémoire est persistée ».

## 4. Preuve humaine, trois minutes

Après `npm run dev`, dans Telegram, dans cet ordre :

| Envoi | Attendu | Prouve |
|---|---|---|
| `quelle heure est-il ?` | une heure **juste** avec le fuseau configuré | outil → LLM → rendu HTML |
| `combien font 18 % de 249 ?` | `44,82` | le modèle appelle la calculatrice au lieu de deviner |
| `retiens que je cours le mardi` | confirmation + `/memory` montre la ligne | persistance |
| depuis un **autre** compte | refus laconique ou silence | liste blanche, en conditions réelles |
| quota dépassé (mettre un faux modèle) | message générique, **pas** de détail technique | non-fuite des erreurs |

## 5. Invariants

```bash
python3 scripts/check_invariants.py .
```

Vingt et une règles statiques : exécution de code, cloisonnement des couches, ordre de la
liste blanche, cadre d'injection, bornes de boucle, schémas stricts, `.gitignore`, secrets,
verbosité des erreurs, cohérence `.env.example`/config, sonde d'inventaire des modèles,
**absence d'écriture non déclarée** (`DISK-WRITE-OK:`), **port d'écoute déclaré**
(`LISTEN-EXCEPTION:`), **page qui tient le micro sans dépendance externe**, joignabilité des
commandes, supervision et codes de sortie. Code de sortie 1 = quelque chose à corriger ; le
message donne le correctif, pas seulement le symptôme. À brancher en `pre-commit` ou en CI — un
agent qui « marchait » lundi peut violer une règle après trois ajouts d'outils.

## Un refus doit nommer sa cause, sinon le bug est invisible

`log.warn('transcription en échec', { type: 'AudioError' })` a fait perdre une soirée :
le type de l'erreur ne dit rien, et l'utilisateur ne voit qu'un message poli. Deux
règles mécaniques en découlent :

- le journal d'un refus porte **le motif** (message interne borné, statut HTTP) — mais
  jamais le corps renvoyé par le fournisseur, qui peut contenir la requête, donc la clé,
  donc le nom du fichier de l'utilisateur ;
- une erreur fabriquée **avant** l'appel doit être reconnaissable comme telle : chez
  OpenGravity, `AudioError.status` vaut `null` quand rien n'a été envoyé. Écrire
  `status === undefined` rend la branche morte — le type `number | null` ne se compare
  pas à `undefined`, et TypeScript ne peut pas t'en avertir.
- **un envoi qui échoue silencieusement n'est pas un envoi** : le `.catch(() => {})` posé sur
  un `ctx.reply()` du canal transforme un refus de l'API en « l'utilisateur n'a rien demandé ».
  Constaté sur `/call` : l'unique façon de savoir si un lien d'appel avait été produit était
  d'ajouter `appel demandé` (journal d'intention) et `réponse /call non envoyée` + motif
  (journal d'échec). Deux lignes, et une classe entière de « rien ne se passe » devient
  lisible — c'est exactement ce que l'utilisateur a rapporté, et ce que le code niait.

## Un nom de fichier est parfois un champ sémantique

Le `file_path` que rend le serveur de fichiers de Telegram pour un vocal est
`files/voice_file_1` : **sans extension**. Groq valide le type d'audio *sur le nom de la
partie multipart*, pas sur son `Content-Type` — mêmes octets, même en-tête, `voice.ogg`
accepté, `voice_file_1` refusé (`file must be one of the following types: [flac mp3 mp4
mpeg mpga m4a ogg opus wav webm]`). Conséquence : tout vocal était refusé, et comme un
400 n'est pas transitoire, la chaîne de secours ne s'essayait même pas.

Trois réflexes à en tirer, plus larges que l'audio :

1. quand un bord externe exige un type, **fabrique-le** à partir de ce que le canal sait
   (`mime_type` déclaré par l'API, à défaut la garantie du protocole : un `voice` Telegram
   EST un OGG/Opus), et ne transmets pas cru un identifiant opaque ;
2. si le type est irrécupérable, **refuse avant l'appel** : un aller-retour payant pour
   apprendre ce qu'on sait déjà est une double faute ;
3. un faux serveur de test doit servir **la forme réelle**, sinon il valide tes
   hypothèses au lieu de les tester — ce harnais rendait `files/file_1.ogg`, un nom que
   le monde réel ne produit pas, et le test est resté vert des semaines.

## Un double de test doit lire les mêmes champs que le client

Un test d'appel vocal en direct échouait « pour une raison de timing » : le texte final du
fournisseur n'arrivait jamais, le tour basculait sur le repli blocs, et la durée mesurée
valait exactement la grâce configurée. Trois correctifs plausibles ont été appliqués **au
test** (marge de grâce, cadres espacés d'un tick, option pour forcer le fournisseur à parler
plus tôt). Les trois étaient à côté : le faux serveur lisait `payload['audio_base64']` alors
que le client envoie `audio_base_64`. Le double n'a jamais rien entendu, donc n'a jamais rien
répondu — ce qui, vu de l'extérieur, imite une latence réseau à s'y méprendre.

La cause n'a été trouvée qu'en imprimant **les deux** : la trame reçue (`RAW len 1798`, avec
le base64 dedans) et la valeur du champ lu (`audio.length 0`). Un champ absent d'un objet JSON
validement parsé ne lève aucune erreur ; un faux serveur muet non plus.

Règles qui en découlent :

- **sur un test « de latence » qui échoue, prouver d'abord que le double reçoit et lit ce que
  le client envoie** (longueur du champ, pas seulement sa présence dans la trame brute), et
  seulement ensuite parler de délais ;
- **ne jamais rendre un test robuste en ajoutant du temps** : une marge fait passer un test
  qui échoue pour une autre raison, c'est-à-dire un test vert pour la mauvaise raison — le
  seul livrable pire qu'un test rouge ;
- **le double valide les noms de champs, ou il ne prouve rien** : un harnais qui accepte
  n'importe quel payload ne peut pas distinguer « client qui n'envoie rien » de « serveur qui
  ne lit rien ». Ici, faire échouer le faux service sur une clé inconnue aurait coupé le débat
  en un run ;
- **retirer la béquille après le diagnostic** : l'option `commitAfterChunks`, ajoutée pour
  forcer le test à passer, a été supprimée une fois la clé corrigée — une rustine de test qui
  survit au bug devient la nouvelle façon de ne rien tester.

## Un test ne doit jamais pouvoir appeler un fournisseur payant

Deux fuites d'environnement, toutes deux rencontrées :

1. **le `.env` du dépôt déborde dans le fils**. Si le code de config recharge
   lui-même `.env` (dotenv au niveau module), un test bout-en-bout qui hérite de
   `process.env` reçoit les vraies clés — et part les utiliser. Constaté : après
   l'ajout d'une clé ElevenLabs dans le `.env` de développement, deux tests
   déjà verts se sont mis à expirer, le fils mourant d'une config incomplète
   *chez le vrai fournisseur*. La parade est une surcharge explicite
   (`ENV_FILE=/dev/null` dans l'environnement du fils) plus un test de config qui
   prouve les deux sens : le fichier ne fait que combler les absences, une variable
   exportée gagne toujours.
2. **le faux serveur imite une forme fausse.** Un harnais qui renvoie `{ data, models }`
   au même endpoint pour deux fournisseurs satisfait les deux par construction et ne
   prouve rien. Relevé sur le réseau : `GET /v1/models` chez ElevenLabs répond un
   **tableau nu**, `{ models: [...] }` chez d'autres, `{ data: [...] }` en compatible
   OpenAI. Un parseur qui ne connaît qu'une forme lit « inventaire vide »… et se
   félicite de n'avoir rien à redire.
3. **le faux serveur omet un détail du protocole qui, lui, est décisif.** Telegram annote
   les commandes dans `message.entities`, et grammy route `bot.command(...)` là-dessus.
   Un harnais qui envoie `{ text: '/voice' }` sans entité ne déclenche *aucune* commande :
   pendant des semaines, `/voice` était avalé par le handler texte de l'agent et répondu
   par le LLM — sans qu'aucun test ne s'en plaigne, parce qu'aucun test n'envoyait de
   commande. Ajoutée, l'entité fait apparaître le bug en une seconde. Même leçon pour le
   menu : le harnais avalait `setMyCommands` dans son `return json(true)` fourre-tout, donc
   rien ne prouvait que la commande était **annoncée** au client. En capturer le corps et
   assertir `/voice` présent a pris dix lignes et aurait attrapé la faute à la source.

Règle pratique : pour chaque fournisseur sondé, le harnais sert **la forme relevée sur
le réseau**, et un test d'inventaire vide doit échouer — « aucun modèle trouvé » ne vaut
pas « modèles vérifiés ». Quand un canal émet une annotation (entités, types de pièce
jointe, en-têtes), le harnais l'émet aussi : une route qu'on ne peut pas atteindre en test
est une route cassée qui s'ignore.

Deux autres scories de harnais, trouvées en écrivant le test de `/voice` :

- **la file d'updates ne doit pas avancer sur une file vide** : un curseur incrémenté à
  chaque `getUpdates` faisait sauter tout update poussé après le démarrage du fils, et
  faisait accuser le bot d'ignorer les clics ;
- **attendre la trace, pas le compteur** : `sendVoice` reçu par le harnais ne prouve pas
  que la ligne `vocal envoyé` a déjà atteint le stdout du fils. Attendre l'un pour
  asserter l'autre est une course — le test passait par chance.

## Critère d'acceptation

Ne pas dire « c'est prêt » avant que ces quatre lignes soient vraies et collées dans le
rapport :

```
npm run check                        → typecheck + tests + build, 0 échec
check_invariants.py                  → 22/22
test d'intégration                   → vert, avec les asserts 1-5 ci-dessus
appel réel au fournisseur LLM        → réussi au moins une fois (sinon : l'écrire en Limites)
sonde de modèles au démarrage        → « modèles vérifiés », ou avertissement hors ligne
```

Les deux derniers points sont ceux qu'un bac à sable sans clé ne peut pas valider. Dans ce
cas, l'énoncer : « chaîne LLM vérifiée contre un double scripté au format exact ; le nom de
modèle et les quotas du fournisseur réel restent à confirmer ».

## 6. Un agent vivant se lit dans ses fichiers, pas dans un panneau

Trois réflexes acquis en dépannant un bot qui « s'était arrêté » et ne l'était pas :

- **relire le fichier de journal**, pas l'extrait affiché par un outil de supervision :
  celui-ci a pu être pris au démarrage et montrer un buffer figé. Conclusion inventée à
  partir de là : « aucun message n'est arrivé », alors que trois tours avaient été traités.
- **interroger le processus, pas l'impression** : `ps -o stat,wchan` (un `S` + `ep_poll` =
  qui dort en attente d'événements, pas qui tourne en boucle), des ticks CPU mesurés sur
  quelques secondes (`0` = il attend ; un chiffre élevé = il consomme), `ss -tnp` pour ses
  seules connexions réseau.
- **découpler réception et envoi** : la table `messages` prouve que le tour a été reçu et
  traité ; une ligne `assistant` prouve que la réponse a été produite ; seul le log du
  canal prouve l'envoi. Un agent « muet » est donc soit un agent qui n'a rien reçu, soit un
  agent qui n'a rien su envoyer — deux diagnostics, deux correctifs opposés.

## 7. Un test qui passe ne prouve rien si le comportement cassé donne le même résultat

Le classement par pertinence de la mémoire était mort depuis le premier jour : `julianday()`
appliqué à un epoch en millisecondes renvoie `NULL`, donc `score` valait `NULL` sur toutes
les lignes, et `ORDER BY score DESC` retombait sur le critère de départage, `updated_at`.
Le test existant — « recherche par mots-clés pondérée par la récence » — passait, parce
qu'il vérifiait *quelles* lignes étaient renvoyées, jamais *dans quel ordre*.

La règle pour tout ce qui est un classement, une priorité ou un tri : construire le cas
d'usage où **le comportement faux donne l'ordre inverse**. Ici, un souvenir pertinent mais
ancien contre un souvenir récent mais hors sujet. Un tel test est impossible à écrire
correctement par accident — s'il passe, il prouve.

## 8. Une politique de reprise se prouve en tuant le processus, pas en relisant le code

L'agent s'est arrêté une nuit sans laisser de trace : aucun journal sur disque, donc la
cause est morte avec le stdout. Trois correctifs écrits, 110 tests au vert — et le premier
`kill -9` porté à l'enfant réel a montré que le superviseur **refusait de relancer** : il
confondait « on m'a demandé de m'arrêter » et « l'enfant est mort d'un signal ». Un faux
enfant dans un test ne force pas cette confusion, parce que c'est moi qui choisissais le
signal que je lui mettais dans la main.

Le rituel, à faire une fois par changement de politique de reprise, sur le vrai processus :

| Geste | Ce qui doit se passer | Ce que ça couvre |
|---|---|---|
| `kill -9 <pid enfant>` | « enfant tué par un signal », délai de backoff, nouvel enfant qui se reconnecte | panne brutale, OOM-killer |
| `kill -TERM <pid superviseur>` | l'enfant ferme la base puis sort `0` ; **pas** de relance ; verrou supprimé | arrêt voulu |
| second superviseur lancé | refus immédiat, sortie `78` | guerre de `409` sur le même token |
| `TELEGRAM_BOT_TOKEN` invalide | un seul essai, `78`, aucune boucle | erreur de config ≠ panne passagère |

Le détail qui compte : `code = null, signal = 'SIGKILL'` est le **cas général** d'une mort
inattendue (le noyau ne choisit pas d'autre code), tandis qu'un arrêt demandé se constate
par l'écouteur de signal *du superviseur*. Décider de relancer à partir du signal de l'enfant
inverse les deux, et laisse le service éteint exactement quand il aurait dû repartir.

## 9. Une exception à une invariante se câble en mention vérifiable

Rendre l'agent journalisable faisait échouer trois règles du vérificateur (`media-no-residue`
interdisait toute écriture dans `src/`, `env-single-point` toute lecture de `process.env`,
`no-code-execution` tout `child_process`). Les élargir d'un trait aurait été le chemin le
plus court et le plus faux. La façon dont le skill les admet :

- l'exception est **nommée dans le fichier concerné** (`DISK-WRITE-OK:` explique ce qui est
  écrit et pourquoi) — un fichier qui se met à écrire du media sans le dire tombe encore ;
- elle est **conditionnée** à une contrepartie : le superviseur n'a droit à `process.env`
  que s'il appelle `registerSecrets`, et à `child_process` que sans `shell: true` ni
  `execSync` ;
- chaque règle modifiée est **re-invalidee par mutation** : ici cinq retraits (mention,
  `installCrashGuards`, retour en `process.exit(1)`, `shell: true`, `registerSecrets`) ont
  produit cinq `FAIL`, un par règle visée.

Le chantier Google Workspace a ajouté deux exemptions de la même forme — `invariant: exec-transport`
pour un module qui lance un binaire métier, `invariant: env-enfant` pour celui qui filtre
l'environnement du fils — et la première version de la garde était **trompable par de la prose** :
elle cherchait `childEnvironment(` dans le fichier, où la définition de la fonction suffisait à
faire passer un transport qui ne l'appelait pas. Quatre mutations, quatre `FAIL` obtenus après
durcissement (contrôle sur le code commentaires déduits, `env:` issu du filtre, aucun étalement du
père) :

| Mutation | Résultat attendu | Constaté |
|---|---|---|
| marqueur retiré du fichier | `no-code-execution` FAIL | FAIL |
| `childEnvironment(parent, extra)` remplacé par `{ ...parent, ...extra }` | les deux règles FAIL | 2 FAIL |
| le seul mot `childEnvironment` laissé dans un commentaire, spawn sur env brut | FAIL | FAIL |
| `shell: true` réintroduit | FAIL | FAIL |

Une invariante qui ne peut plus échouer est devenue une préférence ; une invariante avec une
exception inconditionnelle est une invariante supprimée ; **une exception dont la contrepartie se
vérifie dans les commentaires se vérifie dans le décor**.

## 10. Un double imite l'API, pas le vocabulaire de la bibliothèque

Le faux `gws` des tests a d'abord renvoyé `body.base64String` — le nom du champ dans la
documentation de la bibliothèque — alors que le REST renvoie `body.data`. Le test passait,
l'extracteur de production restait aveugle. Trois leçons de la même famille :

- **la fidélité se juge sur la réponse réelle**, pas sur la ressemblance au code qu'on a sous la
  main : une fixture copiée sur un appel `--dry-run` ou sur une erreur vécue vaut mieux qu'un objet
  inventé propre ;
- **une clé de fixture est un argv**, pas un nom de fonction : `"drive files get (metadata)"` et
  `"helper +send"` distinguent deux appels que le test aurait confondus ;
- **un double muet imite une latence, pas un comportement** : le module `fake-gws.mjs` du projet
  modèle connaît dix modes (`fixtures`, `hang`, `huge`, `raw`, `mcp`, `authfail`, `authfail-helper`,
  `quota`, `notfound`, `garbage`) et enregistre ce qu'on lui demande (`FAKE_GWS_RECORD`, JSONL
  `{argv, env, params, dryRun}`) — c'est comme ça que l'isolation d'environnement se prouve au lieu
  d'être affirmée.

Le piège d'un mode `hang` en ESM : `setInterval` seul ne suffit pas (le corps du module continue),
et `await new Promise(() => undefined)` seul fait quitter Node avec le code 13
(`ERR_UNFINISHED_TOP_LEVEL_AWAIT`). La forme qui pend réellement : envelopper la queue du module
dans une fonction `main()`, y ouvrir l'intervalle comme seul handle, puis `return` — vérifié par
`timeout 2` → code 124.

Enfin : **un test qui ne peut pas échouer est un défaut**. Le harnais de ces tests sonde d'abord le
faux binaire (`probe()`), exactement comme le fait la production ; un harnais qui ne le faisait pas
laissait passer « client absent » pour « client conforme ».

## 11. Un docteur ne distribue pas des ✓ — il nomme ce qu'il a contrôlé

`npm run google:check` : une étape par maillon, contre le **vrai** binaire, avec à chaque fois la
commande qui répare si ça manque. Deux étiquettes ont dû être réécrites parce qu'elles mentaient :
« extracteur de feuilles ✓ » alors que l'appel avait été refusé (401) et que l'étape vérifiait la
non-fragilité des extracteurs ; « outils déclarés ✓ » affiché à côté de « capacité désactivée » — il
faut distinguer *déclarés* de *prêts*. Un ✓ qui ne dit pas ce qu'il contrôle est le même défaut qu'un
test qui passe à côté.

Codes de sortie d'un doctor : `0` tout est en place, `1` un maillon manque, `78` configuration
refusée — les mêmes codes que le contrat de l'agent, pour qu'un script d'installation les lise sans
interprétation. Le doctor n'imprime **aucun contenu** privé : des comptes, des formes, des URLs
construites.

## 12. La chaîne réelle, avec mémoire jetable

Les tests unitaires ne voient ni le choix du modèle, ni le binaire, ni le canal. `npm run
google:live` parcourt le trajet entier — vraie config, vrai LLM, vrai `gws`, vrai Telegram — avec
trois précautions qui le rendent utilisable sur une instance vivante :

- **base de mémoire dans `mkdtemp`** : une vérification ne doit pas laisser de trace dans
  l'historique de l'utilisateur, et se supprime à la fin ;
- **refus de parler à un chat hors liste blanche**, et message préfixé (« 🧪 vérification
  Google — ») pour que le destinataire sache qu'il ne reçoit pas une réponse ordinaire ;
- **la livraison est contrôlée, pas supposée** : le message sort dans un `try`, l'échec s'affiche,
  et le script dit « rien n'a été écrit chez le fournisseur » quand il n'a pas écrit — les écritures
  restent verrouillées pendant une vérification.

Sortie réelle, sans compte connecté : `gmail_search` appelé par le modèle, `auth`/`code 2` classé,
audit `unavailable`, avis opératif livré dans un message séparé, `exit 0`. C'est-à-dire : tout le
trajet fonctionne, et le seul maillon manquant est nommé.

Et si un temps mesuré semble inexplicable, **mesurer le chemin isolément avant d'accuser le
transport** : « le fils n'est pas mort en 1,8 s » s'est révélé « l'appel a été rejoué » (500 + 800 +
500) ; une sonde `spawn(detached)` + `kill(-pid)` tuait le fils en 204 ms. La conclusion utile n'était
pas un correctif de `kill`, c'était **d'arrêter de rejouer les timeouts**.
