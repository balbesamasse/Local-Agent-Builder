#!/usr/bin/env python3
"""Détecte ce qui a changé dans le projet (OpenGravity) depuis la dernière
synchro du skill, et traduit ces changements en décisions de mise à jour.

Pourquoi ce script existe : un skill « évolutif » qui repose sur la mémoire de
l'assistant pour savoir qu'il est périmé devient périmé. La seule surveillance
fiable est mécanique — comparer l'empreinte du projet vivant à la capture que le
skill embarque, et signaler ce qui, dans le skill, contredit désormais la réalité.

Usage :
    python3 detect_drift.py [--project CHEMIN] [--skill CHEMIN] [--json] [--quiet]

Sortie :
    0  aucune dérive porteuse de décision (le skill reflète le projet)
    1  des évolutions devraient être intégrées (minor ou major)
    2  projet ou skill introuvable

Le script n'écrit rien. Il ne lit jamais un fichier .env : seules les *clés* de
configuration sont comparées, jamais les valeurs, pour qu'un rapport de dérive
puisse être collé dans un ticket sans fuite.
"""

from __future__ import annotations

import argparse
import hashlib
import fnmatch
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL_ROOT_DEFAULT = HERE.parent

# Les deux scripts qui comparent projet et miroir doivent ignorer EXACTEMENT les mêmes
# chemins, donc la liste vit une seule fois : dans refresh_reference.py (celle qui construit le
# miroir), et le détecteur la lit. Deux listes séparées dérivent : ici, `logs/supervisor.pid`
# — un verrou de runtime — ressortait comme « capacité nouvelle à intégrer » et aurait déclenché
# un bump pour un fichier qui ne dit rien de la méthode. Un détecteur qui crie sur du bruit
# s'apprend à l'ignorer, et un détecteur ignoré ne protège plus rien.
_SHARED = {"dirs": set(), "files": set(), "globs": []}
try:
    import sys as _sys

    _sys.path.insert(0, str(Path(__file__).resolve().parent))
    from refresh_reference import IGNORES as _IGNORES

    _SHARED["dirs"] = {i for i in _IGNORES if "/" not in i and "*" not in i and "." not in i}
    _SHARED["files"] = {i for i in _IGNORES if "*" not in i and i not in _SHARED["dirs"]}
    _SHARED["globs"] = [i for i in _IGNORES if "*" in i]
except Exception:
    pass  # l'import echoue : on retombe sur le filet de securite ci-dessous

EXCLUDE_DIRS = _SHARED["dirs"] | {"node_modules", "dist", "build", "coverage", ".git", ".venv", "__pycache__", ".next"}
SKIP_FILES = _SHARED["files"] | {".env", "service-account.json", "package-lock.json"}
SKIP_GLOBS = list(_SHARED["globs"])
# Le snapshot de référence peut légitimement contenir ces fichiers ; le projet, non,
# et leur différence n'est pas une évolution à intégrer.
DATA_FILES = re.compile(r"\.(db|db-wal|db-shm|log)$")

# Gravité par zone : une évolution de ces fichiers touche la METHODOLOGIE, pas un détail.
# src/config.ts en tête : c'est le contrat d'installation, pas un fichier de plus —
# une clé qui change de nom ou de défaut change ce que chaque utilisateur doit faire.
CORE_AREAS = ("src/config.ts", "src/core/", "src/security/", "src/llm/", "src/memory/", "src/tools/", "src/channels/")
DOC_AREAS = ("docs/", "README", ".env.example", "AGENTS.md")

SEV_ORDER = {"patch": 0, "minor": 1, "major": 2}

# Réglages que scaffold.py écrit dans le projet généré à la demande de l'utilisateur.
# Une différence limitée à ces lignes est un CHOIX DE PROJET, pas une évolution de la
# méthode : on la signale (un détecteur de dérive qui masque est un détecteur menteur)
# mais on la qualifie, pour qu'elle ne déclenche pas de bump.
LOCAL_KNOBS = re.compile(r"(AGENT_NAME|SYSTEM_TIMEZONE)['\"]?\s*,\s*['\"][^'\"]*['\"]")


