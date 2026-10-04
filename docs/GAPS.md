# Manques traités

Relevés avec `bash scripts/gaps-check.sh` (table `skill_gaps` de chaque bot).

| Date | Bot | Manque | Traitement |
|---|---|---|---|
| 2026-10-04 | Léa | « arrête-toi », « viens ici », « arrête de creuser » (3×) | Ordres de rappel exécutés par le code (arrêt + suivi), sans modèle : `isRecallOrder` dans `src/decider/loop.ts` |
| 2026-10-04 | joueurs | portes non ouvertes, difficultés dans l'eau | `src/bot/movements.ts` : ouverture des portes en bois, coût de l'eau relevé à 4 |
| 2026-10-04 | Alex | « donne ton bois » (2×) | Nouvelle compétence `give {item, count?}` : rejoint le joueur et lui lance les objets (nom exact ou famille, ex. « log ») |
| 2026-10-05 | Léa | « raconte-moi une blague » | Conversation : phrase adressée au bot (ni ordre ni question d'inventaire) → réponse courte du modèle gratuit, dans le personnage, au plus toutes les 15 s. « récolter 10 de charbon » : minerai inaccessible (No path), abandon après 4 essais, normal |
| 2026-10-05 | Léa | « pose le four à côté de la table de craft » (3×), « t'as un four ? » | Compétence `place {item, near?}` (sur ordre seulement) ; questions : four, établi, coffre, lit, seau, bâtons |
| 2026-10-05 | joueurs | « défends-moi » / « attaque » annulé par la survie | En combat (attack en cours), la fuite pour le nombre demande 6 monstres au lieu de 3 ; vie basse au contact et creeper restent prioritaires ; un ordre coupé par un réflexe est repris dans les 30 s |
| 2026-10-05 | Alex | « t'as une hache ? », « t'as une pioche ? » (2× chacun) | Questions sur les outils : il dit lesquels (« une pioche en pierre ») |
| 2026-10-05 | joueurs | pioche adaptée au minerai, demander au joueur si rien | `ensureHarvestTool` : outil requis par le bloc (`harvestTools`), inventaire → fabrication → coffres proches → demande au joueur ; « va miner » / « va récolter » sans cible → « je mine quoi ? », la réponse complète l'ordre. Vitres vérifiées : blocs pleins et protégés |
| 2026-10-05 | Léa | « miner jusqu'en y=-10 … un while y != 10 » | Compétence `staircase {targetY, direction?}` : escalier vers le bas, arrêt devant lave/eau/vide, regraviers recreusés |
| 2026-10-05 | joueurs | « s'il casse sa hache, il la refait ? » | `ensureTool` : avant chaque bloc récolté/miné, refabrique hache ou pioche (planches, bâtons, établi posé si besoin) |
| 2026-10-05 | Léa | « récolte tous les minerais » → blocs inconnus | Familles de blocs (`minerais` → *_ore, `bois` → bûches) ; gains comptés sur ce que le bloc lâche (minerai de fer → fer brut) |
| 2026-10-05 | Alex | « alex t'as combien de buches » | Question reconnue même sans « ? » et avec l'interpellation devant |
| 2026-10-05 | Léa | plantage « heap out of memory » (4 Go) sur « creuse en escalier » | Recherche de chemin bornée à 32 blocs (`searchRadius`), délai de calcul laissé à 5 s |
| 2026-10-05 | Alex | « t'as du bois ou pas ? », « tu as eu tes trente bûches ? » | Réponses aux questions d'inventaire, calculées sur l'inventaire réel (`src/feedback/questions.ts`) |
| 2026-10-05 | Alex | « je vais faire un sol comme toi » : constructions d'initiative au mauvais endroit | Plus de construction sans ordre (`BOT_BUILD_INITIATIVE=false` par défaut, garde-fou dans `applyGuards`) |
| 2026-10-05 | Alex | « ramène-moi 30 bûches » → 3 bûches | Récolte bloc par bloc (collectblock abandonnait toute sa liste au premier trajet trop long), rayon 48, délai 10 s/bloc (max 5 min), délai plein pour les ordres, `thinkTimeout` 10 s |
| 2026-10-05 | Alex | « Alex, trouve de la laine » incompris | Verbes « trouve », « chope », « ramène-moi » ajoutés aux ordres. « trop de l'alien » : transcription ratée, ignoré |
| 2026-10-05 | Alex | « c'est nul… si je ne te demande pas à construire, construis pas » (compris comme un ordre de construire) | Reproches : « nul », « il ne faut pas », impératif négatif (« construis pas ») ; reproche d'une initiative → domaine « sur demande seulement » 2 h (`Autonomy.restrictToRequests`, visible dans `!autonomie`) |
| 2026-10-05 | joueurs | le bot ouvre la porte mais ne passe pas | Bug du pathfinder (reste en mode « pose de bloc » après l'ouverture) : les passages sont traversables au calcul, `DoorOpener` ouvre juste avant le passage |
| 2026-10-05 | joueurs | ordres oraux mal compris (« alex fait 3 echelles », « là tu peux couper… », « ok, tu vas ramasser… ») | Règles d'ordre : mots de remplissage oraux, « tu vas », « s'il te plaît », nouveaux verbes ; caractère corrompu dans la règle « plutôt » réparé |
| 2026-10-05 | joueurs | registre des manques figé | Manques ajoutés : phrase adressée au bot mais incomprise, ordre exécuté qui échoue (avec la raison) |
| 2026-10-05 | joueurs | transcription approximative (« bushes », « beau ») | Whisper : vocabulaire Minecraft + prénoms en contexte, recherche en faisceau (5) |
| 2026-10-05 | joueurs | le bot casse les blocs posés pour aller aux bûches | `PlacedBlocks` (registre persistant) + blocs de construction protégés ; collectblock reçoit des réglages protégés, remis après chaque récolte |
| 2026-10-04 | Alex | « pose chest » | Fausse alerte : coffres/fours couverts par store/retrieve/smelt, retirés des blocs non pris en charge |
| 2026-10-04 | Léa | « on arrête du creuset, viens », « suis-moi », « reviens à la surface » | Variantes de rappel couvertes par `isRecallOrder` |

## En attente de déploiement

Règle : déployer (bots seulement) au-delà de 5 éléments, ou tout de suite si un joueur tape `!deploy` dans le chat. Dernier déploiement : `4c82ce2` (2026-10-05, sur `!deploy`).

1. Combat sur ordre : seuil de fuite relevé, reprise de l'ordre après un réflexe
2. Compétence « poser » (four à côté de l'établi)
3. Questions : four, établi, coffre…
4. Conversation (réponse courte quand on parle au bot)
