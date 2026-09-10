#!/usr/bin/env bash
#
# veille du superviseur — « qui garde le gardien ? »
#
# `src/supervise.ts` digère les crashes de l'agent : il relance, il compte les échecs, il
# refuse deux instances sur le même token. Mais personne ne digère `src/supervise.ts`. Sa mort
# est silencieuse et définitive : un `kill -9`, un OOM qui le choisit lui, une session qui
# tombe, et le bot est arrêté sans journal ni cause — exactement le symptôme qu'on avait
# corrigé au premier étage.
#
# Ce script est le deuxième étage, et il ne fait qu'une chose : vérifier que le verrou
# `logs/supervisor.pid` désigne un processus vivant, et le relancer sinon. Il ne lit JAMAIS
# l'intention dans le mode de mort du processus d'en face (la même leçon qu'au premier étage :
# un superviseur qui déduisait « voulu » d'un code de mort apprenait à ne pas relancer).
#
#   scripts/keepalive.sh loop     # tourne au premier plan (c'est ce que lance le process
#                                 # manager / launchd / systemd)
#   scripts/keepalive.sh status   # âges et pids des trois étages + sonde du hub
#   scripts/keepalive.sh stop     # arrête la veille, puis le superviseur, puis l'agent
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/logs/keepalive.log"
SUP_PID="$ROOT/logs/supervisor.pid"
INTERVAL="${KEEPALIVE_INTERVAL:-20}"
# `--env-file` pour le SUPERVISEUR (il répare l'environnement, donc il lit les clés), PAS pour
# l'enfant : `--command` cesse d'accumuler les arguments au premier qui commence par `--`, et
# `--command node --env-file=.env dist/index.js` ne donnait donc que `node` au spawn. L'enfant
# n'a pas besoin du flag : `loadConfig()` fait son `dotenv` lui-même.
START=(node --env-file=.env dist/supervise.js --command node dist/index.js)

# stdout (capturé par le gestionnaire de processus) ET fichier : `status` relit le fichier, et
# une veille qui n'écrit que sur son terminal est une veille sans histoire à raconter.
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

# Le superviseur est-il vivant ? On croit le verrou, pas `pgrep` : le verrou est ce que le
# superviseur lui-même utilise pour refaire la même question, et il meurt avec lui.
supervisor_alive() {
  [ -f "$SUP_PID" ] || return 1
  local pid
  pid="$(tr -dc '0-9' < "$SUP_PID")"
  [ -n "$pid" ] && [ "$pid" -gt 0 ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# L'agent, pas le superviseur : la ligne de commande du SUPERVISEUR contient
# `--command node dist/index.js`, donc un `pgrep -f dist/index.js` les compte les deux. Ce
# filtre par `ps` (portable, pas de /proc) est la seule façon honnête de distinguer les deux.
agent_pids() {
  local pid args
  # `pgrep -x node` d'abord : un `pgrep -f dist/index.js` attrape n'importe quel shell dont la
  # ligne de commande contient ce texte — y compris celui qui est en train de le taper. Une
  # veille qui SIGTERM les curieux n'est pas une veille, c'est un piége à consignes.
  for pid in $(pgrep -x node 2>/dev/null); do
    args="$(ps -p "$pid" -o args= 2>/dev/null)"
    case "$args" in *supervise.js*) continue ;; esac
    case "$args" in node*dist/index.js*) printf '%s\n' "$pid" ;; esac
  done
}

agent_alive() { [ -n "$(agent_pids)" ]; }

supervisor_pid() { [ -f "$SUP_PID" ] && tr -dc '0-9' < "$SUP_PID"; }

# Un superviseur tué de l'extérieur laisse son enfant ORPHELIN. Deux agents = deux pollers
# sur le même token = `409 Conflict` et deux morts, et deux hubs qui se battent le port (le
# second sort en 75 pendant que le premier tourne). La veille ne se contente donc pas de
# relancer : elle ramène le compte à un, en ne touchant qu'aux processus dont le père n'est
# plus le superviseur vivant — jamais à l'agent légitime, même en plein appel.
reap_orphans() {
  local sup pid ppid left
  sup="$(supervisor_pid)"
  if [ -n "$sup" ] && ! kill -0 "$sup" 2>/dev/null; then sup=""; fi
  for pid in $(agent_pids); do
    if [ -n "$sup" ]; then
      ppid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -dc '0-9')"
      [ "$ppid" = "$sup" ] && continue
    fi
    log "agent sans père légitime (pid $pid) — arrêté AVANT toute nouvelle instance"
    kill -TERM "$pid" 2>/dev/null
    # On attend la mort réelle : tuer puis relancer dans la même seconde faisait echouer le
    # nouvel agent en `EADDRINUSE` sur le port que l'orphelin n'avait pas encore rendu, et
    # chaque echec de ce type coute un palier de backoff au superviseur (4 s, 8 s, 16 s…).
    left=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      kill -0 "$pid" 2>/dev/null || { left=1; break; }
      sleep 0.5
    done
    if [ "$left" != 1 ]; then
      log "l'agent $pid n'a pas rendu les armes en 6 s — SIGKILL (un appel en cours est déjà perdu)"
      kill -KILL "$pid" 2>/dev/null
      sleep 1
    fi
  done
}

