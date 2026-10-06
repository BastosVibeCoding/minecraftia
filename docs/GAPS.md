# Manques traités

Relevés avec `bash scripts/gaps-check.sh` (table `skill_gaps` de chaque bot).

| Date | Bot | Manque | Traitement |
|---|---|---|---|
| 2026-10-04 | Léa | « arrête-toi », « viens ici », « arrête de creuser » (3×) | Ordres de rappel exécutés par le code (arrêt + suivi), sans modèle : `isRecallOrder` dans `src/decider/loop.ts` |
| 2026-10-04 | joueurs | portes non ouvertes, difficultés dans l'eau | `src/bot/movements.ts` : ouverture des portes en bois, coût de l'eau relevé à 4 |
| 2026-10-04 | Alex | « donne ton bois » (2×) | Nouvelle compétence `give {item, count?}` : rejoint le joueur et lui lance les objets (nom exact ou famille, ex. « log ») |
| 2026-10-06 | évolution 6 | mémoire des consignes | « retiens que… », « à l'avenir… », « je n'aime pas que tu… », « ne … plus jamais », « mets toujours… » : retenues en base (20 max), données au modèle à chaque décision (prioritaires sur les habitudes), clé du cache incluse ; `!consignes`, `!oublie consigne <n>` |
| 2026-10-06 | évolution 4 | aide à la construction | `extend_wall` (prolonger le mur que le joueur vient de construire, même bloc et hauteur, longueur ou « jusqu'ici ») ; `copy_build` (reproduire à côté ce qu'il vient de construire) ; `bring` (apporter des objets : coffres, sinon fabriqués, puis donnés) ; pose contre n'importe quelle face voisine ; sur ordre seulement ; verbes prolonge, continue, copie, refais |
| 2026-10-06 | évolution 3 | agriculture | `harvest_crops` : récolte seulement les cultures mûres (blé, carottes, pommes de terre, betteraves), ramasse, replante sur la terre labourée ; une récolte « collect » de cultures est redirigée vers elle |
| 2026-10-06 | évolution 2 | fonte automatique | `smeltFor` : lingots, verre, pierre, charbon de bois, viandes cuites… obtenus en faisant cuire ce qu'il faut (sur soi ou dans les coffres) ; utilisé par la fabrication et par la recherche d'outil (pioche en fer avec seulement du fer brut) |
| 2026-10-06 | Léa, Alex | JSON dans le chat (`[ { "response": … } ]`) ; décision rejetée (explore radius > 64) | plainReply extrait la phrase de toute forme JSON (liste, objet imbriqué) ; paramètre numérique hors bornes ramené à la borne au lieu d'un nouvel appel. Configurations des mods vérifiées : valides |
| 2026-10-05 | joueurs | que font les bots quand les humains se déconnectent ? | Son joueur absent 1 min : rentrer à la maison et ranger, puis se déconnecter ; déconnexion garantie à 5 min même si le retour échoue ; au démarrage, connexion seulement si son joueur est là ; reconnexion quand il revient (ping de la liste des joueurs). Chaque bot ne suit que son joueur |
| 2026-10-05 | joueurs | le mot « maison » dans le chat ou à la voix déplaçait la maison | Désignation stricte : « ici c'est la maison », « c'est ici chez nous », « la maison est ici », « voici notre maison » (pas de question, pas de négation) |
| 2026-10-05 | Alex | coffre à panneau « nourriture » : objets d'autres familles laissés dedans | Un coffre à panneau ne garde que sa famille : sans coffre de leur famille, les intrus vont au « divers », sinon au coffre sans panneau le plus libre |
| 2026-10-05 | Alex | steaks pas rangés dans le coffre à panneau « nourriture » | Deux coffres « nourriture » (un deviné, un à panneau) : une famille marquée par un panneau n'est plus le rôle d'un coffre sans panneau (rôle retenu compris), qui prend sa famille suivante ; chair putréfiée, œil d'araignée → butin |
| 2026-10-05 | Alex, Léa | tri : objets pris puis gardés, « Tri fini : 0 objets déplacés » | Coffre ouvert : l'inventaire du bot ne suit qu'à la fermeture ; les retraits sont comptés dans la fenêtre du coffre (`window.count`), aussi pour la reprise dans les coffres ; message honnête quand rien n'a bougé |
| 2026-10-05 | Léa | « fabrique des vitres » (3×), « donne-moi une table de craft » → ingrédients manquants | craft : recette la plus proche de l'inventaire, ingrédients pris dans les coffres, planches et bâtons faits au besoin, établi fabriqué et posé si nécessaire, sinon le bot dit ce qui manque |
| 2026-10-05 | Léa | « t'es où ? » | Position, distance au joueur et à la maison. « range l'item que je vais te donner », « il y a d'autres coffres » : intentions futures ou remarques, ignorées |
| 2026-10-05 | Alex | tri : 278 objets retirés, aucun déposé, gardés sur lui | Pause de 400 ms entre deux coffres, erreurs d'ouverture et de dépôt enregistrées dans le résultat, objets non déposés remis dans leur coffre d'origine |
| 2026-10-05 | Alex, Léa | reprise annoncée ratée alors que l'objet était arrivé ; « prends toute la nourriture » ; « donne-moi tes glass » planté | Retrait compté sur l'inventaire réel ; familles dans retrieve (food, ores, wood, seeds) ; give saute un objet introuvable |
| 2026-10-05 | Alex, Léa | « t'as combien de cuivre », « tu lis quoi sur le panneau », « combien de pancartes », « t'as trouvé des trucs ? » | Questions cuivre, panneaux (lecture et compte, sans « ? »), avancement |
| 2026-10-05 | Léa | « casse les escaliers en bois (wooden_stairs) » → blocs inconnus ; « va explorer » → No path | Familles par dernier mot (stairs) ; casser sur ordre un type de bloc de construction nommé (seulement lui) ; exploration retentée dans 3 directions |
| 2026-10-05 | joueurs | « le tri ne marche pas très bien » | Rôles des coffres mémorisés d'un tri à l'autre (ils changeaient à chaque tri) ; retrait vérifié dans l'inventaire (un retrait raté faisait déposer la pioche du bot) ; résumé dit à la fin ; familles « verre » et « construction » ; questions : graines, betteraves, « c'est écrit quoi sur la pancarte ? » ; test anti-caractères de contrôle |
| 2026-10-05 | joueurs | « les bots peuvent trier les coffres ? » | Compétence `sort_chests` : rôle de chaque coffre = panneau posé dessus (bois, minerais, nourriture, divers…), sinon famille dominante, vide = divers ; objets déplacés vers le coffre de leur famille, sinon le divers ; coffres doubles comptés une fois ; verbe « trie » |
| 2026-10-05 | Léa | trois coffres à la maison, elle ouvre le mauvais | Rangement : tour des coffres (8 max), chaque objet avec le même objet, sinon sa famille, sinon le coffre le plus libre, coffre plein → suivant ; reprendre cherche dans tous les coffres ; bug du compte après dépôt corrigé |
| 2026-10-05 | joueurs | la maison | `HomeStore` : « ici c'est la maison » / `!maison` (persistée), maison devinée (lit, coffres, établi parmi les blocs posés) proposée puis confirmée par oui/non ; `go_home` par étapes ; rangement dans les coffres de la maison ; repli vers la maison quand la vie est basse (≤ 96 blocs) ; zone protégée `BOT_HOME_RADIUS` (24) ; exploration et recherche à ≤ 128 blocs ; le soir, quand le joueur est rentré, retour et sommeil |
| 2026-10-05 | Léa | « tue les vaches / les cochons » → aucune cible | L'attaque part chercher la cible (étapes de 30 blocs), sinon « Je ne trouve pas de vache dans le coin. » ; délai 2 min |
| 2026-10-05 | Alex | « mets les bûches dans le coffre » → aucun coffre à portée | Coffre cherché à 32 blocs (au lieu de 16) |
| 2026-10-05 | Alex | « dors » → il fait jour, sans le dire | Tout ordre raté est expliqué au joueur (« Je n'y arrive pas : … »), sauf si la compétence l'a déjà dit. « tape un villageois » : ignoré volontairement |
| 2026-10-05 | Alex | hache en fer fabriquée (3 lingots) pour couper du bois | Choix du joueur : le fer est permis, mais un outil tout fait dans les coffres proches est pris avant de fabriquer (ordre : inventaire → coffre → fabrication → matériaux des coffres → demande) |
| 2026-10-05 | Léa | « fais cuire le sable » → destination full (3×) | Four vidé avant usage : sortie récupérée, entrée étrangère retirée, combustible déjà en place conservé |
| 2026-10-05 | Léa | « tape les mobs » | Verbe « tape » |
| 2026-10-05 | joueurs | ressource hors de portée : la tâche n'est pas faite | Rien en vue → endroits mémorisés (`ResourceMemory`, migration 4 : récoltes des joueurs et du bot), puis recherche par étapes de 30 blocs (150 blocs max), sinon retour vers le joueur et « Je n'ai pas trouvé de … dans le coin, tu peux me montrer où ? » |
| 2026-10-05 | joueurs | sable récolté sous l'eau, le bot s'est noyé | Récolte : bloc à l'air libre d'abord, bloc touchant l'eau seulement s'il n'y a rien d'autre (`isUnderWater`) |
| 2026-10-05 | joueurs | latence : réponses lentes | Gemini saturé (7–20 s par décision depuis ~2 h) : chaque fournisseur sauf le dernier de la chaîne a 4,5 s pour répondre, sinon relais au suivant et pause de 2 min |
| 2026-10-05 | Léa | « Léa ? » | Appelée par son seul nom : répond « Oui ? » |
| 2026-10-05 | Léa | « t'as fini ? » (2×) | Question d'avancement : action en cours, sinon résultat de la dernière |
| 2026-10-05 | Léa | « clique sur le lit », « t'as le sable ? » | Verbe « clique » ; questions : sable, gravier, terre, verre, argile. Seau de lave, dropper : ignorés volontairement |
| 2026-10-05 | joueurs | les bots cassent les vitres posées | mineflayer-pvp imposait ses réglages (creuser partout) pendant et après chaque combat : pvp reçoit nos réglages protégés sans creuser, réglages remis après l'attaque, garde toutes les 2 s qui rétablit nos réglages si un module les remplace |
| 2026-10-05 | joueurs | chat : `{ "response": … }` et « Je te suis ! » en boucle | Réponse extraite du JSON (`plainReply`) ; plus de phrase pour un simple suivi, sauf en réponse à un ordre |
| 2026-10-05 | Léa | « t'as mangé ? » | Questions d'état : faim, vie, « ça va ? » (vie et faim réelles). Seaux, redstone tenus par le joueur : ignorés volontairement |
| 2026-10-05 | joueurs | les bots voient les monstres à travers les murs | `canSee` (rayon yeux → tête/pieds, arrêté par les blocs opaques ; verre, feuilles, barreaux, clôtures laissent voir ; contact à 1,5 bloc) appliqué aux réflexes, à la fuite, aux cibles d'attaque et au monde décrit au modèle |
| 2026-10-05 | Léa | « tue les poules » → aucune cible | Attaque : recherche à 32 blocs (au lieu de 16) et enchaînement des cibles jusqu'à 8. Seau de lave tenu par le joueur : ignoré volontairement |
| 2026-10-05 | Léa | « reprends tes affaires au sol » | Compétence `pickup {radius?}` : marche sur chaque objet tombé, du plus proche au plus loin ; verbe « reprends ». « fish of the chicken » : transcription ratée, ignoré |
| 2026-10-05 | Alex | « Léa, donne ton fer » exécuté par Alex | `BOT_PEERS` : phrase adressée à l'autre bot ignorée (sauf si le bot est aussi appelé par son nom) |
| 2026-10-05 | Léa | « va mettre le fer au four » → pas de combustible ; « Léa prend le charbon » incompris | Four : combustible et objet à cuire pris dans les coffres proches, sinon demande au joueur ; verbe « prend » |
| 2026-10-05 | Alex | « attaque Léa » | Ignoré volontairement : les bots n'attaquent ni les joueurs ni l'autre bot |
| 2026-10-05 | Alex | « récupère le fer dans les trois fours » → le four est vide (2×) | `furnace_take` passe par tous les fours à portée (24 blocs), pas seulement le plus proche |
| 2026-10-05 | joueurs | « donne » devrait viser le dernier objet évoqué | « donne », « donne-le », « donne-les-moi » → dernier objet évoqué (question, ordre) ou récolté, le plus récent ; « donne tout » reste tout |
| 2026-10-05 | Alex | non relevés : « donne » (pas de all), « récolte le fer dans le four et mets-le dans le coffre » (pas de raw_iron, 2×) | Le registre ignorait les échecs « précondition » : désormais relevés pour tout ordre. `give all` (tout sauf équipement/nourriture), compétence `furnace_take`, ordres en plusieurs étapes (`splitOrder` : « et/puis » + verbe) exécutés à la suite avec le résultat précédent en contexte |
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

Règle : déployer (bots seulement) au-delà de 5 éléments, ou tout de suite si un joueur tape `!deploy` dans le chat. Dernier déploiement : `88f8bfb` (2026-10-05, sur `!deploy`).

1. JSON : réponses en liste nettoyées, paramètres ramenés aux bornes
2. Fonte automatique
3. Agriculture (récolte des mûres et replantation)
4. Aide à la construction (prolonger, copier, apporter)
5. Mémoire des consignes
