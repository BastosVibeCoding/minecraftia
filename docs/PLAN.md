# Minecraftia — Plan de réalisation

Compagnon IA pour Minecraft dont le rôle **émerge** de la façon de jouer de son joueur.
Ce document est la référence d'architecture. Il est validé une fois, puis les phases s'enchaînent.

---

## 0. État des lieux (constaté le 2026-10-04)

### Dépôt
| Élément | Constat |
|---|---|
| Dossier local `Bot minecraft/` | **vide**, pas de dépôt git |
| `github.com/BastosVibeCoding/minecraftia` | **dépôt vide** (aucun commit, aucune branche) |
| Recherche disque (`OneDrive`, `Documents`) | aucun `package.json` qui référence mineflayer, aucun fichier Edge TTS |

**Décision (Bastien)** : on repart **vraiment de zéro**. Rien n'est réutilisé ni migré.

### VPS Contabo (`169.58.55.167`, accès par clé SSH `~/.ssh/contabo_minecraft`)
Ubuntu 24.04, 8 vCPU, 23 Go RAM, 145 Go disque, Docker, Node 22, Python 3.12.
Restes de l'ancien bot **supprimés le 2026-10-04** :
- conteneur `voice-relay` et son dossier ;
- mods Easy LLM / Easy LLM Voice, Ledger, FabricTailor, Kotlin et leurs configurations ;
- enregistrements ServerReplay, `mods-retires`, l'ancien monde et ses sauvegardes, le cron de
  sauvegarde, les clés IA (la clé OpenRouter a été déplacée dans `/opt/minecraftia/.env`, droits 600),
  le cache HuggingFace.
Il reste, propre : `itzg/minecraft-server` Fabric 1.21, `online-mode=false`, monde neuf, mods
lithium, ferrite-core, chunky, **Simple Voice Chat 2.6.22** ; RCON actif ; cron de pré-génération
Chunky la nuit. **Ollama** (qwen2.5) est conservé à la demande de Bastien mais n'est pas utilisé
par Minecraftia.

### Environnement
| Outil | État |
|---|---|
| Node.js 24.15 / npm 11.12 | OK |
| Python 3.14.4 | OK |
| `better-sqlite3` + `sqlite-vec` 0.1.9 | **installés et testés** : extension chargée, table `vec0`, requête KNN correcte |
| `faster-whisper` 1.2.1 | installé, embarque `silero_vad_v6.onnx` (Silero VAD sans PyTorch) |
| `onnxruntime` 1.30 | installé |
| Java (PC) | 17.0.12. Pas bloquant : aucun code Java à compiler, le serveur tourne sur le VPS |
| git 2.55 | OK ; `gh` absent |

### Outils demandés
| Outil | État | Utilisation |
|---|---|---|
| **graphify** (`graphifyy` 0.9.75, pip) | **présent** (CLI) | `graphify update .` (extraction tree-sitter, sans LLM) à la fin de chaque phase. Sortie dans `graphify-out/`, ignorée par git |
| **Headroom** | **absent** | pas de remplacement. Le contexte est tenu par des phases courtes et `docs/JOURNAL.md` |
| **Claude Code Setup** | **absent** (plugin non installé) | je configure à la main : `CLAUDE.md`, `.claude/settings.json` (hook typecheck + tests), commandes `.claude/commands/` |
| **Task Observer** | **absent** | remplacé par `docs/JOURNAL.md` : tâches faites, décisions, ce qui a été appris, par phase |
| Skills de coding Claude | présents : `init`, `code-review`, `simplify`, `run`, `claude-api` | `claude-api` avant le décideur (prix, IDs de modèles), `code-review` + `simplify` en fin de phase, `run` pour lancer le bot réel |

---

## 1. Architecture

```
            ┌────────────── Joueur (joue, parle, corrige) ──────────────┐
            │                                                           │
            ▼                                                           ▼
   [1] Observateur ──épisodes──▶ [3] Arbre de comportements ◀── [2] Retours du joueur
     mineflayer → RawEvent        SQLite + sqlite-vec               chat + STT → classifieur
            ▲                          │  branches pertinentes          (correction/approbation/
            │                          ▼                                 enseignement/ordre/bavardage)
            │                   [5] Décideur LLM ◀── [4] Autonomie (score par domaine)
            │                    OpenRouter, JSON validé
            │                          │ décision
            │                          ▼
            │                   [6] Compétences ◀══ préemption ══ [7] Réflexes de survie
            │                    pathfinder, collectblock, pvp        (code pur, chaque tick)
            │                          │
            └──────── Monde ◀──────────┘
                         │
                         ▼
                  [8] Résultat ──▶ Arbre + Autonomie
```