# Le troisième étage doit pouvoir réparer l'étage du milieu. Sinon il ne veille que sur un
# binaire déjà présent : `dist/supervise.js` absent (clonage neuf, `git clean`, bac à sable
# restauré sans dossier de build) produit un `MODULE_NOT_FOUND` immédiat, et une veille qui se
# contente de relancer la même commande tourne en boucle sur un fichier qui n'existe pas —
# c'est exactement ce qui est arrivé ici, journal à l'appui.
prepare() {
  local need=0
  [ -f "$ROOT/node_modules/better-sqlite3/package.json" ] || need=1
  [ -f "$ROOT/dist/supervise.js" ] && [ -f "$ROOT/dist/index.js" ] || need=2
  [ "$need" = 0 ] && return 0
  if [ "$need" = 1 ]; then
    log "dépendances absentes — npm ci"
    ( cd "$ROOT" && npm ci --no-audit --no-fund ) >>"$ROOT/logs/keepalive.log" 2>&1 || log "npm ci a échoué — la relance suivante réessaiera"
  fi
  if [ -f "$ROOT/dist/supervise.js" ] && [ -f "$ROOT/dist/index.js" ]; then return 0; fi
  log "build absent — npm run build"
  ( cd "$ROOT" && npm run build ) >>"$ROOT/logs/keepalive.log" 2>&1 \
    || log "npm run build a échoué — le superviseur refusera de démarrer, et le dira"
}

start_supervisor() {
  # Réparation d'abord : un agent sans père qui tient encore le port ferait échouer le
  # démarrage suivant sur EADDRINUSE, donc sur un code 75 qui use le budget de backoff.
  reap_orphans
  prepare
  ( cd "$ROOT" && exec "${START[@]}" ) >>"$ROOT/logs/supervisor-console.log" 2>&1 &
  log "superviseur relancé (pid $!)"
}

status() {
  supervisor_alive && echo "veille     : superviseur vivant (pid $(supervisor_pid))" \
                   || echo "veille     : AUCUN superviseur vivant"
  echo "agent      : $(agent_pids | tr '\n' ' ')$( [ -n "$(agent_pids)" ] || echo 'aucun')"
  echo "hub 8790   : $( { curl -sS -o /dev/null -m 5 -w '/call → HTTP %{http_code}' http://127.0.0.1:8790/call 2>/dev/null || echo 'hub injoignable' ; } )"
  echo "--- dernières lignes ---"
  tail -n 3 "$ROOT/logs/supervisor.log" 2>/dev/null | sed 's/^/  superviseur | /'
  tail -n 3 "$LOG" 2>/dev/null | sed 's/^/  veille      | /'
}

stop() {
  # Dans cet ordre : la veille d'abord (sinon elle relance ce qu'on est en train d'arrêter),
  # le superviseur ensuite (il sait couper son enfant proprement), l'agent en dernier recours.
  pkill -f 'keepalive.sh loop' 2>/dev/null
  # Attendre la mort reelle de la boucle (meme principe que `reap_orphans` pour les orphelins) :
  # un arret n'est pas ce qu'on a demande, c'est ce qu'on a verifie.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f 'keepalive.sh loop' >/dev/null 2>&1 || break
    sleep 1
  done
  if [ -f "$SUP_PID" ]; then
    kill "$(tr -dc '0-9' < "$SUP_PID")" 2>/dev/null
    sleep 3
  fi
  # Uniquement les pids que nous reconnaissons comme nôtres, jamais un `pkill -f` large.
  for pid in $(agent_pids); do kill -TERM "$pid" 2>/dev/null; done
  sleep 1
  for pid in $(agent_pids); do kill -KILL "$pid" 2>/dev/null; done
  if pgrep -f 'keepalive.sh loop' >/dev/null 2>&1; then
    echo "superviseur et agent coupes, mais la boucle de veille est toujours vivante (pid $(pgrep -f 'keepalive.sh loop' | tr '\n' ' ')) : relance « stop » ou coupe-la a la main."
    return 1
  fi
  echo "veille, superviseur et agent arretes (verifie : aucun processus, port libere)."
}

# Une `sleep` ordinaire avale le signal : bash ne court le piege qu'une fois la commande
# terminee, donc un Ctrl+C ou un `stop` attendu pouvait trainer d'un cycle complet (20 s) —
# et le message de `stop` proclamait un deja arrete qui ne l'etait pas encore. La sieste
# passe par l'arriere-plan : le signal interrompt `wait`, le piege part dans la seconde.
nap() { sleep "${1:-$INTERVAL}" & wait $! 2>/dev/null || true; }

loop() {
  mkdir -p "$ROOT/logs"
  trap 'log "veille arrêtée sur signal"; exit 0' TERM INT
  log "veille démarrée (contrôle toutes les ${INTERVAL}s)"
  local fails=0
  while :; do
    if supervisor_alive; then
      fails=0
      reap_orphans
    else
      fails=$((fails + 1))
      start_supervisor
      # Un superviseur qui meurt tout de suite, trois fois de suite, ne se soigne pas à
      # coups de relances : c'est presque toujours une config refusée (code 78), et le
      # marteler ferait un aller-retour Telegram par échec. On espace, et on le dit.
      if [ "$fails" -ge 3 ]; then
        log "3 superviseurs morts d'affilée — relance espacée de 5 min (lire logs/supervisor.log)"
        fails=0
        sleep 300
      else
        nap
      fi
    fi
    nap
  done
}

case "${1:-status}" in
  loop) loop ;;
  status) status ;;
  stop) stop ;;
  *) echo "usage: $0 {loop|status|stop}"; exit 2 ;;
esac
