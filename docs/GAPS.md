# Manques traités

Relevés avec `bash scripts/gaps-check.sh` (table `skill_gaps` de chaque bot).

| Date | Bot | Manque | Traitement |
|---|---|---|---|
| 2026-10-04 | Léa | « arrête-toi », « viens ici », « arrête de creuser » (3×) | Ordres de rappel exécutés par le code (arrêt + suivi), sans modèle : `isRecallOrder` dans `src/decider/loop.ts` |
| 2026-10-04 | joueurs | portes non ouvertes, difficultés dans l'eau | `src/bot/movements.ts` : ouverture des portes en bois, coût de l'eau relevé à 4 |
| 2026-10-04 | Alex | « donne ton bois » (2×) | Nouvelle compétence `give {item, count?}` : rejoint le joueur et lui lance les objets (nom exact ou famille, ex. « log ») |
| 2026-10-05 | joueurs | le bot casse les blocs posés pour aller aux bûches | `PlacedBlocks` (registre persistant) + blocs de construction protégés ; collectblock reçoit des réglages protégés, remis après chaque récolte |
| 2026-10-04 | Alex | « pose chest » | Fausse alerte : coffres/fours couverts par store/retrieve/smelt, retirés des blocs non pris en charge |
| 2026-10-04 | Léa | « on arrête du creuset, viens », « suis-moi », « reviens à la surface » | Variantes de rappel couvertes par `isRecallOrder` |

## En attente de déploiement

Règle : déployer (bots seulement) au-delà de 5 éléments, ou tout de suite si un joueur tape `!deploy` dans le chat. Dernier déploiement : `b2ec736` (2026-10-04, sur `!deploy`).

1. `!pourquoi` et journaux : nom du modèle qui a réellement répondu (chaîne)
2. Coffre/four plus signalés comme manques
3. Blocs posés par les joueurs jamais cassés (déplacement et récolte)
