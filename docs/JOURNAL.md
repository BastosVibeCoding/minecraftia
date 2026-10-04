# Journal de travail

Remplace Task Observer (absent de l'environnement) : tâches, décisions, apprentissages, incertitudes.

## 2026-10-04 — Préparation

- Dépôt GitHub et dossier local vides : départ de zéro (décision de Bastien).
- VPS nettoyé de l'ancien bot (voir PLAN.md §0). `mondes-archives/` (1,8 Go, ancien monde) : suppression
  refusée par le garde-fou automatique, laissée à Bastien.
- Choix voix : Simple Voice Chat via les mods existants Easy LLM + Easy LLM Voice (protocole relevé dans
  le dépôt d'exemple de leur auteur ; `MC_SERVER_ID` obligatoire côté serveur).
- Outils : graphify présent (CLI) ; Headroom, Task Observer, Claude Code Setup absents.
- sqlite-vec 0.1.9 + better-sqlite3 : chargement et KNN vérifiés sous Windows.

## 2026-10-04 — Phase 1 : socle

**Fait**
- Config zod (`.env` + JSON optionnel sans secret), logger pino avec masquage des secrets, bus typé
  tolérant aux erreurs d'abonnés, filet global (exceptions et rejets journalisés, processus maintenu).
- `BotConnection` : reconnexion à délai exponentiel plafonné, remis à zéro après une session stable.
- `ActionController` : une action à la fois, délai maximal, préemption synchrone, verrou réflexe, statut `death`.
- Réflexes : règles pures (lave, chute + seau, noyade, feu, creeper, nombre d'hostiles, vie basse, faim),
  moteur à chaque `physicsTick`, réflexe plus urgent prioritaire, délai max par type, exécuteur mineflayer.
- Suivi du joueur quand le bot est inactif (comportement neutre de départ).

**Testé** — 40 tests verts (config, masquage, bus, contrôleur, règles, moteur, reconnexion).
Le test clé : un réflexe interrompt une action en cours **dans le même tick**, sans appel LLM.
Essais réels sur le serveur du VPS (dangers provoqués par RCON) :
- faim extrême → le bot mange (9 pains consommés) ;
- 3 zombies → fuite d'environ 15 blocs, aucun dégât ;
- lave sous les pieds → hors du bloc de lave en moins d'une seconde (après correctif) ;
- noyade sous un plafond de pierre → nage jusqu'à la poche d'air, air de nouveau à 300/300.

**Appris**
- Première version de la fuite de lave inopérante : le pathfinder ne démarre pas d'un bloc de lave →
  pilotage direct.
- Remontée verticale inutile sous un plafond (grotte immergée) → viser la poche d'air la plus proche.
- `bot.oxygenLevel` de mineflayer alterne valeur brute et valeur sur 20 : un essai réel a montré une
  noyade sans réflexe → lecture normalisée depuis les métadonnées (`oxygenOf`).
- Erreur de protocole `PartialReadError` (ArmorTrimMaterial) vue une fois avec `hideErrors: false` : non
  bloquante pour la connexion, à surveiller pour l'inventaire.

**Incertain**
- Rejoindre la rive après la noyade : le pilotage direct bute parfois contre un obstacle ; le bot survit
  mais peut recouler. Une baisse de vie inexpliquée pendant ces essais (noyés probables, non vérifié).
- Réflexe de chute (seau d'eau) non essayé en réel.
