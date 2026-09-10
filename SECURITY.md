# Politique de sécurité

## Signaler une faille

N'ouvrez **pas** d'issue publique pour une vulnérabilité. Utilisez l'onglet
*Security → Report a vulnerability* du dépôt, ou contactez le mainteneur en privé.

Merci d'inclure : la version concernée, l'invariant contourné le cas échéant,
et une reproduction minimale.

## Modèle de menace

Ce projet génère des agents qui tournent **en local**, pilotés par un canal de
messagerie. Les hypothèses de sécurité sont :

- **la liste blanche est la frontière** — un identifiant non autorisé n'atteint
  jamais un handler ; la garde est installée avant eux (invariant
  `allowlist-before-handlers`) ;
- **la sortie d'un outil n'est pas de confiance** — elle est encadrée avant
  d'entrer dans le contexte du modèle (`untrusted-framing`) ;
- **la boucle est bornée** — pas d'exécution illimitée (`bounded-loop`) ;
- **les actions dangereuses demandent un humain** (`dangerous-requires-approval`) ;
- **aucune exécution de code arbitraire** — ni `eval`, ni `Function`, ni
  `import()` dynamique (`no-code-execution`, `static-tool-loading`) ;
- **les erreurs brutes ne remontent pas à l'utilisateur** (`no-error-detail-to-user`).

Les 22 invariants sont vérifiés par `scripts/check_invariants.py`, exécuté en CI
sur l'implémentation de référence **et** sur un agent fraîchement généré.

## Vos secrets

Aucun secret n'est présent dans ce dépôt : seuls des fichiers `.env.example` et
`service-account.json.example` sont fournis. Le `.gitignore` exclut `.env`,
`service-account.json`, les clés et les bases SQLite. Le générateur et le script
de rafraîchissement refusent activement de copier un secret.

Si vous exposez accidentellement un jeton (Telegram, OpenAI, Google), **révoquez-le
immédiatement** auprès du fournisseur : réécrire l'historique Git ne suffit pas.
