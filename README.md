# local-agent-builder

Skill (empaqueté en plugin Claude Code) pour créer, sécuriser et étendre des **agents
d'IA personnels qui tournent en local** et se pilotent depuis un canal de messagerie —
la famille d'agents dont OpenGravity est le premier exemplaire.

Contenu : un processus en 6 étapes, quatre références techniques, **l'implémentation de
référence complète** comme modèle de génération, et deux scripts qui exécutent réellement
quelque chose (générateur de projet + vérificateur d'invariants).

## Installer

Depuis Claude Code, une fois le dépôt déclaré comme marketplace :

```
/plugin marketplace add <owner>/local-agent-builder
/plugin install local-agent-builder@local-agent-builder
```

Sans le CLI, l'installation est triviale — un skill n'est qu'un dossier :

```bash
mkdir -p ~/.claude/skills
cp -r skills/local-agent-builder ~/.claude/skills/
```

Validation par le validateur officiel du skill-creator :

```bash
python3 ~/.claude/skills/skill-creator/scripts/quick_validate.py ~/.claude/skills/local-agent-builder
# → Skill is valid!
```

## Utiliser

Le skill se déclenche seul sur une demande du type « je veux un agent perso sur
Telegram avec une mémoire ». À la main :

```
> utilise le skill local-agent-builder pour créer un agent nommé Atlas, canal Telegram, fuseau Europe/Paris
```

Les deux scripts s'utilisent aussi indépendamment du skill :

```bash
# Générer un agent neuf depuis la référence (renomme, et refuse de copier un secret)
python3 scripts/scaffold.py --name "Atlas" --out ../atlas --timezone "Europe/Paris"

# Auditer N'IMPORTE QUEL agent de cette famille (y compris un projet déjà lancé)
python3 scripts/check_invariants.py ../atlas
```

## Arborescence

```
.claude-plugin/plugin.json     manifeste du plugin
skills/local-agent-builder/
├── SKILL.md                   processus (177 lignes, < 500 comme recommandé)
├── references/
│   ├── blueprint.md           plan fichier par fichier, couches, format d'outil, boucle
│   ├── security.md            les 14 invariants et le défaut réel derrière chacun
│   ├── verification.md        protocole en 5 niveaux + pattern de test bout-en-bout
│   └── extending.md           canaux, fournisseurs, outils sensibles, audio, cloud
├── scripts/
│   ├── scaffold.py            générateur de projet (copie + renommage + audit anti-fuite)
│   ├── check_invariants.py    14 règles statiques, exit 1 si un invariant tombe
│   ├── detect_drift.py        projet vivant vs capture du skill : ce qui a changé, quel bump
│   └── refresh_reference.py   re-capture la référence (garde-fou anti-secret) et bump le skill
├── assets/reference/          OpenGravity v0.1 : 43 fichiers, sans .env ni base
└── evals/evals.json            3 prompts d'évaluation avec assertions objectivement vérifiables
```

## Ce que le skill garantit (et ne garantit pas)

Garanti : le générateur refuse d'écrire un projet contenant une valeur type clé API,
et n'emporte jamais `.env`, `memory.db*` ou `service-account.json`. Le vérificateur
contrôle l'exécution de code, le sens des dépendances, l'ordre de la liste blanche, la
borne de boucle, la validation stricte des arguments, l'encadrement anti-injection, les
secrets commités et la verbosité des erreurs renvoyées au canal.

Non garanti : rien sur le comportement du fournisseur LLM réel (quota, nom de modèle,
latence) — `references/verification.md` explique la preuve à faire en conditions réelles,
et le rapport final du skill doit la citer.

## Origine

Construit avec `skill-creator` (dépôt `anthropics/claude-plugins-official`), en suivant
son processus : capture d'intention depuis la conversation ayant produit OpenGravity,
brouillon, validation par `quick_validate.py`, jeu de tests dans `evals/evals.json`.
Les invariants du vérificateur viennent des bugs **réellement** trouvés pendant cette
construction — dont un dans le projet modèle lui-même : `security/allowlist.ts`
importait `grammy`, ce que la règle `layering` a signalé.

## Faire évoluer le skill (v1.1.0 et après)

Le skill se veut le miroir de l'état **validé** du projet, pas son état d'origine. Trois
pièces le rendent tenable sans bonne mémoire :

```bash
python3 skills/local-agent-builder/scripts/detect_drift.py --project ../opengravity
# 0 = aligné ; 1 = des évolutions méritent d'être intégrées, avec le bump recommandé

python3 skills/local-agent-builder/scripts/refresh_reference.py --project ../opengravity   --bump minor --summary "ce qui change pour qui construit un agent"
```

`--bump` réécrit `metadata.version` dans le frontmatter et insère une entrée `CHANGELOG.md`
au format de traçabilité (version précédente, intégrations, pourquoi, ce qui a été
remplacé, impact, **preuve**, empreinte). Le niveau de bump reste un jugement humain : le
script propose, il ne décrète pas. Barème et garde-fous (anti-empilement, ce qui ne
justifie *pas* une mise à jour) : `references/evolution.md`.

La re-capture refuse de publier un projet contenant un secret, ignore `.env`,
`memory.db*` et `node_modules`, et vérifie après coup que rien de tout cela ne s'est copié.
