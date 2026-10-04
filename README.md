# Minecraftia

Compagnon IA pour Minecraft (Fabric 1.21) **sans rôle préprogrammé** : il part d'une page blanche,
suit son joueur, survit, écoute — et sa spécialité (construction, combat, minage, un mélange)
émerge de la façon de jouer du joueur. Il retient des **mécanismes** (comment, dans quel ordre,
avec quelles préférences), pas des séquences à rejouer.

- Le joueur peut **enseigner** (« regarde, je fais comme ça ») : ce qu'il fait ensuite compte triple.
- Une **correction** (« non, pas comme ça ») pèse plus que tout et s'applique immédiatement.
- L'**autonomie** monte domaine par domaine : observer → imiter → proposer → agir seul.
- Les **réflexes de survie** (lave, noyade, feu, chute, vie basse, fuite) sont du code pur, sans LLM,
  toujours prioritaires.

## Architecture

```
            ┌──────────────── Joueur : joue, parle, corrige ─────────────────┐
            │                                                                │
            ▼                                                                ▼
   [1] Observateur ──épisodes──▶ [3] Arbre de comportements ◀──── [2] Retours du joueur
   Easy LLM + mineflayer          SQLite + sqlite-vec              chat + voix (Whisper)
   → « mur 7×4 en pierre           situation → mécanismes          → correction / approbation /
      taillée, symétrique »        poids, décroissance                enseignement / ordre
            ▲                              │ branches pertinentes
            │                              ▼
            │                     [5] Décideur LLM ◀─────── [4] Autonomie par domaine
            │                     OpenRouter (Haiku 4.5)        score continu + bandes
            │                     JSON validé, cache, budget
            │                              │ décision
            │                              ▼
            │                     [6] Compétences ◀══ préemption ══ [7] Réflexes de survie
            │                     build, collect, attack…           code pur, chaque tick
            │                              │
            └─────────── Monde ◀───────────┘
                           │
                           ▼
                     [8] Résultat ──▶ Arbre + Autonomie
```

| Module | Code | Rôle |
|---|---|---|
| 1. Observateur | `src/observer/`, `src/bot/easyLlm*.ts`, `src/bot/mineflayerEvents.ts` | événements du joueur → épisodes analysés (forme, matériaux, symétrie, ordre, distance d'engagement…) |
| 2. Retours | `src/feedback/`, `src/voice/`, `voice/` | classifieur d'énoncés (règles puis petit LLM si ambigu), transcription vocale |
| 3. Arbre | `src/tree/`, `src/store/` | fusion des situations proches, renforcement, décroissance sur le temps de jeu actif, recherche vectorielle |
| 4. Autonomie | `src/autonomy/` | score par domaine, hystérésis, propositions, initiatives graduées |
| 5. Décideur | `src/decider/` | état du monde + branches + autonomie → décision JSON validée ; routage Haiku / Sonnet |
| 6. Compétences | `src/skills/` | primitives paramétrées avec délai maximal ; paramètres et enchaînement viennent de l'arbre |
| 7. Réflexes | `src/reflexes/` | règles de survie pures, préemption dans le tick |
| 8. Résultat | `src/outcome/` | réussi / raté / mort, inventaire et vie avant/après → arbre et autonomie |

Détails : [docs/PLAN.md](docs/PLAN.md). Journal du développement : [docs/JOURNAL.md](docs/JOURNAL.md).

### Déploiement (VPS)

Trois conteneurs sur un réseau Docker interne ; seuls le jeu (25565/tcp) et la voix (24454/udp) sont publics.

| Conteneur | Contenu |
|---|---|
| `mc-server` | Fabric 1.21 (itzg) + Simple Voice Chat + **Easy LLM** (télémétrie) + **Easy LLM Voice** (voix du bot) |
| `minecraftia` | le bot (Node 22), base SQLite dans `/opt/minecraftia/data` |
| `minecraftia-voice` | service vocal Python : faster-whisper `small` + Silero VAD, Edge TTS |

## Installation

### Développement (PC)

Prérequis : Node.js ≥ 22, Python ≥ 3.12 (pour le service vocal), un serveur Minecraft Fabric 1.21.

```bash
npm install
cp .env.example .env        # puis remplir (voir Configuration)
npm run typecheck && npm test
npm run dev                 # lance le bot
```

Service vocal en local (facultatif) :

```bash
cd voice && pip install -r requirements.txt
python -m minecraftia_voice.server          # écoute sur ws://localhost:8800 (VOICE_URL)
```

Au premier lancement, le modèle d'embeddings multilingue (~130 Mo) est téléchargé dans
`data/models/`, et le modèle Whisper dans le cache du service vocal.

### Production (VPS)

```bash
bash scripts/deploy.sh      # envoie le code et la config des mods, reconstruit et relance bot + voix
```

Le script copie `deploy/docker-compose.yml` dans `/opt/minecraft/` et la configuration des mods
Easy LLM dans le dossier `config` du serveur. Les secrets restent dans `/opt/minecraftia/.env`
sur le VPS (jamais dans le dépôt). Journaux : `docker logs -f minecraftia`.

**Mods côté joueur** : installer **Simple Voice Chat** (Fabric 1.21) dans son client pour parler au bot
et l'entendre ; rien d'autre n'est nécessaire.

## Configuration

Tout passe par `.env` (modèle : [.env.example](.env.example)). Un fichier `config/minecraftia.json`
facultatif peut ajuster les réglages fins (seuils des réflexes, délais…), **sans aucun secret**.

| Variable | Défaut | Rôle |
|---|---|---|
| `MC_HOST`, `MC_PORT` | `localhost`, `25565` | serveur Minecraft |
| `MC_USERNAME` | `Minecraftia` | pseudo du bot (serveur en `online-mode=false`) |
| `FOLLOW_PLAYER` | — (obligatoire) | joueur que le bot suit et dont il apprend |
| `STRATEGY` | `mirror` | `mirror` : devenir comme le joueur ; `complement` : point d'extension, refusé au démarrage |
| `OPENROUTER_API_KEY` | — | clé OpenRouter ; sans clé, le bot suit et survit sans décideur |
| `OPENROUTER_MODEL_FAST` | `anthropic/claude-haiku-4.5` | décisions courantes, classification |
| `OPENROUTER_MODEL_STRONG` | `anthropic/claude-sonnet-5.5` | après 3 échecs dans une même situation, ou pour composer |
| `DAILY_BUDGET_USD` | `1.00` | budget quotidien ; au-delà, arrêt propre (suivi + réflexes) |
| `TELEMETRY_PORT` | `7891` | serveur WebSocket où se connecte le mod Easy LLM |
| `VOICE_URL` | `ws://voice:8800` | service vocal ; vide = pas de voix |
| `VOICE_LINK_PORT` | `8765` | où se connecte le mod Easy LLM Voice |
| `LOG_LEVEL` | `info` | niveau des journaux (les secrets y sont toujours masqués) |
| `DATA_DIR` | `data` | base SQLite et modèles |

Service vocal : `WHISPER_MODEL` (`small`), `WHISPER_THREADS` (`4`), `TTS_ENGINE` (`edge`),
`EDGE_VOICE` (`fr-FR-HenriNeural`).

## Commandes en jeu

À écrire dans le chat par le joueur suivi :

| Commande | Réponse |
|---|---|
| `!arbre` | spécialité qui émerge (poids par domaine) et situations les plus apprises, avec la façon de faire retenue (ou corrigée) |
| `!autonomie` | confiance par domaine : pourcentage et bande (observe, imite, propose, agit seul) |
| `!pourquoi` | dernière décision : intention, justification, modèle ou cache, comportements appris utilisés |
| `!oublie <chose>` | met de côté ce qui ressemble à la description (situations et façons de faire) |
| `!budget` | appels au modèle, tokens et coût du jour par rapport au budget |
| `!aide` | rappel des commandes |

Phrases comprises (chat ou voix) : « regarde, je fais comme ça » (enseignement), « non, pas comme ça »,
« arrête » (correction), « bien joué », « parfait » (approbation), « construis un mur », « coupe du bois »
(ordres), « non, construis plutôt en bois » (correction + ordre). Les phrases ambiguës sont tranchées
par le petit modèle.

## Coûts

Mesuré en production : ≈ 1 300 tokens en entrée et 220 en sortie par décision, **≈ 0,0025 $** avec
Haiku 4.5. Aucune décision n'est prise par tick : uniquement sur événement (épisode du joueur,
correction, ordre) ou initiative selon l'autonomie, avec un intervalle minimal de 5 s, un cache des
situations quasi identiques et aucun appel tant que rien n'est appris ou qu'un domaine est en observation.

