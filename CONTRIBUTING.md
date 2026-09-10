# Contribuer

## Règle d'or

Un agent de cette famille se juge sur ses invariants. Avant toute PR :

```bash
cd skills/local-agent-builder
python3 scripts/check_invariants.py assets/reference    # doit afficher 22/22
```

Si un invariant tombe, la PR est refusée — même si le code « marche ».
Chaque invariant existe parce qu'un défaut réel s'est produit ; la raison de
chacun est documentée dans `references/security.md`.

## Modifier l'implémentation de référence

`assets/reference/` est une capture de l'agent OpenGravity validé. Elle ne se
modifie pas à la main : on fait évoluer le projet vivant, puis on re-capture.

```bash
python3 scripts/detect_drift.py <chemin-du-projet>      # qu'est-ce qui a bougé ?
python3 scripts/refresh_reference.py <chemin-du-projet> # re-capture + bump de version
```

`refresh_reference.py` contient un garde-fou anti-secret : il refuse de copier
un `.env`, une base SQLite ou une clé. Ne le contournez pas.

## Vérifier que le générateur tient

```bash
python3 scripts/scaffold.py --name "Test" --out /tmp/test --timezone "Europe/Paris"
python3 scripts/check_invariants.py /tmp/test           # doit aussi afficher 22/22
```

Un générateur qui produit un projet non conforme est un bug bloquant.

## Ce qui sera refusé

- un invariant désactivé plutôt que corrigé ;
- un outil dangereux enregistré sans approbation humaine ;
- un `import()` dynamique ou un `eval` dans le code de production ;
- une lecture de `process.env` ailleurs que dans `src/config.ts` ;
- un secret, une base ou un `.env` committé ;
- une variable d'environnement câblée mais non documentée (l'invariant
  `env-doc-sync` compte les deux côtés).

## Sécurité

Ne déclarez pas une faille dans une issue publique. Voir `SECURITY.md`.
