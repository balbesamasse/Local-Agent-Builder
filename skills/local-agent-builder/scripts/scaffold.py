#!/usr/bin/env python3
"""
Genere un nouvel agent personnel local a partir de la reference OpenGravity.

    python3 scaffold.py --name "MonAgent" --out ../monagent [--timezone Africa/Bamako]
                         [--no-tests] [--force]

Ce que fait le script :
  1. copie l'implementation de reference (assets/reference) sans node_modules,
     sans build, sans base de donnees et sans .env ;
  2. rebaptise l'agent partout (nom d'affichage, nom du paquet npm, defauts de
     config, README, docs) ;
  3. applique le fuseau horaire demande ;
  4. verifie que rien du contexte local (secrets, .env, memory.db) ne s'est
     glisse dans la sortie ;
  5. ecrit SCAFFOLD.md avec la suite exacte des etapes.

Il ne copie JAMAIS : node_modules, dist, .env, memory.db*, service-account.json,
.git. Un secret ne doit pas survivre a la generation d'un second agent.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REFERENCE = HERE.parent / "assets" / "reference"

# Nom de l'agent dans l'implementation de reference : c'est la chaine a remplacer.
REFERENCE_NAME = "OpenGravity"

EXCLUDE_DIRS = {"node_modules", "dist", ".git", "coverage", ".test-build"}
EXCLUDE_FILES = {".env", ".env.local", "memory.db", "memory.db-journal", "memory.db-wal", "memory.db-shm", "service-account.json", "package-lock.json"}


def kebab(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "local-agent"


def rename_tree(out: Path, new_name: str, timezone: str) -> int:
    """Remplace le nom de l'agent et le fuseau dans les fichiers de texte."""
    # Toute extension qui peut porter le nom de l'agent, y compris les fichiers d'exploitation :
    # `.plist`, `.service` et `.sh` contenaient `opengravity` (Label launchd, unit systemd,
    # chemin du projet) et partaient tels quel dans un projet renomme. Une cible oubliee n'est
    # pas un detail de presentation : c'est le nom d'un autre agent qui reste actif sur la
    # machine de l'utilisateur.
    targets = [
        p for p in out.rglob("*") if p.is_file() and p.suffix in {".ts", ".md", ".json", ".example", ".sql", ".plist", ".service", ".sh"}
    ]
    touched = 0
    for path in targets:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        updated = text
        if new_name != REFERENCE_NAME:
            # Deux formes a remplacer : le nom d'affichage et sa version minuscule
            # (utilisee comme slug : identifiant de paquet, referer, prefixe de
            # repertoire de test). Oublier la seconde laisse des traces de l'agent
            # modele dans un projet destine a etre publie.
            updated = updated.replace(REFERENCE_NAME, new_name).replace(REFERENCE_NAME.lower(), kebab(new_name))
            # Le nom du paquet npm doit rester en kebab-case valide.
            if path.name == "package.json":
                pkg = json.loads(updated)
                pkg["name"] = kebab(new_name)
                updated = json.dumps(pkg, indent=2) + "\n"
        if timezone:
            updated = re.sub(r'(SYSTEM_TIMEZONE=")[^"]*(")', rf"\g<1>{timezone}\g<2>", updated)
            updated = re.sub(r"(readString\('SYSTEM_TIMEZONE', ')[^']*(')\)", rf"\g<1>{timezone}\g<2>)", updated)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            touched += 1
    if new_name != REFERENCE_NAME:
        slug = kebab(new_name)
        for path in sorted(out.rglob("*"), key=lambda q: (-len(q.parts), str(q))):
            if not path.is_file():
                continue
            if path.name == f"{REFERENCE_NAME.lower()}.service":
                path.rename(path.with_name(f"{slug}.service")); touched += 1
            elif path.name == f"com.{REFERENCE_NAME.lower()}.keepalive.plist":
                path.rename(path.with_name(f"com.{slug}.keepalive.plist")); touched += 1
    return touched


