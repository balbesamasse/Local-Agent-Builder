#!/usr/bin/env python3
"""Rafraîchit la capture de référence du skill et son empreinte, puis propose le bump.

Un skill qui « évolue avec le projet » meurt d'un détail logistique : la copie de
référence (assets/reference) se fait à la main, donc ne se fait plus. Ce script rend
l'opération sûre et répétée :

  • copie filtrée : aucun secret, aucune base de données, aucun node_modules ;
  • analyse anti-fuite AVANT permutation : un secret détecté annule l'opération et
    supprime la copie en cours — le skill ne doit jamais devenir un exfiltrateur ;
  • permutation atomique par répertoire temporaire (pas de demi-état visible) ;
  • réécriture de assets/skill_state.json (empreinte du projet, date, version) ;
  • --bump patch|minor|major réécrit metadata.version dans SKILL.md et ajoute une
    entrée CHANGELOG au format de traçabilité convenu.

Le verdict sur le niveau de bump appartient à l'humain : --bump est une inférence
assistée (elle s'appuie sur detect_drift.py), pas une décision automatique.

Usage :
    python3 refresh_reference.py [--project DIR] [--skill DIR] [--dry-run]
                                [--bump patch|minor|major] [--summary "texte"]
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL_ROOT_DEFAULT = HERE.parent
PROJECT_DEFAULT = SKILL_ROOT_DEFAULT.parent.parent.parent / "opengravity"

IGNORES = [
    "node_modules", "dist", "build", "coverage", ".git", ".venv", "__pycache__", "logs",
    # « logs » : le miroir ne doit pas embarquer un répertoire de RUNTIME, même vide —
    # un scaffold propre ne crée pas ses dossier de journal lui-même, et un `logs/` copié
    # depuis la machine de référence risque d'y charrier les journaux de quelqu'un d'autre.
    ".env", ".env.local", "memory.db", "memory.db-*", "*.log", "service-account.json",
    "serviceAccount*.json", "*.pem", "*.key", ".DS_Store", ".arena", ".npm", ".cache",
    "SCAFFOLD.md",
]
SECRET_PATTERNS = [
    r"gsk_[A-Za-z0-9_-]{20,}",
    r"sk-[A-Za-z0-9_-]{20,}",
    r"ghp_[A-Za-z0-9]{30,}",
    r"BEGIN (?:RSA )?PRIVATE KEY",
    r"AIza[0-9A-Za-z_-]{30,}",
    r"\d{8,10}:[A-Za-z0-9_-]{30,}",  # forme d'un token Telegram
]
# Les fixtures de test contiennent des jetons de forme volontairement réaliste : ils
# sont fabriqués pour la suite, pas volés. On les signale sans bloquer la copie.
TEST_DIRS = re.compile(r"(^|/)(src/(test|tests)|tests?|.*testing.*)/")
# Les fichiers .example sont des modèles : ils DOIVENT montrer la forme d'une clé.
# On ne les excuse que s'ils portent une marque de place holder visible — sinon
# n'importe qui pourrait glisser une clé réelle dans un fichier .example et la
# faire passer. Un garde-fou qui sonne à chaque exécution légitime sera désactivé ;
# l'échappatoire doit donc être typée et vérifiable, pas absente.
PLACEHOLDER_MARKERS = re.compile(r"(?i)(remplacez|votre|exemple|placeholder|xxx+|your[_ -]|<[^>]{2,}>|todo)")


def fingerprint(root: Path) -> dict:
    """Empreinte compacte : suffisante pour détecter un changement, sans contenu."""
    files = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if any(part in IGNORES or part.startswith(".") and part not in (".env.example",) for part in rel.parts):
            continue
        # `.sh` compte : un projet qui shippe un watchdog (`scripts/keepalive.sh`) a une partie
        # de sa surveillance dans un script shell, et une empreinte qui l'ignore laisse sa
        # mort passer inaperçue — le miroir ne doit pas être aveugle à l'étage du haut.
        if p.suffix not in {".ts", ".json", ".md", ".example", ".sh", ".gitignore"} and p.name != ".gitignore":
            continue
        files[str(rel)] = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    tree = hashlib.sha256("\n".join(f"{k}:{v}" for k, v in sorted(files.items())).encode()).hexdigest()[:32]
    return {"files": len(files), "tree": tree}


def scan_for_secrets(root: Path) -> list[str]:
    hits: list[str] = []
    for p in sorted(root.rglob("*")):
        # `.sh` dans l'analyse anti-fuite : un script d'exploitation est exactement l'endroit où
        # une clé atterrit quand quelqu'un a voulu « juste lancer le bot plus vite ».
        if not p.is_file() or p.suffix not in {".ts", ".js", ".json", ".md", ".example", ".txt", ".py", ".sh"}:
            continue
        rel = str(p.relative_to(root))
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        excused = rel.endswith(".example") and bool(PLACEHOLDER_MARKERS.search(text))
        for pattern in SECRET_PATTERNS:
            for m in re.finditer(pattern, text):
                where = f"{rel}:{text[:m.start()].count(chr(10)) + 1}"
                if TEST_DIRS.search("/" + rel) or excused:
                    continue
                hits.append(where + " → " + m.group(0)[:10] + "…")
    return hits


def bump_version(current: str, kind: str) -> str:
    parts = (current or "1.0.0").split(".")
    while len(parts) < 3:
        parts.append("0")
    major, minor, patch = (int(re.sub(r"\D", "", p) or 0) for p in parts[:3])
    if kind == "major":
        return f"{major + 1}.0.0"
    if kind == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Resynchronise le skill avec l'état réel du projet.")
    ap.add_argument("--project", type=Path, default=PROJECT_DEFAULT)
    ap.add_argument("--skill", type=Path, default=SKILL_ROOT_DEFAULT)
    ap.add_argument("--dry-run", action="store_true", help="montre les écarts, n'écrit rien")
    ap.add_argument("--bump", choices=["patch", "minor", "major"], help="incrémente metadata.version dans SKILL.md")
    ap.add_argument("--summary", default="", help="une phrase : ce qui a changé et pourquoi ça compte")
    args = ap.parse_args()

    project, skill = args.project.resolve(), args.skill.resolve()
    if not (project / "src/config.ts").is_file():
        print(f"« {project} » ne ressemble pas à un agent OpenGravity (src/config.ts absent)", file=sys.stderr)
        return 2
    if not (skill / "SKILL.md").is_file():
        print(f"skill introuvable : {skill}", file=sys.stderr)
        return 2

    dest = skill / "assets/reference"
    before = fingerprint(dest) if dest.is_dir() else {"files": 0, "tree": "(absent)"}
    now = fingerprint(project)

    print(f"projet    : {project}")
    print(f"empreinte : {now['files']} fichiers, tree {now['tree'][:12]}")
    print(f"référence : {'%d fichiers, tree %s' % (before['files'], before['tree'][:12]) if dest.is_dir() else 'absente'}")
    same = before == now
    if same:
        print("\nréférence déjà identique au projet : rien à copier.")
    if args.dry_run:
        print("\n(--dry-run : aucune écriture)")
        return 0

    # mkdtemp crée le répertoire ; copytree, lui, refuse une destination existante.
    # D'où un sous-répertoire réservé : la zone de transit n'existe qu'une fois copiée.
    tmp_root = Path(tempfile.mkdtemp(prefix="ref-", dir=str(dest.parent if dest.parent.is_dir() else skill / "assets")))
    staging = tmp_root / "reference"
    try:
        shutil.copytree(project, staging, ignore=shutil.ignore_patterns(*IGNORES), symlinks=False)

        hits = scan_for_secrets(staging)
        if hits:
            print("\n❌ secrets détectés dans la copie — opération annulée, rien n'a été publié :", file=sys.stderr)
            for h in hits[:10]:
                print("   ", h, file=sys.stderr)
            return 1

        # Contrôle dur : ces fichiers ne doivent JAMAIS se retrouver là, même si le
        # projet les a créés entre deux exécutions.
        for forbidden in (".env", "service-account.json", "memory.db"):
            if (staging / forbidden).exists():
                print(f"\n❌ {forbidden} s'est copié malgré les filtres — opération annulée.", file=sys.stderr)
                return 1

        if not same:
            if dest.exists():
                shutil.rmtree(dest)
            staging.replace(dest)
    finally:
        # 'finally' et pas une ligne après le 'try' : les retours d'erreur ci-dessus
        # doivent nettoyer aussi. Un répertoire temporaire oublié dans assets/ se
        # retrouve copié au prochain scaffold, et le skill devient un fuitard.
        shutil.rmtree(tmp_root, ignore_errors=True)

    # --- état du skill -------------------------------------------------------
    # dont_write_bytecode : ce script tourne dans le dossier du skill, et un
    # __pycache__ créé là atterrit dans la arborescence publiée/installée du skill.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(skill / "scripts"))
    import detect_drift

    signals = detect_drift.project_signals(project)
    skill_md = (skill / "SKILL.md").read_text(encoding="utf-8")
    current = (re.search(r'version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?', skill_md) or [None, "1.0.0"])[1]
    new_version = bump_version(current, args.bump) if args.bump else current

    state = {
        "skill": skill.name,
        "skill_version": new_version,
        "previous_version": current if args.bump else None,
        "project": "OpenGravity",
        "project_root": str(project),
        "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "reference_fingerprint": now,
        "project_signals": {
            "files": signals["file_count"],
            "prod_lines": signals["prod_lines"],
            "test_lines": signals["test_lines"],
            "tests": signals["test_count"],
            "e2e": signals["e2e_count"],
            "tools": sorted(signals["tools"]),
            "commands": signals["commands"],
            "tables": sorted(signals["tables"]),
            "deps": sorted(signals["deps"]),
            "model_defaults": signals["model_defaults"],
            "env_keys": signals["env_keys"],
        },
        "summary": args.summary or None,
    }
    (skill / "assets/skill_state.json").write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if args.bump:
        updated = re.sub(r'(version:\s*")' + re.escape(current) + '(")', r"\g<1>" + new_version + r"\g<2>", skill_md, count=1)
        entry = (
            f"## v{new_version} — {dt.date.today().isoformat()}\n\n"
            f"- **à partir de** : v{current}\n"
            f"- **intégrations** : {args.summary or 'À COMPLÉTER — lister les évolutions retenues'}\n"
            f"- **pourquoi** : à compléter (impact sur la façon de construire les agents)\n"
            f"- **remplacé / supprimé** : à compléter\n"
            f"- **preuve** : à compléter (commande exécutée + résultat brut)\n"
            f"- **empreinte de référence** : {now['files']} fichiers, tree `{now['tree'][:12]}`\n\n"
        )
        changelog = skill / "CHANGELOG.md"
        text = changelog.read_text(encoding="utf-8") if changelog.is_file() else "# Historique du skill\n"
        # L'entrée se place juste avant la première section « ## » existante : un
        # partition("\n\n") la posait au-dessus du paragraphe d'introduction, ce qui
        # cassait le fichier (l'en-tête se retrouvait en milieu de page).
        lines = text.splitlines(keepends=True)
        idx = next((n for n, ln in enumerate(lines) if ln.startswith("## ")), len(lines))
        changelog.write_text("".join(lines[:idx]) + entry + "\n" + "".join(lines[idx:]), encoding="utf-8")

        # L'empreinte annoncée dans le frontmatter est une affirmation vérifiable : si
        # rien ne la réécrit, elle ment dès la deuxième capture (constaté en v1.2.0).
        updated = re.sub(
            r'(empreinteDeReference:\s*")[^"]*(")',
            r"\g<1>" + f"{now['files']} fichiers · tree {now['tree'][:12]}" + r"\g<2>",
            updated,
            count=1,
        )
        (skill / "SKILL.md").write_text(updated, encoding="utf-8")
        print(f"\n✓ SKILL.md : version {current} → {new_version}, empreinteDeReference réalignée")
        print(f"✓ CHANGELOG.md : entrée v{new_version} insérée (les champs « à compléter » sont à rédiger)")

    print(f"✓ assets/skill_state.json écrit ({now['files']} fichiers, {signals['test_count']} tests, {len(signals['tools'])} outils)")
    if not same:
        print("✓ référence rafraîchie — lancer ensuite : python3 scripts/detect_drift.py (attendu : aucune dérive)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