### Règles de frontière
- Les modules communiquent **uniquement** par un bus d'événements typé (`src/core/bus.ts`) ou par
  des interfaces injectées. Aucun module n'importe l'implémentation d'un autre.
- Seuls `src/bot/` et `src/skills/` touchent l'objet mineflayer. L'observateur reçoit des
  `RawEvent` normalisés produits par un adaptateur. On peut donc le tester en rejouant des
  journaux JSONL, sans serveur.
- Les réflexes ne dépendent de rien d'autre que du bot et du contrôleur d'actions. Ils ne lisent
  jamais l'arbre ni la configuration apprise.

### Arborescence cible
```
src/
  config/        schéma zod, chargement .env + config.json
  core/          logger (pino, rédaction des secrets), bus, erreurs, horloge injectable
  bot/           connexion, reconnexion, adaptateur mineflayer → RawEvent, état du monde compact
  store/         ouverture DB, migrations, VectorIndex (sqlite-vec | repli mémoire)
  observer/      segmentation en épisodes + analyseurs (structure, combat, minage, exploration, équipement)
  feedback/      chat, client STT, classifieur d'énoncés
  tree/          nœuds, renforcement, décroissance, recherche, oubli
  autonomy/      scores par domaine, bandes de comportement
  decider/       déclencheurs, prompt, routeur de modèles, cache, budget, validation
  skills/        primitives paramétrées + contrôleur d'actions (timeout, abort)
  reflexes/      règles de survie, préemption
  outcome/       évaluation après action
  strategy/      mirror (implémenté) | complement (point d'extension)
  commands/      !arbre !autonomie !pourquoi !oublie ...
  tts/           interface Speaker + EdgeTTS
stt/             service Python (faster-whisper + Silero VAD)
scripts/         migrate-json.ts, sim-hour.ts, replay.ts
test/            vitest, journaux simulés (builder.jsonl, fighter.jsonl)
```

### Stack
TypeScript `strict`, Node 22+, mineflayer, mineflayer-pathfinder, mineflayer-collectblock,
mineflayer-pvp, better-sqlite3, sqlite-vec, zod, pino, vitest. Embeddings locaux (voir 3.3).

### Mods serveur Easy LLM + Easy LLM Voice (choix validé le 2026-10-04)
mineflayer ne peut pas rejoindre Simple Voice Chat, et il ne voit pas les crafts d'un autre joueur.
On utilise deux mods existants (Modrinth `easy-llm`, `easy-llm-voice`, auteur Kou_AIandHuman,
Fabric 1.21, code fermé, usage privé autorisé). Dans les deux cas, **le mod est client
WebSocket et Minecraftia est serveur**.

| Mod | Canal | Ce qui circule |
|---|---|---|
| Easy LLM | `ws://minecraftia:7891` | → mod : `{"type":"first_access","min":{x,y,z},"max":{x,y,z}}` (zone de blocs suivie). ← mod : messages `{server_id,type,tick,data}` ou `{"type":"event_batch","items":[…]}`. Types utiles : `players_tick` (position, vitesse, regard, équipement de chaque joueur), `block_update`, `swing_hand`, `craft_item` (objet, ingrédients consommés, établi), `player_move_start/end`, `chat`, `container_close`, `block_snapshot`, et `heard_audio_batch` (paquets Opus entendus, par locuteur) |
| Easy LLM Voice | `ws://minecraftia:8765` (un port par bot) | → mod : `setup {agent_id, player_name, audio_codec:"opus", sample_rate:48000, channels:1, frame_millis:20}`, puis `voice_frame {sequence, opus_data_base64, whispering}` cadencés à 20 ms, `voice_stop {last_sequence}`, `interrupt` |

Le format exact des champs est relevé sur le vrai mod en phase 3 et figé dans des fixtures de test.