def audit_leaks(out: Path) -> list[str]:
    """Refuse une generation qui contiendrait un secret ou une donnee personnelle."""
    problems: list[str] = []
    for path in out.rglob("*"):
        if not path.is_file():
            continue
        if path.name in {".env", "memory.db", "service-account.json"} or path.suffix == ".db":
            problems.append(f"fichier sensible copie : {path.relative_to(out)}")
            continue
        if path.suffix not in {".ts", ".md", ".json", ".example", ".sh", ".plist", ".service"}:
            continue
        # Les doubles de test manipulent des tokens et cles factices, verifies comme
        # tels par la suite de tests : pas de faux positif ici.
        parts = path.relative_to(out).parts
        if "test" in parts or "testing" in parts:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"(gsk_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|\d{8,12}:[A-Za-z0-9_-]{30,}|BEGIN RSA PRIVATE KEY)", text):
            problems.append(f"valeur type secret dans {path.relative_to(out)} : {m.group(1)[:14]}…")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Genere un agent local a partir de la reference.")
    parser.add_argument("--name", default=REFERENCE_NAME, help="nom d'affichage de l'agent (ex. 'Atlas')")
    parser.add_argument("--out", required=True, help="repertoire de sortie (cree s'il n'existe pas)")
    parser.add_argument("--timezone", default="", help="fuseau IANA par defaut (ex. Africa/Bamako)")
    parser.add_argument("--no-tests", action="store_true", help="ne pas copier src/test (demarrage minimal)")
    parser.add_argument("--force", action="store_true", help="ecrase un repertoire de sortie non vide")
    args = parser.parse_args()

    if not REFERENCE.is_dir():
        print(f"implementation de reference absente : {REFERENCE}", file=sys.stderr)
        print("restaurer le contenu de assets/reference/ (copie de l'agent modele).", file=sys.stderr)
        return 2

    out = Path(args.out).resolve()
    if out.exists() and any(out.iterdir()) and not args.force:
        print(f"{out} n'est pas vide (utiliser --force pour ecraser).", file=sys.stderr)
        return 2

    # copytree refuse une destination existante : on part toujours d'un repertoire
    # qui n'existe pas (un dossier vide laisse aussi des artefacts de copie).
    if out.exists():
        shutil.rmtree(out)

    def ignore(dir_path: Path, names: list[str]) -> set[str]:
        skipped = {n for n in names if n in EXCLUDE_DIRS or n in EXCLUDE_FILES}
        if args.no_tests and dir_path.name == "src" and "test" in names:
            skipped |= {"test", "testing"}
        return skipped

    shutil.copytree(REFERENCE, out, ignore=lambda d, n: ignore(Path(d), n), symlinks=False)

    # --no-tests : les fabriques de test ne servent plus a rien.
    if args.no_tests:
        shutil.rmtree(out / "src" / "testing", ignore_errors=True)
        pkg = json.loads((out / "package.json").read_text())
        pkg["scripts"].pop("test", None)
        pkg["scripts"].pop("check", None)
        (out / "package.json").write_text(json.dumps(pkg, indent=2) + "\n")

    touched = rename_tree(out, args.name, args.timezone)

    problems = audit_leaks(out)
    if problems:
        shutil.rmtree(out, ignore_errors=True)
        print("generation annulee, fuite detectee :", file=sys.stderr)
        for item in problems[:10]:
            print(f"  - {item}", file=sys.stderr)
        return 1

    (out / "SCAFFOLD.md").write_text(
        "\n".join(
            [
                f"# {args.name} — genere depuis la reference",
                "",
                f"Nom d'affichage : `{args.name}` · paquet npm : `{kebab(args.name)}`"
                + (f" · fuseau : `{args.timezone}`" if args.timezone else ""),
                f"{touched} fichier(s) rebaptise(s). Aucun secret, aucune base de donnees n'a ete copie.",
                "",
                "## Suite obligatoire",
                "",
                "```bash",
                "npm install",
                "cp .env.example .env && chmod 600 .env   # puis remplir token + ids + cle LLM",
                "npm run check                             # typecheck + tests + build",
                'python3 <chemin-du-skill>/scripts/check_invariants.py .   # invariants de securite',
                "npm run dev",
                "```",
                "",
                "## A faire avant la premiere conversation serieuse",
                "",
                "1. Ecrire /id au bot pour recuperer son identifiant numerique, le mettre dans",
                "   TELEGRAM_ALLOWED_USER_IDS, puis passer TELEGRAM_ID_COMMAND_ENABLED=false.",
                "2. Relire la liste des outils dans src/tools/builtin/ et retirer ce qui n'est pas",
                "   utile : chaque outil est une capacite d'action, donc une surface d'attaque.",
                "3. Decider du sort de memory.db (sauvegarde chifffee, ou purge reguliere).",
                "4. Ne pas activer DANGEROUS_TOOLS_ENABLED sans avoir ecrit d'outil sensible a approuver.",
                "",
            ]
        ),
        encoding="utf-8",
    )

    files = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())
    print(f"{args.name} généré dans {out}")
    print(f"  {len(files)} fichiers, {touched} renommés" + ("" if not args.no_tests else " (sans suite de tests)"))
    print(
            "  étapes suivantes : "
            + " → ".join(
                [
                    "npm install",
                    "cp .env.example .env",
                    "npm run check",
                    "npm run dev (mise au point)",
                    "bash scripts/keepalive.sh status (veille) — deploy/ pour launchd ou systemd",
                    "npm run build && npm run supervise (service)",
                ]
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
