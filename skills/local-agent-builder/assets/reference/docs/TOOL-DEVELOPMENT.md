# Développer un outil

## Règle n°1

Un outil est appelé par un modèle de langage. Écrivez-le comme une API publique
exposée à un utilisateur hostile : validée, bornée, sans effet de bord surprise.

## Squelette

```ts
// src/tools/builtin/mon-outil.ts
import type { Tool } from '../registry.js';
import type { ToolContext, ToolResult } from '../../core/types.js';

export const myTool: Tool = {
  name: 'mon_outil',                       // minuscules + _ , ≤ 64 car.
  description:
    'Une phrase sur QUAND l’utiliser, une sur QUOI il renvoie. Le modèle ne voit que ça.',
  parameters: {
    cible: { type: 'string', required: true, maxLength: 80, description: 'Description courte, elle aussi vue par le modèle.' },
    nombre: { type: 'integer', min: 1, max: 50 },
  },
  maxOutputChars: 800,                      // défensif par défaut
  async run(args, ctx): Promise<ToolResult> {
    // args.cible est déjà un string non vide, args.nombre un entier dans [1,50]
    return { status: 'ok', content: `résultat pour ${args.cible as string}` };
  },
};
```

Puis, dans `src/tools/builtin/index.ts` : `return [getCurrentTimeTool, …, myTool]`.
C'est tout — la validation, le schéma JSON, l'audit et `/tools` suivent.

## Ce que la structure vous donne gratuitement

| Préoccupatio | Traitée par |
|---|---|
| JSON invalide / champ inconnu / hors bornes | `executeToolCall` → le modèle reçoit l'erreur et se corrige |
| Nom d'outil inventé (`read_file`) | refus avant lookup, journalisé `denied` |
| Sortie démesurée | `maxOutputChars` (défaut 1200) + troncature |
| Fuite de balisage dans le prompt | `asUntrusted('TOOL_OUTPUT_…')` ajouté par la boucle d'agent |
| Traçabilité | table `tool_calls` (arguments, statut, durée) |
| Panne de l'outil | `try/catch` : l'agent reçoit `erreur d’exécution : …` et continue |

## Les quatre décisions à prendre explicitement

**1. Cet outil écrit-il ?** Si oui, rendez l'opération additive ou réversible, et
documentez-le dans la description. Un outil de suppression ne doit accepter qu'un
identifiant précis (comme `forget`), jamais « tout ».

**2. Une donnée non fiable entre-t-elle dans le contenu renvoyé ?** Alors ne la
recopiez jamais telle quelle dans une action : tronquez, encadrez
(`asUntrusted(label, …)`) et rappelez au modèle que c'est une donnée.

**3. L'action est-elle irréversible ou coûteuse ?** Marquez
`requiresApproval: true, dangerous: true`. La boucle crée un ticket, envoie les
boutons ✅/🚫, n'exécute qu'après clic — et le constructeur du registre refuse
`dangerous: true` sans `requiresApproval`, donc l'oubli est impossible.

**4. Quels identifiants le contexte peut-il toucher ?** `ctx.chatId` et
`ctx.userId` viennent du **transport** (Telegram), jamais du LLM. Filtrez toute
lecture et toute écriture dessus : c'est ce qui rend `recall` incapable de fuiter
vers une autre conversation.

## Recette

```bash
npm test
```

`src/test/tools.test.ts` contient les tests de référence (nom refusé, arguments
invalides, plafond de mémoire, cloisonnement par chat). Dupliquez le bloc qui
correspond à votre outil. Trois choses à tester systématiquement :

1. `{"champ_inconnu":1}` → rejeté, et le message d'erreur est assez clair pour
   que le modèle se corrige ;
2. sortie de 10 000 caractères → tronquée ;
3. un appel avec l'id d'une autre conversation → aucune donnée d'autrui renvoyée.

## Anti-patterns

- `eval`, `new Function`, `child_process`, `fs.readFile` sur un chemin fourni par
  le modèle : même « juste pour les/power-users », c'est une exécution de code à
  distance déguisée. La calculatrice du projet est un parseur de 200 lignes pour
  cette raison.
- Lire `process.env` dans un outil : la config arrive par `ctx.config`.
- Renvoyer un objet : `content` est du texte. Un JSON profondément imbriqué fait
  divaguer les petits modèles.
- Compter sur `tool_choice` pour empêcher un appel : seul le registre décide.