Deux interfaces isolent ces mods du reste : `TelemetrySource` (→ `RawEvent`) et `VoiceLink`
(audio entrant → STT, PCM du TTS → Opus → mod). Si un jour ces mods cassent ou nous limitent, un
mod maison peut les remplacer sans toucher au reste.
Contraintes connues : variable `MC_SERVER_ID` obligatoire côté serveur (sinon plantage au
démarrage) ; les mises à jour de blocs ne remontent que dans la zone abonnée, que l'on recentre
sur le joueur suivi.

### Déploiement
```
VPS /opt/minecraft/docker-compose.yml   (réseau Docker interne, seuls 25565/tcp et 24454/udp publics)
  mc-server     itzg Fabric 1.21 + Simple Voice Chat + Easy LLM + Easy LLM Voice
  minecraftia   Node (bookworm-slim) : le bot, SQLite dans un volume, ports 7891/8765 internes
  stt           Python : faster-whisper (CPU, int8) + Silero VAD, port interne
```
Développement et tests sur le PC Windows. Déploiement sur le VPS : `rsync` du dépôt, puis
`docker compose up -d --build`. Les secrets restent dans `/opt/minecraftia/.env` sur le VPS.

---

## 2. Les 8 modules

### [1] Observateur
- **Entrée** : `RawEvent` (`block_placed`, `block_broken`, `craft`, `container`, `swing`, `equip`,
  `attack`, `hurt`, `health`, `move`, `chat`, `collect`, `dimension`…) attribués au joueur suivi.
  Deux adaptateurs produisent ces `RawEvent` : Easy LLM pour les blocs, crafts, conteneurs,
  coups de bras et la position de chaque joueur, mineflayer pour les entités, la vie et les dégâts.
  Un bloc est attribué au joueur s'il est à portée (≤ 5 blocs) et a fait un `swing_hand` dans
  les 300 ms. Les crafts, eux, sont attribués exactement.
- **Segmentation** : un épisode s'ouvre au premier événement d'un type d'activité et se ferme après
  un silence (8 s par défaut), un changement d'activité ou un déplacement de plus de 24 blocs.
- **Analyseurs** (fonctions pures, testées) :
  - *structure* : boîte englobante, dimensions, histogramme des matériaux, symétrie (miroir X/Z),
    creux/plein, ordre de pose (bas → haut, contour → remplissage), forme (mur, sol, tour, pièce).
    Exemple : « mur 7×4 en pierre taillée, symétrique, posé bas → haut ».
  - *combat* : distance d'engagement, arme, cibles, PV au moment du repli, usage du bouclier, durée.
  - *minage* : profondeur (Y), motif (branche, escalier, grotte), outil, minerais visés.
  - *exploration* : biomes, distance, lieux revisités (grille de 32 blocs).
  - *équipement / survie* : changements d'armure ou d'arme, seuil de PV auquel le joueur mange.
- **Sortie** : `Episode { domain, kind, situation, mechanism, params, source, ts }` publié sur le bus.

### [2] Retours du joueur
- **Chat** : message du joueur suivi → classifieur.
- **Voix** : Simple Voice Chat → Easy LLM (`heard_audio_batch`, Opus) → décodage → service STT → même classifieur.
- **Classifieur** en deux étages, pour économiser :
  1. règles locales (« non », « pas comme ça », « arrête » → correction ; « bien », « parfait » →
     approbation ; « regarde », « je fais comme ça » → enseignement ; impératif + verbe connu → ordre) ;
  2. petit LLM (Haiku 4.5) seulement si les règles sont ambiguës. Sortie JSON
     `{label, domain?, target?, confidence}` validée par zod.
- **Effet** : enseignement → ouvre une *fenêtre d'enseignement* (90 s) ; les épisodes observés pendant
  cette fenêtre sont marqués `source=taught`. Correction → appliquée immédiatement (voir 3.2).

### [3] Arbre de comportements
- Racines = domaines (`build`, `combat`, `mine`, `gather`, `explore`, `craft`, `survive`).
  Les domaines servent de **taxonomie**, pas de rôles : au départ tous les poids valent zéro.
