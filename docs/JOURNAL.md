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

## 2026-10-04 — Phase 2 : stockage

**Fait**
- Schéma SQLite (migration v1 embarquée, `user_version`), WAL, clés étrangères.
- `VectorIndex` : `SqliteVecIndex` (vec0, distance cosinus) et `MemoryVectorIndex` (repli), tous deux
  persistés dans `node_embeddings` ; la table virtuelle se reconstruit si elle diverge.
- `Embedder` : modèle local multilingue `paraphrase-multilingual-MiniLM-L12-v2` (q8, 384 dims,
  130 Mo dans `data/models`) et `HashingEmbedder` déterministe (tests, repli hors-ligne).
  Changement d'embedder détecté via `meta` → réindexation automatique.
- `Store` : accès aux épisodes, nœuds, preuves, autonomie, import hérité (aucune règle d'apprentissage).
- Migration JSON (`npm run migrate`) : copie brute intégrale de chaque fichier + mappage du format
  `minecraftia-export` v1 ; idempotente par hachage du contenu.

**Testé** — 52 tests verts. sqlite-vec et le repli mémoire renvoient les mêmes voisins et les mêmes
similarités ; aller-retour sans perte (contenu brut identique octet pour octet) ; idempotence ;
JSON invalide ou inconnu conservé. Exécution réelle du script de migration avec le vrai modèle :
6 nœuds, 4 vecteurs dans sqlite-vec, second passage ignoré.

**Appris**
- Mesure réelle du modèle : chargement 7 s, 34 ms pour 3 phrases ; « mur en pierre » ~ « muraille »
  = 0,92, « mur » ~ « combattre un zombie » = 0,14.

**Incertain**
- Pas de JSON hérité réel à migrer (départ de zéro) : le format reconnu est celui que nous définissons.

## 2026-10-04 — Phase 3 : observateur

**Fait**
- `RawEvent` normalisé ; `Observer` : un seau par activité, clos après silence, éloignement ou à la
  demande ; état du joueur (équipement, vie, faim, biome, lieux visités → « base »).
- Analyseurs : construction (forme, dimensions, palette, symétrie, ordre vertical, contour d'abord,
  échafaudage), minage (cibles, profondeur, escalier/tunnel/puits/carrière, outil), récolte, combat
  (cibles, distance d'engagement, arme, bouclier, seuil de repli, style), artisanat (séquence),
  exploration (distance, biomes), survie (seuils pour manger, équipement).
- Arbre (partie ingestion) : situation fusionnée par similarité ≥ 0,88 dans le même domaine,
  mécanismes concurrents distingués par signature, préférences fusionnées (moyennes et décomptes pondérés).
- Adaptateurs : Easy LLM (format relevé sur le vrai mod, fixture de 390 messages réels) et mineflayer
  (attaques et mobs tués ; repli pour les blocs, déplacements, équipement quand Easy LLM est absent).
- Mods Easy LLM + Easy LLM Voice réinstallés ; image Docker du bot ; service `minecraftia` dans le
  compose du VPS ; `scripts/deploy.sh` ; joueur scripté `scripts/test-player.ts`.

**Testé** — 89 tests verts, dont la chaîne complète sur la capture réelle (→ épisode « mur en pierre
taillée, de bas en haut »). Essai réel en production (bot dans Docker sur le VPS, joueur scripté) :
épisodes « mur 7×3 en stone bricks (symétrique, de bas en haut) », « 8 oak planks, 1 crafting table »,
« 3× zombie à l'épée en fer à 2 blocs, style offensif, 1 tué » → 3 situations et 3 mécanismes en base.

**Appris**
- Easy LLM : les poses (`block_update`) ne sont pas attribuées ; pas d'événement d'attaque ;
  `players_tick` donne vie, faim, biome, équipement et inventaire de chaque joueur.
- Premier essai de combat sans épisode : la blessure du mob arrive avant le coup de bras (vu avec un
  bot espion) → attribution indépendante de l'ordre.
- La fusion des listes perdait l'ordre des fabrications → champ `sequence`.

**Incertain**
- Bot à 1,5 PV près d'un zombie immobile : fuite puis retour vers le joueur, en boucle. Les réflexes
  priment (voulu), mais l'oscillation est à traiter côté décideur (ne pas suivre vers une menace).
- Lieux visités tenus en mémoire seulement (la « base » se réapprend après un redémarrage).

## 2026-10-04 — Phase 4 : arbre

**Fait**
- Décroissance paresseuse (`w · 2^(−Δt/demi-vie)`, demi-vie 6 h) mesurée en **temps de jeu actif**
  (`PlayClock`, persisté ; n'avance que si le bot est connecté et le joueur suivi en ligne).
- Renforcement : observation +1, enseignement +3, correction montrée +5, approbation +2 (+1 situation),
  réussite +0,5, échec −1 ; correction : `w × 0,2 − 5` → le mécanisme passe « à éviter ».
  Chaque variation laisse une preuve (`node_evidence`).
- Recherche : top-k situations par similarité × (1 + ln(1 + poids)), mécanismes positifs classés,
  mécanismes corrigés renvoyés à part (`avoid`) pour que le décideur les évite.
- `profile()` (spécialité émergente), `overview()` (pour `!arbre`), `forget()` / `restore()` (pour `!oublie`).
- Outil `scripts/tree-query.ts` pour inspecter l'arbre.

**Testé** — 102 tests verts. **Test de divergence (arbres)** automatisé : deux bases vierges nourries
d'une heure de bâtisseur et d'une heure de combattant simulés → domaines dominants `build` / `combat`,
profils quasi orthogonaux (cosinus < 0,3), préférences fidèles (pierre taillée de bas en haut ;
épée en fer, bouclier, engagement < 3,5 blocs). Correction : même un mécanisme de poids 10 passe à éviter.
En production, avec le vrai modèle : « un monstre approche, il faut se défendre » → branche combat
en tête (0,50) ; « bâtir une muraille » → « construire un mur » (0,85) sans mot commun.

**Appris**
- L'embedder de test (lexical) ne rapproche que des textes au vocabulaire partagé : les tests de
  recherche utilisent des requêtes cohérentes avec cette limite ; le sens est vérifié en production.
