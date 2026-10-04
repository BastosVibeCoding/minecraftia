# Minecraftia

Compagnon IA pour Minecraft dont le rôle **émerge** du style de jeu de son joueur.
Référence d'architecture : [docs/PLAN.md](docs/PLAN.md). Journal de travail : [docs/JOURNAL.md](docs/JOURNAL.md).

## Commandes
- `npm run typecheck` — TypeScript strict (TS 7), sans émission
- `npm test` — vitest (aucun appel réseau ni LLM réel dans les tests)
- `npm run dev` — lance le bot (lit `.env`)
- `python -m graphify update .` — régénère le graphe du code dans `graphify-out/`
- `npm run test:voice` — tests Python du service vocal ; `npm run sim:hour` — heure simulée et coût
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
- Tout texte envoyé au chat passe par `installSafeChat` (jamais de « / » en tête).
- Règles d'autonomie et liste « à éviter » appliquées par le code (`Decider.enforce`), pas seulement demandées au LLM.

## Pièges connus
- Deux copies de `vec3` dans `node_modules` : utiliser le type `Bot['entity']['position']`, construire
  les vecteurs avec `me.offset(...)`, ne pas importer `vec3`.
- `bot.oxygenLevel` de mineflayer est incohérent (brut 0..300 ou sur 20) : utiliser `oxygenOf(bot)`.
- `entity.isInWater` / `isInLava` existent à l'exécution mais pas dans les types : `physicsFlags()`.
- Le pathfinder refuse de démarrer dans la lave : les réflexes pilotent directement (regard + commandes).
- RCON via SSH : quotes simples côté distant, sinon `~` est développé en `/root`. `fill`/`setblock`
  échouent (« not loaded ») si aucun joueur n'est près de la zone : téléporter d'abord.
- Easy LLM : `block_update` n'a pas de joueur (pose attribuée par coup de bras + portée) ; `block_break`
  et `craft_item` sont attribués ; aucun événement d'attaque. Fixture réelle : `test/fixtures/easyllm-capture.jsonl`.
- mineflayer : la blessure d'un mob (`entityHurt`) arrive souvent AVANT le coup de bras (`entitySwingArm`).
- Heredocs bash + Python sous Windows : les apostrophes et contre-obliques se perdent ; écrire les
  fichiers TypeScript avec l'outil Write/Edit, et des titres de test entre guillemets doubles.
- Easy LLM Voice : `heard_audio_batch` vient des paquets de micro d'un client Simple Voice Chat ;
  une voix injectée par un point d'accès n'est pas « entendue ».
- Skins (FabricTailor 2.5.0) : `skin set URL` est cassé (MineSkin refuse son format, échec silencieux).
  Copier le PNG dans `/opt/minecraft/data/skins/` puis `execute as <bot> run skin set upload slim /data/skins/<f>.png`.
  Source des skins : `deploy/skins/`. Vérifier dans le playerdata (`fabrictailor:skin_data`).
- Whitelist en offline-mode : `whitelist add` met l'UUID en ligne ; écrire l'UUID offline
  (md5 « OfflinePlayer:<nom> », v3) dans `whitelist.json` puis `whitelist reload`.
- Essais réels : `scripts/test-player.ts` (joueur scripté « Testeur ») + préparation par RCON ; déploiement
  `bash scripts/deploy.sh` ; journaux `docker logs minecraftia`.

## Environnement
- Serveur : VPS Contabo `169.58.55.167`, clé `~/.ssh/contabo_minecraft`, `/opt/minecraft` (itzg, Fabric 1.21,
  `online-mode=false`, Simple Voice Chat). Secrets du bot sur le VPS : `/opt/minecraftia/.env`.
- Développement : Windows, Node 24 ; production : Node 22 dans Docker sur le VPS.