- Niveau 1 = **situation** (contexte où le mécanisme s'applique).
  Niveau 2 = **mécanisme** (comment faire : primitive + paramètres + ordre).
  Plusieurs mécanismes peuvent concurrencer une même situation ; le plus lourd gagne.
- **Fusion** : un nouvel épisode dont la situation est à moins d'un seuil de similarité (cosinus
  0,88) d'un nœud existant le renforce et fusionne ses paramètres (moyenne pondérée pour les valeurs
  numériques, histogramme pour les catégories). Sinon un nouveau nœud est créé.
  On retient ainsi le mécanisme et les préférences, pas la séquence exacte.
- Détails des poids : 3.2.

### [4] Autonomie
- Un score continu `s ∈ [0,1]` par domaine, initialisé à 0.
- Mise à jour : `s ← clamp(s + g·(1−s))` pour un gain, `s ← clamp(s − p·s)` pour une perte.
  Réussite +0,04, approbation +0,08, échec −0,06, correction −0,20, mort −0,30.
- Comportement **gradué**, pas en paliers :
  - `s < 0,25` observe : suit le joueur, ne fait rien seul dans ce domaine ;
  - `0,25 → 0,5` imite : reproduit ce que le joueur fait en ce moment, à côté de lui ;
  - `0,5 → 0,75` propose : annonce « je peux faire X ? » et attend un oui ou un délai ;
  - `≥ 0,75` agit seul : prend des initiatives.
  Les bornes ont une hystérésis de 0,03. L'intervalle entre initiatives et la durée maximale d'une
  action varient continûment avec `s`.

### [5] Décideur LLM
- **Déclencheurs** (jamais par tick) : fin d'action, nouvel épisode du joueur, ordre du joueur,
  bot inactif depuis plus de 20 s, sortie d'un réflexe. Intervalle minimal 5 s entre deux appels.
- **Entrée** : état du monde compact (≈ 300 tokens : PV, faim, inventaire résumé, position,
  joueur, menaces, heure), top-k (6) branches pertinentes, scores d'autonomie, dernier résultat.
- **Sortie** : JSON `{ intent, domain, skill, params, chain?, say?, rationale, needsApproval }`
  validé par zod. Invalide → 1 nouvelle tentative avec l'erreur de validation → sinon repli sûr
  (`follow`).
- **Routage** : `anthropic/claude-haiku-4.5` par défaut. Modèle plus gros (configurable, par défaut
  `anthropic/claude-sonnet-5.5`) seulement si 3 échecs consécutifs dans la même situation, ou pour
  composer une *nouvelle compétence* : une chaîne de primitives existantes, en JSON validé, stockée
  comme mécanisme. **Aucun code généré n'est exécuté.**
- **Cache** : signature de situation = hachage des caractéristiques quantifiées + ids des nœuds
  retenus. Une situation quasi identique avec un cache valide (TTL 120 s) ne déclenche pas d'appel.
  Le cache d'un domaine est invalidé dès qu'une correction le touche.
- **Budget** : plafond quotidien en USD (`.env`). Chaque appel est consigné dans `llm_calls`
  (modèle, tokens, coût, latence). Plafond atteint → le décideur se coupe proprement et le bot
  retombe sur suivi + réflexes. Il prévient une fois dans le chat.
- **Explicabilité** : la décision, les nœuds utilisés et le `rationale` sont stockés ; `!pourquoi`
  les restitue.
- **Mode `mirror | complement`** : `config.strategy`. Une interface `RoleStrategy` transforme les
  branches retenues avant le prompt. `MirrorStrategy` les passe telles quelles. `complement` est
  accepté par le schéma mais refusé au démarrage avec un message explicite (« stratégie non
  implémentée ») : c'est le point d'extension, sans fonction factice.

### [6] Compétences
Primitives génériques, chacune avec des paramètres typés (zod), un `AbortSignal` et un délai max :
`follow`, `goTo`, `collect(block, count)`, `build(shape, dims, material, symmetry, order)`,
`attack(targetFilter, engageDistance, retreatHp, useShield)`, `equip`, `craft(item, count)`,
`eat`, `guard(radius)`, `explore(radius, biomes?)`, `deposit`, `say`.
Un `ActionController` exécute une action à la fois, applique le délai max et expose
`preempt(reason)`.

