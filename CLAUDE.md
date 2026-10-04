# Minecraftia

Compagnon IA pour Minecraft dont le rôle **émerge** du style de jeu de son joueur.
Référence d'architecture : [docs/PLAN.md](docs/PLAN.md). Journal de travail : [docs/JOURNAL.md](docs/JOURNAL.md).

## Commandes
- `npm run typecheck` — TypeScript strict (TS 7), sans émission
- `npm test` — vitest (aucun appel réseau ni LLM réel dans les tests)
- `npm run dev` — lance le bot (lit `.env`)
- `python -m graphify update .` — régénère le graphe du code dans `graphify-out/`
- `/fin-de-phase` — checklist de clôture d'une phase ; `/rcon <cmd>` — commande serveur

## Règles du projet
- Les 8 modules ne communiquent que par le bus typé (`src/core/bus.ts`, événements dans `src/core/events.ts`)
  ou par des interfaces injectées. Seuls `src/bot/`, `src/skills/` et les adaptateurs `mineflayer*.ts`
  touchent l'objet mineflayer.
- Les réflexes (`src/reflexes/`) ne lisent jamais l'arbre, l'autonomie ni une valeur apprise.
- Toute action passe par `ActionController` avec un `timeoutMs` et respecte son `AbortSignal`.
- Aucun appel LLM par tick. Secrets uniquement dans `.env` ; le logger les masque (`scrub`).
- Horloge injectable (`Clock`) : jamais `Date.now()` dans une logique testée.
- Pas de fonction factice, pas de TODO, pas de test désactivé.
- Code et commentaires en français, comme le reste du dépôt.

## Pièges connus
- Deux copies de `vec3` dans `node_modules` : utiliser le type `Bot['entity']['position']`, construire
  les vecteurs avec `me.offset(...)`, ne pas importer `vec3`.
- `bot.oxygenLevel` de mineflayer est incohérent (brut 0..300 ou sur 20) : utiliser `oxygenOf(bot)`.
- `entity.isInWater` / `isInLava` existent à l'exécution mais pas dans les types : `physicsFlags()`.
- Le pathfinder refuse de démarrer dans la lave : les réflexes pilotent directement (regard + commandes).
- RCON via SSH : quotes simples côté distant, sinon `~` est développé en `/root`.

## Environnement
- Serveur : VPS Contabo `169.58.55.167`, clé `~/.ssh/contabo_minecraft`, `/opt/minecraft` (itzg, Fabric 1.21,
  `online-mode=false`, Simple Voice Chat). Secrets du bot sur le VPS : `/opt/minecraftia/.env`.
- Développement : Windows, Node 24 ; production : Node 22 dans Docker sur le VPS.
