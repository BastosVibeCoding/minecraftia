# Manques traités

Relevés avec `bash scripts/gaps-check.sh` (table `skill_gaps` de chaque bot).

| Date | Bot | Manque | Traitement |
|---|---|---|---|
| 2026-10-04 | Léa | « arrête-toi », « viens ici », « arrête de creuser » (3×) | Ordres de rappel exécutés par le code (arrêt + suivi), sans modèle : `isRecallOrder` dans `src/decider/loop.ts` |
| 2026-10-04 | joueurs | portes non ouvertes, difficultés dans l'eau | `src/bot/movements.ts` : ouverture des portes en bois, coût de l'eau relevé à 4 |
| 2026-10-04 | Alex | « donne ton bois » (2×) | Nouvelle compétence `give {item, count?}` : rejoint le joueur et lui lance les objets (nom exact ou famille, ex. « log ») |
| 2026-10-05 | Alex | « c'est nul… si je ne te demande pas à construire, construis pas » (compris comme un ordre de construire) | Reproches : « nul », « il ne faut pas », impératif négatif (« construis pas ») ; reproche d'une initiative → domaine « sur demande seulement » 2 h (`Autonomy.restrictToRequests`, visible dans `!autonomie`) |
| 2026-10-05 | joueurs | le bot ouvre la porte mais ne passe pas | Bug du pathfinder (reste en mode « pose de bloc » après l'ouverture) : les passages sont traversables au calcul, `DoorOpener` ouvre juste avant le passage |
| 2026-10-05 | joueurs | ordres oraux mal compris (« alex fait 3 echelles », « là tu peux couper… », « ok, tu vas ramasser… ») | Règles d'ordre : mots de remplissage oraux, « tu vas », « s'il te plaît », nouveaux verbes ; caractère corrompu dans la règle « plutôt » réparé |
| 2026-10-05 | joueurs | registre des manques figé | Manques ajoutés : phrase adressée au bot mais incomprise, ordre exécuté qui échoue (avec la raison) |
| 2026-10-05 | joueurs | transcription approximative (« bushes », « beau ») | Whisper : vocabulaire Minecraft + prénoms en contexte, recherche en faisceau (5) |
| 2026-10-05 | joueurs | le bot casse les blocs posés pour aller aux bûches | `PlacedBlocks` (registre persistant) + blocs de construction protégés ; collectblock reçoit des réglages protégés, remis après chaque récolte |
| 2026-10-04 | Alex | « pose chest » | Fausse alerte : coffres/fours couverts par store/retrieve/smelt, retirés des blocs non pris en charge |
| 2026-10-04 | Léa | « on arrête du creuset, viens », « suis-moi », « reviens à la surface » | Variantes de rappel couvertes par `isRecallOrder` |

## En attente de déploiement

Règle : déployer (bots seulement) au-delà de 5 éléments, ou tout de suite si un joueur tape `!deploy` dans le chat. Dernier déploiement : `0eb6138` (2026-10-05, 6 éléments, bots + voix).

1. Portes : ouverture par `DoorOpener` au lieu du pathfinder
2. Reproches mieux compris (« nul », « il ne faut pas », « construis pas »)
3. Règle « sur demande seulement » après le reproche d'une initiative
