#!/usr/bin/env python3
"""
Vérificateur des invariants de sécurité d'un agent local de type OpenGravity.

Usage :
    python3 check_invariants.py [CHEMIN_DU_PROJET] [--json] [--quiet]

Sortie : une liste de constats, code de sortie 1 si un invariant est violé.
Le script ne modifie aucun fichier : il est conçu pour tourner dans une CI, un
pre-commit, ou avant de considerer l'agent "pret".

Les regles ne sont pas esthetiques : chacune correspond a un defaut reel
rencontre pendant la construction d'OpenGravity (fuite du message d'erreur du
fournisseur, outil dangereux enregistre sans approbation, sortie d'outil
reinjectee comme instruction, chaine d'echappement HTML incomplete).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# --- couches interdites d'import -------------------------------------------
# core/ et tools/ doivent survivre a un changement de canal ou de fournisseur :
# un import de grammy dans core/ casse cette propriete (et donc le passage cloud).
FORBIDDEN_IMPORTS = {
    "src/core": [r"grammy", r"channels/"],
    "src/tools": [r"grammy", r"channels/", r"llm/"],
    "src/memory": [r"grammy", r"channels/"],
    "src/security": [r"grammy", r"channels/", r"llm/"],
    "src/llm": [r"grammy", r"channels/"],
    "src/audio": [r"grammy", r"channels/"],
    "src/media": [r"grammy", r"channels/", r"llm/"],
}

# Execution de code arbitraire : non negociable.
# Le bootstrap d'un processus appele a tourner des jours doit pouvoir faire ce que le
# reste du code n'a pas le droit de faire : lancer son propre point d'entree, lire la rare
# variable d'environnement qui designe son journal, ecrire un fichier de verrou. Ces
# permissions ne sont pas des oublis de regle : elles sont nommees, et chacune est exigible
# par une contrepartie verifiee plus bas (voir R1/R2/R15).
SUPERVISOR = "src/supervise.ts"
DISK_WRITE_OK = {"src/core/logger.ts", SUPERVISOR}
MARKER = "DISK-WRITE-OK:"  # chaque fichier autorise doit le porter, sinon l'exception est refusee
# Un port d'ecoute est une DECISION, pas une habitude : la meme logique d'exception nommee
# s'applique (voir R20) — le fichier doit dire pourquoi il ecoute et par quel drapeau on l'eteint.
LISTEN_MARKER = "LISTEN-EXCEPTION:"

# Un transport externe (CLI metier, pas du code du modele) et un filtreur d'environnement sont les
# deux seuls cas ou une regle doit pouvoir etre levee. Levable ne veut pas dire silencieuse : la
# levee exige un marqueur dans le fichier, et le marqueur ne suffit pas si la contrepartie
# structurelle n'est pas la. Sans marqueur, la regle tombe comme avant.
EXEC_TRANSPORT_MARKER = "invariant: exec-transport"
ENV_CHILD_MARKER = "invariant: env-enfant"
# Interfaces de contrainte entre modules : un champ declare et jamais lu est une promesse fausse
# (un outil qui « explique » dans un champ que personne ne lit n'explique rien a l'utilisateur).
AUDITED_INTERFACES = ("ToolResult", "AgentReply")

EXEC_PATTERNS = [
    (r"(?<![\w.$])eval\s*\(", "eval() — exécution de code arbitraire"),
    (r"new\s+Function\s*\(", "new Function() — équivalent de eval()"),
    (r"from\s+['\"]node:(child_process|vm|worker_threads)['\"]", "module d'exécution/child_process"),
    (r"require\(['\"](child_process|vm)['\"]\)", "require() d'un module d'exécution"),
]


def strip_ts(source: str) -> str:
    """Retire commentaires et remplace le contenu des chaines par des espaces.

    Une detection naave sur le texte brut produit des faux positifs (le mot
    `eval()` dans un commentaire) et des faux negatifs (une URL `//` qui avale
    la fin d'une ligne). On scanne donc une seule fois, en machine a etats.
    """
    out: list[str] = []
    i, n = 0, len(source)
    state = "code"  # code | line | block | sq | dq | tpl
    brace_depth = 0
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if state == "code":
            if ch == "/" and nxt == "/":
                state, i = "line", i + 2
                continue
            if ch == "/" and nxt == "*":
                state, i = "block", i + 2
                continue
            if ch == "'":
                state = "sq"
            elif ch == '"':
                state = "dq"
            elif ch == "`":
                state = "tpl"
            elif ch == "{":
                brace_depth += 1
            elif ch == "}":
                brace_depth = max(0, brace_depth - 1)
            out.append(ch)
            i += 1
            continue
        if state == "line":
            if ch == "\n":
                state = "code"
                out.append("\n")
            i += 1
            continue
        if state == "block":
            if ch == "*" and nxt == "/":
                state, i = "code", i + 2
                out.append(" ")
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        # etats "chaine" : on preserve le texte (necessaire pour detecter les
        # motifs dans les literals), mais on suit les echappements et ${}.
        quote = {"sq": "'", "dq": '"', "tpl": "`"}[state]
        if ch == "\\":
            out.append("  ")
            i += 2
            continue
        if state == "tpl" and ch == "$" and nxt == "{":
            out.append("  ")
            i += 2
            continue
        if ch == quote:
            state = "code"
        out.append(ch)
        i += 1
    return "".join(out)


class Check:
    def __init__(self, rule: str, ok: bool, detail: str, fix: str) -> None:
        self.rule, self.ok, self.detail, self.fix = rule, ok, detail, fix

    def as_dict(self) -> dict:
        return {"rule": self.rule, "ok": self.ok, "detail": self.detail, "fix": self.fix}


def find_files(root: Path, subdir: str = "src") -> list[Path]:
    base = root / subdir
    if not base.is_dir():
        return []
    return sorted(p for p in base.rglob("*.ts") if p.is_file())


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def run(root: Path) -> list[Check]:
    checks: list[Check] = []
    sources = find_files(root)
    if not sources:
        return [Check("structure", False, f"aucun fichier .ts sous {root / 'src'}", "relancer depuis la racine du projet de l'agent")]

    production = [p for p in sources if "/test/" not in rel(root, p) and "/testing/" not in rel(root, p)]
    code = {p: strip_ts(p.read_text(encoding="utf-8")) for p in sources}

    # --- R1 : aucune execution de code ------------------------------------
    hits: list[str] = []
    transports: list[str] = []
    for p in production:
        is_supervisor = rel(root, p) == SUPERVISOR
        # Un module qui lance un binaire METIER (client Google, outil installe) est autorise, mais
        # seulement s'il dit lui-meme qu'il le fait et s'il garantit les deux choses qui rendent
        # l'affaire sure : pas d'interpretatif de shell, et un environnement construit par filtrage
        # (un fils qui herite de tout herite aussi des cles d'API, et elles ressortent dans ses
        # messages d'erreur). eval() et new Function() ne sont jamais leves.
        raw = p.read_text(encoding="utf-8")
        # Le marqueur se lit dans le texte brut (c'est un commentaire), les DEUX contreparties se
        # lisent dans le code commentaire-supprime : sinon une phrase en prose dans l'en-tete
        # (« ici, childEnvironment, pas de shell: true ») suffirait a lever la regle. C'est
        # exactement le defaut qu'on est en train d'interdire ailleurs.
        body = code[p]
        is_transport = (
            EXEC_TRANSPORT_MARKER in raw
            and "shell: true" not in body
            # L'env du fils doit SORTIR d'un filtrage, et aucun objet d'environment ne doit etre un
            # etalement du pere : « { ...this.parentEnv, ...overrides } » a l'air d'une liste blanche
            # et herite de tout. La forme est refusee, pas seulement le mot.
            and re.search(r"env:\s*(?:this\.)?childEnv\b|env:\s*childEnvironment\(", body)
            and not re.search(r"\.\.\.\s*(?:this\.)?(?:parentEnv|process\.env)\b", body)
        )
        if is_transport:
            transports.append(rel(root, p))
        for pattern, label in EXEC_PATTERNS:
            for m in re.finditer(pattern, code[p]):
                # Un superviseur lance le point d'entree de l'agent : c'est son role.
                if is_supervisor and "child_process" in pattern:
                    continue
                if is_transport and "child_process" in pattern:
                    continue
                line = code[p][: m.start()].count("\n") + 1
                hits.append(f"{rel(root, p)}:{line} → {label}")
        if is_supervisor:
            raw_sup = p.read_text(encoding="utf8")
            for forbidden, why in [
                (r"shell:\s*true", "shell: true expose la ligne de commande a l'interpretatif"),
                (r"\bexecSync\s*\(", "execSync execute une commande arbitraire"),
                (r"\bexecFile\s*\([^)]*shell", "execFile avec shell annule sa propre garantie"),
            ]:
                if re.search(forbidden, strip_ts(raw_sup)):
                    hits.append(f"{SUPERVISOR} → {why}")
    checks.append(Check(
        "no-code-execution", not hits,
        "; ".join(hits[:6])
        if hits
        else f"{len(production)} fichiers sans eval/Function"
        + (f", child_process cantonne a {', '.join(transports)} (binaire metier, environnement filtre)" if transports else " et sans child_process"),
        "remplacer par un parseur dédié (voir tools/calculator.ts) ou un appel réseau borné ; pour un transport metier legitime, marquer le fichier et garantir env filtre + pas de shell",
    ))

    # --- R2 : process.env confine a la config ------------------------------
    env_out: list[str] = []
    for p in production:
        r = rel(root, p)
        if r == "src/config.ts" or "process.env" not in code[p]:
            continue
        raw_env = p.read_text(encoding="utf-8")
        if ENV_CHILD_MARKER in raw_env:
            # Lire process.env pour le FILTRER n'est pas lire process.env pour y choisir un reglage.
            # La levee exige la meme preuve structurelle que R1 : un environment construit par un
            # filtrage, et aucun etalement du pere — un { ...process.env } presente comme une liste
            # blanche herite de tout, et le marqueur ne serait qu'un commentaire d'autorisation.
            body_env = code[p]
            filter_used = re.search(r"env:\s*(?:this\.)?childEnv\b|env:\s*childEnvironment\(", body_env)
            spread = re.search(r"\.\.\.\s*(?:this\.)?(?:parentEnv|process\.env)\b", body_env)
            if filter_used is None or spread is not None:
                env_out.append(f"{r} (process.env lu sans filtre reel : le fils heriterait des cles de l'agent)")
            continue
        if r == SUPERVISOR:
            # Exception justifiee : le superviseur doit connaitre son journal et ses secrets
            # AVANT de pouvoir passer par une config qu'il reste a valider. En contrepartie,
            # il doit enregistrer les valeurs a masquer : sans ca, il recopierait un token
            # dans chaque ligne de decision de relance.
            if "registerSecrets(" not in strip_ts(p.read_text(encoding="utf8")):
                env_out.append(f"{r} (process.env lu sans registerSecrets : le journal du superviseur serait la fuite)")
            continue
        env_out.append(r)
    checks.append(Check(
        "env-single-point", not env_out,
        "; ".join(env_out[:6]) if env_out else "process.env lu uniquement dans src/config.ts",
        "exposer la valeur via AppConfig : la validation et le masquage des secrets ne doivent avoir qu'un seul point",
    ))

    # --- R3 : sens des dependances entre couches ---------------------------
    layer_hits: list[str] = []
    for prefix, forbidden in FORBIDDEN_IMPORTS.items():
        for p in production:
            r = rel(root, p)
            if not r.startswith(prefix):
                continue
            for spec in re.findall(r"from\s+['\"]([^'\"]+)['\"]", code[p]):
                for bad in forbidden:
                    if re.search(bad, spec):
                        layer_hits.append(f"{r} importe {spec} ({bad})")
    checks.append(Check(
        "layering", not layer_hits,
        "; ".join(layer_hits[:6]) if layer_hits else "core/tools/memory/security/llm indépendants du canal",
        "le noyau ne doit pas connaître le transport : sinon un ajout de canal ou un passage cloud impose de réécrire le raisonnement",
    ))

    # --- R4 : outil dangereux => approbation obligatoire -------------------
    unapproved: list[str] = []
    for p in production:
        text = code[p]
        for m in re.finditer(r"\{[^{}]*?name:\s*['\"]([a-z0-9_]+)['\"][^{}]*?\}", text, re.S):
            block = m.group(0)
            if "dangerous: true" in block and "requiresApproval: true" not in block:
                unapproved.append(m.group(1))
    registry = root / "src/tools/registry.ts"
    enforced = registry.is_file() and "requiresApproval" in registry.read_text(encoding="utf-8") and "throw" in registry.read_text(encoding="utf-8")
    checks.append(Check(
        "dangerous-requires-approval", not unapproved and enforced,
        (f"outils sans approbation : {', '.join(unapproved)}" if unapproved else "aucun outil dangereux enregistré sans approbation")
        + ("" if enforced else " ; le registre ne vérifie pas l'invariant à l'enregistrement"),
        "marquer requiresApproval: true, et vérifier l'invariant dans le constructeur du registre (pas dans l'appelant)",
    ))

    # --- R5 : liste blanche avant tout handler -----------------------------
    channels = sorted((root / "src/channels").glob("**/bot.ts")) if (root / "src/channels").is_dir() else []
    if channels:
        bot = channels[0].read_text(encoding="utf-8")
        guard = bot.find("allowlistMiddleware(")
        handlers = [(m.start(), m.group(0)) for m in re.finditer(r"bot\.(?:on|command)\(\s*['\"]([^'\"]+)['\"]", bot)]
        # /id est l'exception documentee (recuperation du chat id a l'installation).
        offenders = [name for pos, name in handlers if (guard == -1 or pos < guard) and not name.endswith("id'") and not name.endswith('id"')]
        checks.append(Check(
            "allowlist-before-handlers", guard != -1 and not offenders,
            f"{rel(root, channels[0])} : garde à l'offset {guard}, handlers avant elle → {', '.join(offenders) if offenders else 'aucun'}",
            "enregistrer le middleware de liste blanche avant toute commande ou handler : un handler placé avant répond aux inconnus",
        ))
        # --- R6 : aucune capacite chargee dynamiquement ---------------------
        # Le modele ne doit pas pouvoir designer un module a charger : la liste
        # des outils est close. Un import() ou require() construit depuis une
        # chaine rouvre exactement la porte que le registre ferme.
        dyn: list[str] = []
        for p2 in production:
            text = code[p2]
            for m in re.finditer(r"(?:await\s+)?import\s*\(|\brequire\s*\(", text):
                line = text[: m.start()].count("\n") + 1
                dyn.append(f"{rel(root, p2)}:{line}")
        checks.append(Check(
            "static-tool-loading", not dyn,
            f"chargement dynamique : {'; '.join(dyn[:4])}" if dyn else "aucun import() dynamique dans le code de production",
            "les capacités doivent être enregistrées statiquement dans buildRegistry() ; un import résolu depuis une chaîne transforme le LLM en chargeur de plugins",
        ))
    else:
        checks.append(Check("allowlist-before-handlers", False, "aucun canal trouvé dans src/channels/", "créer src/channels/<canal>/bot.ts branché sur runAgent"))

    # --- R7 : boucle d'agent bornée ----------------------------------------
    agent = root / "src/core/agent.ts"
    agent_code = strip_ts(agent.read_text(encoding="utf-8")) if agent.is_file() else ""
    bounded = bool(re.search(r"maxIterations|MAX_ITERATIONS", agent_code)) and bool(re.search(r"for\s*\(", agent_code))
    checks.append(Check(
        "bounded-loop", bounded,
        "boucle bornée par maxIterations" if bounded else "aucune borne d'itérations détectée dans src/core/agent.ts",
        "sans plafond, un modèle qui boucle sur les outils appelle le fournisseur indéfiniment (coût + blocage)",
    ))

    # --- R8 : sorties d'outils encadrées comme données ---------------------
    framed = "asUntrusted" in agent_code
    checks.append(Check(
        "untrusted-framing", framed,
        "sorties d'outils encadrées" if framed else "les résultats d'outils sont injectés sans cadre anti-injection",
        "envelopper toute sortie dans un cadre explicite et neutraliser les marqueurs du cadre (voir sanitizer.asUntrusted)",
    ))

    # --- R9 : validation d'arguments stricte -------------------------------
    args_file = root / "src/tools/args.ts"
    args_code = strip_ts(args_file.read_text(encoding="utf-8")) if args_file.is_file() else ""
    strict = "additionalProperties: false" in args_code or "additionalProperties:false" in args_code.replace(" ", "")
    checks.append(Check(
        "strict-args-schema", strict,
        "champs inconnus refusés" if strict else "le schéma d'outils n'interdit pas les champs inconnus",
        "additionalProperties:false + refus explicite des clés hors spec, sinon un champ injecté peut cibler un autre chat",
    ))

    # --- R10 : secrets hors de l'index et des sources ----------------------
    gitignore = root / ".gitignore"
    gi = gitignore.read_text(encoding="utf-8") if gitignore.is_file() else ""
    missing = [g for g in (".env", "memory.db") if g not in gi and "*.db" not in gi and "*.db*" not in gi]
    checks.append(Check(
        "gitignore-secrets", bool(gi) and not missing,
        f".gitignore correct" if not missing and gi else f"entrées manquantes : {', '.join(missing) or '.gitignore absent'}",
        "ajouter .env, memory.db* et service-account.json au .gitignore",
    ))

    secret_hits: list[str] = []
    for p in production:
        for m in re.finditer(r"(sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|BEGIN (RSA )?PRIVATE KEY|ghp_[A-Za-z0-9]{30,})", code[p]):
            secret_hits.append(f"{rel(root, p)}:{m.group(1)[:12]}…")
    checks.append(Check(
        "no-committed-secrets", not secret_hits,
        "; ".join(secret_hits[:4]) if secret_hits else "aucune valeur type clé API dans les sources",
        "révoquer immédiatement la clé concernée et la déplacer dans .env (un secret commité est un secret compromis)",
    ))

    # --- R11 : messages d'erreur non verbeux vers l'utilisateur ------------
    # Fuite corrigée pendant la construction d'OpenGravity : renvoyer error.message
    # au canal expose le contenu de la requête et parfois la clé.
    leaky = [rel(root, p) for p in production if re.search(r"reply[^\n]{0,60}\$\{(?:err|error)\b[^}]*\.message", strip_ts(p.read_text(encoding='utf-8')))]
    checks.append(Check(
        "no-error-detail-to-user", not leaky,
        f"détail technique renvoyé au canal dans : {'; '.join(leaky[:3])}" if leaky else "les erreurs brutes restent dans les journaux",
        "journaliser le détail, renvoyer une phrase générique au canal",
    ))

    # --- R13 : le contrat de configuration ne ment nulle part ---------------
    # Ne est né d'un incident réel : la documentation d'un agent annonçait deux noms
    # de modèles que le compte utilisé ne proposait pas, et une clé (Google) était
    # documentée sans qu'aucun code ne la lise. Un .env.example qui diverge de la
    # config est un contrat faux : l'utilisateur remplit des clés inutiles et en
    # ignore des obligatoires.
    cfg_path = root / "src/config.ts"
    cfg_code = strip_ts(cfg_path.read_text(encoding="utf-8")) if cfg_path.is_file() else ""
    # Tout identifiant UPPER_SNAKE passé comme premier argument d'un appel, dans la
    # seule fichier qui a le droit de toucher l'environnement (R2). On n'énumère pas
    # les noms de helpers : readString/raw/readIds hier, readList demain — une règle
    # de dérive qui casse au premier refactor est un faux sentiment de sécurité.
    NON_KEY_CALLS = ("startsWith", "endsWith", "includes", "indexOf", "match", "test", "push", "concat")
    read_keys = {
        m.group(2)  # groupe 1 = nom de la fonction, groupe 2 = nom de la clé
        for m in re.finditer(r"([A-Za-z_$][\w$]*)\(\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]\s*[,)]", cfg_code)
        # On écarte les comparaisons de sentinelles (« startsWith('REMPLACEZ_...') ») :
        # ce ne sont pas des lectures de configuration. La liste est volontairement
        # composée de méthodes de comparaison, pas de noms de nos helpers, pour
        # survivre au renommage de readString/raw/readIds.
        if m.group(1) not in NON_KEY_CALLS
    }
    read_keys |= set(re.findall(r"process\.env\s*\.\s*([A-Z][A-Z0-9_]{2,})", cfg_code))
    read_keys |= set(re.findall(r"process\.env\[\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]\s*\]", cfg_code))

    env_example = root / ".env.example"
    doc_keys: set[str] = set()
    exempt: set[str] = set()
    if env_example.is_file():
        lines = env_example.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            m = re.match(r"\s*([A-Z0-9_]+)\s*=", line)
            if not m:
                continue
            key = m.group(1)
            doc_keys.add(key)
            # Bloc de commentaires contigus au-dessus de la clé : s'il annonce la
            # clé comme « non câblée », l'absence de lecture dans src/ est assumée.
            j = i - 1
            block = []
            while j >= 0 and (lines[j].lstrip().startswith("#") or not lines[j].strip()):
                block.append(lines[j])
                if lines[j].lstrip().startswith("###"):
                    break
                j -= 1
            if any("non câbl" in b for b in block):
                exempt.add(key)

    undocumented = sorted(read_keys - doc_keys)
    dead = sorted(doc_keys - read_keys - exempt)
    checks.append(Check(
        "env-doc-sync", env_example.is_file() and not undocumented and not dead,
        ("aucun .env.example à comparer à src/config.ts" if not env_example.is_file()
         else f"{len(read_keys)} clés lues par la config, {len(doc_keys)} documentées, {len(exempt)} annoncées non câblées"
              if not undocumented and not dead
         else "; ".join(filter(None, [
             f"non documentées : {', '.join(undocumented)}" if undocumented else "",
             f"documentées mais jamais lues : {', '.join(dead)}" if dead else "",
             f"({env_example.name} introuvable)" if not env_example.is_file() else "",
         ])))
        ,
        "tout ce que la config lit doit être documenté ; toute clé documentée doit être lue, "
        "ou porter la mention « non câblée » dans son bloc de commentaires",
    ))

    # --- R14 : un identifiant de modèle épinglé doit être vérifié ------------
    # Les catalogues de modèles sont propres à chaque compte et changent sans
    # prévenir. Un nom recopié depuis une doc n'est qu'une hypothèse : la seule
    # parade mécanique est d'interroger l'inventaire du fournisseur au démarrage
    # (une requête) au lieu de laisser l'utilisateur devant un bot muet.
    pinned = re.findall(
        r"read(?:String)?\(\s*['\"][A-Z0-9_]*MODEL[A-Z0-9_]*['\"]\s*,\s*['\"]([^'\"]{3,})['\"]",
        cfg_code,
    )
    raw = {p: p.read_text(encoding="utf-8") for p in production}
    probe_modules = {p for p in production if re.search(r"/models\b", raw[p])}
    index_raw = raw.get(root / "src/index.ts", "")
    wired = any(p.name.replace(".ts", "") in index_raw for p in probe_modules)
    checks.append(Check(
        "model-inventory-probe", not pinned or (bool(probe_modules) and wired),
        (f"{len(pinned)} modèle(s) par défaut, inventaire vérifié au démarrage" if pinned and probe_modules and wired
         else "aucun modèle épinglé dans la config" if not pinned
         else f"modèles par défaut {pinned[:3]} sans sonde d'inventaire branchée sur le démarrage"),
        "récupérer GET <base>/models au démarrage et refuser de partir sur un modèle absent du compte",
    ))

    # --- R15 : aucun octet recu ou produit ne doit toucher le disque --------
    # La consigne « telecharge puis supprime apres usage » parait sure et ne l'est
    # pas : un retour a la ligne rate, une exception avant le finally, et il reste un
    # fichier contenant une transcription privee dans un depot mal ignore. Ne rien
    # ecrire est une propriete du code ; promettre de nettoyer n'en est pas une.
    WRITE_PATTERNS = [
        r"\bwriteFileSync\s*\(", r"\bwriteFile\s*\(",
        r"\bappendFileSync\s*\(", r"\bappendFile\s*\(",
        r"\bcreateWriteStream\s*\(", r"\bopenSync\s*\(",
    ]
    raw_prod = {p_: p_.read_text(encoding="utf-8") for p_ in production}
    writers: list[str] = []
    for p_ in production:
        r = rel(root, p_)
        if not any(re.search(rx, strip_ts(raw_prod[p_])) for rx in WRITE_PATTERNS):
            continue
        if r in DISK_WRITE_OK and MARKER in raw_prod[p_]:
            continue  # journal et verrou : ecritures declarees et justifiee dans le fichier
        writers.append(r if r not in DISK_WRITE_OK else f"{r} (ecrit sur disque sans porter la mention {MARKER})")
    checks.append(Check(
        "media-no-residue", not writers,
        ("aucune ecriture fichier directe dans src/ : le media reste en memoire, "
         "SQLite ecrit seul son propre fichier" if not writers
         else "ecritures disque directes : " + ", ".join(writers[:4])),
        "les octets audio (recus comme synthetises) ne doivent jamais etre ecrits : les garder "
        "en memoire ; si une retention est reellement decidee, l'ecrire depuis un module dedie, "
        "l'ajouter au .gitignore, nettoyer dans un finally ET le prouver par un test — ou "
        "corriger la documentation qui pretend que « rien n'est ecrit sur disque »",
    ))

    # --- R16 : un fichier heberge par le serveur de fichiers est borne -------
    # Le `file_path` vient d'un service externe : il peut pointer ailleurs (redirection),
    # mentir sur sa taille, ou tenter une traversee. Son URL porte de surcroit le token
    # du bot, donc aucun message d'erreur ne doit la reproduire.
    # Seul le module qui fait reellement le fetch est tenu aux gardes : exiger
    # redirect/plafond dans chaque fichier mentionnant `file_path` accuserait celui qui
    # se contente de le transmettre, et une regle qui hurle toujours finit ignoree.
    media_getters = [
        p_ for p_ in production
        if "file_path" in raw_prod[p_] and re.search(r"\bfetch\s*\(", raw_prod[p_])
    ]
    if not media_getters:
        checks.append(Check(
            "media-download-bounded", True,
            "aucun telechargement de fichier media (agent sans voix)",
            "sans media, rien a borner",
        ))
    else:
        problems = []
        for p_ in media_getters:
            name = rel(root, p_)
            text = raw_prod[p_]
            if not re.search(r"""redirect\s*:\s*['"]manual['"]""", text):
                problems.append(name + " : redirections non desactivees")
            # Presence du mot ne suffit pas : il faut des COMPARAISONS reelles, et DEUX.
            # Le telechargement est borne a l'annonce (content-length) PUIS pendant le
            # flux : un mensonge d'en-tete ne doit pas suffire a depasser le plafond.
            # Limites assumees : un regex ne prouve pas l'arithmetique (un plafond
            # multiplie par 1e9 passerait) — ce niveau de preuve revient aux tests
            # unitaires du module, pas a ce verificateur.
            bounds = re.findall(
                r"[<>]=?\s*[\w.]*(?:max|limit)[\w.]*|[\w.]*(?:max|limit)[\w.]*\s*[<>]=?", text, re.I
            )
            if len(bounds) < 2:
                problems.append(
                    f"{name} : {len(bounds)} plafond(s) compare(s), attendu 2 "
                    "(taille annoncee + flux reel)"
                )
            if not re.search(r"content-length", text, re.I):
                problems.append(name + " : content-length ignore (plafond applique trop tard)")
            # Le validateur doit etre APPELE en garde (`if (!valide(...)) throw`), pas
            # simplement defini dans le meme fichier : sinon la regle se satisfait de
            # l'existence de la fonction, ce qui n'empeche personne de l'oublier.
            if not re.search(r"!\s*\w*(?:isSafe|safe|validate|assert|check)\w*\s*\(", text):
                problems.append(name + " : le chemin Telegram n'est pas valide avant usage")
        checks.append(Check(
            "media-download-bounded", not problems,
            (f"{len(media_getters)} module(s) telechargent un fichier du serveur de fichiers, "
             "avec plafond declare + plafond reel, redirections coupees et chemin valide"
             if not problems else "; ".join(problems)),
            "valider la forme du file_path, redirect:'manual', prelever content-length PUIS borner "
            "le flux reel, et ne jamais exposer l'URL dans une erreur (elle contient le token)",
        ))

    # --- R17 : la decision de parler ne se laisse pas dicter par la sortie ---
    # Ni la legende ecrite par un expediteur ni le texte genere par le modele ne doivent
    # nourrir la detection d'une demande vocale : celui qui controle la sortie controlerait
    # sinon un appel facture chez le fournisseur de synthese.
    dictated = []
    for p_ in production:
        for m in re.finditer(r"\b(?:asksForVoice|refusesVoice|shouldSpeak)\s*\(([^;\n]{1,200})", raw_prod[p_]):
            arg = m.group(1)
            if re.search(r"reply|answer|assistant|response|\bresult\b|\bout\b|turnBody\(", arg, re.I):
                dictated.append(rel(root, p_) + " : " + arg.strip()[:60])
    checks.append(Check(
        "voice-decision-input", not dictated,
        ("la decision vocale ne voit que le texte recu de l'utilisateur" if not dictated
         else "entree de la decision vocale suspecte — " + "; ".join(dictated[:3])),
        "determiner le mode vocal uniquement a partir du message recu de l'utilisateur, jamais "
        "d'un texte genere par le modele ni d'une legende traverse telle quelle",
    ))

    # --- R18 : un agent appele a tourner des jours est garde et supervise ----
    # Un bot Telegram s'est arrete tout seul sans que personne puisse dire pourquoi :
    # trois causes distinctes, toutes evitables par une propriete du code. (a) aucune
    # garde contre un rejet de promesse ou une exception synchrone ; (b) aucun journal sur
    # disque, donc le stdout meurt avec le processus et la cause avec lui ; (c) code de
    # sortie unique (1) pour « config invalide » et pour « panne passagere », ce qui rend
    # toute reprise automatique aveugle. Verifie comme un contrat entre trois fichiers,
    # pas comme la presence d'un mot-cle.
    guard_path = root / "src/core/guard.ts"
    sup_path = root / SUPERVISOR
    guard_raw = guard_path.read_text(encoding="utf8") if guard_path.exists() else ""
    sup_raw = sup_path.read_text(encoding="utf8") if sup_path.exists() else ""
    entry_raw = raw_prod.get(root / "src/index.ts", "")
    pkg_path = root / "package.json"
    pkg_raw = pkg_path.read_text(encoding="utf8") if pkg_path.exists() else ""
    unmet: list[str] = []
    if "process.on('unhandledRejection'" not in guard_raw and 'process.on("unhandledRejection"' not in guard_raw:
        unmet.append("src/core/guard.ts ne couvre pas unhandledRejection (Node 20 le considère fatal)")
    if "uncaughtException" not in guard_raw:
        unmet.append("src/core/guard.ts ne couvre pas uncaughtException (le motif du décès est perdu)")
    if "installCrashGuards(" not in strip_ts(entry_raw):
        unmet.append("src/index.ts n'installe pas la garde")
    if "setLogFile(" not in strip_ts(entry_raw):
        unmet.append("src/index.ts n'ouvre pas de journal fichier (rien ne survit au terminal)")
    if re.search(r"process\.exit\s*\(\s*1\s*\)", entry_raw):
        unmet.append("src/index.ts sort en code 1 : un superviseur ne peut pas distinguer config invalide et panne")
    if "exitCodeFor(" not in strip_ts(entry_raw):
        unmet.append("src/index.ts ne mappe pas l'erreur sur un code de sortie distinct")
    if "delayFor(" not in sup_raw or "backoff" not in sup_raw.lower() and "consecutive" not in sup_raw:
        unmet.append("le superviseur ne calcule pas de délai croissant (martellerait le fournisseur en panne)")
    if f"noRestartCodes" not in sup_raw:
        unmet.append("le superviseur ne distingue pas les codes sans relance (78) : boucle infinie sur une config cassée")
    if "readLock(" not in sup_raw:
        unmet.append("le superviseur ne prend pas de verrou d'instance (deux instances = 409 Telegram = mort certaine)")
    if '"supervise"' not in pkg_raw:
        unmet.append("package.json n'expose pas de script « supervise » : la bonne façon de démarrer restera méconnue")
    checks.append(Check(
        "supervised-and-guarded", not unmet,
        ("garde d'os installée, journal sur disque, codes 75/78 distincts, superviseur à backoff et verrou"
         if not unmet else "résilience incomplète — " + " ; ".join(unmet[:4])),
        "installer une garde unhandledRejection/uncaughtException, journaliser sur un fichier, sortir en 78 pour "
        "une config invalide et 75 pour une panne, et confier la relance à un superviseur à délai croissant "
        "protégé par un verrou d'instance",
    ))

    # --- R19 : une commande enregistree doit etre joignable ----------------
    # Constate sur le bot modele : `/voice` etait code, documente dans /help, declare dans
    # le menu Telegram… et jamais execute, parce que grammy applique les filtres dans
    # l'ordre d'enregistrement et que le handler `message:text` de l'agent, plus tot dans le
    # fichier, avalait la mise a jour avant lui. Aucun test ne s'en plaignait : le harnais
    # n'envoyait pas d'`entities`, donc aucune commande n'etait reconnue. Deux choses sont
    # verifiees ici : l'ordre d'enregistrement, le menu declare face aux handlers, et les
    # handlers faces a la liste partagee qui alimente ce menu.
    channel_files = sorted(root.glob("src/channels/*/bot.ts"))
    cmd_hits: list[str] = []
    declared: set[str] = set()
    checked_channels = 0
    for cf in channel_files:
        raw = cf.read_text(encoding="utf8")
        code_only = strip_ts(raw)
        commands = list(re.finditer(r"bot\.command\(\s*['\"]([a-z_0-9]+)['\"]", code_only))
        if not commands:
            continue
        checked_channels += 1
        catchalls = [m.start() for m in re.finditer(r"bot\.on\(\s*['\"](message|message:text)['\"]", code_only)]
        floor = min(catchalls) if catchalls else len(code_only)
        for m in commands:
            name, offset = m.group(1), m.start()
            declared.add(name)
            if offset > floor:
                line = code_only[:offset].count("\n") + 1
                cmd_hits.append(f"{rel(root, cf)}:{line} → /{name} enregistré après le handler texte qui l'avale")
        menu = set(re.findall(r"command:\s*['\"]([a-z_0-9]+)['\"]", code_only))
        for name in sorted(menu - declared):
            cmd_hits.append(f"{rel(root, cf)} → le menu annonce /{name}, qu'aucun bot.command n'enregistre")
    # Le menu Telegram se declare au demarrage (`setMyCommands` dans index.ts), pas dans le
    # canal : le chercher dans les fichiers de canal le verrait vide et rendrait la
    # verification faussement silencieuse. On le prend donc sur tout le code de production,
    # et on ne checking qu'un sens — une commande volontairement hors menu (derriere un
    # drapeau) reste legitime, un menu qui promet une commande morte ne l'est pas.
    for p_ in production:
        for name in re.findall(r"command:\s*['\"]([a-z_0-9]+)['\"]", strip_ts(raw_prod[p_])):
            if name not in declared:
                cmd_hits.append(f"{rel(root, p_)} → le menu annonce /{name}, qu'aucun handler n'enregistre")
    # Sens inverse : une commande enregistree et absente du menu est invisible dans le
    # client — c'est exactement ce qui est arrive a /voice, qui repondait tres bien aux
    # messages sans jamais apparaitre a cote des autres commandes. Aucune erreur, aucun
    # log, aucun test de comportement ne peut le voir : seul le compte le remarque.
    listed: set[str] = set()
    for cf in channel_files:
        code_only = strip_ts(cf.read_text(encoding="utf8"))
        block = re.search(r"COMMANDS[^=]*=\s*\[(.*?)\n\]", code_only, re.S)
        if block is not None:
            listed |= set(re.findall(r"command:\s*['\"]([a-z_0-9]+)['\"]", block.group(1)))
    if listed:  # pas de liste partagee -> rien a exiger (un menu recopie a la main reste verifie dans l'autre sens)
        for name in sorted(declared - listed):
            cmd_hits.append(f"{rel(root, channel_files[0])} → /{name} est enregistre mais dans aucune liste de commandes annoncees")
    checks.append(Check(
        "commands-reachable", not cmd_hits or checked_channels == 0,
        (f"{len(declared)} commande(s) de canal enregistrées avant le handler texte, menu et aide cohérents"
         if not cmd_hits else "commande injoignable — " + "; ".join(cmd_hits[:4])),
        "enregistrer toute bot.command AVANT le handler message:text de l'agent (grammy "
        "applique les filtres dans l'ordre) ; au lieu de recopier le menu dans le bootstrap, "
        "le deriver d'une seule liste partagee (commande + aide + menu) et faire passer le "
        "menu par une fausse API dans le test bout-en-bout ; dans les tests, envoyer les "
        "`entities` que Telegram ajoute vraiment",
    ))

    # --- R20 : un port d'écoute n'est jamais une habitude, c'est une décision ---
    # Un agent local est cense ne JAMAIS ecouter : ouvrir un port, c'est faire entrer le
    # reseau local dans la confiance de l'utilisateur. Le mode appel vocal en direct a eu
    # besoin de le faire (l'API Bot de Telegram ne transporte aucun media d'appel : la page
    # d'appel doit donc etre servie par l'agent lui-meme) — l'exception est licite, mais
    # seulement si elle est BORNEE et NOMMEE. Tout fichier qui cree un serveur ou l'ecoute
    # doit donc :
    #   1. vivre sous `src/realtime/`, ou etre le point d'entree qui ne fait que deleguer ;
    #   2. porter la mention LISTEN-EXCEPTION: avec son motif ;
    #   3. etre coupe par une bascule de config (REALTIME_ENABLED) lue AVANT `listen()` ;
    #   4. confronter la liste blanche d'utilisateurs a la poignee de main (un port ouvert
    #      sans porte d'entree = un micro offert a tout le LAN).
    # Le motif de detection est volontairement etroit (`server.listen(`/`createServer(`) :
    # `hub.listen()` dans un cabling n'est pas un system call, et une regle qui hurle sur
    # chaque methode nommee "listen" finit ignoree — donc fausse.
    listen_re = re.compile(r"\bcreateServer\s*\(|\b(?:server|httpServer|httpsServer)\s*\.\s*listen\s*\(")
    listeners = [p_ for p_ in production if listen_re.search(strip_ts(raw_prod[p_]))]
    listen_problems: list[str] = []
    config_blob = "".join(raw_prod[q] for q in production if q.name == "config.ts")
    for p_ in listeners:
        r = rel(root, p_)
        raw = raw_prod[p_]
        delegating = r == "src/index.ts"
        if not (r.startswith("src/realtime/") or delegating):
            listen_problems.append(f"{r} ouvre un port hors de src/realtime/ (l'exception n'est déclarée que pour le canal d'appel)")
        if LISTEN_MARKER not in raw:
            listen_problems.append(f"{r} écoute sans porter la mention {LISTEN_MARKER} (motif exigible, sinon l'exception est silencieuse)")
        if not re.search("REALTIME_ENABLED|realtimeEnabled", raw) and not re.search("REALTIME_ENABLED|realtimeEnabled", config_blob):
            listen_problems.append(f"{r} : aucune bascule REALTIME_ENABLED — le port doit pouvoir être coupé par config")
    if listeners:
        guarded = [q for q in listeners if "allowedUserIds" in raw_prod[q] and ".has(" in raw_prod[q]]
        if not guarded:
            listen_problems.append("le module qui écoute ne confronte aucun allowedUserIds : micro ouvert sans liste blanche")
    checks.append(Check(
        "listening-is-a-decision", not listen_problems,
        (f"{len(listeners)} module(s) d'écoute, tous sous src/realtime/ avec mention, bascule et liste blanche"
         if listeners and not listen_problems
         else "aucun port écouté (le défaut d'un agent local)" if not listeners
         else "port mal déclaré — " + "; ".join(listen_problems[:4])),
        "ne jamais ajouter un serveur en silence : le loger sous src/realtime/, y écrire la mention "
        f"{LISTEN_MARKER} avec le motif, le couper par un drapeau de config (REALTIME_ENABLED) et "
        "exiger la liste blanche à la poignée de main — ou garder l'agent sans port d'écoute",
    ))

    # --- R21 : la page qui tient le micro ne doit rien charger d'ailleurs -----
    # Une page d'appel qui ouvre un micro est une surface d'attaque ET un point de panne :
    # si elle depend d'un CDN, le bot meurt derriere un VPN ou un pare-feu ; si elle est
    # servie en clair sur un nom de domaine, le navigateur refuse getUserMedia.
    page_files = [p_ for p_ in production if "getUserMedia" in raw_prod[p_]]
    page_problems: list[str] = []
    ext_src = re.compile(r"(?:src|href)\s*=\s*[\"']https?://")
    for p_ in page_files:
        raw = raw_prod[p_]
        hits = ext_src.findall(raw)
        if hits:
            page_problems.append(f"{rel(root, p_)} : {len(hits)} ressource(s) externe(s) référencée(s)")
        if "@import" in raw or "@font-face" in raw:
            page_problems.append(f"{rel(root, p_)} : une police ou une feuille de style externe")
        if "permissions-policy" in raw and "microphone" not in raw.split("permissions-policy", 1)[1][:90]:
            page_problems.append(f"{rel(root, p_)} : permissions-policy sans microphone=(self)")
    checks.append(Check(
        "call-page-isolated", not page_problems,
        ("page d'appel autonome : " + ", ".join(sorted({rel(root, q) for q in page_files})) if page_files and not page_problems
         else "aucune page embarquée servant un micro" if not page_files
         else "page dépendante — " + "; ".join(page_problems[:4])),
        "une page qui tient le micro doit tout embarquer (script, style, worklet en blob:) : aucune "
        "URL externe, un CSP default-src 'none', et HTTPS ou localhost pour getUserMedia",
    ))

    # --- R22 : un champ de contrat doit avoir un lecteur ---------------------
    # Regle nee d'un champ `userNotice` declare, documente, rempli par chaque outil refuse, et lu
    # par personne : l'agent « expliquait » ses refus dans un champ que le canal jetait. Un champ
    # sans lecteur est une interface qui ment sur ce qu'elle garantit.
    unread: list[str] = []
    types_path = root / "src" / "core" / "types.ts"
    if types_path.exists():
        types_src = types_path.read_text(encoding="utf-8")
        others = [q for q in production if q != types_path]
        for iface in AUDITED_INTERFACES:
            body = re.search(rf"export interface {iface} \{{(.*?)\n\}}", types_src, re.S)
            if body is None:
                continue
            for field in re.findall(r"^\s{2}(\w+)\??\s*:", body.group(1), re.M):
                reads = 0
                for q in others:
                    text = code[q]
                    if (re.search(rf"\.{field}\b", text)
                            or re.search(rf"\{{[^}}*]\b{field}\b", text)
                            or re.search(rf"\b{field}:", text)):
                        reads += 1
                if reads == 0:
                    unread.append(f"{iface}.{field} (produit, jamais lu)")
    checks.append(Check(
        "contract-fields-read", not unread,
        "; ".join(unread[:6]) if unread else f"champs de {', '.join(AUDITED_INTERFACES)} tous lus par un consommateur",
        "soit le lire (le canal affiche l'info), soit le retirer de l'interface : un champ que personne ne lit est une promesse fausse",
    ))

    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description="Vérifie les invariants de sécurité d'un agent local.")
    parser.add_argument("root", nargs="?", default=".", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    if not root.is_dir():
        print(f"chemin invalide : {root}", file=sys.stderr)
        return 2

    checks = run(root)
    failures = [c for c in checks if not c.ok]

    if args.json:
        print(json.dumps({"root": str(root), "passed": len(checks) - len(failures), "failed": len(failures), "checks": [c.as_dict() for c in checks]}, indent=2))
    elif not args.quiet:
        for c in checks:
            mark = "  ok  " if c.ok else "  FAIL"
            print(f"[{mark}] {c.rule:32} {c.detail}")
            if not c.ok:
                print(f"         → correctif : {c.fix}")
        print(f"\n{len(checks) - len(failures)}/{len(checks)} invariants vérifiés" + (f" — {len(failures)} à corriger" if failures else " — l'agent respecte sa politique de sécurité"))
    else:
        print("OK" if not failures else f"{len(failures)} invariant(s) violé(s)")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
