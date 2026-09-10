# Feuille de route

Ordre volontaire : d'abord ce qui rend l'agent utile au quotidien, ensuite ce qui
le rend scalable. Chaque étape est écrite pour ne pas demander de réécrire le noyau.

## v0.1 — livrée

- [x] Telegram en long polling, liste blanche, rate-limit
- [x] Boucle d'agent bornée (itérations + retrait des outils pour forcer la fin)
- [x] Groq principal + secours + OpenRouter optionnel, **IDs de modèles vérifiés sur le
      compte** (`src/llm/model-check.ts`) : un nom inexistant fait échouer le démarrage
      au lieu de silencer le bot
- [x] Premier tour de bot réellement validé en production locale : Telegram entrant, appel
      d'outil `remember`, écriture lue dans `memory.db` (2026-09-02)
- [x] Outils : `get_current_time`, `remember`, `recall`, `forget`, `calculator`
- [x] SQLite : historique fenêtré, mémoire longue durée, audit, approbations
- [x] Approbation humaine par boutons pour tout outil marqué sensible
- [x] 56 tests, dont 2 bout-en-bout qui démarrent le vrai processus

## v0.2 — audio (le manque le plus visible)

**Livré le 2026-09-02** (bien avant le plan initial) : transcription Groq → secours
ElevenLabs, synthèse ElevenLabs en OGG/Opus, mode `mirror`, plafond d'entrée et budget
de sortie, zéro écriture disque, 2 tests bout-en-bout sur le trajet vocal complet.
Ce qui reste réellement à faire, ci-dessous, garde sa valeur.

La transcription **et** la synthèse peuvent rester chez un seul fournisseur :
Groq expose `whisper-large-v3` en `POST /v1/audio/transcriptions`, exactement la
même base URL et la même clé que le texte. ElevenLabs n'est alors plus qu'un choix
de qualité vocale, pas une nécessité.

1. `src/media/download.ts` — `ctx getFile` → `api.getFileLink` → téléchargement
   **taille max garde-fou** (25 Mo), dans un fichier temporaire, supprimé en `finally`.
2. `src/tools/builtin/transcribe_audio.ts` — n'appelle pas le LLM : le texte
   transcrit devient le message utilisateur, avec la mention `[transcrit]`.
3. `src/media/tts.ts` — provider `VoiceProvider { speak(text): Promise<Buffer> }` :
   `ElevenLabsVoice` (clé + id de voix dans `.env`) ou `GroqTtsVoice`.
4. `src/channels/telegram/bot.ts` — si la réponse est marquée vocale (drapeau par
   conversation, ou requête explicite « réponds-moi en audio »), envoyer
   `sendVoice` en MP3. Repli texte automatique si la synthèse échoue.

Garde-fous à ne pas oublier : autoriser l'audio dans la liste blanche uniquement,
max 3 minutes, ne jamais réutiliser un buffer au-delà d'un envoi, journaliser la
durée (coût), et couper la synthèse si le texte dépasse ~1500 caractères.

## v0.3 — tâches et rappels

- `schedule`/`list_reminders`/`cancel_reminder` sur une table `reminders`
  (id, chat_id, at_ts, prompt, status). Une `setTimeout` réarmé au réveil +
  une relance au démarrage pour les rappels passés.
- L'agent ne « court » pas tout seul : à l'heure dite, il s'injecte son propre
  prompt comme nouveau tour, avec `source='reminder'` dans l'audit.

## v0.4 — plus de contexte, mieux rangé

- [ ] `search_memories` en FTS5 (`CREATE VIRTUAL TABLE memories_fts`) au lieu du
      LIKE actuel, avec `content` tokenisé : recherche correcte sans dépendance.
- [ ] Résumé automatique de session : au-delà de N messages, un appel LLM produit
      un résumé stocké en mémoire et l'historique est compacté.
- [ ] Pièces jointes : lecture de `.txt`/`.md` (PDF en v0.5), injectés dans un
      cadre `<BEGIN_FILE>` et marqués non fiables.

## v1.0 — hors de la machine locale

Le besoin type : laisser tourner l'agent 24/7 sans poste allumé, et lui donner des
compétences qui supposent un serveur (webhooks Google Calendar, notifications
push, accès à un Drive partagé).

**Option A — un seul petit runtime, le plus proche de l'existant.**
Cloud Run (ou Fly.io/Render) en conteneur, une instance, `min-instances=1`, avec
Telegram en **webhook** : `src/channels/telegram/webhook.ts`, même `AgentDeps`,
`webhookCallback(bot, 'std/http')` fourni par grammY. Secrets dans le gestionnaire
de secrets du fournisseur, jamais dans l'image. Coût : il faut un TLS et un
`secret_token` vérifié sur chaque requête (Telegram l'envoie en en-tête
`X-Telegram-Bot-Api-Secret-Token`) — sans cela, n'importe qui pourrait forger des
updates et contourner la liste blanche. **C'est le point sensible de cette option.**

**Option B — Firebase.**
- `functions.https.onRequest` → même gestionnaire de webhook.
- Firestore remplace SQLite : implémenter `Store` en interface (`src/memory/store.ts`
  est le seul fichier à connaître) avec `FirestoreStore`. Les écritures synchrones
  de better-sqlite3 deviennent `await` : la signature de `Store` change, le reste
  de l'agent est déjà asynchrone.
- Cloud Scheduler déclenche les rappels (pas de `setTimeout` survivant).
- Secret Manager pour les clés.
- Limite réelle : un appel de synthèse coûte 1-2 s ; une function à 540 s de timeout
  le supporte, mais les itérations multiples doivent être idempotentes — d'où la
  table `processed_updates` déjà présente dans le schéma v1, prévue pour ce cas.

**Ce qui ne bouge pas** dans les deux options : la boucle d'agent, la validation
des outils, la liste blanche, l'approbation humaine, le formatage Telegram.
C'est le critère d'acceptation de la refactorisation : `src/core/` et
`src/tools/` ne doivent jamais importer `grammy`, `better-sqlite3` ni un SDK cloud.

## Dettes connues à solder en route

- `Store` expose des méthodes de mapping SQL : à transformer en interface + deux
  implémentations au moment du passage cloud (et pas avant — une abstraction pour
  une seule implémentation est du bruit).
- La file de serialization par chat est en mémoire : multi-instance ⇒ un verrou
  partagé (Firestore transaction, ou Redis `SETNX`) sera obligatoire, sinon deux
  instances répondront en même temps dans le même fil.
- Le rate-limit est en mémoire : même remarque.
- `looksLikeSecret()` est heuristique : à remplacer par une détection nommée
  d'entités si la mémoire grossit.