def walk_files(root: Path) -> list[Path]:
    out: list[Path] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        parts = p.relative_to(root).parts
        if any(part in EXCLUDE_DIRS for part in parts):
            continue
        # Données locales et artefacts du générateur : présents dans un projet, pas
        # dans l'autre, sans que ça dise quoi que ce soit sur la méthodologie.
        if p.name in SKIP_FILES or p.name == "SCAFFOLD.md" or DATA_FILES.search(p.name):
            continue
        if any(fnmatch.fnmatch(p.name, pattern) for pattern in SKIP_GLOBS):
            continue
        out.append(p)
    return out


def read(p: Path) -> str:
    """Lecture tolérante : un fichier binaire ou absent ne doit pas crasher un audit."""
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def agent_tokens(root: Path) -> list[str]:
    """Nom de l'agent tel qu'il est écrit dans les sources (slug + version affichée)."""
    pkg = root / "package.json"
    name = ""
    if pkg.is_file():
        try:
            name = json.loads(pkg.read_text(encoding="utf-8")).get("name", "")
        except json.JSONDecodeError:
            name = ""
    name = name or root.name
    return sorted({name, name.replace("-", " ").title(), name.capitalize()}, key=len, reverse=True)


def sha(p: Path, renames: list[str] | None = None) -> str:
    """Hash *normalisé* : le nom de l'agent est effacé avant comparaison.

    Sans ça, générer un projet avec scaffold.py — qui renomme OpenGravity en Atlas,
    Beacon ou ce que l'utilisateur a choisi — produirait une « dérive » sur chaque
    fichier touché. Un détecteur qui signale le renommage comme un changement de fond
    est un détecteur qu'on apprend à ignorer, et un détecteur ignoré ne protège rien.
    """
    data = p.read_bytes()
    if renames and p.suffix in {".ts", ".js", ".json", ".md", ".example", ".txt"}:
        text = data.decode("utf-8", "replace")
        for token in renames:
            if token:
                text = re.sub(re.escape(token), "<agent>", text, flags=re.I)
        data = text.encode()
    return hashlib.sha256(data).hexdigest()[:16]


def project_signals(root: Path) -> dict:
    """Résumé stable et comparables des traits qui intéressent le skill."""
    files = walk_files(root)
    rel = {p: str(p.relative_to(root)) for p in files}
    renames = agent_tokens(root)
    hashes = {rel[p]: sha(p, renames) for p in files}

    pkg = {}
    pkg_path = root / "package.json"
    if pkg_path.is_file():
        try:
            pkg = json.loads(read(pkg_path))
        except json.JSONDecodeError:
            pkg = {}

    src = root / "src"
    prod = [p for p in files if rel[p].startswith("src/") and "/test" not in rel[p] and "testing" not in rel[p]]
    tests = [p for p in files if re.match(r"src/(test|tests)/", rel[p])]

    # Clés d'environnement lues par la config (aucune valeur : jamais de secret).
    cfg = read(src / "config.ts")
    env_keys = sorted(
        {
            m.group(2)
            for m in re.finditer(r"([A-Za-z_$][\w$]*)\(\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]\s*[,)]", cfg)
            if m.group(1) not in ("startsWith", "endsWith", "includes", "indexOf", "match", "test", "push", "concat")
        }
    )
    model_defaults = dict(
        re.findall(r"['\"](GROQ_MODEL|GROQ_FALLBACK_MODEL|OPENROUTER_MODEL)['\"]\s*,\s*['\"]([^'\"]+)['\"]", cfg)
    )

    # Outils déclarés, avec leurs garde-fous.
    tools: dict[str, dict] = {}
    for p in [x for x in prod if x.relative_to(src).parts[0] == "tools"]:
        body = read(p)
        for name in re.findall(r"name:\s*'([a-z0-9_]+)'", body):
            tools[name] = {
                "dangerous": bool(re.search(r"dangerous:\s*true", body)),
                "approval": bool(re.search(r"requiresApproval:\s*true", body)),
            }

    # Schéma de mémoire : tables et colonnes, source de toute migration.
    schema = read(src / "memory/schema.ts")
    tables: dict[str, list[str]] = {}
    for m in re.finditer(r"CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\((.*?)\n\s*\)", schema, re.S):
        cols = [c.strip().split()[0] for c in m.group(2).split(",") if c.strip()]
        tables[m.group(1)] = [c for c in cols if c.upper() not in ("PRIMARY", "FOREIGN", "UNIQUE", "CHECK")]

    commands = sorted(set(re.findall(r"bot\.command\(\s*['\"]([a-z_]+)['\"]", read(src / "channels/telegram/bot.ts"))))

    return {
        "hashes": hashes,
        "file_count": len(hashes),
        "deps": {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})},
        "scripts": sorted(pkg.get("scripts", {}).keys()),
        "env_keys": env_keys,
        "model_defaults": model_defaults,
        "tools": tools,
        "tables": tables,
        "commands": commands,
        # comptage en sauts de ligne, comme wc -l : sinon les chiffres du skill et
        # ceux du projet ne sont pas comparables, et un écart fantôme fait perdre
        # toute crédibilité au rapport de dérive.
        "prod_lines": sum(read(p).count("\n") for p in prod),
        "test_lines": sum(read(p).count("\n") for p in tests),
        "test_count": sum(len(re.findall(r"^[ \t]*test\(", read(p), re.M)) for p in tests),
        "e2e_count": sum(len(re.findall(r"^[ \t]*test\(", read(p), re.M)) for p in tests if "integration" in p.name),
    }