`npm run sim:hour` rejoue une heure de jeu simulée (bâtisseur, combattant, mixte) à travers les vrais
modules : **0,15 à 0,23 $ par heure**, sous le budget quotidien par défaut (1 $). Ce critère est aussi
vérifié par les tests.

## Tests

```bash
npm test              # 190 tests Node (aucun appel réseau ni LLM réel : LLM simulé)
npm run test:voice    # tests Python du service vocal ; VOICE_REAL_TESTS=1 pour l'essai réel TTS → Whisper
npm run sim:hour      # une heure de jeu simulée et son coût
```

Critères couverts : test de **divergence** (deux bases vierges, un bâtisseur et un combattant simulés →
arbres et comportements nettement différents), **correction effective dès la décision suivante**
(y compris pour une habitude très renforcée), **réflexe qui interrompt une action dans le même tick
sans appel LLM**, **heure simulée sous le budget**, unitaires sur l'arbre, l'autonomie et le routage.

Essais réels : `scripts/test-player.ts` (joueur scripté « Testeur » : construire, fabriquer, combattre,
enseigner, parler) avec préparation par RCON, `scripts/tree-query.ts` (inspecter l'arbre).

## Vérifier la voix en jeu

La chaîne vocale aval (paquets Opus de Simple Voice Chat → transcription → compréhension) est testée,
mais l'entrée réelle dépend du micro d'un joueur équipé du client Simple Voice Chat. Pour vérifier :

1. Rejoindre le serveur avec Simple Voice Chat installé, se placer à moins de 48 blocs du bot.
2. Dire : « regarde, je fais comme ça ».
3. Sur le VPS : `docker logs --since 1m minecraftia | grep voix` doit montrer
   `voix entendue : « regarde, je fais comme ça »` puis `retour du joueur … "label":"teaching"`.
4. Le bot répond « Je regarde ! » dans le chat et, si sa voix fonctionne, à l'oral.

## Mods tiers

Easy LLM et Easy LLM Voice (auteur : Kou_AIandHuman, licence « tous droits réservés », usage privé)
sont isolés derrière deux interfaces (`EasyLlmTelemetry` / `HeardAudioExtractor` et `VoiceLink`) :
un mod maison pourrait les remplacer sans toucher au reste.
