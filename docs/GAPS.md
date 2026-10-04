# Manques traités

Relevés avec `bash scripts/gaps-check.sh` (table `skill_gaps` de chaque bot).

| Date | Bot | Manque | Traitement |
|---|---|---|---|
| 2026-10-04 | Léa | « arrête-toi », « viens ici », « arrête de creuser » (3×) | Ordres de rappel exécutés par le code (arrêt + suivi), sans modèle : `isRecallOrder` dans `src/decider/loop.ts` |
| 2026-10-04 | joueurs | portes non ouvertes, difficultés dans l'eau | `src/bot/movements.ts` : ouverture des portes en bois, coût de l'eau relevé à 4 |