def skill_signals(skill_root: Path) -> dict:
    """Ce que le skill prétend, y compris ses propres chiffres avancés dans SKILL.md."""
    skill_md = read(skill_root / "SKILL.md")
    body = re.sub(r"^---.*?---", "", skill_md, count=1, flags=re.S)
    all_md = "\n".join(read(p) for p in sorted(skill_root.rglob("*.md")))

    rules_file = read(skill_root / "scripts/check_invariants.py")
    # Un invariant = un Check ajouté à la liste. Le Check("structure", …) de garde
    # (racine invalide) n'est pas un invariant : le compter gonflerait le total, et
    # un total faux dans un outil qui surveille les totaux faux est un comble utile.
    # dict.fromkeys : un invariant peut être ajouté dans deux branches (ok / ko) sans
    # cesser d'être un seul invariant. Compter les occurrences le surcompterait, et le
    # total affiché par check_invariants.py — lui, exact — deviendrait introuvable.
    rules = list(dict.fromkeys(re.findall(r"checks\.append\(Check\(\s*\n?\s*[\"']([a-z0-9-]+)[\"']", rules_file)))

    # Un markdown coupé par un retour à la ligne reste une AFFIRMATION. Sans cette
    # normalisation, « 4 437 lignes de ⏎ production » se lisait « aucun chiffre annoncé »
    # — et le vérificateur validait en silence ce qu'il ne parvenait pas à lire, ce qui
    # est le pire mode de défaillance pour un outil de cohérence.
    flat = re.sub(r"\s+", " ", body)

    def num(pattern: str) -> int | None:
        m = re.search(pattern, flat)
        return int(m.group(1).replace(" ", "").replace("\u202f", "")) if m else None

    return {
        "version": (re.search(r'version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?', skill_md) or [None, None])[1],
        "claimed_invariants": len(rules),
        "invariant_rules": rules,
        "claimed_prod_lines": num(r"([\d \u202f]{3,7}) lignes de production"),
        "claimed_test_lines": num(r"([\d \u202f]{3,7}) lignes de tests"),
        "claimed_tests": num(r"([\d ]+) tests\b"),
        "claimed_e2e": num(r"bout-en-bout[^\d]{0,30}(\d+)") or num(r"(\d+) bout-en-bout"),
        "mentions_llama_default": bool(re.search(r"llama-3\.[0-9]-[0-9]+b", all_md)),
        "files": {
            "references": sorted(p.name for p in (skill_root / "references").glob("*.md")),
            "scripts": sorted(p.name for p in (skill_root / "scripts").glob("*.py")),
            "has_changelog": (skill_root / "CHANGELOG.md").is_file(),
            "has_evolution": (skill_root / "references/evolution.md").is_file(),
            "has_state": (skill_root / "assets/skill_state.json").is_file(),
        },
    }


