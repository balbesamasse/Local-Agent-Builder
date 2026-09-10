# Faire évoluer le skill avec le projet

Ce fichier règle une question précise : **quand ce skill doit-il changer, et de combien ?**
Sans elle, un skill « évolutif » devient soit un fatras d'annotations, soit un fichier
mort qu'on recopie sans y toucher. Le contrat est le suivant : le skill doit représenter
**le meilleur état validé** du projet, pas son histoire.

## Sommaire

- [Le principe](#le-principe)
- [Signaux de synchro](#signaux-de-synchro)
- [Ce qui justifie une mise à jour](#ce-qui-justifie-une-mise-à-jour)
- [Ce qui ne la justifie pas](#ce-qui-ne-la-justifie-pas)
- [Procédure, dans l'ordre](#procédure-dans-lordre)
- [Barème de version](#barème-de-version)
- [Gabarit de traçabilité](#gabarit-de-traçabilité)
- [Anti-empilement](#anti-empilement)
- [Prouver une règle nouvelle](#prouver-une-règle-nouvelle)
- [Le détecteur évolue aussi](#le-détecteur-évolue-aussi)
- [Limites du dispositif](#limites-du-dispositif)

## Le principe

Trois règles se tiennent :

1. **Le projet est la source de vérité, le skill en est le miroir.** Quand les deux
   divergent, on corrige le miroir — jamais l'inverse. Une règle de skill que le code
   ne suit plus n'est pas une aspiration, c'est un mensonge utile à personne.
2. **Une décision validée remplace la règle qu'elle contredit.** Elle ne s'ajoute pas à
   côté. Le premier réflexe, en documentant, est d'empiler : « ajouter la nouvelle
   façon de faire » laisse le lecteur choisir au hasard entre deux consignes.
   L'étape de suppression est obligatoire, pas optionnelle.
3. **Rien n'entre dans le skill qui n'ait été éprouvé.** Une règle sans défaut réel
   derrière elle est une opinion. Chaque invariant de `check_invariants.py` correspond à
   un bug rencontré ; chaque prescription de SKILL.md correspond à un choix qu'on a vu
   échouer ou réussir. Ce qui n'a pas pu être exécuté ici porte la mention
   `[non prouvé]` — et cette mention est une dette, pas un ornement.

## Signaux de synchro

Lancer `scripts/detect_drift.py` :

- après tout commit qui touche `src/core/`, `src/security/`, `src/llm/`, `src/memory/`,
  `src/tools/`, `src/channels/` ;
- après l'ajout ou le retrait d'un outil, d'une commande de canal, d'une table, d'une
  clé de configuration, d'une dépendance ;
- après un incident de production (le skill doit intégrer la correction, pas le
  contournement) ;
- avant toute nouvelle génération d'agent avec `scaffold.py` — générer depuis une
  référence périmée propage l'obsolescence à N projets ;
- ponctuellement, quand le SKILL.md est cité dans une réponse : ses chiffres doivent être
  justes, sinon il perd son autorité.

Le script ne se contente pas de lister des fichiers : il classe (`major`/`minor`/`patch`),
dit **sur quel fichier du skill** agir, et compare les chiffres que le SKILL.md annonce à
ce que le projet contient vraiment. C'est ce dernier point qui a rattrapé le plus d'erreurs
à l'usage : des phrases comme « 56 tests » vieillissent sans que personne ne les relise.

## Ce qui justifie une mise à jour

| Zone | Exemple qui l'a déclenchée |
|---|---|
| Architecture, couches | `security/allowlist.ts` séparé du canal pour que la liste blanche survive à un changement de messagerie |
| Outil et son schéma | `remember` qui refuse un contenu de forme secrète |
| Sécurité | portail `DANGEROUS_TOOLS_ENABLED`, approbation humaine rendue obligatoire par le constructeur |
| Mémoire et persistance | classement par pertinence cassé (`julianday` sur un epoch-ms ⇒ score NULL) |
| Fournisseurs, modèles | noms de modèles documentés absents du compte ⇒ sonde d'inventaire au démarrage |
| Conventions et outillage | `check_invariants.py` exécuté en CI, `npm run check` comme porte de sortie |
| Décision abandonnée | MarkdownV2 et le formatage maison : abandonnés au profit du HTML |
| Problème résolu | message d'erreur brut du fournisseur renvoyé dans la conversation |
| Dette knowingly accepted | file d'attente et rate-limit en mémoire ⇒ bloquants pour le multi-instance |

## Ce qui ne la justifie pas

- une correction de formulation, de faute, de style, de couleur de commenteur ;
- un réglage de valeur par défaut cosmétique sans conséquence pour qui installe ;
- un coup de debug ponctuel dont la leçon tient en une ligne de commit ;
- une idée émise puis abandonnée dans la conversation, sans jamais avoir été implémentée ;
- un changement de convenance personnelle non discuté avec l'utilisateur.

Le test qui tranche : **« est-ce que quelqu'un qui construit un agent demain se comporterait
mieux si je l'écris ici ? »** Si non, ça va dans le commit, pas dans le skill. C'est le
garde-fou qui empêche le fichier de grossir jusqu'à devenir illisible.

## Procédure, dans l'ordre

1. **Analyser** : `python3 scripts/detect_drift.py` et lire le diff réel du projet. Ne pas
   se fier au souvenir de la conversation.
2. **Mesurer l'impact sur le skill existant** : chercher dans les quatre `references/*.md`
   et SKILL.md les passages qui traitent du même objet (`grep` sur les mots-clés, pas la
   mémoire).
3. **Chercher la contradiction** : l'ancienne règle est-elle toujours vraie ? Partiellement ?
   Fausse ? C'est l'étape qui distingue une mise à jour d'une annexe.
4. **Remplacer** ce qui est faux, **conserver** ce qui tient, **ajouter** seulement ce qui
   n'a pas de siège naturel.
5. **Structurer si besoin** : un chapitre qui déborde part dans une référence ; SKILL.md
   garde sa taille de lecture d'une traite (< 500 lignes, progressif sur trois niveaux).
6. **Bumper** selon le barème, avec `scripts/refresh_reference.py --bump <niveau> --summary …`
   — qui rafraîchit aussi la capture de référence et l'empreinte. Le bump reste un jugement :
   le script propose, l'humain dispose.
7. **Tracer** dans `CHANGELOG.md` avec le gabarit ci-dessous, puis revérifier :
   `detect_drift.py` doit descendre à `patch` ou `none`, `check_invariants.py` doit rester
   plein sur la référence embarquée, `quick_validate.py` doit valider le frontmatter.

## Barème de version

Version sémantique en trois chiffres, portée par `metadata.version` dans le frontmatter
(seuls `name`, `description`, `license`, `allowed-tools`, `metadata`, `compatibility` sont
autorisés par le format skill — le numéro vit donc dans `metadata`, pas dans une clé libre).

| Niveau | Quand | Exemple vécu |
|---|---|---|
| `patch` (1.1.**1**) | chiffres du skill repris, formulation, exemple corrigé, coquille dans une référence | passer « 56 tests » à 63 |
| `minor` (1.**2**.0) | nouvelle capacité décrite, nouvel invariant, nouvelle intégration, outil ajouté, convention validée sans casser les précédentes | 1.0.0 → 1.1.0 : sonde de modèles + 2 invariants |
| `major` (**2**.0.0) | changement de philosophie ou d'architecture : passage webhook par défaut, canal qui devient obligatoire, mémoire hors SQLite, retrait d'une couche | — pas encore vécu |

Un bump mineur ne se refuse pas pour « trop peu de matière » : trois lignes qui empêchent
un incident valent un bump. Un bump majeur, si — il doit emporter une réécriture des
invariants, pas une mode.

## Gabarit de traçabilité

Une entrée par version, en tête de `CHANGELOG.md` :

```markdown
## v1.2.0 — 2026-09-14

- **à partir de** : v1.1.0
- **intégrations** : <ce qui est devenu règle, une ligne par décision>
- **pourquoi** : <le défaut ou l'incident que ça empêche, et ce que ça change pour qui construit>
- **remplacé / supprimé** : <la règle morte, avec la raison — ne jamais la laisser vivante à côté>
- **impact sur la construction** : <fichiers du skill modifiés, invariants ajoutés, geste interdit>
- **preuve** : <commande exécutée + résultat brut, ex. « check_invariants sur /tmp/broken → 10 violations »>
- **empreinte de référence** : <n> fichiers, tree `<hash>`
```

Le champ **preuve** est obligatoire. C'est lui qui empêche le skill de se remplir de règles
qu'on a écrites mais jamais essayées.

## Anti-empilement

Trois contrôles, tous mécaniques ou presque :

- le `grep` des valeurs retirées : après avoir remplacé un nom de modèle, une commande, une
  API, chercher l'ancien nom dans tout le skill (y compris `assets/reference/`, `README.md`,
  `evals/`). C'est ainsi que huit occurrences d'un modèle mort ont été trouvées, dont cinq
  hors du fichier que j'avais modifié ;
- les chiffres annoncés : `detect_drift.py` les compare au projet, donc ils ne peuvent plus
  pourrir en silence ;
- la taille : SKILL.md reste sous 500 lignes. Si une section grossit, c'est qu'elle mérite
  une référence — pas que le skill doit être plus long.

## Prouver une règle nouvelle

Une règle de vérification qui n'a jamais échoué n'est pas testée, elle est décorative. Pour
chaque règle ajoutée à `check_invariants.py`, au moins un des deux :

- la passer sur une **fixture cassée** où l'on a réintroduit le défaut, et citer le résultat
  (ex. `/tmp/broken` → violations attendues) ;
- la passer sur la capture **pré-correction** du projet, et vérifier qu'elle crie. C'est ce
  qu'a fait `model-inventory-probe` : sur la référence d'avant le correctif, elle nomme
  d'elle-même les deux modèles morts.

Attention au faux positif, qui est le vrai coût d'une règle statique : la première version de
`env-doc-sync` comptait comme clé de configuration toute chaîne `MAJUSCULE` en premier
argument, donc `startsWith('REMPLACEZ_PAR_LE_VOTRE')`, et proclamait une violation inventée.
Elle a été corrigée en écartant les méthodes de comparaison — et non en énumérant nos noms de
helpers, qui changent au premier refactor.

## Le détecteur évolue aussi

`scaffold.py`, `refresh_reference.py`, `detect_drift.py` et `check_invariants.py` sont des
pièces du skill, pas des accessoires : ils ont le droit de changer de version, et leurs faux
positifs sont des bugs de sécurité — un détecteur qui crie s'apprend à l'ignorer, et un
détecteur ignoré ne protège rien. Trois corrections de cet ordre valent d'être répétées :

- **hachage normalisé par le nom de l'agent** : avant, générer un projet avec
  `scaffold.py --name Beacon` faisait signaler chaque fichier touché par le renommage
  comme une « évolution du projet ». Le hash efface donc le nom (slug, casse
  indéterminée) avant comparaison. Un détecteur qui crie sur un bruit apprend à être
  ignoré — et un détecteur ignoré ne protège rien.
- **les réglages locaux sont qualifiés, jamais masqués** : un `src/config.ts` porteur d'un
  simple `SYSTEM_TIMEZONE` différent est rendu comme `réglage-local` en `patch`, sans bump
  recommandé ; le même fichier porteur d'un changement de borne (`HISTORY_LIMIT`) remonte
  en `fichier-modifié`/`minor` et bloque (code de sortie 1). La nuance se calcule sur le
  delta de lignes, elle n'est pas devinée depuis le nom du fichier.
- **un garde-fou qui sonne toujours trouve une échappatoire humaine** : l'analyse
  anti-fuite refusait de publier la référence à cause de `service-account.json.example`,
  dont le rôle est précisément de montrer la *forme* d'une clé privée. La règle excuse
  désormais un `.example` **à condition qu'il porte une marque de place holder visible** ;
  un `.example` contenant du matériel de clé sans marqueur reste refusé, et ce cas est
  testé. Ne jamais remplacer cela par « ignorer les `.example` ».

Règle de contrôle ajoutée au passage : `--json` doit produire **un seul** document. Un
second objet collé en fin de flux (pour être pratique en mode silencieux) rend le rapport
illisible par `jq`, donc par une CI, donc inexistant en pratique.

Trois angles morts trouvés en auditant le miroir contre l'état v0.2 :

- **toute extension qui peut porter le nom de l'agent doit être une cible de renommage** :
  `scaffold.py` ne relisait que `.ts/.md/.json/.example/.sql`, si bien qu'un projet « Témoin »
  partait avec `Label com.opengravity.keepalive` dans son plist et
  `deploy/systemd/opengravity.service` dans son dossier. La liste des extensions à renommer et
  celle de l'audit anti-fuite doivent être **les mêmes** : un fichier que le générateur ne sait
  pas renommer est un fichier qu'il ne sait pas non plus vérifier ;
- **l'empreinte de référence doit voir le runtime, pas seulement le code** : `.sh` est compté
  (la veille d'un projet de ce gabarit est un script shell), `logs/` est ignoré (un gabarit ne
  livre pas un répertoire de journal, même vide) ;
- **un projet et un miroir ne peuvent pas avoir deux listes d'exclusion** : `refresh_reference.py`
  ignorait `logs/`, `detect_drift.py` non — le verrou `logs/supervisor.pid`, créé par le fait
  même de faire tourner l'agent, ressortait comme « capacité nouvelle à intégrer » et proposait un
  bump pour un fichier qui ne dit rien de la méthode. Le détecteur lit maintenant la liste du
  constructeur de miroir ; s'il ne peut pas l'importer, il retombe sur un filet de sécurité.
  Contrôle : le bruit de runtime ne lève plus rien, et un fichier réellement neuf
  (`src/tools/drift-probe.ts`, créé puis supprimé) est toujours signalé en `fichier-ajouté` avec
  bump `minor` recommandé — élargir une liste d'ignorance ne doit jamais aveugler le détecteur.

Contrôle après correction : le projet témoin passe de 13 à **17 fichiers renommés**, ne contient
plus aucune occurrence du nom modèle dans `deploy/` ni `scripts/`, et `check_invariants.py` y
annonce 21/21 (le compte de l'époque : 22 règles depuis v1.8, le vérificateur étant la source du
nombre).

## Limites du dispositif

- le script lit des **structures**, pas des intentions : il ne saura jamais si un changement
  est une amélioration ou une régression, seulement qu'il est ;
- la référence embarquée est une **capture**, pas un lien : elle ne bouge que si
  `refresh_reference.py` est lancé, et le détecteur ne voit alors que le projet contre la
  capture — d'où l'obligation de rafraîchir en même temps qu'on documente ;
- les évolutions **non codées** (une convention d'équipe, un arbitrage de produit) lui sont
  invisibles : c'est le seul morceau qui reste 100 % humain, et donc le premier qu'on oublie ;
- rien ici ne s'exécute tout seul (pas de CI, pas de hook) : dans un dépôt où c'est possible,
  ajouter `detect_drift.py --quiet` en étape de CI est le premier prolongement utile.