### [7] Réflexes de survie
- Vérifiés à chaque `physicsTick` (20 Hz), code pur, sans LLM ni accès à l'arbre.
- Règles par priorité : lave / feu (sortir, chercher l'eau), noyade (remonter), chute (viser l'eau,
  s'arrêter), PV bas (manger, fuir), menace écrasante (fuir vers le joueur).
- Déclenchement → `ActionController.preempt()` (stoppe pathfinder, pvp, collectblock) puis action
  réflexe. **Objectif mesuré par test : préemption au tick suivant, aucun appel LLM.**
- Jamais désactivables : ils ne lisent aucune valeur apprise.

### [8] Résultat
Après chaque action : instantané avant / après (inventaire, blocs posés ou cassés, PV, mort).
Statut `success | failure | death | preempted | timeout`. Il est publié, puis appliqué à l'arbre
(nœud utilisé) et à l'autonomie (domaine). `preempted` par un réflexe n'est pas compté comme échec.

---

## 3. Données

### 3.1 Schéma SQLite (`data/minecraftia.db`, WAL)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- schema_version, embedder

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  player TEXT NOT NULL,
  domain TEXT NOT NULL,                 -- build|combat|mine|gather|explore|craft|survive
  kind TEXT NOT NULL,                   -- wall, branch_mine, melee_engage...
  summary TEXT NOT NULL,                -- phrase lisible
  params_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('observed','taught','corrected','legacy')),
  started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL
);

CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('domain','situation','mechanism')),
  domain TEXT NOT NULL,
  label TEXT NOT NULL,                  -- texte embarqué / affiché
  situation_json TEXT, mechanism_json TEXT,
  weight REAL NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER, decayed_at INTEGER NOT NULL,   -- décroissance paresseuse
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','forgotten'))
);
CREATE INDEX nodes_domain ON nodes(domain, status, weight DESC);

-- Index vectoriel : sqlite-vec si disponible...
CREATE VIRTUAL TABLE node_vec USING vec0(embedding float[384]);      -- rowid = nodes.id
-- ...sinon repli : même interface VectorIndex, cosinus calculé en mémoire
CREATE TABLE node_embeddings (node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                              embedding BLOB NOT NULL);

CREATE TABLE node_evidence (            -- traçabilité de chaque variation de poids
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- observed|taught|approval|correction|success|failure|decay|forget
  delta REAL NOT NULL, episode_id INTEGER, utterance_id INTEGER, decision_id INTEGER,
  at INTEGER NOT NULL
);

CREATE TABLE autonomy (domain TEXT PRIMARY KEY, score REAL NOT NULL, band TEXT NOT NULL,
                       updated_at INTEGER NOT NULL);
CREATE TABLE autonomy_events (id INTEGER PRIMARY KEY, domain TEXT NOT NULL, delta REAL NOT NULL,
                              reason TEXT NOT NULL, ref_id INTEGER, at INTEGER NOT NULL);

CREATE TABLE utterances (id INTEGER PRIMARY KEY, player TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('chat','voice')), text TEXT NOT NULL,
  label TEXT NOT NULL,                  -- correction|approval|teaching|order|chatter
  classifier TEXT NOT NULL,             -- rules|llm
  confidence REAL NOT NULL, domain TEXT, at INTEGER NOT NULL);

CREATE TABLE decisions (id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, situation_hash TEXT NOT NULL,
  model TEXT, cached INTEGER NOT NULL, node_ids_json TEXT NOT NULL, decision_json TEXT NOT NULL,
  rationale TEXT NOT NULL, autonomy_json TEXT NOT NULL, at INTEGER NOT NULL);

CREATE TABLE outcomes (id INTEGER PRIMARY KEY, decision_id INTEGER REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('success','failure','death','preempted','timeout')),
  details_json TEXT NOT NULL, at INTEGER NOT NULL);

CREATE TABLE decision_cache (situation_hash TEXT PRIMARY KEY, domain TEXT NOT NULL,
  decision_json TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);

CREATE TABLE llm_calls (id INTEGER PRIMARY KEY, purpose TEXT NOT NULL,  -- decide|classify|compose
  model TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL,
  latency_ms INTEGER, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL);