# ---------------------------------------------------------------- drift ---

def finding(kind, severity, what, why, targets, fix):
    return {
        "kind": kind,
        "severity": severity,
        "what": what,
        "why": why,
        "skill_files": targets,
        "action": fix,
    }


def compare(proj: dict, base: dict, skill: dict, project_dir: Path = None, baseline_dir: Path = None) -> list[dict]:
    out: list[dict] = []

    added = sorted(set(proj["hashes"]) - set(base["hashes"]))
    removed = sorted(set(base["hashes"]) - set(proj["hashes"]))
    changed = sorted(k for k in set(proj["hashes"]) & set(base["hashes"]) if proj["hashes"][k] != base["hashes"][k])

    for path in added:
        sev = "minor" if path.startswith(CORE_AREAS) else "patch"
        if "docs/" in path or path.endswith(".md"):
            sev = "patch" if not path.startswith("src/") else "minor"
        out.append(finding(
            "fichier-ajouté", sev, path,
            "une capacité neuve ou un garde-fou supplémentaire que le skill ne décrit pas encore",
            ["SKILL.md", "references/blueprint.md"] if path.startswith("src/") else ["SKILL.md"],
            "décrire l'apport quelque part dans le skill, sinon le prochain agent généré ne l'aura pas",
        ))
    for path in removed:
        sev = "major" if path.startswith(("src/core/", "src/security/", "src/memory/", "src/llm/")) else "minor"
        out.append(finding(
            "fichier-supprimé", sev, path,
            "une ability annoncée par le skill n'existe plus : la doc est désormais fausse",
            ["SKILL.md", "references/blueprint.md", "assets/reference/"],
            "retirer du skill toute règle qui suppose ce fichier, puis rafraîchir la référence",
        ))
    for path in changed:
        sev = "minor" if path.startswith(CORE_AREAS) else "patch"
        kind = "fichier-modifié"
        why = "le comportement réel a bougé par rapport à ce que le skill enseigne"
        # Delta limité aux réglages locaux (nom d'agent, fuseau par défaut) : c'est le
        # générateur qui a fait son travail, pas le projet qui a évolué.
        try:
            a = (baseline_dir / path).read_text(encoding="utf-8").splitlines()
            b = (project_dir / path).read_text(encoding="utf-8").splitlines()
            delta = [x for x in set(a) ^ set(b)]
            if delta and all(LOCAL_KNOBS.search(x) for x in delta):
                kind, sev = "réglage-local", "patch"
                why = ("différence confinée aux valeurs que scaffold.py écrit sur demande "
                       "(nom, fuseau) : à ne PAS propager dans le skill")
        except OSError:
            pass
        out.append(finding(
            kind, sev, path,
            "le comportement réel a bougé par rapport à ce que le skill enseigne",
            ["assets/reference/", "references/blueprint.md"] if path.startswith("src/") else ["assets/reference/"],
            "relire le diff puis décider si la règle du skill doit changer (sinon : rien)",
        ))

    # Dépendances : un ajout de dépendance est une décision durable (surface d'attaque).
    for dep in sorted(set(proj["deps"]) - set(base["deps"])):
        out.append(finding("dépendance-ajoutée", "minor", f"{dep}@{proj['deps'][dep]}",
                           "toute dépendance est du code exécuté : elle mérite d'être justifiée dans le skill",
                           ["references/security.md", "SKILL.md"], "documenter pourquoi elle est nécessaire et ce qu'elle ne doit pas faire"))
    for dep in sorted(set(base["deps"]) - set(proj["deps"])):
        out.append(finding("dépendance-retirée", "major", dep,
                           "le skill recommande encore une brique que le projet a abandonnée",
                           ["SKILL.md", "references/blueprint.md"], "supprimer les mentions de cette dépendance"))

    # Contrat de configuration.
    for key in sorted(set(proj["env_keys"]) - set(base["env_keys"])):
        out.append(finding("clé-config-ajoutée", "minor", key,
                           "un nouveau réglage expose un choix que l'installateur doit connaître",
                           ["SKILL.md", "references/blueprint.md", ".env.example"], "ajouter la clé au chapitre configuration avec son défaut"))
    for key in sorted(set(base["env_keys"]) - set(proj["env_keys"])):
        out.append(finding("clé-config-supprimée", "major", key,
                           "le skill ferait documenter une clé qui ne fait plus rien",
                           ["SKILL.md", "references/blueprint.md", ".env.example"], "retirer la clé de toute la documentation"))

    # Outils : le cœur de la valeur du skill.
    for tool in sorted(set(proj["tools"]) - set(base["tools"])):
        out.append(finding("outil-ajouté", "minor", tool,
                           "un patron d'outil validé en pratique vaut plus qu'un patron inventé",
                           ["references/blueprint.md", "SKILL.md"], "prescrire l'outil, son schéma d'arguments et son garde-fou"))
    for tool in sorted(set(base["tools"]) - set(proj["tools"])):
        out.append(finding("outil-supprimé", "major", tool,
                           "le générateur embarque un outil que le projet a jugé inutile ou dangereux",
                           ["assets/reference/", "references/blueprint.md"], "retirer l'outil du modèle, une surface de capacité inutilisée est un risque"))
    for tool in sorted(set(proj["tools"]) & set(base["tools"])):
        if proj["tools"][tool] != base["tools"][tool]:
            out.append(finding("garde-fou-d-outil", "major", f"{tool} : {base['tools'][tool]} → {proj['tools'][tool]}",
                               "dangerous/requiresApproval sont la ligne de flottaison de la sécurité : un changement ici change la doctrine",
                               ["references/security.md", "SKILL.md"], "mettre à jour la règle et l'invariant correspondant"))

    # Schéma de mémoire : une migration est un événement.
    for table in sorted(set(proj["tables"]) - set(base["tables"])):
        out.append(finding("table-ajoutée", "minor", f"{table}({', '.join(proj['tables'][table])})",
                           "la persistance change de forme : les futurs agents doivent naître avec la migration qui va bien",
                           ["references/blueprint.md", "assets/reference/"], "documenter la version de schéma et le chemin de migration"))
    for table in sorted(set(base["tables"]) & set(proj["tables"])):
        if set(proj["tables"][table]) != set(base["tables"][table]):
            out.append(finding("colonnes-modifiées", "major", f"{table} : {base['tables'][table]} → {proj['tables'][table]}",
                               "un changement de colonnes sans migration = corruption silencieuse chez les agents déjà déployés",
                               ["references/blueprint.md", "assets/reference/"], "ajouter la migration et le test qui prouve l'upgrade depuis v{n-1}"))

    # Commandes du canal.
    for cmd in sorted(set(proj["commands"]) - set(base["commands"])):
        out.append(finding("commande-ajoutée", "patch", f"/{cmd}", "le mode d'emploi du skill omet une commande disponible", ["SKILL.md"], "compléter la liste des commandes"))
    for cmd in sorted(set(base["commands"]) - set(proj["commands"])):
        out.append(finding("commande-retirée", "minor", f"/{cmd}", "le skill promet une commande qui n'existe plus", ["SKILL.md"], "retirer la commande de la doc — et vérifier si le retrait était une décision de sécurité"))

    for name, before, after in (
        ("modèle par défaut", base["model_defaults"], proj["model_defaults"]),
    ):
        if before != after:
            for k in sorted(set(before) | set(after)):
                if before.get(k) != after.get(k):
                    out.append(finding("valeur-par-défaut", "minor", f"{k} : {before.get(k)!r} → {after.get(k)!r}",
                                       "une valeur par défaut est une décision : elle s'applique à tous les agents générés ensuite",
                                       ["SKILL.md", ".env.example", "assets/reference/src/config.ts"],
                                       "propager partout, y compris dans la doc : un défaut corrigé mais une doc qui cite l'ancien valeur = mensonge cohérent"))

    CLAIM_KEYS = (("lignes de production", "prod_lines", "claimed_prod_lines"),
                  ("lignes de tests", "test_lines", "claimed_test_lines"),
                  ("tests", "test_count", "claimed_tests"),
                  ("tests bout-en-bout", "e2e_count", "claimed_e2e"))
    for label, key, claim_key in CLAIM_KEYS:
        claimed, actual = skill.get(claim_key), proj[key]
        if isinstance(claimed, int) and claimed != actual:
            out.append(finding("chiffre-périmé-du-skill", "patch", f"{label} : le SKILL.md annonce {claimed}, le projet fait {actual}",
                               "un chiffre inexact dans un skill de référence décrédibilise tout le reste et fausse les évaluations",
                               ["SKILL.md"], "mettre à jour le chiffre, ou le retirer s'il n'a pas de valeur pédagogique"))

    return out


