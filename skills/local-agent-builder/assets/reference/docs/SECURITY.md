# Sécurité d'OpenGravity

## Modèle de menace

L'agent lit du texte non fiable (messages, futures pages web, fichiers) et peut
agir via des outils. Trois adversaires sont considérés :

1. **un tiers qui écrit au bot** → bloqué par la liste blanche, avant tout autre
   traitement ;
2. **un contenu injecté** (prompt injection) qui cherchera à faire appeler un
   outil dangereux → bloqué par la liste close d'outils, la validation
   d'arguments, le plafond d'itérations et l'approbation humaine ;
3. **un compromis de la machine** → hors périmètre : si l'attaquant exécute du
   code en votre nom, il lit `.env` et `memory.db`. Chiffrez le disque.

## Ce qui est garanti par le code

| Garantie | Où | Vérifié par |
|---|---|---|
| Deny-by-default sur les IDs | `security/allowlist.ts`, middleware enregistré avant tout handler | `config.test.ts`, `integration.test.ts` (l'intrus ne déclenche **aucun** appel LLM) |
| Rate-limit par utilisateur | `security/rate-limit.ts` | `config.test.ts` |
| Entrée bornée et nettoyée (contrôles, bidi, taille) | `security/sanitizer.ts` | `config.test.ts`, `agent.test.ts` |
| Outil inexistant refusé avant exécution | `tools/registry.ts` | `tools.test.ts`, `agent.test.ts` |
| Arguments validés, champs inconnus refusés | `tools/args.ts` | `tools.test.ts` |
| Aucune exécution de code (`eval`/`Function`/shell) | tout le dépôt, calculatrice = parseur | `tools.test.ts` (liste de tentatives) |
| Sortie d'outil tronquée + encadrée comme donnée | `asUntrusted()` | `agent.test.ts`, `config.test.ts` |
| Boucle finie (itérations + retrait des outils) | `core/agent.ts` | `agent.test.ts` |
| Action sensible = clic humain, jeton à usage unique, TTL | `security/approvals.ts` | `agent.test.ts` (usurpation d'utilisateur, de chat, jeton forgé, rejeu, expiration) |
| Secrets jamais écrits dans un log ni renvoyés | `core/logger.ts`, `redact()` | `config.test.ts`, `integration.test.ts` |
| HTML Telegram échappé, `javascript:` et attributs injectés neutralisés | `channels/telegram/format.ts` | `format.test.ts` |
| Outil dangereux sans approbation impossible à enregistrer | constructeur de `ToolRegistry` | `tools.test.ts` |
- Le démarrage vérifie que chaque modèle configuré figure bien dans l'inventaire du
  fournisseur (`src/llm/model-check.ts`) : un identifiant fantaisiste est une erreur de
  configuration, il doit tuer le processus plutôt que d'offrir un bot muet. Un fournisseur
  injoignable n'est qu'un avertissement — l'agent doit pouvoir démarrer hors ligne.
- **Le `file_path` renvoyé par Telegram est suspect par construction.** Il sert à
  construire une URL de téléchargement. La garde refuse donc ce qui **sort de la
  racine** : chemin absolu, segment `..`, double slash, segment commençant par un point,
  deux-points en tête (schéma `https:`/`file:`), tout caractère hors
  `[A-Za-z0-9._/:-]`, plus de 180 caractères. Elle n'exige **pas** une nomenclature
  précise : la première version acceptait uniquement `files/<nom>.<ext>` et a refusé les
  vocaux réels (`files/AgentAudioFile/…`, `…_19:32:00_1.ogg`). Un garde-fou calqué sur la
  forme observée un jour se retourne contre l'utilisateur ; ce qui doit être bloqué est
  la traversée, pas la surprise.
- **Un refus de média se journalise sans déballer la pièce jointe.** Le motif du refus
  est nommé (`segment traversant`, `caractère non autorisé « % »`…), la racine et la
  longueur, jamais le nom complet : les chemins Telegram contiennent parfois le nom
  d'origine du fichier de l'utilisateur.
- **Taille bornée deux fois** : sur `content-length` déclaré, puis pendant la lecture.
  L'en-tête seul ment facilement ; le plafond real est appliqué octet par octet et la
  connexion est coupée dès le dépassement.
- **Aucun fichier audio écrit.** Ni le vocal reçu, ni l'audio synthétisé ne passent par
  le disque : rien à nettoyer, rien à oublier de nettoyer, rien à chiffrer.
- **Le token du bot est dans l'URL de téléchargement** : le module ne renvoie donc que
  le statut HTTP dans ses messages, jamais l'URL, jamais le corps de la réponse.
- **La transcription est une donnée non fiable**, traitée comme un message texte : elle
  entre dans la boucle d'agent par le même encadrement, sans droit supplémentaire.


## Liste de contrôle avant la première utilisation

- [ ] `TELEGRAM_BOT_TOKEN` provient de @BotFather, jamais réutilillé ailleurs.
- [ ] `TELEGRAM_ALLOWED_USER_IDS` : vos IDs **numériques**, pas des @usernames
      (un @username est revendable, un id non).
- [ ] `/id` pour récupérer son id, puis mettre `TELEGRAM_ID_COMMAND_ENABLED=false` :
      la commande répond hors liste blanche (c'est un choix assumé pour
      l'installation, pas une vulnérabilité, mais elle signale qu'un bot écoute).
- [ ] `chmod 600 .env service-account.json memory.db`.
- [ ] `DANGEROUS_TOOLS_ENABLED=false` (défaut) tant que vous n'avez pas besoin d'un
      outil sensible.
- [ ] Le dépôt est privé, et `memory.db` est dans `.gitignore` (il contient votre
      vie ; il n'a rien à faire dans Git).
- [ ] Quota Groq surveillé : une clé gratuite plafonne, ce n'est pas une faille,
      mais un déni de service économique si l'agent tourne en continu.
- [ ] Sauvegarde chiffrée de `memory.db` (un `cp` suffit, l'absence de sauvegarde
      est le risque le plus probable de perte réelle).
- [ ] Le journal de démarrage affiche `modèles vérifiés chez le fournisseur` (ou, à
       défaut, l'avertissement d'inventaire injoignable — jamais un silence).
- [ ] `VOICE_MODE` est un choix délibéré (`mirror` par défaut) : `always` consomme du
      quota à chaque tour, `off` rend le bot strictement muet.
- [ ] `ELEVENLABS_VOICE_ID` a été lu sur TON compte (`GET /v1/voices`) — le démarrage le
      vérifie et refuse de partir sur une voix inexistante.


## Ce qui n'est PAS défendu (à connaître)

- **La mémoire est en clair.** SQLite n'est pas chiffré. Ne stockez aucun secret :
  `remember` refuse déjà ce qui ressemble à un mot de passe, une clé ou un numéro
  de carte, mais une formulation détournée passerait. C'est un garde-fou, pas un
  chiffrement.
- **Le contexte peut être induit en erreur.** Un texte hostile peut pousser le
  modèle à *essayer* d'appeler un outil. Il ne peut pas appeler ce qui n'existe
  pas, ni forcer une exécution sans validation ; il peut en revanche le faire
  paraphraser. La surface réelle d'impact reste la liste des outils.
- **Le LLM voit vos souvenirs** chargés par similarité : c'est le but, donc tout
  ce que vous écrivez dans la mémoire est destiné à un service distant.
- **Le transport est la sécurité de Telegram.** Le bot parle à l'API en HTTPS ;
  le contenu est quand même chez Groq/OpenRouter. Pour un agent strictement hors-
  ligne, branchez un modèle local via `GROQ_BASE_URL` sur Ollama.

## En cas de doute

```bash
grep -c "" memory.db          # la base grossit-elle anormalement ?
sqlite3 memory.db 'SELECT tool_name,status,COUNT(*) FROM tool_calls GROUP BY 1,2;'
sqlite3 memory.db 'SELECT id,content FROM memories ORDER BY id DESC LIMIT 20;'
```

Pour repartir de zéro : arrêter le bot, supprimer `memory.db*`. Pour ne perdre que
l'historique d'un chat : `/forget`. Un souvenir précis : `/memory` puis
`/forget_memory <id>`.