CREATE INDEX llm_calls_day ON llm_calls(at);

CREATE TABLE legacy_import (id INTEGER PRIMARY KEY, source_file TEXT NOT NULL,
  json_path TEXT NOT NULL, raw_json TEXT NOT NULL, mapped_to TEXT, imported_at INTEGER NOT NULL);
```

Migrations versionnées dans `src/store/migrations/NNN_*.sql`, appliquées au démarrage.

### 3.2 Dynamique des poids
| Signal | Effet sur le nœud |
|---|---|
| observation passive | `+1,0` |
| enseignement (fenêtre active) | `+3,0` |
| approbation | `+2,0` sur le nœud de la dernière décision |
| réussite / échec d'action | `+0,5` / `−1,0` |
| **correction** | poids `× 0,2` puis `−5`. Si le joueur montre ou dit l'alternative, nouveau nœud à `+5`. Cache du domaine invalidé, décision suivante forcée |
| décroissance | `w ← w · 2^(−Δt / demi-vie)`, Δt en **temps de jeu actif** (demi-vie 6 h de jeu) : une semaine sans jouer ne fait rien oublier |
| `!oublie <chose>` | recherche sémantique, nœuds correspondants passés en `forgotten` (réversible) |

La décroissance est paresseuse : elle est appliquée à la lecture, à partir de `decayed_at`.

### 3.3 Embeddings
Texte de situation → vecteur 384 dimensions avec **`Xenova/paraphrase-multilingual-MiniLM-L12-v2`**
via `@huggingface/transformers` (local, gratuit, gère le français ; environ 120 Mo téléchargés une
fois). Interface `Embedder`. Les tests utilisent un `HashingEmbedder` déterministe (aucun
téléchargement en CI). Le nom de l'embedder est stocké dans `meta` ; s'il change, la réindexation
est automatique.

### 3.4 Migration JSON
`scripts/migrate-json.ts <dossier>` : parcourt les JSON, mappe les structures reconnues (par
exemple préférences → nœuds, historique → épisodes `legacy`) et recopie **chaque valeur brute**
dans `legacy_import`. Rien n'est perdu, même ce qui n'a pas pu être mappé. Le script est idempotent
(hachage du contenu) et testé par un aller-retour.
Il n'existe pas de JSON hérité (on repart de zéro) : le script est livré avec un format d'entrée
documenté et des fixtures. Il sert à importer un export ou une sauvegarde, et à restaurer.

---

## 4. Coût

- Haiku 4.5 sur OpenRouter : environ 1 $/M tokens en entrée, 5 $/M en sortie (je relis les tarifs
  exacts au moment du code ; ils sont configurables).
- Appel type : environ 1 500 tokens en entrée, 150 en sortie, soit à peu près 0,0023 $.
- Une heure jouée : déclencheurs par événement, intervalle min 5 s, cache. Estimation de 60 à 150
  appels, soit **0,15 à 0,35 $/h**.
- Budget par défaut : `DAILY_BUDGET_USD=1.00`. Le test `sim-hour` rejoue une heure d'événements
  avec un LLM simulé qui facture les tokens. Il échoue si le coût dépasse le budget horaire configuré.

---

## 5. Phases

Chaque phase se termine par : `npm run typecheck && npm test` verts, `graphify update .`, une
entrée dans `docs/JOURNAL.md`, un commit, et un résumé (fait / testé / incertain).

| # | Phase | Livrables | Tests clés |
|---|---|---|---|
| 1 | **Socle** | config zod + `.env.example`, logger avec rédaction des secrets, bus, connexion + reconnexion (backoff), suivi du joueur, `ActionController`, réflexes, filet global (`uncaughtException` / `unhandledRejection` journalisés, sans sortie) | réflexes sur bot simulé : préemption au tick suivant, aucun appel LLM ; schéma de config ; rédaction des logs |
| 2 | **Stockage** | migrations, `VectorIndex` (sqlite-vec + repli mémoire), `Embedder`, script de migration JSON | les deux index renvoient les mêmes voisins ; migration sans perte (aller-retour) |
| 3 | **Observateur** | adaptateurs mineflayer et Easy LLM → RawEvent, segmentation, analyseurs, épisodes → nœuds | analyseurs sur fixtures (mur 7×4 symétrique, etc.) ; rejeu JSONL → épisodes attendus ; messages réels d'Easy LLM capturés et rejoués |
| 4 | **Arbre** | fusion, renforcement, décroissance, recherche top-k, oubli | unitaires poids et décroissance ; **test de divergence** bâtisseur / combattant (arbres) |
| 5 | **Décideur + compétences** | prompt, routeur, validation, repli, primitives, résultat → arbre ; boucle complète en imitation | routage (Haiku / escalade), JSON invalide → retry → repli ; **divergence (comportements)** ; correction effective dès la décision suivante |
| 6 | **Autonomie** | scores, bandes avec hystérésis, propositions (« je peux… ? »), initiatives | montée et baisse par domaine, domaines indépendants |
| 7 | **Retours du joueur** | chat + classifieur ; voix entrante (Easy LLM → STT Python) ; TTS Edge derrière l'interface `Speaker`, joué dans le jeu par Easy LLM Voice | classifieur (règles + LLM simulé) ; STT sur un WAV de test ; encodage Opus des trames ; correction prioritaire |
| 8 | **Durcissement** | budget + arrêt propre, cache, commandes `!arbre` `!autonomie` `!pourquoi` `!oublie`, README, journal des coûts | **sim-hour sous budget** ; commandes ; reconnexion sur serveur coupé |

Validation réelle : à partir de la phase 1, le bot est lancé sur le **serveur Fabric 1.21 du VPS**
(`online-mode=false`) et j'observe son comportement réel.
Je lance des scénarios scriptés par un second bot « joueur ». Je ne peux pas jouer à la place d'un
humain : le ressenti en jeu restera à confirmer par toi.

---

## 6. Risques

| Risque | Impact | Parade |
|---|---|---|
| Mods Easy LLM fermés, un seul auteur, figés en 1.21 | bloqués si bug ou abandon | derrière `TelemetrySource` / `VoiceLink` : remplaçables par un mod maison ; on reste en 1.21 |
| Protocole Easy LLM peu documenté | champs mal interprétés | capture des vrais messages, fixtures, validation zod tolérante (champs inconnus ignorés, journalisés) |
| Mods Easy LLM absents ou déconnectés | plus de voix ni de crafts | le bot continue : attribution par mineflayer en repli, chat seul pour les retours |
| `online-mode=false` sur un VPS public | n'importe qui peut se connecter sous n'importe quel pseudo | activer la whitelist (joueurs + bot) ; je le propose en phase 1 |
| Attribution des blocs en repli (portée + swing) | faux positifs près d'autres joueurs | seuils stricts ; un seul joueur suivi ; testé sur fixtures |
| Compatibilité mineflayer avec la sous-version 1.21.x | connexion impossible | épingler la dernière 1.21.x supportée par `minecraft-data` (vérifiée à l'installation) |
| Modules natifs (better-sqlite3, sqlite-vec) sous Windows / Node 24 | installation cassée | déjà vérifié OK ; repli mémoire derrière `VectorIndex` |
| Modèle d'embedding (120 Mo, 1er lancement) | démarrage lent, hors-ligne | cache local ; `HashingEmbedder` en repli |
| Dérive des tarifs ou des IDs de modèles OpenRouter | budget faux | prix et modèles dans la config ; coût réel lu dans la réponse OpenRouter (`usage`) quand il est fourni |
| STT sur CPU (faster-whisper) | latence de la voix | modèle `small` int8, VAD pour ne transcrire que la parole ; mesure de latence en phase 7 |
| Le LLM propose des actions incohérentes | comportements étranges | sortie contrainte aux primitives connues + validation zod + repli `follow` |

---

## 7. Décisions prises (2026-10-04)

| Sujet | Décision |
|---|---|
| Code existant | aucun : départ de zéro, restes de l'ancien bot supprimés du VPS |
| Audio | (b) Simple Voice Chat, via les mods existants Easy LLM + Easy LLM Voice |
| Serveur | VPS Contabo, Fabric 1.21 dans Docker, monde neuf |
| Ollama | conservé sur le VPS, non utilisé |
| Git | un commit par phase, poussé sur `BastosVibeCoding/minecraftia` (`main`) |