def recommend(findings: list[dict]) -> str:
    if not findings:
        return "none"
    return max(findings, key=lambda f: SEV_ORDER[f["severity"]])["severity"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Détecte la dérive entre un agent vivant et le skill qui doit le représenter.")
    ap.add_argument("--project", type=Path, default=SKILL_ROOT_DEFAULT.parent.parent.parent / "opengravity")
    ap.add_argument("--skill", type=Path, default=SKILL_ROOT_DEFAULT)
    ap.add_argument("--baseline", type=Path, help="à la place de assets/reference (ex. une capture antérieure)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    project = args.project.resolve()
    skill = args.skill.resolve()
    baseline = (args.baseline or skill / "assets/reference").resolve()
    if not project.is_dir():
        print(f"projet introuvable : {project}", file=sys.stderr)
        return 2
    if not baseline.is_dir():
        print(f"référence du skill introuvable : {baseline}", file=sys.stderr)
        return 2

    proj, base, skl = project_signals(project), project_signals(baseline), skill_signals(skill)
    findings = compare(proj, base, skl, project, baseline)
    bump = recommend(findings)
    verdict_ok = bump in ("none", "patch")

    report = {
        "project": str(project),
        "baseline": str(baseline),
        "skill_version": skl["version"],
        "project_signature": {
            "files": proj["file_count"], "prod_lines": proj["prod_lines"], "test_lines": proj["test_lines"],
            "tests": proj["test_count"], "e2e": proj["e2e_count"], "tools": sorted(proj["tools"]),
            "commands": proj["commands"], "env_keys": len(proj["env_keys"]), "tables": sorted(proj["tables"]),
            "deps": sorted(proj["deps"]), "model_defaults": proj["model_defaults"],
        },
        "skill_claims": {k: v for k, v in skl.items() if k != "files"},
        "counts": {sev: sum(1 for f in findings if f["severity"] == sev) for sev in ("major", "minor", "patch")},
        "bump_recommended": bump,
        "findings": findings,
    }

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    elif not args.quiet:
        print(f"projet   : {project}")
        print(f"référence: {baseline}")
        print(f"skill    : v{skl['version']} — {skl['claimed_invariants']} invariants, "
              f"{skl['claimed_prod_lines'] if skl['claimed_prod_lines'] is not None else 'aucun chiffre'} "
              f"lignes annoncées / {proj['prod_lines']} réelles")
        print()
        if not findings:
            print("aucune dérive : le skill décrit l'état réel du projet.")
        for sev in ("major", "minor", "patch"):
            group = [f for f in findings if f["severity"] == sev]
            if not group:
                continue
            print(f"{sev} ({len(group)})")
            for f in group:
                print(f"  · {f['kind']:24} {f['what']}")
                print(f"    pourquoi : {f['why']}")
                print(f"    agir sur : {', '.join(f['skill_files'])}")
                print(f"    décision : {f['action']}")
            print()
        print(f"bump recommandé : {bump}" + ("" if verdict_ok else f" → passer v{skl['version']} à la version mineure/majeure suivante"))
        print("rappel : un bump ne s'envisage que si l'évolution a une valeur durable — voir references/evolution.md")

    if args.quiet and not args.json:
        # Le mode --json n'imprime QUE le rapport : y ajouter un second objet en fin de
        # flux le rendrait illisible par jq ou par une CI — et un rapport de sécurité
        # qu'on ne peut pas parser est un rapport qu'on finit par sauter.
        print("OK" if verdict_ok else f"{len(findings)} dérive(s), bump {bump}")

    return 0 if verdict_ok else 1


if __name__ == "__main__":
    sys.exit(main())
