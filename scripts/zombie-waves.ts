/**
 * Défense du château : des vagues de zombies de plus en plus fortes attaquent le château ; les joueurs
 * défendent le Roi (un villageois immobile, étiqueté « roi »). Barre « Vague » (zombies restants),
 * barre « Vie du Roi », tableau des zombies tués. La partie s'arrête quand le Roi meurt.
 * Les sapeurs (zombies à pioche) creusent les murs de pierre ; les creepers marchent jusqu'aux murs et les font sauter.
 * Réapparition des joueurs après 5 secondes (spectateur, puis retour dans la cour).
 * Nouvelle partie (vague 1) : château remis à neuf, inventaires et scores remis à zéro, nouveau Roi.
 * Passifs (vie, force, armure…) achetés au Maître des passifs, gardés jusqu'à la mort du Roi.
 * Tourelles à poser où l'on veut ; réparation et améliorations du château ; boss uniques (pillards, Roi des zombies,
 * Wither à la vague 20, puis mode Infini) ; tourelles de quatre types améliorables ; le Roi parle ; marché noir ;
 * événements aléatoires (orage, brouillard, météores, ruée) ; flèche vers les derniers monstres.
 * Rôles choisis en début de partie (Chevalier, Archer, Ingénieur, Soigneur, Mage, Invocateur) chez le Maître des rôles (changement
 * de classe ensuite pour 50 émeraudes, niveau gardé) ; ils montent
 * de niveau avec les victimes et ont une capacité spéciale par vague (objet à utiliser d'un clic droit).
 * Hall d'avant-partie : choix de la carte (classique, désert, neige, Nether) et de la difficulté (Facile à Cauchemar).
 * Nouveaux monstres (Breeze, Bogged, sorcière, blaze, squelette wither, brute, zoglin, Illusionniste, Warden, shulkers),
 * monstres d'élite, Bélier, tour de siège, assaut par le nord, nuit de sang.
 * Les joueurs lancent chaque vague en marchant sur la plaque dorée de la cour.
 * Prestige permanent (+1 émeraude par monstre par niveau) chez le Maître du prestige ; victimes des tourelles
 * comptées pour leur poseur (une émeraude toutes les deux).
 * Chaque niveau de passif coûte plus cher que le précédent ; passifs, Bénédiction du Roi et tourelles s'achètent
 * au catalogue personnel (livre et /trigger boutique), dans le chat, tous en même temps. Aucun remboursement en émeraudes (les réductions des villageois permettaient d'en fabriquer).
 * Tourelles avec une vie (abîmées par les monstres au contact, détruites à 0), réparables au parchemin.
 * Rôles jusqu'au niveau 20 (chaque niveau demande plus de victimes) et arbre de compétences par classe (/trigger arbre).
 * Joueurs à terre (un allié accroupi les relève), ultimes (accroupi + clic droit, jauge de victimes), roulette de
 * l'Enchanteur, jetons de gloire des élites et des boss échangés contre des objets uniques.
 * Barres de vie au-dessus des monstres ; cœurs des joueurs sous leur pseudo. Équipement des joueurs incassable. Pièces : une émeraude par monstre tué, 5 par vague repoussée ; boutique : le marchand à côté du Roi.
 * Tout passe par RCON (aucun bot dans la partie).
 * À lancer avec `docker run --restart unless-stopped` : après la mort du Roi, le script s'arrête et une nouvelle partie démarre.
 * Usage : node dist/scripts/zombie-waves.js [hôte RCON] [secondes avant la 1re vague] [numéro de la 1re vague, « 1r » pour reprendre
 *   sans le hall, « 7c » pour reprendre la vague 7 déjà en cours] [difficulté : 1 normal, 2 dur…]
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { Rcon } from './rcon.js';

const [rconHost = 'localhost', firstDelay = '60', resumeWave = '1', power = '1'] = process.argv.slice(2);
/** Marque laissée dans le conteneur après une défaite : au redémarrage, nouvelle partie depuis la vague 1. */
const GAME_OVER_MARK = '/tmp/partie-finie';
/** « 1r » : reprise à la vague 1 d'une partie déjà lancée (sans repasser par le hall). */
const resuming = resumeWave.endsWith('r') && !existsSync(GAME_OVER_MARK);
/** « 7c » : la vague 7 est déjà en cours (ses monstres sont là) : on la reprend sans rien faire apparaître. */
const continuing = resumeWave.endsWith('c') && !existsSync(GAME_OVER_MARK);
const firstWave = existsSync(GAME_OVER_MARK) ? '1' : String(Number.parseInt(resumeWave, 10));
rmSync(GAME_OVER_MARK, { force: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Points d'apparition hors des murs, surtout côté porte (sud, z positif), sol à y = -60. */
const SPAWNS: [number, number][] = [
  [-30, 50], [0, 55], [30, 50], [-50, 30], [50, 30], [-45, -10], [45, -10], [0, -45],
];
/** Points d'apparition au nord, derrière le château (une vague sur trois attaque par là). */
const NORTH_SPAWNS: [number, number][] = [[-30, -50], [0, -55], [30, -50], [-50, -30], [50, -30]];
/** Préfixe des étiquettes de ce lancement du script (les numéros ne se mélangent pas avec ceux d'un lancement précédent). */
const RUN = Date.now().toString(36);
const KING = '@e[tag=roi,limit=1]';
/** Équipement incassable et réparé : seulement les objets qui ont une durabilité (flèches et blocs intacts). */
const UNBREAKABLE =
  '{"function":"minecraft:filtered","item_filter":{"predicates":{"minecraft:damage":{}}},' +
  '"modifier":{"function":"minecraft:set_components","components":{"minecraft:unbreakable":{},"minecraft:damage":0}}}';
const SLOTS = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet', 'weapon.offhand', ...Array.from({ length: 9 }, (_, i) => `hotbar.${i}`), ...Array.from({ length: 27 }, (_, i) => `inventory.${i}`)];
/** Pause minimale après une vague, avant que la plaque puisse lancer la suivante. */
const PAUSE_S = 5;
/** Plaque dorée de la cour : les joueurs lancent eux-mêmes la vague suivante en marchant dessus. */
const WAVE_START = '3 -60 9';
/** Attente avant de revenir en jeu après une mort. */
const RESPAWN_S = 5;

/** Nombre extrait d'une réponse « Test passed, count: N » ou « …: 87.5f » ; 0 si absent. */
function number(reply: string): number {
  const m = /(?:count: |data: )(-?[0-9.]+)/.exec(reply);
  return m ? Number(m[1]) : 0;
}

/**
 * Commande d'apparition du monstre `i` de la vague `n` : zombies de plus en plus solides, zombies géants
 * (assez petits pour passer la porte) dès la vague 2, vindicateurs dès la 3, un ravageur dès la 6,
 * et un boss géant (trop grand pour la porte : à abattre depuis les remparts) toutes les 5 vagues.
 */
/** Thème de la vague : toutes les 4 vagues des araignées (elles escaladent), toutes les 7 des squelettes archers. */
function waveTheme(n: number): 'normale' | 'araignées' | 'squelettes' {
  return n % 7 === 0 ? 'squelettes' : n % 4 === 0 ? 'araignées' : 'normale';
}

/** Monstres d'élite : un pouvoir, affiché devant leur nom dans sa couleur. */
const ELITES = [
  { key: 'blinde', label: 'Blindé', color: 'gray' },
  { key: 'enrage', label: 'Enragé', color: 'red' },
  { key: 'regen', label: 'Régénérant', color: 'light_purple' },
  { key: 'explosif', label: 'Explosif', color: 'gold' },
  { key: 'diviseur', label: 'Diviseur', color: 'dark_green' },
  { key: 'etendard', label: 'Porte-étendard', color: 'yellow' },
];
/** Nouveaux monstres à la place de zombies ordinaires : [vague effective minimale, tous les combien, rang, type]. */
const EXTRA_MOBS: [number, number, number, string][] = [
  [3, 8, 6, 'breeze'], [4, 9, 7, 'witch'], [4, 7, 3, 'bogged'], [6, 10, 8, 'blaze'],
  [7, 11, 9, 'wither_skeleton'], [8, 12, 10, 'piglin_brute'], [8, 13, 11, 'zoglin'], [9, 14, 12, 'illusioner'],
];

function mobCommand(
  n: number, i: number, x: number, z: number, p: number, id: string, bloodNight: boolean,
): { command: string; name: string; health: number; color: string; elite?: string } {
  const theme = waveTheme(n);
  // e : vague « effective », plus avancée quand la partie est plus dure
  const e = n + (p - 1);
  const boss = n % (p > 1 ? 3 : 5) === 0 && i === 0;
  const giants = p > 1 ? Math.floor((n * p) / 2) : n >= 2 ? Math.floor(n / 2) : 0;
  const giant = !boss && i >= 1 && i <= giants;
  const ravager = n >= (p > 1 ? 3 : 6) && i === giants + 1;
  const vindicator = !giant && !ravager && n >= (p > 1 ? 2 : 3) && i % 5 === 4;
  // creepers : ils font sauter les murs (chargés quand la partie avance)
  const creeper = !giant && !ravager && !vindicator && !boss && e >= 3 && i % 6 === 5;
  let type = creeper ? 'creeper' : ravager ? 'ravager' : vindicator ? 'vindicator' : e >= 5 && i % 3 === 1 && !giant ? 'husk' : 'zombie';
  // vagues à thème : les zombies (hors boss) deviennent araignées ou squelettes archers
  if (!boss && theme !== 'normale' && (type === 'zombie' || type === 'husk')) {
    type = theme === 'araignées' ? (i % 4 === 3 && !giant ? 'cave_spider' : 'spider') : i % 3 === 1 ? 'stray' : 'skeleton';
  }
  // nouveaux monstres, de plus en plus nombreux, à la place de zombies ordinaires
  if (!boss && !giant && theme === 'normale' && (type === 'zombie' || type === 'husk')) {
    const extra = EXTRA_MOBS.find(([min, every, rank]) => e >= min && i % every === rank);
    if (extra) type = extra[3];
  }
  const zombieLike = type === 'zombie' || type === 'husk';
  const archer = type === 'skeleton' || type === 'stray' || type === 'bogged';
  // sapeurs : un zombie sur quatre creuse les murs de pierre (voir la boucle principale)
  const sapper = zombieLike && !boss && !giant && i % 4 === 2;
  const charged = creeper && e >= 6 && i % 12 === 11 ? 'powered:1b,' : '';
  const baby = zombieLike && !boss && !giant && e >= 4 && i % 4 === 3 ? 'IsBaby:1b,' : '';
  // nuit de sang : +50 % de vie
  const health = Math.round((boss ? 100 + 15 * n : giant ? 36 + 6 * n : ravager ? 70 + 6 * n : 18 + 3 * n) * (bloodNight ? 1.5 : 1));
  const elite = !boss && type !== 'creeper' && Math.random() < Math.min(0.3, 0.08 + 0.01 * n) ? ELITES[Math.floor(Math.random() * ELITES.length)] : undefined;
  const metal = e >= 9 ? 'iron' : e >= 5 ? 'chainmail' : 'leather';
  const armor = (zombieLike || archer) && e >= 2 ? `ArmorItems:[{id:"minecraft:${metal}_boots",count:1},{},{id:"minecraft:${metal}_chestplate",count:1},{id:"minecraft:${metal}_helmet",count:1,components:{"minecraft:unbreakable":{}}}],` : '';
  const weapon = type === 'wither_skeleton' ? 'HandItems:[{id:"minecraft:stone_sword",count:1},{}],' : archer ? 'HandItems:[{id:"minecraft:bow",count:1},{}],' : vindicator ? 'HandItems:[{id:"minecraft:iron_axe",count:1},{}],' : sapper ? 'HandItems:[{id:"minecraft:iron_pickaxe",count:1},{}],' : zombieLike && e >= 5 ? `HandItems:[{id:"minecraft:${e >= 9 ? 'iron' : 'stone'}_sword",count:1},{}],` : '';
  const scale = boss ? 4 : giant ? (p > 1 && i % 2 === 0 ? 2.8 : 1.9) : 0;
  const baseName = boss ? 'Zombie Géant' : giant ? (archer ? 'Archer géant' : type === 'spider' ? 'Araignée géante' : 'Géant') : ravager ? 'Bélier' : '';
  const name = elite ? (baseName ? `${baseName} ${elite.label.toLowerCase()}` : elite.label) : baseName;
  const nameColor = elite?.color ?? 'white';
  const attrs = [
    scale ? `{id:"minecraft:generic.scale",base:${scale}}` : '',
    `{id:"minecraft:generic.max_health",base:${health}}`,
    '{id:"minecraft:generic.follow_range",base:64}',
    elite?.key === 'blinde' ? '{id:"minecraft:generic.armor",base:16},{id:"minecraft:generic.armor_toughness",base:8}' : '',
    giant || boss ? `{id:"minecraft:generic.attack_damage",base:${(boss ? 6 : 4) + Math.floor(n / 3)}}` : zombieLike ? `{id:"minecraft:generic.attack_damage",base:${3 + Math.floor(n / 4)}}` : '',
    zombieLike ? `{id:"minecraft:generic.movement_speed",base:${(giant || boss ? 0.2 : 0.23 + 0.006 * e).toFixed(3)}}` : '',
  ].filter(Boolean);
  const command =
    `summon minecraft:${type} ${x} -60 ${z} {Tags:["vague","${id}"${sapper ? ',"sapeur"' : ''}${ravager ? ',"belier"' : ''}${elite ? `,"elite_${elite.key}"` : ''}],` +
    `PersistenceRequired:1b,${type === 'piglin_brute' ? 'IsImmuneToZombification:1b,' : ''}${baby}${charged}` +
    `CustomName:'${healthBar(name, health, health, nameColor)}',CustomNameVisible:1b,${armor}${weapon}` +
    `ArmorDropChances:[0f,0f,0f,0f],HandDropChances:[0f,0f],Health:${health}f,attributes:[${attrs.join(',')}]}`;
  return { command, name, health, color: nameColor, ...(elite ? { elite: elite.key } : {}) };
}

/** Nom affiché au-dessus d'un monstre : son nom éventuel et une barre de vie (verte, jaune, rouge). */
function healthBar(name: string, hp: number, max: number, nameColor = 'white'): string {
  const filled = Math.max(0, Math.min(10, Math.ceil((hp / max) * 10)));
  const color = filled > 6 ? 'green' : filled > 3 ? 'yellow' : 'red';
  const parts = [
    ...(name ? [`{"text":"${name} ","color":"${nameColor}"}`] : []),
    `{"text":"${'█'.repeat(filled)}","color":"${color}"}`,
    `{"text":"${'█'.repeat(10 - filled)}","color":"dark_gray"}`,
  ];
  return `[${parts.join(',')}]`;
}

/** Butin du coffre qui apparaît toutes les 5 vagues (4 objets tirés au hasard). */
const LOOT = [
  'elytra', 'totem_of_undying', 'ender_pearl 8', 'golden_apple 5', 'enchanted_golden_apple',
  'trident[enchantments={levels:{"minecraft:loyalty":3,"minecraft:impaling":3}}]',
  'enchanted_book[stored_enchantments={levels:{"minecraft:sharpness":5}}]',
  'enchanted_book[stored_enchantments={levels:{"minecraft:protection":4}}]',
  'diamond_chestplate[enchantments={levels:{"minecraft:protection":4}}]',
  'crossbow[enchantments={levels:{"minecraft:piercing":4,"minecraft:quick_charge":3}}]',
  'splash_potion[potion_contents={potion:"minecraft:strong_healing"}]',
  'emerald 20',
  'firework_rocket 32',
];

/**
 * Rôles choisis en début de partie (ticket échangé chez le Maître des rôles), gardés jusqu'à la fin de la partie.
 * `bonus` s'ajoute aux passifs (même attribut) ; `kit` est donné au choix du rôle.
 */
interface Role {
  id: number;
  key: string;
  name: string;
  color: string;
  bonus: Record<string, number>;
  /** Bonus ajouté à chaque niveau du rôle (voir roleLevelFor : chaque niveau demande plus de victimes). */
  perLevel: Record<string, number>;
  kit: string[];
  /** Capacité spéciale, une fois par vague (objet à utiliser d'un clic droit). */
  ability: string;
}
const ROLES: Role[] = [
  {
    id: 1, key: 'chevalier', name: '⚔ Chevalier', color: 'red',
    bonus: { 'generic.max_health': 8, 'generic.armor': 4, 'generic.knockback_resistance': 0.3 },
    perLevel: { 'generic.max_health': 1, 'generic.armor': 0.5 },
    ability: 'Cri de guerre',
    kit: ['diamond_sword[enchantments={levels:{"minecraft:sharpness":3}},unbreakable={}]'],
  },
  {
    id: 2, key: 'archer', name: '🏹 Archer', color: 'green',
    bonus: { 'generic.movement_speed': 0.015, 'generic.jump_strength': 0.1 },
    perLevel: { 'generic.max_health': 1, 'generic.movement_speed': 0.0015, 'generic.jump_strength': 0.01 },
    ability: 'Pluie de flèches',
    kit: ['bow[enchantments={levels:{"minecraft:power":5,"minecraft:flame":1,"minecraft:punch":1,"minecraft:infinity":1}},unbreakable={}]', 'spectral_arrow 64'],
  },
  {
    id: 3, key: 'ingenieur', name: '🔧 Ingénieur', color: 'aqua',
    bonus: {},
    perLevel: { 'generic.max_health': 1 },
    ability: 'Réparation',
    kit: ['cobblestone 64', 'cobblestone 64'],
  },
  {
    id: 4, key: 'soigneur', name: '✚ Soigneur', color: 'light_purple',
    bonus: {},
    perLevel: { 'generic.max_health': 1 },
    ability: 'Soin de groupe',
    kit: ['splash_potion[potion_contents={potion:"minecraft:strong_healing"}]', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}]',
      'splash_potion[potion_contents={potion:"minecraft:strong_healing"}]', 'splash_potion[potion_contents={potion:"minecraft:strong_healing"}]'],
  },
  {
    id: 5, key: 'mage', name: '✦ Mage', color: 'dark_aqua',
    bonus: {},
    perLevel: { 'generic.max_health': 1 },
    ability: 'Tempête de foudre',
    kit: ['wind_charge 64', 'splash_potion[potion_contents={potion:"minecraft:strong_slowness"}]', 'splash_potion[potion_contents={potion:"minecraft:strong_slowness"}]'],
  },
  {
    id: 6, key: 'invocateur', name: '🐺 Invocateur', color: 'gold',
    bonus: {},
    perLevel: { 'generic.max_health': 1 },
    ability: 'Appel de la meute',
    kit: ['cooked_beef 32', 'bone 16'],
  },
];
/** Loups de l'Invocateur : 2, plus un tous les 2 niveaux de rôle ; renforts de la capacité pendant 30 s. */
const PET_BASE = 2;
const PET_CALL = 3;
const PET_CALL_S = 30;
/**
 * Arbre de compétences de chaque classe : 3 branches de 3 compétences (coût 1, 2, 3 points). Chaque niveau de rôle
 * donne un point ; une compétence demande la précédente de sa branche. Les compétences apprises sont gardées dans le
 * score « arbre_acquis » (un bit par compétence : branche × 3 + rang), remis à zéro à chaque changement de classe et partie.
 */
interface Skill {
  key: string;
  label: string;
  /** Bonus d'attributs (s'ajoutent aux passifs et au rôle) ; sans bonus, l'effet est appliqué ailleurs dans le script. */
  attr?: Record<string, number>;
}
const SURVIVAL: Skill[] = [
  { key: 'armure', label: 'Armure (+2)', attr: { 'generic.armor': 2 } },
  { key: 'vigueur', label: 'Vigueur (+3 cœurs)', attr: { 'generic.max_health': 6 } },
  { key: 'celerite', label: 'Célérité (+10 % vitesse)', attr: { 'generic.movement_speed': 0.01 } },
];
const TREES: Record<string, { branches: [string, string, string]; skills: [Skill[], Skill[], Skill[]] }> = {
  chevalier: {
    branches: ['Défense', 'Attaque', 'Commandement'],
    skills: [
      [{ key: 'peau', label: 'Peau dure (+2 armure)', attr: { 'generic.armor': 2 } }, { key: 'rempart', label: 'Rempart (+4 cœurs)', attr: { 'generic.max_health': 8 } },
        { key: 'roc', label: 'Inébranlable (recul −50 %, robustesse +4)', attr: { 'generic.knockback_resistance': 0.5, 'generic.armor_toughness': 4 } }],
      [{ key: 'lame', label: 'Lame affûtée (+2 dégâts)', attr: { 'generic.attack_damage': 2 } }, { key: 'furie', label: 'Furie (+10 % vitesse)', attr: { 'generic.movement_speed': 0.01 } },
        { key: 'massacre', label: 'Massacre (+3 dégâts)', attr: { 'generic.attack_damage': 3 } }],
      [{ key: 'cri', label: 'Cri prolongé (20 s)' }, { key: 'regen_cri', label: 'Cri revigorant (régénération)' }, { key: 'aura', label: 'Aura de courage (résistance aux alliés)' }],
    ],
  },
  archer: {
    branches: ['Agilité', 'Tir', 'Survie'],
    skills: [
      [{ key: 'vif', label: 'Pas léger (+10 % vitesse)', attr: { 'generic.movement_speed': 0.01 } }, { key: 'bond', label: 'Bond (saut plus haut)', attr: { 'generic.jump_strength': 0.15 } },
        { key: 'plume', label: 'Plume (pas de dégâts de chute)', attr: { 'generic.safe_fall_distance': 40 } }],
      [{ key: 'carquois', label: 'Carquois (32 flèches par vague)' }, { key: 'faucon', label: 'Œil de faucon (monstres visibles)' }, { key: 'deluge', label: 'Déluge (Pluie de flèches ×2)' }],
      [SURVIVAL[0]!, SURVIVAL[1]!, { key: 'esquive', label: 'Esquive (résistance permanente)' }],
    ],
  },
  ingenieur: {
    branches: ['Tourelles', 'Construction', 'Survie'],
    skills: [
      [{ key: 'economie', label: 'Économie (tourelles −25 %)' }, { key: 'calibre', label: 'Gros calibre (tourelles +25 % dégâts)' }, { key: 'blindage', label: 'Blindage (tourelles +50 % vie)' }],
      [{ key: 'macon', label: 'Maçon (64 pierres par vague)' }, { key: 'entretien', label: 'Entretien (tourelles réparées à chaque vague)' }, { key: 'double', label: 'Maître d’œuvre (capacité 2 fois par vague)' }],
      [SURVIVAL[0]!, SURVIVAL[1]!, { key: 'robuste', label: 'Robuste (recul −30 %)', attr: { 'generic.knockback_resistance': 0.3 } }],
    ],
  },
  soigneur: {
    branches: ['Aura', 'Soin', 'Survie'],
    skills: [
      [{ key: 'aura_large', label: 'Aura étendue (+3 blocs)' }, { key: 'aura_forte', label: 'Aura puissante (régénération II)' }, { key: 'aura_roi', label: 'Bénédiction (soigne le Roi de partout)' }],
      [{ key: 'apothicaire', label: 'Apothicaire (2 potions par vague)' }, { key: 'soin_total', label: 'Soin total (4 cœurs bonus)' }, { key: 'double', label: 'Second souffle (capacité 2 fois par vague)' }],
      SURVIVAL,
    ],
  },
  mage: {
    branches: ['Foudre', 'Vent', 'Survie'],
    skills: [
      [{ key: 'chaine', label: 'Chaîne d’éclairs (10 cibles)' }, { key: 'surcharge', label: 'Surcharge (+8 dégâts)' }, { key: 'portee', label: 'Portée (36 blocs)' }],
      [{ key: 'reserve', label: 'Réserve (32 charges de vent par vague)' }, { key: 'givre', label: 'Givre (aura de lenteur)' }, { key: 'double', label: 'Archimage (capacité 2 fois par vague)' }],
      SURVIVAL,
    ],
  },
  invocateur: {
    branches: ['Meute', 'Crocs', 'Survie'],
    skills: [
      [{ key: 'meute', label: 'Meute (+1 loup)' }, { key: 'grande_meute', label: 'Grande meute (+1 loup)' }, { key: 'alpha', label: 'Alpha (Appel +3 loups)' }],
      [{ key: 'crocs', label: 'Crocs (loups +3 dégâts)' }, { key: 'pelage', label: 'Pelage épais (loups +20 vie)' }, { key: 'lien', label: 'Lien vital (loups régénérés)' }],
      SURVIVAL,
    ],
  },
};
/** Compétences apprises (masque du score « arbre ») et points dépensés. */
const learnedSkills = (role: string | undefined, mask: number): Skill[] =>
  role && TREES[role] ? TREES[role]!.skills.flatMap((branch, b) => branch.filter((_, t) => (mask >> (b * 3 + t)) & 1)) : [];
const spentPoints = (mask: number) => [0, 1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, bit) => sum + ((mask >> bit) & 1) * ((bit % 3) + 1), 0);
/** Attributs qui ne sont pas des passifs, avec leur valeur de base (pour les bonus de l'arbre). */
const EXTRA_ATTRIBUTES: [string, number][] = [['generic.armor_toughness', 0], ['generic.safe_fall_distance', 3]];
/** Points d'expérience pour remplir la barre au niveau L. */
const xpForLevel = (level: number) => (level <= 15 ? 2 * level + 7 : level <= 30 ? 5 * level - 38 : 9 * level - 158);

/** Prix d'un changement de classe chez le Maître des rôles (le niveau du rôle, lié aux victimes, est gardé). */
const ROLE_CHANGE_PRICE = 50;
/** Victimes par niveau de rôle, et niveau maximal. */
/** Victimes cumulées pour atteindre le niveau L : L × (L + 6) (7 pour le niveau 1, puis 9, 11, 13… de plus ; 520 au niveau 20). */
const killsForRoleLevel = (level: number) => level * (level + 6);
/** Niveau de rôle atteint avec `kills` victimes. */
const roleLevelFor = (kills: number) => {
  let level = 0;
  while (level < ROLE_MAX_LEVEL && killsForRoleLevel(level + 1) <= kills) level++;
  return level;
};
const ROLE_MAX_LEVEL = 20;
/** Objet de capacité (canne à carotte : son utilisation est comptée par une statistique du jeu). */
const abilityItem = (r: Role) =>
  `carrot_on_a_stick[custom_data={capacite:1b},unbreakable={},custom_name='{"text":"${r.ability} (clic droit)","color":"${r.color}","italic":false}']`;
/** Commande d'apparition d'un loup de l'Invocateur, plus solide et plus fort à chaque niveau de rôle (valeurs tenues à jour ensuite). */
const petCommand = (name: string, uuid: string, hp: number, damage: number, tags: string[]) => {
  return (
    `execute at ${name} run summon minecraft:wolf ~1 ~ ~1 {Owner:${uuid},Tags:[${tags.map((t) => `"${t}"`).join(',')}],PersistenceRequired:1b,` +
    `CustomName:'{"text":"Loup de ${name}","color":"gold"}',Health:${hp}f,attributes:[{id:"minecraft:generic.max_health",base:${hp}},` +
    `{id:"minecraft:generic.attack_damage",base:${damage}},{id:"minecraft:generic.movement_speed",base:0.35}]}`
  );
};
/** Ticket de rôle, donné à chaque joueur en début de partie ; c'est la monnaie du Maître des rôles. */
const ROLE_TICKET = '{id:"minecraft:paper",count:1,components:{"minecraft:custom_data":{ticket:"role"},"minecraft:custom_name":\'{"text":"Ticket de rôle","color":"gold","italic":false}\',"minecraft:enchantment_glint_override":1b}}';
const ROLE_TICKET_ITEM = 'paper[custom_data={ticket:"role"},custom_name=\'{"text":"Ticket de rôle","color":"gold","italic":false}\',enchantment_glint_override=true]';

/** Répliques du Roi dans le chat, selon ce qui se passe. */
const KING_LINES = {
  vague: ['Défendez-moi, mes braves !', 'Ils arrivent… courage !', 'Encore eux ?! Repoussez-les !', 'Pour le royaume !', 'Tenez les murs, j’ai confiance en vous !'],
  boss: ['Par ma couronne, quel monstre !', 'Ce colosse va écraser mon château !', 'Visez la tête, mes chevaliers !'],
  blesse: ['Aïe ! Ils me grignotent !', 'Hé ! Quelqu’un pourrait m’aider ?', 'Ma couronne est toute cabossée…'],
  danger: ['Au secours ! Je ne tiendrai pas longtemps !', 'Ils sont dans la salle du trône !'],
  critique: ['À l’aide ! Je vais tomber !!', 'Mes chevaliers… je vous en supplie…'],
  victoire: ['Bravo mes chevaliers !', 'Victoire ! Mais restez sur vos gardes.', 'Magnifique ! Le royaume vous remercie.', 'Ha ! Ils ont pris la fuite !'],
  marche: ['Hmm, ce marchand masqué ne m’inspire pas confiance… mais ses prix…', 'Un marchand masqué dans la cour ? Faites vite, il ne restera pas.'],
  infini: ['Vous êtes des légendes ! Mais ils ne s’arrêteront jamais…', 'Plus de boss final… seulement l’infini. Tenez bon !'],
  mort: ['Je… vous… ai… aimés…', 'Mon royaume… est… tombé…'],
};
const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)]!;

/** Marché noir : objets rares à prix fort, chez un marchand masqué qui apparaît pendant certaines pauses. */
const BLACK_MARKET: { price: number; item: string; components?: string }[] = [
  { price: 35, item: 'elytra' },
  { price: 30, item: 'totem_of_undying' },
  { price: 45, item: 'netherite_chestplate', components: '"minecraft:enchantments":{levels:{"minecraft:protection":3}}' },
  { price: 30, item: 'netherite_helmet', components: '"minecraft:enchantments":{levels:{"minecraft:protection":3}}' },
  { price: 35, item: 'trident', components: '"minecraft:enchantments":{levels:{"minecraft:loyalty":3,"minecraft:impaling":5}}' },
  { price: 40, item: 'mace', components: '"minecraft:enchantments":{levels:{"minecraft:density":5,"minecraft:wind_burst":2}}' },
  { price: 30, item: 'enchanted_golden_apple' },
];
/** Chance qu'un marchand masqué apparaisse pendant une pause. */
const BLACK_MARKET_CHANCE = 0.35;

/**
 * Catalogue personnel : un livre dont le bouton lance `/trigger boutique` ; la boutique du joueur (passifs, Bénédiction
 * du Roi, tourelles, à ses niveaux et à ses prix) s'affiche alors dans son chat, une ligne cliquable par article
 * (`/trigger achat set <numéro>`). Tout le monde peut acheter en même temps, n'importe où.
 */
const CATALOGUE_BOOK =
  `written_book[custom_data={catalogue:1b},written_book_content={title:"Catalogue",author:"Le Roi",pages:['[{"text":"Catalogue\\\\n\\\\n","bold":true,"color":"dark_purple"},` +
  `{"text":"[ Ouvrir ma boutique ]","color":"dark_green","bold":true,"clickEvent":{"action":"run_command","value":"/trigger boutique"}},` +
  `{"text":"\\\\n\\\\n[ Mon arbre de compétences ]","color":"dark_aqua","bold":true,"clickEvent":{"action":"run_command","value":"/trigger arbre"}},` +
  `{"text":"\\\\n\\\\n[ ★ Prestige ]","color":"gold","bold":true,"clickEvent":{"action":"run_command","value":"/trigger prestige"}},` +
  `{"text":"\\\\n\\\\nPassifs et tourelles, à vos niveaux et à vos prix. Aussi : /trigger boutique, /trigger arbre, /trigger prestige.","color":"black","bold":false}]']}]`;
/** Numéros d'achat du catalogue : passifs (1 à 20), Bénédiction du Roi (50), tourelles (60 et plus). */
const BUY_BLESSING = 50;
const BUY_TURRET = 60;
/** Roulette de l'Enchanteur (catalogue) et objets uniques échangés contre des jetons de gloire. */
const BUY_ROULETTE = 70;
const BUY_UNIQUE = 80;
const ROULETTE_PRICE = 15;
/** Enchantements de la roulette selon l'objet tenu : [enchantement, niveau maximal normal]. */
const ROULETTE: { match: RegExp; enchants: [string, number][] }[] = [
  { match: /_sword$|_axe$/, enchants: [['sharpness', 5], ['smite', 5], ['fire_aspect', 2], ['looting', 3], ['knockback', 2], ['sweeping_edge', 3]] },
  { match: /^bow$/, enchants: [['power', 5], ['flame', 1], ['punch', 2], ['infinity', 1]] },
  { match: /^crossbow$/, enchants: [['quick_charge', 3], ['multishot', 1], ['piercing', 4]] },
  { match: /_helmet$|_chestplate$|_leggings$|_boots$/, enchants: [['protection', 4], ['projectile_protection', 4], ['blast_protection', 4], ['thorns', 3]] },
  { match: /^trident$/, enchants: [['impaling', 5], ['loyalty', 3], ['channeling', 1]] },
  { match: /^mace$/, enchants: [['density', 5], ['breach', 4], ['wind_burst', 3]] },
];
/** Jeton de gloire : lâché par les élites (1) et les boss (3), échangé contre des objets uniques. */
const TOKEN_ITEM = 'echo_shard[custom_data={jeton:1b},custom_name=\'{"text":"Jeton de gloire","color":"aqua","italic":false}\',enchantment_glint_override=true]';
const TOKEN_NBT = '{id:"minecraft:echo_shard",count:COUNT,components:{"minecraft:custom_data":{jeton:1b},"minecraft:custom_name":\'{"text":"Jeton de gloire","color":"aqua","italic":false}\',"minecraft:enchantment_glint_override":1b}}';
const UNIQUES: { name: string; cost: number; item: string }[] = [
  { name: 'Excalibur', cost: 5, item: 'netherite_sword[enchantments={levels:{"minecraft:sharpness":8,"minecraft:fire_aspect":3,"minecraft:looting":3,"minecraft:sweeping_edge":3}},unbreakable={},custom_name=\'{"text":"Excalibur","color":"gold","italic":false}\']' },
  { name: 'Arc du Roi', cost: 5, item: 'bow[enchantments={levels:{"minecraft:power":8,"minecraft:flame":1,"minecraft:infinity":1,"minecraft:punch":2}},unbreakable={},custom_name=\'{"text":"Arc du Roi","color":"gold","italic":false}\']' },
  { name: 'Bottes d’Hermès', cost: 4, item: 'netherite_boots[enchantments={levels:{"minecraft:protection":5,"minecraft:feather_falling":6}},unbreakable={},attribute_modifiers={modifiers:[{type:"minecraft:generic.movement_speed",id:"minecraft:hermes",amount:0.04,operation:"add_value",slot:"feet"},{type:"minecraft:generic.armor",id:"minecraft:hermes_armure",amount:3,operation:"add_value",slot:"feet"}]},custom_name=\'{"text":"Bottes d’Hermès","color":"gold","italic":false}\']' },
  { name: 'Totem d’immortalité', cost: 3, item: 'totem_of_undying' },
];
/** À terre : seuil de vie, durée, et temps (en passages d'une seconde) pour être relevé par un allié accroupi. */
const DOWNED_HP = 6;
const DOWNED_S = 20;
const REVIVE_TICKS = 3;
/** Ultime : victimes pour le charger. */
const ULT_COST = 25;

/** Équipement de départ, redonné à chaque nouvelle partie. */
const KIT = [
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'iron_sword[enchantments={levels:{"minecraft:sharpness":2}}]',
  'bow[enchantments={levels:{"minecraft:power":2,"minecraft:infinity":1}}]',
  'arrow 64', 'shield', 'flint_and_steel', 'cooked_beef 32', 'cobblestone 64',
  CATALOGUE_BOOK,
];
/**
 * Cartes : même plan de château, style et décor différents. Le modèle intact de chaque carte est à `dx` blocs à l'est ;
 * il est recopié sur l'arène à chaque nouvelle partie. `wall` : matériau des murs (sapeurs, murs renforcés) ;
 * `ground` : sol (douves) ; `wallBlock` et `merlon` : blocs des tours d'archers.
 */
interface GameMap {
  key: string;
  name: string;
  color: string;
  dx: number;
  wall: string;
  ground: string;
  wallBlock: string;
  merlon: string;
}
const MAPS: GameMap[] = [
  { key: 'classique', name: 'Château classique', color: 'green', dx: 1000, wall: '#minecraft:stone_bricks', ground: 'minecraft:grass_block', wallBlock: 'stone_bricks', merlon: 'stone_brick_wall' },
  { key: 'desert', name: 'Forteresse du désert', color: 'yellow', dx: 2000, wall: 'minecraft:cut_sandstone', ground: 'minecraft:sand', wallBlock: 'cut_sandstone', merlon: 'sandstone_wall' },
  { key: 'neige', name: 'Citadelle des neiges', color: 'aqua', dx: 3000, wall: 'minecraft:polished_diorite', ground: 'minecraft:snow_block', wallBlock: 'polished_diorite', merlon: 'diorite_wall' },
  { key: 'nether', name: 'Bastion du Nether', color: 'red', dx: 4000, wall: 'minecraft:polished_blackstone_bricks', ground: 'minecraft:netherrack', wallBlock: 'polished_blackstone_bricks', merlon: 'polished_blackstone_brick_wall' },
];
/** Difficultés : multiplicateur du nombre de monstres, difficulté du jeu, vie de base du Roi. */
interface Difficulty {
  key: string;
  name: string;
  color: string;
  power: number;
  mc: 'normal' | 'hard';
  kingHp: number;
}
const DIFFICULTIES: Difficulty[] = [
  { key: 'facile', name: 'Facile', color: 'green', power: 1.5, mc: 'normal', kingHp: 200 },
  { key: 'normal', name: 'Normal', color: 'yellow', power: 2.5, mc: 'normal', kingHp: 150 },
  { key: 'difficile', name: 'Difficile', color: 'red', power: 3.5, mc: 'hard', kingHp: 150 },
  { key: 'cauchemar', name: 'Cauchemar', color: 'dark_purple', power: 5, mc: 'hard', kingHp: 100 },
];
/** Carte et difficulté de la partie en cours (choisies dans le hall, gardées dans le score « partie »). */
const game = { map: MAPS[0]!, difficulty: DIFFICULTIES[1]! };
/** Demi-largeur de l'arène recopiée depuis le modèle (château, abords, points d'apparition). */
const ARENA = 60;
/**
 * Hall d'avant-partie : un levier par carte (rangée z = -303) et par difficulté (rangée z = -299), aux x ci-dessous,
 * posés sur des socles (levier à y = -59) ; plaque « Lancer la partie » en (0, -60, -297).
 */
const LOBBY_SPAWN = '0.5 -60 -301.5';
const LOBBY_LEVER_X = [-6, -2, 2, 6];
const LOBBY_START = '0 -60 -297';

/** Recopie l'arène depuis un modèle (`masked` : seulement les blocs pleins, pour réparer sans effacer). */
async function copyArena(rcon: Rcon, dx: number, masked: boolean): Promise<void> {
  await rcon.run(`forceload add ${dx - ARENA} ${-ARENA} ${dx + ARENA} ${ARENA}`);
  await rcon.run(`forceload add ${-ARENA} ${-ARENA} ${ARENA} ${ARENA}`);
  for (let x0 = -ARENA; x0 <= ARENA; x0 += 11) {
    const x1 = Math.min(ARENA, x0 + 10);
    await rcon.run(`clone ${x0 + dx} -62 ${-ARENA} ${x1 + dx} -43 ${ARENA} ${x0} -62 ${-ARENA}${masked ? ' masked' : ''}`);
  }
  await rcon.run(`forceload remove ${dx - ARENA} ${-ARENA} ${dx + ARENA} ${ARENA}`);
  await rcon.run(`forceload remove ${-ARENA} ${-ARENA} ${ARENA} ${ARENA}`);
}

/**
 * Nouvelle partie : château remis à neuf (blocs posés retirés, brèches rebouchées, coffre rempli),
 * inventaires vidés puis kit de départ, scores à zéro, nouveau Roi, tout le monde dans la cour.
 */
async function newGame(rcon: Rcon): Promise<void> {
  await rcon.run('kill @e[tag=vague]');
  await rcon.run('kill @e[tag=roi]');
  await rcon.run('kill @e[type=minecraft:zombie_villager]');
  await copyArena(rcon, game.map.dx, false);
  await rcon.run('kill @e[type=minecraft:item]');
  await rcon.run('kill @e[type=minecraft:iron_golem]');
  await rcon.run('kill @e[type=minecraft:snow_golem]');
  await rcon.run('kill @e[tag=tourelle]');
  await rcon.run('kill @e[tag=marchenoir]');
  await rcon.run('kill @e[tag=pet]');
  // passifs remis à zéro : ils ne servent que pendant la partie en cours (Bénédiction du Roi comprise)
  for (const p of [...PASSIVES, BLESSING, REPAIR, ...UPGRADES]) await rcon.run(`scoreboard players reset * p_${p.key}`);
  await rcon.run(
    "summon minecraft:villager 0 -60 -3 {CustomName:'\"Le Roi\"',CustomNameVisible:1b,NoAI:1b,PersistenceRequired:1b,Tags:[\"roi\"],Glowing:1b," +
      'Rotation:[0f,0f],VillagerData:{profession:"minecraft:cleric",level:5,type:"minecraft:plains"},Health:150f,attributes:[{id:"minecraft:generic.max_health",base:150}]}',
  );
  // vie maximale du Roi selon la difficulté et la Bénédiction (remise à zéro juste avant)
  const blessing = Number(/has (-?\d+)/.exec(await rcon.run(`scoreboard players get #equipe p_${BLESSING.key}`))?.[1] ?? 0);
  await rcon.run(`attribute ${KING} minecraft:generic.max_health base set ${kingHealth(blessing)}`);
  await rcon.run(`data modify entity ${KING} Health set value ${kingHealth(blessing)}f`);
  await rcon.run('scoreboard players reset * tues');
  await rcon.run('scoreboard players reset * morts');
  await rcon.run('clear @a');
  await rcon.run('effect clear @a');
  await rcon.run('xp set @a 0 levels');
  await rcon.run('gamemode survival @a');
  await rcon.run('tp @a 0 -60 12');
  for (const item of KIT) await rcon.run(`give @a minecraft:${item}`);
  await rcon.run(`give @a minecraft:${ROLE_TICKET_ITEM}`);
  await rcon.run('scoreboard players reset * role');
  await rcon.run('scoreboard players reset * arbre_acquis');
  await rcon.run('scoreboard players reset * tourelles');
  // le prestige ne vaut que pour la partie en cours
  await rcon.run('scoreboard players reset * niv_prestige');
  await rcon.run('effect give @a minecraft:instant_health 1 5 true');
  await rcon.run('effect give @a minecraft:saturation 5 5 true');
}

/** Types de tourelles : étiquette, nom, couleur, prix, bloc en guise de tête. */
interface TurretKind {
  tag: string;
  name: string;
  color: string;
  price: number;
  head: string;
}
const TURRET_KINDS: TurretKind[] = [
  { tag: 'fleche', name: 'Tourelle', color: 'aqua', price: 12, head: 'dispenser' },
  { tag: 'glace', name: 'Tourelle de glace', color: 'blue', price: 14, head: 'blue_ice' },
  { tag: 'feu', name: 'Tourelle de feu', color: 'red', price: 14, head: 'magma_block' },
  { tag: 'canon', name: 'Canon', color: 'dark_gray', price: 18, head: 'tnt' },
];
/** Dégâts par type et par niveau (1 à 3). */
/** Niveau maximal d'une tourelle (étiquettes lvl2 à lvl5 ; sans étiquette : niveau 1). */
const TURRET_MAX_LEVEL = 5;
const TURRET_DAMAGE: Record<string, number[]> = { fleche: [5, 8, 12, 16, 21], glace: [3, 4, 6, 8, 10], feu: [4, 6, 9, 12, 15], canon: [4, 6, 9, 12, 15] };
/** Niveau d'une tourelle d'après ses étiquettes (réponse de `data get entity … Tags`). */
const turretLevel = (tags: string) => {
  for (let level = TURRET_MAX_LEVEL; level >= 2; level--) if (tags.includes(`"lvl${level}"`)) return level;
  return 1;
};
/** Sélecteur des tourelles qui peuvent encore monter de niveau. */
const NOT_MAX_TURRET = `tag=tourelle,tag=!lvl${TURRET_MAX_LEVEL}`;
/** Emplacements d'un support d'armure tous verrouillés : on ne peut rien lui prendre ni lui mettre. */
const LOCKED_SLOTS = 4144959;
const turretComponents = (k: TurretKind) =>
  `"minecraft:custom_name":'{"text":"${k.name}","color":"${k.color}","italic":false}',"minecraft:entity_data":{id:"minecraft:armor_stand",` +
  `Tags:["tourelle","${k.tag}"],Invulnerable:1b,NoBasePlate:1b,DisabledSlots:${LOCKED_SLOTS},CustomName:'"${k.name}"',CustomNameVisible:1b,` +
  `ArmorItems:[{},{},{},{id:"minecraft:${k.head}",count:1}]}`;
/** Sélecteur d'un type (les tourelles posées avant les types, étiquette « tourelle » seule, tirent des flèches). */
const kindSelector = (k: TurretKind) => (k.tag === 'fleche' ? 'tag=!glace,tag=!feu,tag=!canon' : `tag=${k.tag}`);
/** Tourelle sous la forme des arguments de /give (kit de l'ingénieur). */
const turretItemArgs = (k: TurretKind) =>
  `custom_name='{"text":"${k.name}","color":"${k.color}","italic":false}',entity_data={id:"minecraft:armor_stand",Tags:["tourelle","${k.tag}"],` +
  `Invulnerable:1b,NoBasePlate:1b,DisabledSlots:${LOCKED_SLOTS},CustomName:'"${k.name}"',CustomNameVisible:1b,ArmorItems:[{},{},{},{id:"minecraft:${k.head}",count:1}]}`;
const turretUpgradeItemArgs = () =>
  `custom_data={passif:"${TURRET_UPGRADE.key}"},custom_name='{"text":"${TURRET_UPGRADE.label}","color":"${TURRET_UPGRADE.color}","italic":false}',enchantment_glint_override=true`;
/** Vie des tourelles selon leur niveau, et dégâts par monstre au contact (à moins de 2 blocs) à chaque passage. */
const TURRET_HP = [40, 60, 80, 100, 130];
const TURRET_HIT = 3;
/** Vie regagnée par passage (toutes les 2 s) sans monstre au contact : 1 point toutes les 10 s. */
const TURRET_REGEN = 0.2;
/** Parchemin de réparation de tourelle : à garder sur soi en s'approchant d'une tourelle abîmée. */
const TURRET_REPAIR = { key: 'reparetourelle', label: 'Réparation de tourelle (approchez-vous d’une tourelle)', color: 'green' };
/** Parchemin d’amélioration de tourelle : à garder sur soi en s’approchant d’une tourelle (jusqu’au niveau 5). */
const TURRET_UPGRADE = { key: 'ameliotourelle', label: 'Amélioration de tourelle (approchez-vous d’une tourelle)', color: 'light_purple' };
const scrollComponents = (p: { key: string; label: string; color: string }) =>
  `"minecraft:custom_data":{passif:"${p.key}"},"minecraft:custom_name":'{"text":"${p.label}","color":"${p.color}","italic":false}',"minecraft:enchantment_glint_override":1b`;

/** Articles du marchand (prix en émeraudes) ; `components` au format NBT des objets. */
const SHOP: { price: number; item: string; count?: number; components?: string }[] = [
  { price: 1, item: 'flint_and_steel' },
  { price: 2, item: 'arrow', count: 32 },
  { price: 3, item: 'cooked_beef', count: 16 },
  { price: 4, item: 'golden_apple', count: 2 },
  { price: 4, item: 'shield', components: '"minecraft:enchantments":{levels:{"minecraft:unbreaking":3}}' },
  { price: 2, item: 'splash_potion', components: '"minecraft:potion_contents":{potion:"minecraft:strong_healing"}' },
  { price: 6, item: 'tnt', count: 8 },
  { price: 3, item: 'cobweb', count: 8 },
  { price: 5, item: 'lava_bucket' },
  { price: 8, item: 'snow_golem_spawn_egg' },
  { price: 2, item: 'firework_rocket', count: 16, components: '"minecraft:fireworks":{flight_duration:2b}' },
  // tourelles : vendues dans la boutique personnelle de chaque joueur (prix croissant avec ses tourelles)
  { price: 10, item: 'paper', components: scrollComponents(TURRET_UPGRADE) },
  { price: 6, item: 'paper', components: scrollComponents(TURRET_REPAIR) },
  { price: 8, item: 'diamond_boots', components: '"minecraft:enchantments":{levels:{"minecraft:protection":2}}' },
  { price: 10, item: 'diamond_helmet', components: '"minecraft:enchantments":{levels:{"minecraft:protection":2}}' },
  { price: 14, item: 'diamond_leggings', components: '"minecraft:enchantments":{levels:{"minecraft:protection":2}}' },
  { price: 16, item: 'diamond_chestplate', components: '"minecraft:enchantments":{levels:{"minecraft:protection":2}}' },
  { price: 12, item: 'bow', components: '"minecraft:enchantments":{levels:{"minecraft:power":4,"minecraft:punch":1,"minecraft:infinity":1}}' },
  { price: 10, item: 'crossbow', components: '"minecraft:enchantments":{levels:{"minecraft:multishot":1,"minecraft:quick_charge":2}}' },
  { price: 15, item: 'diamond_sword', components: '"minecraft:enchantments":{levels:{"minecraft:sharpness":3,"minecraft:sweeping_edge":2}}' },
  { price: 20, item: 'iron_golem_spawn_egg' },
  { price: 25, item: 'enchanted_golden_apple' },
  { price: 40, item: 'netherite_sword', components: '"minecraft:enchantments":{levels:{"minecraft:sharpness":5,"minecraft:fire_aspect":2,"minecraft:sweeping_edge":3}}' },
];

/**
 * Passifs permanents, vendus en parchemins par le Maître des passifs : un parchemin acheté est consommé
 * aussitôt et monte le niveau du passif (score `p_<clé>`), gardé jusqu'à la fin de la partie (mort du Roi).
 */
interface Passive {
  key: string;
  label: string;
  /** Nom court pour l'affichage permanent. */
  short: string;
  color: string;
  price: number;
  max: number;
  /** Attribut du joueur et sa valeur de base au niveau donné ; absent pour la fortune (émeraudes en plus). */
  attribute?: [string, (level: number) => number];
}
const PASSIVES: Passive[] = [
  { key: 'vie', short: '❤ Vie', label: '+1 cœur', color: 'red', price: 10, max: 10, attribute: ['generic.max_health', (l) => 20 + 2 * l] },
  { key: 'force', short: '⚔ Force', label: '+1 dégât', color: 'dark_red', price: 12, max: 5, attribute: ['generic.attack_damage', (l) => 1 + l] },
  { key: 'armure', short: 'Armure', label: '+1 point d’armure', color: 'gray', price: 10, max: 10, attribute: ['generic.armor', (l) => l] },
  { key: 'vitesse', short: 'Vitesse', label: '+6 % de vitesse', color: 'aqua', price: 8, max: 5, attribute: ['generic.movement_speed', (l) => 0.1 * (1 + 0.06 * l)] },
  { key: 'stabilite', short: 'Stabilité', label: '-10 % de recul', color: 'dark_green', price: 6, max: 5, attribute: ['generic.knockback_resistance', (l) => 0.1 * l] },
  { key: 'allonge', short: 'Allonge', label: '+0,5 bloc de portée', color: 'yellow', price: 8, max: 4, attribute: ['player.entity_interaction_range', (l) => 3 + 0.5 * l] },
  { key: 'saut', short: 'Saut', label: '+1/2 bloc de saut', color: 'white', price: 8, max: 3, attribute: ['generic.jump_strength', (l) => 0.42 + 0.1 * l] },
  { key: 'vol', short: 'Vol de vie', label: '+5 % de vol de vie', color: 'dark_purple', price: 15, max: 4 },
  { key: 'critique', short: 'Critique', label: '+10 % de coups critiques', color: 'gold', price: 12, max: 5 },
];

/**
 * Prestige : +1 émeraude par monstre tué de sa main, par niveau, jusqu'à la fin de la partie (score `prestige`, remis à
 * zéro à chaque nouvelle partie). Chaque étape coûte 100 émeraudes et fait repartir de zéro : inventaire vidé (kit de
 * départ redonné), passifs remis à 0, classe et arbre à rechoisir (ticket donné) ; la Bénédiction du Roi reste.
 */
const PRESTIGE_PRICES = [100, 100, 100, 100, 100];
/** Victimes des tourelles : une émeraude toutes les deux pour le poseur. */
const TURRET_KILLS_PER_EMERALD = 2;

/** Bénédiction du Roi : passif d'équipe (score de « #equipe »), +25 de vie maximale pour le Roi par niveau, jusqu'à la fin de la partie. */
const BLESSING: Passive = { key: 'roi', short: 'Roi', label: '+25 vie max du Roi', color: 'gold', price: 15, max: 10 };
const KING_BASE_HEALTH = 150;
const kingHealth = (level: number) => game.difficulty.kingHp + 25 * level;

/** Parchemin d'un passif (objet unique, reconnu par son étiquette `passif`). */
const scroll = (p: Passive) =>
  `{id:"minecraft:paper",count:1,components:{"minecraft:custom_data":{passif:"${p.key}"},` +
  `"minecraft:custom_name":'{"text":"Passif : ${p.label}","color":"${p.color}","italic":false}',"minecraft:enchantment_glint_override":1b}}`;
/** Prix du niveau `level` d'un passif : +50 % du prix de départ à chaque niveau. */
const passivePrice = (p: Passive, level: number) => Math.round(p.price * (1 + 0.5 * (level - 1)));
/** Parchemin d'un niveau précis d'un passif (valable seulement pour passer à ce niveau). */
const levelScroll = (p: Passive, level: number) =>
  `{id:"minecraft:paper",count:1,components:{"minecraft:custom_data":{passif:"${p.key}",niveau:${level}},` +
  `"minecraft:custom_name":'{"text":"${p.label} (niveau ${level}/${p.max})","color":"${p.color}","italic":false}',"minecraft:enchantment_glint_override":1b}}`;


/** Améliorations d'équipe, vendues en parchemins par les marchands, valables jusqu'à la fin de la partie. */
const REPAIR: Passive = { key: 'reparation', short: 'Réparation', label: 'Réparation des murs', color: 'green', price: 10, max: 99 };
const UPGRADES: Passive[] = [
  { key: 'murs', short: 'Murs renforcés', label: 'Murs renforcés (sapeurs et creepers moins efficaces)', color: 'dark_gray', price: 25, max: 1 },
  { key: 'douves', short: 'Douves', label: 'Douves autour du château', color: 'blue', price: 20, max: 1 },
  { key: 'tours', short: "Tours d’archers", label: "Deux tours d’archers dans la cour", color: 'gold', price: 20, max: 1 },
];

/** Effet d'une amélioration du château (réparation : recopie des murs et du sol intacts, sans effacer les blocs posés). */
async function applyUpgrade(rcon: Rcon, key: string): Promise<void> {
  await rcon.run('forceload add -32 -32 32 32');
  if (key === 'reparation') {
    await copyArena(rcon, game.map.dx, true);
    // sol compris (cratères rebouchés) ; les améliorations achetées sont ensuite remises (douves en eau, murs renforcés)
    for (const upgrade of ['murs', 'douves']) {
      if (Number(/has (-?\d+)/.exec(await rcon.run(`scoreboard players get #equipe p_${upgrade}`))?.[1] ?? 0) > 0) await applyUpgrade(rcon, upgrade);
    }
  } else if (key === 'murs') {
    for (const [x0, x1] of [[-24, -1], [0, 24]] as const) {
      await rcon.run(`fill ${x0} -61 -24 ${x1} -43 24 minecraft:deepslate_bricks replace ${game.map.wall}`);
    }
  } else if (key === 'douves') {
    for (const box of ['-26 -62 -26 26 -61 -23', '-26 -62 23 -3 -61 26', '3 -62 23 26 -61 26', '23 -62 -22 26 -61 22', '-26 -62 -22 -23 -61 22']) {
      await rcon.run(`fill ${box} minecraft:water replace #minecraft:dirt`);
      await rcon.run(`fill ${box} minecraft:water replace ${game.map.ground}`);
    }
  } else if (key === 'tours') {
    for (const cx of [-12, 12]) {
      const cz = 14;
      await rcon.run(`fill ${cx - 2} -60 ${cz - 2} ${cx + 2} -48 ${cz + 2} minecraft:${game.map.wallBlock} hollow`);
      await rcon.run(`fill ${cx - 2} -47 ${cz - 2} ${cx + 2} -47 ${cz + 2} minecraft:${game.map.merlon} hollow`);
      await rcon.run(`fill ${cx} -60 ${cz + 1} ${cx} -48 ${cz + 1} minecraft:ladder[facing=north]`);
      await rcon.run(`fill ${cx} -60 ${cz - 2} ${cx} -59 ${cz - 2} minecraft:air`);
      await rcon.run(`setblock ${cx} -46 ${cz} minecraft:lantern`);
    }
  }
  await rcon.run('forceload remove -32 -32 32 32');
}

/** Le marchand, à côté du trône du Roi (invincible), avec les articles de la boutique. */
async function setUpShop(rcon: Rcon): Promise<void> {
  // le prestige se passe avec /trigger prestige (plus de PNJ)
  await rcon.run('kill @e[tag=prestige]');
  // passifs et tourelles s'achètent au catalogue personnel (plus de PNJ par joueur)
  await rcon.run('kill @e[tag=passifs]');
  await rcon.run('kill @e[tag=marchand]');
  // deux marchands, de part et d'autre du trône, pour ne pas faire la queue
  for (const x of [2.5, -1.5]) {
    await rcon.run(
      `summon minecraft:villager ${x} -60 -2.5 {CustomName:'"Marchand"',CustomNameVisible:1b,` +
        'NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Silent:1b,' +
        'Tags:["marchand"],Rotation:[0f,0f],VillagerData:{profession:"minecraft:weaponsmith",level:5,type:"minecraft:plains"},Offers:{Recipes:[]}}',
    );
  }
  for (const a of [...SHOP, ...[REPAIR, ...UPGRADES].map((u) => ({ price: u.price, item: '', upgrade: u }))]) {
    const sell = 'upgrade' in a ? scroll(a.upgrade) : `{id:"minecraft:${a.item}",count:${a.count ?? 1}${a.components ? `,components:{${a.components}}` : ''}}`;
    await rcon.run(
      `execute as @e[tag=marchand] run data modify entity @s Offers.Recipes append value {buy:{id:"minecraft:emerald",count:${a.price}},sell:${sell},` +
        'maxUses:99999,rewardExp:0b,priceMultiplier:0f,demand:0,specialPrice:0,xp:0}',
    );
  }
}

/**
 * Hall d'avant-partie : tout le monde y est envoyé (mode aventure : leviers et plaques seulement), choisit la carte
 * et la difficulté avec les leviers, puis marche sur la plaque « Lancer la partie ».
 */
async function lobby(rcon: Rcon): Promise<void> {
  const powered = async (pos: string) => /passed/.test(await rcon.run(`execute if block ${pos} minecraft:lever[powered=true]`));
  const choice = async <T>(row: number, options: T[], fallback: T) => {
    for (const [i, x] of LOBBY_LEVER_X.entries()) if (await powered(`${x} -59 ${row}`)) return options[i] ?? fallback;
    return fallback;
  };
  await rcon.run('bossbar set minecraft:vague name {"text":"Hall : choisissez la carte et la difficulté, puis la plaque dorée","color":"gold"}');
  await rcon.run('bossbar set minecraft:vague value 0');
  // on arrive dans le hall les mains vides (le kit est donné au lancement de la partie)
  await rcon.run('clear @a');
  await rcon.run('effect clear @a');
  await rcon.run('xp set @a 0 levels');
  await rcon.run('xp set @a 0 points');
  for (;;) {
    // les arrivants (et ceux qui reviennent d'une partie) sont envoyés dans le hall
    await rcon.run(`execute as @a[gamemode=!adventure] run tp @s ${LOBBY_SPAWN}`);
    await rcon.run('gamemode adventure @a');
    await rcon.run(`spawnpoint @a ${LOBBY_SPAWN.split(' ').map((v) => Math.floor(Number(v))).join(' ')}`);
    await rcon.run('bossbar set minecraft:vague players @a');
    game.map = await choice(-303, MAPS, MAPS[0]!);
    game.difficulty = await choice(-299, DIFFICULTIES, DIFFICULTIES[1]!);
    await rcon.run(
      `title @a actionbar [{"text":"Carte : ","color":"gray"},{"text":"${game.map.name}","color":"${game.map.color}"},` +
        `{"text":"   Difficulté : ","color":"gray"},{"text":"${game.difficulty.name}","color":"${game.difficulty.color}"}]`,
    );
    if (/passed/.test(await rcon.run(`execute if block ${LOBBY_START} #minecraft:pressure_plates[powered=true]`))) break;
    await sleep(1000);
  }
  await rcon.run(`scoreboard players set #carte partie ${MAPS.indexOf(game.map)}`);
  await rcon.run(`scoreboard players set #difficulte partie ${DIFFICULTIES.indexOf(game.difficulty)}`);
  await rcon.run(`difficulty ${game.difficulty.mc}`);
  await rcon.run(`tellraw @a [{"text":"Partie lancée : ","color":"gold"},{"text":"${game.map.name}","color":"${game.map.color}"},{"text":" en ","color":"gold"},{"text":"${game.difficulty.name}","color":"${game.difficulty.color}"}]`);
  await rcon.run('spawnpoint @a 0 -60 12');
}

async function main(): Promise<void> {
  const password = process.env.RCON_PASSWORD;
  if (!password) throw new Error('RCON_PASSWORD absent');
  const rcon = new Rcon();
  await rcon.connect(rconHost, Number(process.env.RCON_PORT ?? 25575), password);
  /** Capacité spéciale d'un rôle. */
  const useAbility = async (r: Role, name: string) => {
    await rcon.run(`tellraw @a {"text":"${name} : ${r.ability} !","color":"${r.color}","bold":true}`);
    if (r.key === 'chevalier') {
      const duration = has(name, 'cri') ? 20 : 10;
      await rcon.run(`effect give @a minecraft:strength ${duration} 1 true`);
      await rcon.run(`effect give @a minecraft:resistance ${duration} 0 true`);
      if (has(name, 'regen_cri')) await rcon.run(`effect give @a minecraft:regeneration ${duration} 1 true`);
      await rcon.run(`execute at ${name} run playsound minecraft:event.raid.horn master @a ~ ~ ~ 4 1`);
      await rcon.run(`execute at ${name} run particle minecraft:angry_villager ~ ~2 ~ 1 0.5 1 0 20`);
    } else if (r.key === 'archer') {
      const zone = `execute at ${name} anchored eyes positioned ^ ^ ^15`;
      await rcon.run(`${zone} as @e[tag=vague,distance=..${has(name, 'deluge') ? 10 : 7}] run damage @s ${has(name, 'deluge') ? 20 : 10} minecraft:arrow by ${name}`);
      for (const [ox, oz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
        await rcon.run(`${zone} run summon minecraft:arrow ~${ox} ~12 ~${oz} {pickup:0b,Motion:[0.0,-2.0,0.0]}`);
      }
      await rcon.run(`execute at ${name} run playsound minecraft:entity.arrow.shoot master @a ~ ~ ~ 2 0.6`);
    } else if (r.key === 'ingenieur') {
      await applyUpgrade(rcon, 'reparation');
      for (const turret of turrets.values()) turret.hp = TURRET_HP[turret.level - 1]!;
      await rcon.run(`execute at ${name} run playsound minecraft:block.anvil.use master @a ~ ~ ~ 1 1`);
    } else if (r.key === 'invocateur') {
      const uuid = /(\[I; -?\d+, -?\d+, -?\d+, -?\d+\])/.exec(await rcon.run(`data get entity ${name} UUID`))?.[1];
      if (uuid) {
        const level = roleLevelFor(await score(name, 'tues'));
        const stats = petStats(name, level);
        for (let i = 0; i < PET_CALL + (has(name, 'alpha') ? 3 : 0); i++) await rcon.run(petCommand(name, uuid, stats.hp, stats.damage, ['pet', `renfort_${name}`]));
        await rcon.run(`execute at ${name} run playsound minecraft:entity.wolf.howl master @a ~ ~ ~ 2 1`);
        setTimeout(() => void rcon.run(`kill @e[tag=renfort_${name}]`), PET_CALL_S * 1000);
      }
    } else if (r.key === 'mage') {
      // foudre sur les 6 monstres les plus proches (24 blocs), dégâts comptés pour le Mage
      await rcon.run(`execute at ${name} run tag @e[tag=vague,distance=..${has(name, 'portee') ? 36 : 24},limit=${has(name, 'chaine') ? 10 : 6},sort=nearest] add foudre`);
      // effet visuel seulement : une vraie foudre transformerait le Roi (villageois) en sorcière et blesserait les joueurs
      await rcon.run('execute at @e[tag=foudre] run particle minecraft:flash ~ ~1 ~ 0 0 0 0 1');
      await rcon.run('execute at @e[tag=foudre] run particle minecraft:electric_spark ~ ~1 ~ 0.3 1 0.3 0.5 30');
      await rcon.run('execute at @e[tag=foudre] run playsound minecraft:entity.lightning_bolt.thunder master @a ~ ~ ~ 0.8 1.2');
      await rcon.run(`execute as @e[tag=foudre] run damage @s ${has(name, 'surcharge') ? 18 : 10} minecraft:lightning_bolt by ${name}`);
      await rcon.run('tag @e[tag=foudre] remove foudre');
    } else if (r.key === 'soigneur') {
      await rcon.run('effect give @a minecraft:instant_health 1 3 true');
      await rcon.run('effect give @a minecraft:regeneration 10 1 true');
      if (has(name, 'soin_total')) await rcon.run('effect give @a minecraft:absorption 30 1 true');
      await rcon.run(`effect give ${KING} minecraft:instant_health 1 3 true`);
      await rcon.run('execute at @a run particle minecraft:heart ~ ~2 ~ 0.5 0.5 0.5 0 6');
      await rcon.run(`execute at ${name} run playsound minecraft:block.beacon.power_select master @a ~ ~ ~ 1 1.4`);
    }
  };
  /** Ultime d'un rôle (accroupi + clic droit avec l'objet de capacité, jauge pleine). */
  const useUltimate = async (r: Role, name: string) => {
    await rcon.run(`title @a times 5 40 10`);
    await rcon.run(`title @a subtitle {"text":"${name} déclenche son ultime !","color":"${r.color}"}`);
    await rcon.run('title @a title {"text":"⚡"}');
    await rcon.run(`execute at ${name} run playsound minecraft:item.totem.use master @a ~ ~ ~ 1 1`);
    if (r.key === 'chevalier') {
      await rcon.run(`effect give ${name} minecraft:resistance 10 4 true`);
      await rcon.run(`effect give ${name} minecraft:strength 10 2 true`);
      await rcon.run(`effect give ${name} minecraft:speed 10 1 true`);
    } else if (r.key === 'archer') {
      await rcon.run(`execute at ${name} as @e[tag=vague,distance=..30] run damage @s 15 minecraft:arrow by ${name}`);
      await rcon.run(`execute at ${name} as @e[tag=vague,distance=..30] at @s run particle minecraft:crit ~ ~2 ~ 0.3 1 0.3 0.5 20`);
    } else if (r.key === 'ingenieur') {
      turretBoost.set(name, Date.now() + 15_000);
      for (const turret of turrets.values()) if (turret.owner === name) turret.hp = TURRET_HP[turret.level - 1]! * (has(name, 'blindage') ? 1.5 : 1);
    } else if (r.key === 'soigneur') {
      for (const who of downed.keys()) await revive(who, name);
      await rcon.run('effect give @a minecraft:instant_health 1 4 true');
      await rcon.run(`effect give ${KING} minecraft:instant_health 1 5 true`);
      await rcon.run('execute at @a run particle minecraft:totem_of_undying ~ ~1 ~ 0.5 1 0.5 0.3 30');
    } else if (r.key === 'mage') {
      await rcon.run('execute at @e[tag=vague] run particle minecraft:explosion_emitter ~ ~1 ~');
      await rcon.run(`execute as @e[tag=vague] run damage @s 20 minecraft:explosion by ${name}`);
    } else if (r.key === 'invocateur') {
      const uuid = /(\[I; -?\d+, -?\d+, -?\d+, -?\d+\])/.exec(await rcon.run(`data get entity ${name} UUID`))?.[1];
      if (uuid) {
        const stats = petStats(name, roleLevelFor(await score(name, 'tues')));
        for (let i = 0; i < 6; i++) await rcon.run(petCommand(name, uuid, stats.hp, stats.damage, ['pet', `renfort_${name}`]));
        setTimeout(() => void rcon.run(`kill @e[tag=renfort_${name}]`), PET_CALL_S * 1000);
      }
    }
  };
  /** Relève un joueur à terre. */
  const revive = async (who: string, by: string) => {
    downed.delete(who);
    await rcon.run(`effect clear ${who}`);
    await rcon.run(`effect give ${who} minecraft:instant_health 1 0 true`);
    await rcon.run(`tellraw @a {"text":"${by} relève ${who} !","color":"green"}`);
  };
  /** Attend qu'un joueur marche sur la plaque dorée (après `minSeconds`), en tenant la barre et la vie du Roi à jour. */
  const waitForStart = async (wave: number, minSeconds: number, color: string) => {
    await rcon.run(`execute if block ${WAVE_START} minecraft:air run setblock ${WAVE_START} minecraft:light_weighted_pressure_plate`);
    const since = Date.now();
    for (;;) {
      const ready = Date.now() - since >= minSeconds * 1000;
      await rcon.run(
        `bossbar set minecraft:vague name {"text":"${ready ? `Marchez sur la plaque dorée pour lancer la vague ${wave}` : `Vague ${wave} : pause…`}","color":"${color}"}`,
      );
      await rcon.run('bossbar set minecraft:vague players @a');
      await kingAlive();
      // plaque enfoncée : n'importe quelle puissance sauf 0 (les états n'acceptent pas d'intervalle)
      const pressed =
        ready &&
        /passed/.test(await rcon.run(`execute if block ${WAVE_START} minecraft:light_weighted_pressure_plate`)) &&
        /passed/.test(await rcon.run(`execute unless block ${WAVE_START} minecraft:light_weighted_pressure_plate[power=0]`));
      if (pressed) return;
      await sleep(1000);
    }
  };
  const kingSays = (line: string) => rcon.run(`tellraw @a [{"text":"<Le Roi> ","color":"gold"},{"text":"${line}","color":"yellow"}]`);
  const say = (title: string, subtitle = '') =>
    rcon.run(`title @a subtitle {"text":"${subtitle}","color":"gray"}`).then(() => rcon.run(`title @a title {"text":"${title}","color":"gold"}`));

  await rcon.run('bossbar add vague {"text":"Préparez-vous !","color":"red"}');
  await rcon.run('bossbar set minecraft:vague color red');
  await rcon.run('bossbar set minecraft:vague players @a');
  await rcon.run('bossbar add roi {"text":"Vie du Roi","color":"yellow"}');
  await rcon.run('bossbar set minecraft:roi color yellow');
  await rcon.run('bossbar set minecraft:roi players @a');
  await rcon.run('scoreboard objectives add tues minecraft.custom:minecraft.mob_kills "Zombies tués"');
  await rcon.run('scoreboard objectives setdisplay sidebar tues');
  // pas de messages de commandes dans le chat (les nôtres comme celles des admins)
  // pas de messages de commandes ; les monstres ne lâchent rien (ni objets ni expérience)
  for (const rule of ['logAdminCommands false', 'sendCommandFeedback false', 'commandBlockOutput false', 'doMobLoot false']) await rcon.run(`gamerule ${rule}`);
  await setUpShop(rcon);
  // les tourelles déjà posées (lancement précédent du script) seront reprises en main
  await rcon.run('tag @e[tag=tourelle] remove suivie');
  await rcon.run('scoreboard objectives add partie dummy');
  if (firstWave === '1' && !resuming && !continuing) {
    await lobby(rcon);
    await newGame(rcon);
  } else {
    // reprise en cours de partie : même carte et même difficulté ; qui était coincé en spectateur revient en jeu
    await rcon.run('tp @a[gamemode=spectator] 0 -60 12');
    await rcon.run('gamemode survival @a[gamemode=spectator]');
    const read = async (key: string) => Number(/has (-?\d+)/.exec(await rcon.run(`scoreboard players get #${key} partie`))?.[1] ?? -1);
    game.map = MAPS[await read('carte')] ?? MAPS[0]!;
    game.difficulty = DIFFICULTIES[await read('difficulte')] ?? DIFFICULTIES.find((d) => d.power === Number(power)) ?? DIFFICULTIES[1]!;
  }
  // vie des joueurs en cœurs, sous les pseudos et dans la liste (Tab)
  await rcon.run('scoreboard objectives add vie health {"text":"❤","color":"red"}');
  await rcon.run('scoreboard objectives setdisplay below_name vie');
  await rcon.run('scoreboard objectives setdisplay list vie');
  // équipe « château » : un monstre de l'équipe ignore les joueurs (alliés) et vise le Roi ; on peut toujours le frapper
  await rcon.run('team add chateau');
  await rcon.run('team modify chateau friendlyFire true');
  // vie maximale (et non la vie actuelle : le script peut reprendre en cours de partie)
  const maxReply = await rcon.run(`attribute ${KING} minecraft:generic.max_health get`);
  const kingMax = Number(/is (-?[0-9.]+)/.exec(maxReply)?.[1] ?? 100);
  await rcon.run(`bossbar set minecraft:roi max ${Math.round(kingMax)}`);

  /** Met à jour la vie du Roi ; `false` s'il est mort. */
  const kingAlive = async (): Promise<boolean> => {
    const reply = await rcon.run(`data get entity ${KING} Health`);
    if (!/data: /.test(reply)) return false;
    const max = Number(/is (-?[0-9.]+)/.exec(await rcon.run(`attribute ${KING} minecraft:generic.max_health get`))?.[1] ?? KING_BASE_HEALTH);
    await rcon.run(`bossbar set minecraft:roi max ${Math.round(max)}`);
    await rcon.run(`bossbar set minecraft:roi value ${Math.max(0, Math.round(number(reply)))}`);
    return true;
  };

  // réapparition après 5 secondes : spectateur avec compte à rebours, puis retour en survie dans la cour
  await rcon.run('gamerule doImmediateRespawn true');
  await rcon.run('scoreboard objectives add morts deathCount');
  for (const p of [...PASSIVES, BLESSING, REPAIR, ...UPGRADES]) await rcon.run(`scoreboard objectives add p_${p.key} dummy`);
  await rcon.run('scoreboard objectives add role dummy');
  await rcon.run('scoreboard objectives add arbre_acquis dummy');
  await rcon.run('scoreboard objectives add arbre trigger');
  await rcon.run('scoreboard objectives add competence trigger');
  await rcon.run('scoreboard objectives add accroupi minecraft.custom:minecraft.sneak_time');
  // le niveau de prestige est gardé dans « niv_prestige » ; « prestige » est la commande /trigger prestige
  // (recopie de l'ancien compteur, une seule fois : quand « niv_prestige » vient d'être créé, et pour les joueurs seulement)
  if (/Created/.test(await rcon.run('scoreboard objectives add niv_prestige dummy'))) {
    await rcon.run('execute as @a run scoreboard players operation @s niv_prestige = @s prestige');
    await rcon.run('scoreboard objectives remove prestige');
  }
  await rcon.run('scoreboard objectives add prestige trigger');
  await rcon.run('scoreboard objectives add boutique trigger');
  await rcon.run('scoreboard objectives add tourelles dummy');
  await rcon.run('scoreboard objectives add achat trigger');
  /** Victimes des tourelles en attente de paiement, par propriétaire, et reste (une émeraude toutes les deux). */
  const turretKills = new Map<string, number>();
  /** Tourelles suivies : numéro → propriétaire (le joueur qui l'a posée), vie, vie affichée. */
  const turrets = new Map<string, { owner: string | undefined; hp: number; shown: number; level: number }>();
  let nextTurret = 0;
  const turretBank = new Map<string, number>();
  await rcon.run('scoreboard objectives add capacite minecraft.used:minecraft.carrot_on_a_stick');
  /** Joueurs ayant déjà utilisé leur capacité pendant la vague en cours (vidé à chaque vague). */
  /** Utilisations de la capacité pendant la vague en cours, par joueur (vidé à chaque vague). */
  const abilityUsed = new Map<string, number>();
  /** Joueurs à terre : fin du délai et passages d'un allié accroupi à côté. */
  const downed = new Map<string, { until: number; revive: number }>();
  /** Temps accroupi au passage précédent (statistique), et qui s'est accroupi depuis. */
  const sneakTime = new Map<string, number>();
  const sneaking = new Set<string>();
  /** Charge de l'ultime (victimes depuis le dernier ultime), par joueur. */
  const ultCharge = new Map<string, number>();
  /** Surcharge de l'Ingénieur : ses tourelles font triple dégâts jusqu'à cette date. */
  const turretBoost = new Map<string, number>();
  /** Rôle et compétences apprises de chaque joueur (tenus à jour par la boucle des joueurs). */
  const skills = new Map<string, { role?: string; mask: number }>();
  const has = (name: string | undefined, key: string) =>
    !!name && learnedSkills(skills.get(name)?.role, skills.get(name)?.mask ?? 0).some((sk) => sk.key === key);
  /** Stats des loups d'un Invocateur selon son niveau et ses compétences. */
  const petStats = (name: string, level: number) => ({
    hp: 30 + 3 * level + (has(name, 'pelage') ? 20 : 0),
    damage: 4 + Math.floor(level / 2) + (has(name, 'crocs') ? 3 : 0),
  });
  /** Dernier niveau de rôle connu par joueur (annonce des montées de niveau). */
  const roleLevels = new Map<string, number>();
  /** Dernière progression montrée dans la barre d'expérience, par joueur. */
  const xpShown = new Map<string, string>();
  // dégâts infligés (en dixièmes de point de vie) : base du vol de vie et des coups critiques
  await rcon.run('scoreboard objectives add degats minecraft.custom:minecraft.damage_dealt');
  const dealt = new Map<string, number>();
  /** Monstres restants dans la vague (pour la flèche vers les derniers). */
  let remaining = 0;
  const stolen = new Map<string, number>();
  const waiting = new Set<string>();
  /** Monstres tués par joueur au dernier passage : chaque nouveau monstre tué rapporte une émeraude. */
  const kills = new Map<string, number>();
  const score = async (name: string, objective: string) =>
    Number(/has (-?\d+)/.exec(await rcon.run(`scoreboard players get ${name} ${objective}`))?.[1] ?? 0);
  /** Un passage à la fois : sinon les commandes s'accumulent dans la file RCON et tout prend du retard. */
  let busy = false;
  /** Compte à rebours de réapparition, à part pour ne pas retenir les autres joueurs ni le passage suivant. */
  const respawn = async (name: string) => {
    for (let s = RESPAWN_S; s > 0; s--) {
      await rcon.run(`title ${name} actionbar {"text":"Réapparition dans ${s} s","color":"red"}`);
      await sleep(1000);
    }
    await rcon.run(`tp ${name} 0 -60 12`);
    await rcon.run(`gamemode survival ${name}`);
    await rcon.run(`effect give ${name} minecraft:resistance 3 4 true`);
    waiting.delete(name);
  };
  setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
      const online = (await rcon.run('list')).split(':').slice(1).join(':').split(',').map((s) => s.trim()).filter(Boolean);
      // qui s'est accroupi depuis le passage précédent (temps accroupi en hausse)
      sneaking.clear();
      for (const name of online) {
        const t = await score(name, 'accroupi');
        if (t > (sneakTime.get(name) ?? t)) sneaking.add(name);
        sneakTime.set(name, t);
      }
      for (const name of online) {
        const k = await score(name, 'tues');
        const before = kills.get(name);
        kills.set(name, k);
        const levels = new Map<string, number>();
        for (const p of PASSIVES) levels.set(p.key, await score(name, `p_${p.key}`));
        levels.set('role', await score(name, 'role'));
        // pièces : victimes de sa main × (1 + prestige) ; victimes de ses tourelles, une émeraude toutes les deux
        const prestige = await score(name, 'niv_prestige');
        levels.set('prestige', prestige);
        if (before !== undefined && k > before) {
          ultCharge.set(name, Math.min(ULT_COST, (ultCharge.get(name) ?? 0) + (k - before)));
          const byTurret = Math.min(k - before, turretKills.get(name) ?? 0);
          turretKills.set(name, (turretKills.get(name) ?? 0) - byTurret);
          const bank = (turretBank.get(name) ?? 0) + byTurret;
          turretBank.set(name, bank % TURRET_KILLS_PER_EMERALD);
          const emeralds = (k - before - byTurret) * (1 + prestige) + Math.floor(bank / TURRET_KILLS_PER_EMERALD);
          if (emeralds > 0) await rcon.run(`give ${name} minecraft:emerald ${emeralds}`);
        }
        // /trigger prestige : 1 = voir son prestige et le prix, 2 = confirmer le passage au niveau suivant
        await rcon.run(`scoreboard players enable ${name} prestige`);
        const prestigeAsk = await score(name, 'prestige');
        if (prestigeAsk > 0) {
          await rcon.run(`scoreboard players set ${name} prestige 0`);
          const current = levels.get('prestige') ?? 0;
          const level = current + 1;
          const price = PRESTIGE_PRICES[current];
          if (price === undefined) {
            await rcon.run(`tellraw ${name} {"text":"Prestige ${current} : c’est le maximum.","color":"gold"}`);
          } else if (prestigeAsk === 1) {
            await rcon.run(`tellraw ${name} [{"text":"★ Prestige ${current} → ${level} : ","color":"gold","bold":true},{"text":"${price} émeraudes. +${level} émeraude${level > 1 ? 's' : ''} par monstre tué de ta main jusqu’à la fin de la partie.","color":"yellow"}]`);
            await rcon.run(`tellraw ${name} {"text":"Attention : tu repars de zéro (inventaire vidé, kit de départ, passifs à 0, classe à rechoisir). Pose tes tourelles avant !","color":"red"}`);
            await rcon.run(`tellraw ${name} {"text":"[ Passer Prestige ${level} ]","color":"gold","bold":true,"clickEvent":{"action":"run_command","value":"/trigger prestige set 2"},"hoverEvent":{"action":"show_text","contents":"${price} émeraudes"}}`);
          } else {
            const owned = Number(/Found (\d+)/.exec(await rcon.run(`clear ${name} minecraft:emerald 0`))?.[1] ?? 0);
            const paid = owned >= price ? Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:emerald ${price}`))?.[1] ?? 0) : 0;
            if (paid < price) {
              if (paid > 0) await rcon.run(`give ${name} minecraft:emerald ${paid}`);
              await rcon.run(`tellraw ${name} {"text":"Pas assez d’émeraudes : le Prestige ${level} coûte ${price}.","color":"red"}`);
            } else {
              levels.set('prestige', level);
              await rcon.run(`scoreboard players set ${name} niv_prestige ${level}`);
              // on repart de zéro : inventaire vidé, kit de départ, passifs à 0
              await rcon.run(`clear ${name}`);
              for (const item of KIT) await rcon.run(`give ${name} minecraft:${item}`);
              for (const passive of PASSIVES) {
                await rcon.run(`scoreboard players reset ${name} p_${passive.key}`);
                levels.set(passive.key, 0);
              }
              // la classe aussi : plus de rôle ni d'arbre, un ticket pour en rechoisir une
              await rcon.run(`scoreboard players set ${name} role 0`);
              await rcon.run(`scoreboard players set ${name} arbre_acquis 0`);
              await rcon.run(`kill @e[tag=pet_${name}]`);
              levels.set('role', 0);
              await rcon.run(`give ${name} minecraft:${ROLE_TICKET_ITEM}`);
              await rcon.run(`tellraw @a {"text":"${name} passe Prestige ${level} et repart de zéro !","color":"gold"}`);
              await rcon.run(`title ${name} times 5 40 10`);
              await rcon.run(`title ${name} subtitle {"text":"Prestige ${level} : +${level} émeraude${level > 1 ? 's' : ''} par monstre jusqu’à la fin de la partie","color":"gold"}`);
              await rcon.run(`title ${name} title {"text":"★"}`);
              await rcon.run(`execute at ${name} run playsound minecraft:ui.toast.challenge_complete master ${name} ~ ~ ~ 1 1`);
            }
          }
        }
        // parchemins achetés : consommés, niveau monté (au-delà du maximum, remboursés)
        for (const p of PASSIVES) {
          // un seul test par passif tant qu'on n'a rien acheté
          if (!/Found/.test(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data~{passif:"${p.key}"}] 0`))) continue;
          for (let lvl = 1; lvl <= p.max; lvl++) {
            const bought = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data={passif:"${p.key}",niveau:${lvl}}]`))?.[1] ?? 0);
            if (bought === 0) continue;
            const level = levels.get(p.key) ?? 0;
            const valid = lvl === level + 1 ? 1 : 0;
            if (valid) {
              levels.set(p.key, lvl);
              await rcon.run(`scoreboard players set ${name} p_${p.key} ${lvl}`);
              await rcon.run(`title ${name} times 5 40 10`);
              await rcon.run(`title ${name} subtitle {"text":"Passif ${p.label} : niveau ${lvl}/${p.max}","color":"${p.color}"}`);
              await rcon.run(`title ${name} title {"text":""}`);
            } else {
              await rcon.run(`title ${name} actionbar {"text":"Ce parchemin était pour le niveau ${lvl} : vous êtes niveau ${level} (perdu)","color":"gray"}`);
            }
          }
        }
        // vol de vie et coups critiques, d'après les dégâts infligés depuis le dernier passage
        const d = await score(name, 'degats');
        const lastDealt = dealt.get(name);
        dealt.set(name, d);
        const hit = lastDealt === undefined ? 0 : Math.max(0, d - lastDealt) / 10;
        if (hit > 0) {
          let heal = (stolen.get(name) ?? 0) + hit * 0.05 * (levels.get('vol') ?? 0);
          for (let k = 0; heal >= 4 && k < 5; k++) {
            await rcon.run(`effect give ${name} minecraft:instant_health 1 0 true`);
            heal -= 4;
          }
          stolen.set(name, heal);
          if (Math.random() < 0.1 * (levels.get('critique') ?? 0)) {
            const bonus = Math.max(2, Math.round(hit / 2));
            await rcon.run(`execute at ${name} as @e[tag=vague,distance=..5,limit=1,sort=nearest] run damage @s ${bonus} minecraft:player_attack by ${name}`);
            await rcon.run(`execute at ${name} as @e[tag=vague,distance=..5,limit=1,sort=nearest] at @s run particle minecraft:crit ~ ~1 ~ 0.4 0.6 0.4 0.2 30`);
            await rcon.run(`execute at ${name} run playsound minecraft:entity.player.attack.crit master @a ~ ~ ~ 1 1`);
          }
        }
        // rôle choisi chez le Maître des rôles : parchemin consommé, rôle noté, équipement donné
        for (const r of ROLES) {
          if (!/Removed/.test(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data={role:"${r.key}"}]`))) continue;
          await rcon.run(`scoreboard players set ${name} role ${r.id}`);
          await rcon.run(`scoreboard players set ${name} arbre_acquis 0`);
          const kit = r.key === 'ingenieur' ? [...r.kit, ...TURRET_KINDS.filter((k) => k.tag === 'fleche' || k.tag === 'canon').map((k) => `armor_stand[${turretItemArgs(k)}]`), `paper[${turretUpgradeItemArgs()}] 2`] : r.kit;
          for (const item of kit) await rcon.run(`give ${name} minecraft:${item}`);
          if (r.key === 'ingenieur') await rcon.run(`scoreboard players add ${name} tourelles 2`);
          await rcon.run(`clear ${name} minecraft:carrot_on_a_stick[minecraft:custom_data={capacite:1b}]`);
          await rcon.run(`give ${name} minecraft:${abilityItem(r)}`);
          await rcon.run(`title ${name} times 5 40 10`);
          await rcon.run(`title ${name} subtitle {"text":"Vous êtes ${r.name}","color":"${r.color}"}`);
          await rcon.run(`title ${name} title {"text":""}`);
          await rcon.run(`tellraw @a {"text":"${name} devient ${r.name}","color":"${r.color}"}`);
        }
        // meute de l'Invocateur : un loup de plus par passage s'il en manque ; plus de loups si on change de rôle
        {
          const isSummoner = (await score(name, 'role')) === 6;
          if (!isSummoner) {
            await rcon.run(`kill @e[tag=pet_${name}]`);
          } else {
            const level = roleLevelFor(k);
            const wanted = PET_BASE + Math.floor(level / 5) + (has(name, 'meute') ? 1 : 0) + (has(name, 'grande_meute') ? 1 : 0);
            const stats = petStats(name, level);
            // tous ses loups (meute et renforts) suivent son niveau et son arbre : dégâts et vie maximale
            await rcon.run(`execute as @e[type=minecraft:wolf,tag=pet,name="Loup de ${name}"] run attribute @s minecraft:generic.attack_damage base set ${stats.damage}`);
            await rcon.run(`execute as @e[type=minecraft:wolf,tag=pet,name="Loup de ${name}"] run attribute @s minecraft:generic.max_health base set ${stats.hp}`);
            if (has(name, 'lien')) await rcon.run(`effect give @e[type=minecraft:wolf,tag=pet,name="Loup de ${name}"] minecraft:regeneration 3 0 true`);
            const pets = number(await rcon.run(`execute if entity @e[tag=pet_${name}]`));
            if (pets < wanted) {
              const uuid = /(\[I; -?\d+, -?\d+, -?\d+, -?\d+\])/.exec(await rcon.run(`data get entity ${name} UUID`))?.[1];
              if (uuid) await rcon.run(petCommand(name, uuid, stats.hp, stats.damage, ['pet', `pet_${name}`]));
            }
          }
        }
        // rôle : niveau d'après les victimes de la partie, objet de capacité, capacité utilisée
        const myRoleId = await score(name, 'role');
        const myRole = ROLES.find((r) => r.id === myRoleId);
        if (myRole) {
          const roleLevel = roleLevelFor(k);
          const known = roleLevels.get(name);
          roleLevels.set(name, roleLevel);
          if (known !== undefined && roleLevel > known) {
            await rcon.run(`title ${name} times 5 40 10`);
            await rcon.run(`title ${name} subtitle {"text":"${myRole.name} niveau ${roleLevel} !","color":"${myRole.color}"}`);
            await rcon.run(`title ${name} title {"text":""}`);
            await rcon.run(`execute at ${name} run playsound minecraft:entity.player.levelup master @a ~ ~ ~ 1 1`);
            if (myRole.key === 'ingenieur') await rcon.run(`give ${name} minecraft:paper[${turretUpgradeItemArgs()}]`);
          }
          if (/No items/.test(await rcon.run(`clear ${name} minecraft:carrot_on_a_stick[minecraft:custom_data={capacite:1b}] 0`))) {
            await rcon.run(`give ${name} minecraft:${abilityItem(myRole)}`);
          }
          if ((await score(name, 'capacite')) > 0 && sneaking.has(name) && (ultCharge.get(name) ?? 0) >= ULT_COST) {
            await rcon.run(`scoreboard players set ${name} capacite 0`);
            ultCharge.set(name, 0);
            await useUltimate(myRole, name);
          }
          if ((await score(name, 'capacite')) > 0) {
            await rcon.run(`scoreboard players set ${name} capacite 0`);
            const uses = abilityUsed.get(name) ?? 0;
            if (uses >= (has(name, 'double') ? 2 : 1)) {
              await rcon.run(`title ${name} actionbar {"text":"${myRole.ability} : déjà utilisé, rechargé à la prochaine vague","color":"gray"}`);
            } else {
              abilityUsed.set(name, uses + 1);
              await useAbility(myRole, name);
            }
          }
        }
        // réparation de tourelle : le parchemin sert près (3 blocs) d'une tourelle abîmée, qui retrouve toute sa vie
        const repairItem = `minecraft:paper[minecraft:custom_data={passif:"${TURRET_REPAIR.key}"}]`;
        if (/Found/.test(await rcon.run(`clear ${name} ${repairItem} 0`))) {
          for (const [id, turret] of turrets) {
            if (turret.hp >= TURRET_HP[turret.level - 1]! || !/passed/.test(await rcon.run(`execute at ${name} if entity @e[tag=${id},distance=..3]`))) continue;
            const tags = await rcon.run(`data get entity @e[tag=${id},limit=1] Tags`);
            const maxHp = TURRET_HP[turretLevel(tags) - 1]!;
            if (turret.hp >= maxHp) continue;
            await rcon.run(`clear ${name} ${repairItem} 1`);
            turret.hp = maxHp;
            await rcon.run(`execute at @e[tag=${id}] run particle minecraft:happy_villager ~ ~1.5 ~ 0.4 0.6 0.4 0 20`);
            await rcon.run(`title ${name} actionbar {"text":"Tourelle réparée !","color":"green"}`);
            break;
          }
        }
        // amélioration de tourelle : le parchemin sert quand on se tient à 3 blocs d'une tourelle pas au maximum
        const scrollItem = `minecraft:paper[minecraft:custom_data={passif:"${TURRET_UPGRADE.key}"}]`;
        if (/Found/.test(await rcon.run(`clear ${name} ${scrollItem} 0`)) && /passed/.test(await rcon.run(`execute at ${name} if entity @e[${NOT_MAX_TURRET},distance=..3]`))) {
          await rcon.run(`clear ${name} ${scrollItem} 1`);
          await rcon.run(`execute at ${name} run tag @e[${NOT_MAX_TURRET},distance=..3,limit=1,sort=nearest] add cible`);
          // du plus haut au plus bas : la tourelle ne monte que d'un niveau (son nom suit avec sa barre de vie)
          for (let level = TURRET_MAX_LEVEL - 1; level >= 2; level--) {
            await rcon.run(`tag @e[tag=cible,tag=lvl${level}] add lvl${level + 1}`);
            await rcon.run(`tag @e[tag=cible,tag=lvl${level + 1}] remove lvl${level}`);
          }
          const noLevel = Array.from({ length: TURRET_MAX_LEVEL - 1 }, (_, i) => `tag=!lvl${i + 2}`).join(',');
          await rcon.run(`tag @e[tag=cible,${noLevel}] add lvl2`);
          await rcon.run('execute at @e[tag=cible] run particle minecraft:totem_of_undying ~ ~1.5 ~ 0.3 0.5 0.3 0.3 40');
          await rcon.run('tag @e[tag=cible] remove cible');
          await rcon.run(`title ${name} actionbar {"text":"Tourelle améliorée !","color":"light_purple"}`);
        }
        // améliorations d'équipe : parchemin consommé, effet sur le château pour toute la partie
        for (const u of [REPAIR, ...UPGRADES]) {
          const bought = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data={passif:"${u.key}"}]`))?.[1] ?? 0);
          if (bought === 0) continue;
          const level = await score('#equipe', `p_${u.key}`);
          const gained = Math.min(bought, u.max - level);
          if (gained > 0) {
            if (u !== REPAIR) await rcon.run(`scoreboard players set #equipe p_${u.key} ${level + gained}`);
            await applyUpgrade(rcon, u.key);
            await rcon.run('title @a times 5 40 10');
            await rcon.run(`title @a subtitle {"text":"${name} : ${u.label}","color":"${u.color}"}`);
            await rcon.run('title @a title {"text":""}');
          }
        }
        // Bénédiction du Roi : parchemin consommé, niveau de l'équipe monté, Roi renforcé et soigné
        for (let lvl = 1; lvl <= BLESSING.max && /Found/.test(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data~{passif:"${BLESSING.key}"}] 0`)); lvl++) {
          const blessed = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data={passif:"${BLESSING.key}",niveau:${lvl}}]`))?.[1] ?? 0);
          if (blessed === 0) continue;
          const level = await score('#equipe', `p_${BLESSING.key}`);
          const gained = lvl === level + 1 ? 1 : 0;
          if (gained > 0) {
            await rcon.run(`scoreboard players set #equipe p_${BLESSING.key} ${level + gained}`);
            await rcon.run(`attribute ${KING} minecraft:generic.max_health base set ${kingHealth(level + gained)}`);
            await rcon.run(`effect give ${KING} minecraft:instant_health 1 3 true`);
            await rcon.run('title @a times 5 40 10');
            await rcon.run(`title @a subtitle {"text":"${name} bénit le Roi : niveau ${level + gained}/${BLESSING.max}","color":"gold"}`);
            await rcon.run('title @a title {"text":""}');
          }
        }
        // tourelle posée près de lui (6 blocs) et pas encore attribuée : elle est à lui, même pendant une pause
        await rcon.run(`execute at ${name} run tag @e[tag=tourelle,tag=!possedee,distance=..6] add proprio_${name}`);
        await rcon.run(`tag @e[tag=proprio_${name},tag=!possedee] add possedee`);
        // catalogue personnel : ouverture (/trigger boutique) et achats (/trigger achat set <numéro>)
        {
          await rcon.run(`scoreboard players enable ${name} boutique`);
          await rcon.run(`scoreboard players enable ${name} achat`);
          const opened = (await score(name, 'boutique')) > 0;
          const choice = await score(name, 'achat');
          if (opened || choice > 0) {
            await rcon.run(`scoreboard players set ${name} boutique 0`);
            await rcon.run(`scoreboard players set ${name} achat 0`);
            const blessingLevel = await score('#equipe', `p_${BLESSING.key}`);
            // tourelles possédées : posées (étiquette du propriétaire) ou encore dans l'inventaire
            // tourelles achetées pendant la partie moins celles détruites : les cacher ne fait pas baisser le prix
            const ownedTurrets = () => score(name, 'tourelles');
            const emeralds = async () => Number(/Found (\d+)/.exec(await rcon.run(`clear ${name} minecraft:emerald 0`))?.[1] ?? 0);
            const tokens = async () => Number(/Found (\d+)/.exec(await rcon.run(`clear ${name} minecraft:echo_shard[minecraft:custom_data={jeton:1b}] 0`))?.[1] ?? 0);
            // objets uniques : payés en jetons de gloire (retrait vérifié, rendu si incomplet)
            const unique = choice >= BUY_UNIQUE ? UNIQUES[choice - BUY_UNIQUE] : undefined;
            if (unique) {
              const paid = (await tokens()) >= unique.cost ? Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:echo_shard[minecraft:custom_data={jeton:1b}] ${unique.cost}`))?.[1] ?? 0) : 0;
              if (paid < unique.cost) {
                if (paid > 0) await rcon.run(`give ${name} minecraft:${TOKEN_ITEM} ${paid}`);
                await rcon.run(`tellraw ${name} {"text":"Pas assez de jetons de gloire : ${unique.name} en demande ${unique.cost}.","color":"red"}`);
              } else {
                await rcon.run(`give ${name} minecraft:${unique.item}`);
                await rcon.run(`tellraw @a {"text":"${name} obtient ${unique.name} !","color":"gold"}`);
              }
            }
            // roulette de l'Enchanteur : un enchantement au hasard sur l'objet tenu, parfois légendaire
            if (choice === BUY_ROULETTE) {
              const held = /"minecraft:([a-z_]+)"/.exec(await rcon.run(`data get entity ${name} SelectedItem.id`))?.[1] ?? '';
              const table = ROULETTE.find((t) => t.match.test(held));
              if (!table) {
                await rcon.run(`tellraw ${name} {"text":"Tenez une arme, un arc, une arbalète, une armure, un trident ou une masse en main.","color":"red"}`);
              } else if ((await emeralds()) < ROULETTE_PRICE) {
                await rcon.run(`tellraw ${name} {"text":"Pas assez d’émeraudes : la roulette coûte ${ROULETTE_PRICE}.","color":"red"}`);
              } else {
                const paid = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:emerald ${ROULETTE_PRICE}`))?.[1] ?? 0);
                if (paid < ROULETTE_PRICE) {
                  if (paid > 0) await rcon.run(`give ${name} minecraft:emerald ${paid}`);
                } else {
                  const [enchant, max] = table.enchants[Math.floor(Math.random() * table.enchants.length)]!;
                  const roll = Math.random();
                  const bonus = max === 1 ? 0 : roll < 0.05 ? 2 : roll < 0.3 ? 1 : 0;
                  const level = max + bonus;
                  await rcon.run(
                    `item modify entity ${name} weapon.mainhand {"function":"minecraft:set_enchantments","enchantments":{"minecraft:${enchant}":${level}},"add":false}`,
                  );
                  const legend = bonus === 2;
                  await rcon.run(`tellraw ${legend ? '@a' : name} {"text":"${legend ? `LÉGENDAIRE ! ${name} obtient` : 'Roulette :'} ${enchant} ${level}","color":"${legend ? 'gold' : 'light_purple'}","bold":${legend}}`);
                  await rcon.run(`execute at ${name} run playsound minecraft:${legend ? 'ui.toast.challenge_complete' : 'block.enchantment_table.use'} master ${name} ~ ~ ~ 1 1`);
                }
              }
            }
            if (choice > 0 && choice !== BUY_ROULETTE && !unique) {
              // article choisi : prix, puis paiement s'il a assez d'émeraudes
              const passive = choice <= PASSIVES.length ? PASSIVES[choice - 1] : undefined;
              const kind = choice >= BUY_TURRET && choice < BUY_TURRET + TURRET_KINDS.length ? TURRET_KINDS[choice - BUY_TURRET] : undefined;
              let price = 0;
              let label = '';
              if (passive) {
                const next = (levels.get(passive.key) ?? 0) + 1;
                if (next <= passive.max) [price, label] = [passivePrice(passive, next), `${passive.label} (niveau ${next})`];
              } else if (choice === BUY_BLESSING) {
                if (blessingLevel < BLESSING.max) [price, label] = [passivePrice(BLESSING, blessingLevel + 1), `Bénédiction du Roi (niveau ${blessingLevel + 1})`];
              } else if (kind) {
                [price, label] = [Math.round(kind.price * (1 + (await ownedTurrets())) * (has(name, 'economie') ? 0.75 : 1)), kind.name];
              }
              if (price === 0) {
                await rcon.run(`tellraw ${name} {"text":"Cet article n’est plus disponible.","color":"gray"}`);
              } else if ((await emeralds()) < price) {
                await rcon.run(`tellraw ${name} {"text":"Pas assez d’émeraudes : ${label} coûte ${price}.","color":"red"}`);
              } else {
                // paiement vérifié : si le retrait est incomplet, on rend exactement ce qui a été pris et l'achat est annulé
                const paid = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:emerald ${price}`))?.[1] ?? 0);
                if (paid < price) {
                  if (paid > 0) await rcon.run(`give ${name} minecraft:emerald ${paid}`);
                  await rcon.run(`tellraw ${name} {"text":"Achat annulé : les émeraudes ont bougé pendant le paiement.","color":"red"}`);
                } else {
                if (passive) {
                  const next = (levels.get(passive.key) ?? 0) + 1;
                  levels.set(passive.key, next);
                  await rcon.run(`scoreboard players set ${name} p_${passive.key} ${next}`);
                } else if (choice === BUY_BLESSING) {
                  await rcon.run(`scoreboard players set #equipe p_${BLESSING.key} ${blessingLevel + 1}`);
                  await rcon.run(`attribute ${KING} minecraft:generic.max_health base set ${kingHealth(blessingLevel + 1)}`);
                  await rcon.run(`effect give ${KING} minecraft:instant_health 1 3 true`);
                  await rcon.run(`tellraw @a {"text":"${name} bénit le Roi (niveau ${blessingLevel + 1}/${BLESSING.max})","color":"gold"}`);
                } else if (kind) {
                  await rcon.run(`give ${name} minecraft:armor_stand[${turretItemArgs(kind)}]`);
                  await rcon.run(`scoreboard players add ${name} tourelles 1`);
                }
                await rcon.run(`tellraw ${name} {"text":"Acheté : ${label} (${price} émeraudes)","color":"green"}`);
                await rcon.run(`execute at ${name} run playsound minecraft:entity.villager.yes master ${name} ~ ~ ~ 1 1`);
                }
              }
            }
            // la boutique, à jour, dans le chat du joueur
            const blessingNow = await score('#equipe', `p_${BLESSING.key}`);
            const owned = await ownedTurrets();
            const line = (id: number, text: string, price: number | undefined, color: string) =>
              price === undefined
                ? rcon.run(`tellraw ${name} [{"text":"   ✔ ","color":"dark_gray"},{"text":"${text} (maximum)","color":"gray"}]`)
                : rcon.run(
                    `tellraw ${name} [{"text":"[Acheter] ","color":"green","bold":true,"clickEvent":{"action":"run_command","value":"/trigger achat set ${id}"},` +
                      `"hoverEvent":{"action":"show_text","contents":"${price} émeraudes"}},{"text":"${text} ","color":"${color}"},{"text":"${price} 💎","color":"gold"}]`,
                  );
            await rcon.run(`tellraw ${name} [{"text":"— Boutique de ${name} — ","color":"light_purple","bold":true},{"text":"${await emeralds()} émeraudes ","color":"gold"},{"text":"[★ Prestige]","color":"gold","clickEvent":{"action":"run_command","value":"/trigger prestige"}}]`);
            for (const [i, passive] of PASSIVES.entries()) {
              const next = (levels.get(passive.key) ?? 0) + 1;
              await line(i + 1, `${passive.label} : niveau ${next - 1} → ${next}`, next <= passive.max ? passivePrice(passive, next) : undefined, passive.color);
            }
            await line(BUY_BLESSING, `Bénédiction du Roi : niveau ${blessingNow} → ${blessingNow + 1}`, blessingNow < BLESSING.max ? passivePrice(BLESSING, blessingNow + 1) : undefined, 'gold');
            for (const [i, kind] of TURRET_KINDS.entries()) {
              await line(BUY_TURRET + i, `${kind.name} (vous en avez ${owned})`, Math.round(kind.price * (1 + owned) * (has(name, 'economie') ? 0.75 : 1)), kind.color);
            }
            await line(BUY_ROULETTE, 'Roulette de l’Enchanteur (objet tenu en main, parfois légendaire)', ROULETTE_PRICE, 'light_purple');
            const myTokens = await tokens();
            await rcon.run(`tellraw ${name} {"text":"— Jetons de gloire : ${myTokens} (lâchés par les élites et les boss) —","color":"aqua","bold":true}`);
            for (const [i, u] of UNIQUES.entries()) {
              await rcon.run(
                `tellraw ${name} [{"text":"[Échanger] ","color":"aqua","bold":true,"clickEvent":{"action":"run_command","value":"/trigger achat set ${BUY_UNIQUE + i}"}},` +
                  `{"text":"${u.name} ","color":"gold"},{"text":"${u.cost} jetons","color":"aqua"}]`,
              );
            }
          }
        }
        const role = ROLES.find((r) => r.id === (levels.get('role') ?? 0));
        const roleLevel = role ? roleLevelFor(k) : 0;
        // arbre de compétences : masque des compétences apprises, menu (/trigger arbre) et apprentissage (/trigger competence)
        let mask = await score(name, 'arbre_acquis');
        skills.set(name, { role: role?.key, mask });
        await rcon.run(`scoreboard players enable ${name} arbre`);
        await rcon.run(`scoreboard players enable ${name} competence`);
        const treeOpen = (await score(name, 'arbre')) > 0;
        const learn = await score(name, 'competence');
        if (treeOpen || learn > 0) {
          await rcon.run(`scoreboard players set ${name} arbre 0`);
          await rcon.run(`scoreboard players set ${name} competence 0`);
          const tree = role ? TREES[role.key] : undefined;
          if (!tree || !role) {
            await rcon.run(`tellraw ${name} {"text":"Choisissez d’abord un rôle chez le Maître des rôles.","color":"gray"}`);
          } else {
            if (learn >= 1 && learn <= 9) {
              const bit = learn - 1;
              const tier = (bit % 3) + 1;
              const skill = tree.skills[Math.floor(bit / 3)]![bit % 3]!;
              const free = roleLevel - spentPoints(mask);
              if ((mask >> bit) & 1) {
                await rcon.run(`tellraw ${name} {"text":"Déjà appris : ${skill.label}","color":"gray"}`);
              } else if (tier > 1 && !((mask >> (bit - 1)) & 1)) {
                await rcon.run(`tellraw ${name} {"text":"Il faut d’abord la compétence précédente de la branche.","color":"red"}`);
              } else if (free < tier) {
                await rcon.run(`tellraw ${name} {"text":"Pas assez de points : ${skill.label} en demande ${tier} (vous en avez ${free}).","color":"red"}`);
              } else {
                mask |= 1 << bit;
                skills.set(name, { role: role.key, mask });
                await rcon.run(`scoreboard players set ${name} arbre_acquis ${mask}`);
                await rcon.run(`tellraw ${name} {"text":"Compétence apprise : ${skill.label}","color":"green"}`);
                await rcon.run(`execute at ${name} run playsound minecraft:entity.player.levelup master ${name} ~ ~ ~ 1 1.5`);
              }
            }
            const free = roleLevel - spentPoints(mask);
            await rcon.run(`tellraw ${name} [{"text":"— Arbre ${role.name} — ","color":"${role.color}","bold":true},{"text":"${free} point${free > 1 ? 's' : ''} à dépenser (1 par niveau)","color":"gold"}]`);
            for (const [b, branch] of tree.skills.entries()) {
              const parts = [`{"text":"${tree.branches[b]} : ","color":"white","bold":true}`];
              for (const [t, skill] of branch.entries()) {
                const bit = b * 3 + t;
                const learnedIt = (mask >> bit) & 1;
                const open = t === 0 || (mask >> (bit - 1)) & 1;
                parts.push(
                  learnedIt
                    ? `{"text":"[✔ ${skill.label}] ","color":"green"}`
                    : open
                      ? `{"text":"[Apprendre : ${skill.label} — ${t + 1} pt] ","color":"yellow","clickEvent":{"action":"run_command","value":"/trigger competence set ${bit + 1}"}}`
                      : `{"text":"[🔒 ${skill.label} — ${t + 1} pt] ","color":"dark_gray"}`,
                );
              }
              await rcon.run(`tellraw ${name} [${parts.join(',')}]`);
            }
          }
        }
        // effets permanents de l'arbre
        if (has(name, 'aura')) await rcon.run(`execute at ${name} run effect give @a[distance=..8] minecraft:resistance 3 0 true`);
        if (has(name, 'esquive')) await rcon.run(`effect give ${name} minecraft:resistance 3 0 true`);
        if (has(name, 'faucon')) await rcon.run(`execute at ${name} run effect give @e[tag=vague,distance=..30] minecraft:glowing 3 0 true`);
        if (has(name, 'givre')) await rcon.run(`execute at ${name} run effect give @e[tag=vague,distance=..5] minecraft:slowness 3 1 true`);
        // aura du Soigneur : plus large avec le niveau et l'arbre, plus forte, et le Roi soigné de partout avec Bénédiction
        if (role?.key === 'soigneur') {
          const range = 6 + Math.floor(roleLevel / 3) + (has(name, 'aura_large') ? 3 : 0);
          const amp = has(name, 'aura_forte') ? 1 : 0;
          await rcon.run(`execute at ${name} run effect give @a[distance=..${range}] minecraft:regeneration 3 ${amp} true`);
          await rcon.run(`execute at ${name} run effect give ${has(name, 'aura_roi') ? KING : KING.replace(']', `,distance=..${range}]`)} minecraft:regeneration 3 ${amp + 1} true`);
        }
        // barre d'expérience = progression du rôle (niveau affiché au-dessus, barre jusqu'au niveau suivant)
        if (role) {
          const progress = roleLevel >= ROLE_MAX_LEVEL ? 1 : (k - killsForRoleLevel(roleLevel)) / (killsForRoleLevel(roleLevel + 1) - killsForRoleLevel(roleLevel));
          const xpBar = `${roleLevel}:${progress}`;
          if (xpShown.get(name) !== xpBar) {
            xpShown.set(name, xpBar);
            const points = Math.min(xpForLevel(roleLevel) - 1, Math.floor(progress * xpForLevel(roleLevel)));
            await rcon.run(`xp set ${name} ${roleLevel} levels`);
            await rcon.run(`xp set ${name} ${points} points`);
          }
        }
        const treeBonus = (attribute: string) => learnedSkills(role?.key, mask).reduce((sum, sk) => sum + (sk.attr?.[attribute] ?? 0), 0);
        const roleBonus = (attribute: string) => (role ? (role.bonus[attribute] ?? 0) + roleLevel * (role.perLevel[attribute] ?? 0) : 0) + treeBonus(attribute);
        // passifs affichés en permanence au-dessus de la barre d'objets (sauf pendant le compte à rebours)
        if (!waiting.has(name) && !downed.has(name)) {
          const owned = PASSIVES.filter((p) => (levels.get(p.key) ?? 0) > 0);
          const parts: string[] = owned.length
            ? owned.map((p, i) => `{"text":"${i ? ' · ' : ''}${p.short} ${levels.get(p.key)}","color":"${p.color}"}`)
            : ['{"text":"Aucun passif : voyez le Maître des passifs","color":"gray"}'];
          const prestigeLevel = levels.get('prestige') ?? 0;
          if (prestigeLevel > 0) parts.unshift(`{"text":"★ Prestige ${prestigeLevel} · ","color":"gold","bold":true}`);
          if (role) {
            const ready = (abilityUsed.get(name) ?? 0) < (has(name, 'double') ? 2 : 1) ? ' ✦' : '';
            const step = killsForRoleLevel(roleLevel + 1) - killsForRoleLevel(roleLevel);
            const into = roleLevel >= ROLE_MAX_LEVEL ? step : k - killsForRoleLevel(roleLevel);
            const filled = Math.floor((into / step) * 5);
            const gauge = `${'■'.repeat(filled)}${'□'.repeat(5 - filled)} ${roleLevel >= ROLE_MAX_LEVEL ? 'max' : `${into}/${step}`}`;
            const freePoints = roleLevel - spentPoints(mask);
            const charge = ultCharge.get(name) ?? 0;
            parts.push(`{"text":"   ⚡ ${charge >= ULT_COST ? 'ULTIME PRÊT (accroupi + clic droit)' : `${charge}/${ULT_COST}`}","color":"${charge >= ULT_COST ? 'yellow' : 'gray'}","bold":${charge >= ULT_COST}}`);
            parts.unshift(`{"text":"${role.name} niv.${roleLevel} ${gauge}${ready}${freePoints > 0 ? ` (${freePoints} pt)` : ''}${owned.length ? ' · ' : ''}","color":"${role.color}","bold":true}`);
          }
          if (remaining > 0 && remaining <= 5) {
            const me = /\[(-?[0-9.]+)d, -?[0-9.]+d, (-?[0-9.]+)d\]/.exec(await rcon.run(`data get entity ${name} Pos`));
            const yaw = Number(/\[(-?[0-9.]+)f/.exec(await rcon.run(`data get entity ${name} Rotation`))?.[1] ?? 0);
            const foe = /\[(-?[0-9.]+)d, -?[0-9.]+d, (-?[0-9.]+)d\]/.exec(await rcon.run(`execute at ${name} run data get entity @e[tag=vague,limit=1,sort=nearest] Pos`));
            if (me && foe) {
              const dx = Number(foe[1]) - Number(me[1]);
              const dz = Number(foe[2]) - Number(me[2]);
              const rel = ((((Math.atan2(-dx, dz) * 180) / Math.PI - yaw) % 360) + 540) % 360 - 180;
              const arrow = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][(Math.round(rel / 45) + 8) % 8];
              parts.push(`{"text":"   Monstre : ${arrow} ${Math.round(Math.hypot(dx, dz))} blocs","color":"red","bold":true}`);
            }
          }
          await rcon.run(`title ${name} actionbar [${parts.join(',')}]`);
        }
        // passifs appliqués à chaque passage (les valeurs de base repartent à zéro quand on meurt)
        for (const p of PASSIVES) {
          if (!p.attribute) continue;
          const [attribute, value] = p.attribute;
          await rcon.run(`attribute ${name} minecraft:${attribute} base set ${value(levels.get(p.key) ?? 0) + roleBonus(attribute)}`);
        }
        for (const [attribute, base] of EXTRA_ATTRIBUTES) await rcon.run(`attribute ${name} minecraft:${attribute} base set ${base + roleBonus(attribute)}`);
        // à terre : sous 3 cœurs, invulnérable mais sans force ; un allié accroupi à côté pendant 3 s le relève, sinon il meurt
        if (!waiting.has(name)) {
          const state = downed.get(name);
          const hp = number(await rcon.run(`data get entity ${name} Health`));
          if (!state && hp > 0 && hp <= DOWNED_HP) {
            downed.set(name, { until: Date.now() + DOWNED_S * 1000, revive: 0 });
            await rcon.run(`tellraw @a {"text":"${name} est à terre ! Accroupissez-vous à côté de lui pour le relever.","color":"red"}`);
            await rcon.run(`execute at ${name} run playsound minecraft:entity.player.hurt master @a ~ ~ ~ 1 0.6`);
          }
          const now = downed.get(name);
          if (now) {
            await rcon.run(`effect give ${name} minecraft:resistance 2 4 true`);
            await rcon.run(`effect give ${name} minecraft:slowness 2 6 true`);
            await rcon.run(`effect give ${name} minecraft:weakness 2 9 true`);
            await rcon.run(`effect give ${name} minecraft:glowing 2 0 true`);
            let helper: string | undefined;
            for (const other of online) {
              if (other === name || !sneaking.has(other) || downed.has(other)) continue;
              if (/passed/.test(await rcon.run(`execute at ${name} if entity @a[name=${other},distance=..2]`))) {
                helper = other;
                break;
              }
            }
            const near = helper !== undefined;
            now.revive = near ? now.revive + 1 : 0;
            if (near && now.revive >= REVIVE_TICKS) {
              await revive(name, helper!);
            } else if (Date.now() > now.until) {
              downed.delete(name);
              await rcon.run(`effect clear ${name}`);
              await rcon.run(`kill ${name}`);
            } else {
              const left = Math.ceil((now.until - Date.now()) / 1000);
              await rcon.run(`title ${name} actionbar {"text":"À TERRE : ${left} s${near ? ' — on vous relève…' : ' — un allié accroupi à côté peut vous relever'}","color":"red","bold":true}`);
            }
          }
        }
        if (waiting.has(name) || number(await rcon.run(`scoreboard players get ${name} morts`).then((r) => r.replace(/has (-?\d+)/, 'count: $1'))) < 1) continue;
        waiting.add(name);
        downed.delete(name);
        await rcon.run(`scoreboard players set ${name} morts 0`);
        await rcon.run(`gamemode spectator ${name}`);
        void respawn(name);
      }
      } finally {
        busy = false;
      }
    })();
  }, 1000);

  await rcon.run('scoreboard objectives add record dummy');
  const best = await score('#meilleur', 'record');
  if (!continuing) {
    await say('Défendez le Roi !', `Préparez-vous, puis marchez sur la plaque dorée${best ? ` · record : vague ${best}` : ''}`);
    await waitForStart(Number(firstWave), Number(firstDelay) > 0 ? Math.min(Number(firstDelay), 10) : 0, 'red');
  }

  /** Monstres des vagues encore en vie : étiquette unique → nom, vie maximale, dernière vie affichée. */
  const tracked = new Map<string, { name: string; max: number; shown: number; color?: string; elite?: string; split?: boolean; pos?: string; tokens?: number }>();
  let nextMob = 0;
  for (let n = Number(firstWave); ; n++) {
    const p = game.difficulty.power;
    const total = Math.round((4 + 3 * n) * p);
    const theme = waveTheme(n);
    const boss = n % (p > 1 ? 3 : 5) === 0;
    // reprise d'une vague déjà en cours : ni annonce ni apparition, on surveille les monstres déjà là
    const continuingNow = continuing && n === Number(firstWave);
    await rcon.run('kill @e[tag=marchenoir]');
    abilityUsed.clear();
    // bonus de l'arbre à chaque vague : flèches, pierres, potions, charges de vent, tourelles réparées
    if (!continuingNow) {
      for (const [name, st] of skills) {
        const give = (item: string) => rcon.run(`give ${name} minecraft:${item}`);
        if (has(name, 'carquois')) await give('arrow 32');
        if (has(name, 'macon')) await give('cobblestone 64');
        if (has(name, 'apothicaire')) for (let i = 0; i < 2; i++) await give('splash_potion[potion_contents={potion:"minecraft:strong_healing"}]');
        if (has(name, 'reserve')) await give('wind_charge 32');
        if (has(name, 'entretien')) for (const turret of turrets.values()) if (turret.owner === name) turret.hp = TURRET_HP[turret.level - 1]! * (has(name, 'blindage') ? 1.5 : 1);
        void st;
      }
    }
    if (n === 21) {
      await say('Mode Infini !', 'Les vagues ne s’arrêteront plus : battez le record');
      await kingSays(pick(KING_LINES.infini));
    }
    if (!continuingNow) await kingSays(pick(boss || n % 10 === 0 || n % 15 === 0 || n === 20 ? KING_LINES.boss : KING_LINES.vague));
    if (!continuingNow) await say(n > 20 ? `Vague ${n} (Infini)` : `Vague ${n}`, boss ? 'Un Zombie Géant et son Nécromancien approchent…' : theme === 'araignées' ? 'Vague des araignées : elles escaladent les murs !' : theme === 'squelettes' ? 'Vague des archers squelettes !' : `${total} monstres`);
    await rcon.run(`bossbar set minecraft:vague max ${total}`);
    // nuit de sang toutes les 10 vagues ; une vague sur trois attaque aussi par le nord
    const bloodNight = n % 10 === 0;
    const northFront = n % 3 === 0;
    if (bloodNight && !continuingNow) {
      await rcon.run('time set midnight');
      await say('Nuit de sang !', 'Les monstres ont 50 % de vie en plus');
    } else if (northFront) {
      await rcon.run('title @a actionbar {"text":"Attention : ils attaquent aussi par le nord !","color":"red"}');
    }
    for (let i = 0; i < (continuingNow ? 0 : total); i++) {
      const spawns = northFront && i % 2 === 1 ? NORTH_SPAWNS : SPAWNS;
      const [x, z] = spawns[i % spawns.length]!;
      const id = `m${RUN}_${nextMob++}`;
      const mob = mobCommand(n, i, x + ((i * 7) % 5) - 2, z + ((i * 3) % 5) - 2, p, id, bloodNight);
      await rcon.run(mob.command);
      const tokens = mob.name.startsWith('Zombie Géant') ? 3 : mob.elite ? 1 : 0;
      tracked.set(id, { name: mob.name, max: mob.health, shown: mob.health, color: mob.color, ...(mob.elite ? { elite: mob.elite } : {}), ...(tokens ? { tokens } : {}) });
      if (i % 4 === 3) await sleep(1000);
    }
    if (boss && !continuingNow) {
      const id = `m${RUN}_${nextMob++}`;
      const hp = 60 + 5 * n;
      await rcon.run(
        `summon minecraft:evoker 0 -60 50 {Tags:["vague","${id}"],PersistenceRequired:1b,CustomName:'${healthBar('Nécromancien', hp, hp)}',CustomNameVisible:1b,` +
          `Health:${hp}f,attributes:[{id:"minecraft:generic.max_health",base:${hp}},{id:"minecraft:generic.follow_range",base:64}]}`,
      );
      tracked.set(id, { name: 'Nécromancien', max: hp, shown: hp, tokens: 2 });
    }
    // boss uniques : Chef des pillards (toutes les 10 vagues), Roi des zombies (toutes les 15), Wither affaibli (vague 20)
    const extraBoss = async (command: string, name: string, hp: number, count: number) => {
      const id = `m${RUN}_${nextMob++}`;
      await rcon.run(command.replace('TAGS', `Tags:["vague","${id}"]`).replace('NAME', `CustomName:'${healthBar(name, hp, hp)}',CustomNameVisible:1b`));
      tracked.set(id, { name, max: hp, shown: hp, tokens: name === 'Shulker' ? 1 : 3 });
      extra += count;
    };
    let extra = boss ? 1 : 0;
    if (n % 10 === 0 && !continuingNow) {
      const hp = 150 + 10 * n;
      await extraBoss(
        `summon minecraft:ravager 0 -60 52 {TAGS,NAME,PersistenceRequired:1b,Health:${hp}f,attributes:[{id:"minecraft:generic.max_health",base:${hp}},{id:"minecraft:generic.follow_range",base:64}],` +
          'Passengers:[{id:"minecraft:pillager",Tags:["vague"],PersistenceRequired:1b,HandItems:[{id:"minecraft:crossbow",count:1},{}],attributes:[{id:"minecraft:generic.follow_range",base:64}]}]}',
        'Chef des pillards', hp, 2,
      );
    }
    if (n % 15 === 0 && !continuingNow) {
      const hp = 200 + 10 * n;
      await extraBoss(
        `summon minecraft:zombie 0 -60 52 {TAGS,NAME,PersistenceRequired:1b,Health:${hp}f,ArmorItems:[{},{},{},{id:"minecraft:golden_helmet",count:1,components:{"minecraft:unbreakable":{}}}],` +
          `HandItems:[{id:"minecraft:golden_sword",count:1},{}],attributes:[{id:"minecraft:generic.max_health",base:${hp}},{id:"minecraft:generic.scale",base:2.5},{id:"minecraft:generic.follow_range",base:64},{id:"minecraft:generic.attack_damage",base:8}]}`,
        'Roi des zombies', hp, 1,
      );
    }
    // le Warden, boss rare toutes les 12 vagues
    if (n % 12 === 0 && !continuingNow) {
      await extraBoss(
        'summon minecraft:warden 0 -60 52 {TAGS,NAME,PersistenceRequired:1b,Health:250f,attributes:[{id:"minecraft:generic.max_health",base:250},{id:"minecraft:generic.follow_range",base:64}]}',
        'Warden', 250, 1,
      );
      await rcon.run('title @a actionbar {"text":"Le Warden sort des profondeurs… abattez-le de loin !","color":"dark_aqua"}');
    }
    // shulkers postés sur les remparts nord : leurs projectiles font léviter
    if (n % 6 === 0 && n + p - 1 >= 6 && !continuingNow) {
      for (const sx of [-14, 14]) {
        await extraBoss(`summon minecraft:shulker ${sx} -50 -20 {TAGS,NAME,PersistenceRequired:1b,Health:40f,attributes:[{id:"minecraft:generic.max_health",base:40}]}`, 'Shulker', 40, 1);
      }
    }
    if (n === 20 && !continuingNow) {
      await extraBoss('summon minecraft:wither 0 -45 50 {TAGS,NAME,PersistenceRequired:1b,Health:150f}', 'Wither affaibli', 150, 1);
      await rcon.run('title @a actionbar {"text":"Le boss final : le Wither !","color":"dark_purple"}');
    }
    await rcon.run(`bossbar set minecraft:vague max ${continuingNow ? Math.max(1, number(await rcon.run('execute if entity @e[tag=vague]'))) : total + extra}`);
    let kingCalled = false;
    let eventDone = false;
    // tour de siège (une vague sur six) : une rampe qui monte marche après marche contre le mur est
    const siegeTower = n % 6 === 3;
    let siegeStep = 0;
    if (siegeTower) await rcon.run('title @a actionbar {"text":"Une tour de siège approche du mur est !","color":"gold"}');
    /** Seuils de vie du Roi déjà commentés pendant cette vague. */
    const kingWarned = new Set<string>();
    const started = Date.now();
    let glowing = false;
    let counterAttack = false;
    for (;;) {
      await sleep(2000);
      if (!(await kingAlive())) {
        await rcon.run('kill @e[tag=vague]');
        await rcon.run('bossbar set minecraft:vague name {"text":"Le Roi est mort","color":"dark_red"}');
        await kingSays(pick(KING_LINES.mort));
        const held = n - 1;
        const record = await score('#meilleur', 'record');
        if (held > record) await rcon.run(`scoreboard players set #meilleur record ${held}`);
        await say('Le Roi est mort !', `Vous avez tenu ${held} vague${held > 1 ? 's' : ''}${held > record ? ' : nouveau record !' : ` (record : ${record})`}`);
        // classement des tueurs de la partie
        const players = (await rcon.run('list')).split(':').slice(1).join(':').split(',').map((x) => x.trim()).filter(Boolean);
        const ranking = await Promise.all(players.map(async (name) => ({ name, kills: await score(name, 'tues') })));
        ranking.sort((a, b) => b.kills - a.kills);
        const lines = ranking.map((r, i) => `{"text":"\\n${i + 1}. ${r.name} : ${r.kills} monstre${r.kills > 1 ? 's' : ''}","color":"${i === 0 ? 'gold' : 'white'}"}`);
        await rcon.run(`tellraw @a [{"text":"Classement de la partie","color":"yellow","bold":true}${lines.length ? ',' + lines.join(',') : ''}]`);
        console.log(`partie terminée à la vague ${n}`);
        // nouvelle partie dans 30 s : le conteneur redémarre le script (--restart), qui remet tout à zéro
        writeFileSync(GAME_OVER_MARK, String(n));
        await sleep(25_000);
        await say('Nouvelle partie !', 'Le château est remis à neuf');
        await sleep(5_000);
        process.exit(0);
      }
      await rcon.run('bossbar set minecraft:vague players @a');
      // barres de vie au-dessus des monstres, mises à jour quand leur vie change
      for (const [id, mob] of tracked) {
        const reply = await rcon.run(`data get entity @e[tag=${id},limit=1] Health`);
        if (!/data: /.test(reply)) {
          // élites et boss lâchent des jetons de gloire là où ils sont tombés
          if (mob.tokens && mob.pos) await rcon.run(`summon minecraft:item ${mob.pos} {Item:${TOKEN_NBT.replace('COUNT', String(mob.tokens))},PickupDelay:10s}`);
          // l'Explosif explose à sa mort (dégâts aux joueurs proches, aucun bloc cassé)
          if (mob.elite === 'explosif' && mob.pos) {
            await rcon.run(`execute positioned ${mob.pos} run particle minecraft:explosion_emitter ~ ~1 ~`);
            await rcon.run(`execute positioned ${mob.pos} run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 1`);
            await rcon.run(`execute positioned ${mob.pos} as @a[distance=..4] run damage @s 8 minecraft:explosion`);
          }
          tracked.delete(id);
          continue;
        }
        if (mob.elite === 'explosif' || mob.tokens) {
          const pos = /\[(-?[0-9.]+)d, (-?[0-9.]+)d, (-?[0-9.]+)d\]/.exec(await rcon.run(`data get entity @e[tag=${id},limit=1] Pos`));
          if (pos) mob.pos = `${pos[1]} ${pos[2]} ${pos[3]}`;
        }
        const hp = number(reply);
        // le Diviseur se dédouble à mi-vie (une fois)
        if (mob.elite === 'diviseur' && !mob.split && hp < mob.max / 2) {
          mob.split = true;
          for (const ox of [1, -1]) {
            await rcon.run(`execute at @e[tag=${id},limit=1] run summon minecraft:zombie ~${ox} ~ ~ {Tags:["vague"],PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",count:1}],attributes:[{id:"minecraft:generic.follow_range",base:64}]}`);
          }
        }
        if (Math.ceil((hp / mob.max) * 10) === Math.ceil((mob.shown / mob.max) * 10)) continue;
        mob.shown = hp;
        await rcon.run(`data merge entity @e[tag=${id},limit=1] {CustomName:'${healthBar(mob.name, hp, mob.max, mob.color)}'}`);
      }
      // loups de l'Invocateur : pas de reproduction (délai de reproduction tenu en permanence), louveteaux retirés
      await rcon.run('execute as @e[type=minecraft:wolf,tag=pet] run data merge entity @s {Age:6000}');
      await rcon.run('kill @e[type=minecraft:wolf,tag=!pet]');
      // pas d'orbes d'expérience : la barre d'expérience sert à la progression des rôles
      await rcon.run('kill @e[type=minecraft:experience_orb]');
      // pouvoirs des élites : régénération, rage, étendard qui renforce les monstres autour
      await rcon.run('effect give @e[tag=elite_regen] minecraft:regeneration 3 1 true');
      await rcon.run('effect give @e[tag=elite_enrage] minecraft:speed 3 1 true');
      await rcon.run('execute at @e[tag=elite_etendard] run effect give @e[tag=vague,distance=..8] minecraft:strength 3 0 true');
      await rcon.run('execute at @e[tag=elite_etendard] run effect give @e[tag=vague,distance=..8] minecraft:resistance 3 0 true');
      // le Bélier défonce barricades et murs devant lui
      for (const target of [game.map.wall, 'minecraft:cobblestone', '#minecraft:planks', '#minecraft:logs']) {
        await rcon.run(`execute as @e[tag=belier] at @s rotated ~ 0 run fill ^-1 ^ ^1 ^1 ^2 ^2 minecraft:air replace ${target}`);
      }
      // tour de siège : une marche de plus à chaque passage, jusqu'au sommet du mur est
      if (siegeTower && siegeStep < 10) {
        const sx = 30 - siegeStep;
        await rcon.run(`fill ${sx} ${-60 + siegeStep} -1 ${sx} ${-60 + siegeStep} 1 minecraft:oak_stairs[facing=west]`);
        await rcon.run(`fill ${sx} ${-61 + siegeStep} -1 ${sx} ${-61} 1 minecraft:oak_planks replace minecraft:air`);
        siegeStep++;
        if (siegeStep === 10) await rcon.run('title @a actionbar {"text":"La tour de siège touche le mur est : défendez-le !","color":"gold"}');
      }
      // près du Roi (12 blocs), les monstres rejoignent l'équipe des joueurs : ils les ignorent et attaquent le Roi
      await rcon.run('team join chateau @a');
      // les monstres égarés (à plus de 70 blocs du Roi) reviennent devant la porte
      await rcon.run(`execute at ${KING} run tp @e[tag=vague,distance=70..] 0 -60 35`);
      for (const slot of SLOTS) await rcon.run(`item modify entity @a ${slot} ${UNBREAKABLE}`);
      await rcon.run(`execute at ${KING} run team join chateau @e[tag=vague,type=!creeper,distance=..12]`);
      // les creepers marchent vers le château ; arrivés contre un mur, ils s'allument et font une brèche
      await rcon.run('execute as @e[type=creeper,tag=vague] at @s facing 0 -60 0 rotated ~ 0 if block ^ ^ ^1 minecraft:air if block ^ ^1 ^1 minecraft:air run tp @s ^ ^ ^0.8');
      await rcon.run('execute as @e[type=creeper,tag=vague] at @s facing 0 -60 0 rotated ~ 0 unless block ^ ^ ^1 minecraft:air run data merge entity @s {ignited:1b}');
      // à mi-vie, le Roi des zombies appelle ses sujets (une fois)
      if (!kingCalled && n % 15 === 0) {
        for (const [id, mob] of tracked) {
          if (mob.name !== 'Roi des zombies' || mob.shown > mob.max / 2) continue;
          kingCalled = true;
          for (const [ox, oz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
            await rcon.run(`execute at @e[tag=${id},limit=1] run summon minecraft:zombie ~${ox} ~ ~${oz} {Tags:["vague"],PersistenceRequired:1b,attributes:[{id:"minecraft:generic.follow_range",base:64}]}`);
          }
          await rcon.run('title @a actionbar {"text":"Le Roi des zombies appelle ses sujets !","color":"dark_green"}');
        }
      }
      // événement aléatoire, environ quatre vagues sur dix, au bout de 25 secondes
      if (!eventDone && Date.now() - started > 25_000) {
        eventDone = true;
        const roll = Math.random();
        if (roll < 0.1) {
          await rcon.run('weather thunder 90');
          await rcon.run('execute as @e[type=creeper,tag=vague] run data merge entity @s {powered:1b}');
          await say('Orage !', 'Les creepers sont chargés');
        } else if (roll < 0.2) {
          await rcon.run('effect give @a minecraft:darkness 20 0 true');
          await say('Brouillard !', 'On ne voit plus rien…');
        } else if (roll < 0.3) {
          // météores sans casse : dégâts d'explosion autour de 8 monstres, aucun bloc touché
          await rcon.run('tag @e[tag=vague,sort=random,limit=8] add meteore');
          await rcon.run('execute at @e[tag=meteore] run particle minecraft:explosion_emitter ~ ~1 ~');
          await rcon.run('execute at @e[tag=meteore] run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 0.8');
          await rcon.run('execute at @e[tag=meteore] as @e[tag=vague,distance=..3] run damage @s 8 minecraft:explosion');
          await rcon.run('tag @e[tag=meteore] remove meteore');
          await say('Pluie de météores !', 'Le ciel tombe sur les monstres');
        } else if (roll < 0.4) {
          await rcon.run('effect give @e[tag=vague] minecraft:speed 20 1 true');
          await say('Ruée !', 'Les monstres accélèrent');
        }
      }
      // tourelles nouvellement posées : un numéro, et le joueur à moins de 8 blocs en devient le propriétaire
      const online = (await rcon.run('list')).split(':').slice(1).join(':').split(',').map((x) => x.trim()).filter(Boolean);
      for (let t = 0; t < 5; t++) {
        await rcon.run('tag @e[tag=tourelle,tag=!suivie,limit=1] add nouvelle');
        if (!/passed/.test(await rcon.run('execute if entity @e[tag=nouvelle]'))) break;
        const id = `t${RUN}_${nextTurret++}`;
        // propriétaire d'origine (étiquette proprio_…) si la tourelle a déjà été suivie, sinon le joueur le plus proche
        let owner = /"proprio_(\w+)"/.exec(await rcon.run('data get entity @e[tag=nouvelle,limit=1] Tags'))?.[1];
        for (const name of owner ? [] : online) {
          if (/passed/.test(await rcon.run(`execute at ${name} if entity @e[tag=nouvelle,distance=..8]`))) {
            owner = name;
            break;
          }
        }
        await rcon.run(`tag @e[tag=nouvelle] add ${id}`);
        if (owner) await rcon.run(`tag @e[tag=nouvelle] add proprio_${owner}`);
        await rcon.run('tag @e[tag=nouvelle] add suivie');
        await rcon.run('tag @e[tag=nouvelle] remove nouvelle');
        turrets.set(id, { owner, hp: TURRET_HP[0]!, shown: -1, level: 1 });
      }
      // tirs : chaque victime d'une tourelle compte pour son propriétaire (émeraudes, classement, rôle)
      for (const [id, turret] of turrets) {
        const owner = turret.owner;
        const tags = await rcon.run(`data get entity @e[tag=${id},limit=1] Tags`);
        if (!/data: /.test(tags)) {
          turrets.delete(id);
          continue;
        }
        const kind = TURRET_KINDS.find((k) => k.tag !== 'fleche' && tags.includes(`"${k.tag}"`)) ?? TURRET_KINDS[0]!;
        const level = turretLevel(tags);
        const range = 22 + 4 * (level - 1);
        const me = `@e[tag=${id},limit=1]`;
        const maxHp = Math.round(TURRET_HP[level - 1]! * (has(owner, 'blindage') ? 1.5 : 1));
        // une amélioration remet la vie au maximum du nouveau niveau
        if (level > turret.level) {
          turret.level = level;
          turret.hp = maxHp;
        }
        const attackers = number(await rcon.run(`execute at ${me} if entity @e[tag=vague,distance=..2]`));
        // abîmée par les monstres au contact ; sinon, elle se répare très lentement (1 point toutes les 10 s)
        turret.hp = attackers > 0 ? Math.max(0, turret.hp - attackers * TURRET_HIT) : Math.min(maxHp, turret.hp + TURRET_REGEN);
        if (turret.hp === 0) {
          await rcon.run(`execute at ${me} run particle minecraft:explosion ~ ~1 ~ 0.3 0.3 0.3 0 3`);
          await rcon.run(`execute at ${me} run playsound minecraft:entity.item.break master @a ~ ~ ~ 1 0.6`);
          await rcon.run(`kill ${me}`);
          if (owner) {
            await rcon.run(`title ${owner} actionbar {"text":"Une de vos tourelles a été détruite !","color":"red"}`);
            await rcon.run(`scoreboard players remove ${owner} tourelles 1`);
          }
          turrets.delete(id);
          continue;
        }
        if (Math.ceil(turret.hp) !== turret.shown) {
          turret.shown = Math.ceil(turret.hp);
          const stars = level > 1 ? ` ${'★'.repeat(level)}` : '';
          await rcon.run(`data merge entity ${me} {CustomName:'${healthBar(`${kind.name}${stars}`, turret.hp, maxHp, kind.color)}'}`);
        }
        const near = `@e[tag=vague,distance=..${range},limit=1,sort=nearest]`;
        const by = owner && online.includes(owner) ? ` by ${owner}` : '';
        const damage = Math.round(TURRET_DAMAGE[kind.tag]![level - 1]! * (has(owner, 'calibre') ? 1.25 : 1) * (owner && (turretBoost.get(owner) ?? 0) > Date.now() ? 3 : 1));
        // cibles du tir (le canon touche tout ce qui est à 3 blocs de la cible) ; celles qui disparaissent sont ses victimes
        if (kind.tag === 'canon') await rcon.run(`execute as ${me} at @s at ${near} run tag @e[tag=vague,distance=..3] add tir`);
        else await rcon.run(`execute as ${me} at @s run tag ${near} add tir`);
        const aimed = number(await rcon.run('execute if entity @e[tag=tir]'));
        if (aimed === 0) continue;
        await rcon.run(`execute as @e[tag=tir] run damage @s ${damage} minecraft:${kind.tag === 'canon' ? 'explosion' : 'arrow'}${by}`);
        const killed = aimed - number(await rcon.run('execute if entity @e[tag=tir]'));
        if (killed > 0 && by) turretKills.set(owner!, (turretKills.get(owner!) ?? 0) + killed);
        if (kind.tag === 'glace') await rcon.run(`effect give @e[tag=tir] minecraft:slowness 3 ${level} true`);
        // feu, et flèches enflammées au niveau 3
        if (kind.tag === 'feu' || level >= 3) await rcon.run('execute as @e[tag=tir] run data merge entity @s {Fire:120s}');
        const particle = kind.tag === 'canon' ? 'explosion' : kind.tag === 'glace' ? 'snowflake' : kind.tag === 'feu' ? 'flame' : 'crit';
        await rcon.run(`execute at @e[tag=tir] run particle minecraft:${particle} ~ ~1 ~ 0.3 0.5 0.3 0.05 ${kind.tag === 'canon' ? 1 : 12}`);
        await rcon.run(`execute at ${me} run playsound minecraft:${kind.tag === 'canon' ? 'entity.generic.explode' : 'entity.arrow.shoot'} master @a ~ ~ ~ 0.6 1.2`);
        await rcon.run('tag @e[tag=tir] remove tir');
      }
      await rcon.run(`execute as @e[tag=tourelle,type=minecraft:armor_stand] run data merge entity @s {DisabledSlots:${LOCKED_SLOTS}}`);
      // le Roi se soigne quand aucun monstre n'est près de lui ; les golems achetés tiennent mieux
      await rcon.run(`execute at ${KING} unless entity @e[tag=vague,distance=..10] run effect give ${KING} minecraft:regeneration 3 0 true`);
      await rcon.run('effect give @e[type=minecraft:iron_golem] minecraft:resistance 5 1 true');
      await rcon.run('effect give @e[type=minecraft:iron_golem] minecraft:regeneration 5 0 true');
      // le Roi commente sa vie (75 %, 50 %, 25 %)
      {
        const hp = number(await rcon.run(`data get entity ${KING} Health`));
        const max = Number(/is (-?[0-9.]+)/.exec(await rcon.run(`attribute ${KING} minecraft:generic.max_health get`))?.[1] ?? KING_BASE_HEALTH);
        for (const [key, ratio] of [['critique', 0.25], ['danger', 0.5], ['blesse', 0.75]] as const) {
          if (hp > 0 && hp < ratio * max && !kingWarned.has(key)) {
            for (const k of ['critique', 'danger', 'blesse']) if (k === key || kingWarned.has(key)) kingWarned.add(k);
            kingWarned.add(key);
            await kingSays(pick(KING_LINES[key]));
            break;
          }
        }
      }
      // une fois par vague, quand sa vie passe sous 30 %, le Roi repousse les monstres autour de lui
      if (!counterAttack) {
        const hp = number(await rcon.run(`data get entity ${KING} Health`));
        const max = Number(/is (-?[0-9.]+)/.exec(await rcon.run(`attribute ${KING} minecraft:generic.max_health get`))?.[1] ?? KING_BASE_HEALTH);
        if (hp > 0 && hp < 0.3 * max) {
          counterAttack = true;
          await rcon.run(`execute at ${KING} as @e[tag=vague,distance=..8] at @s facing entity ${KING} feet rotated ~ 0 run tp @s ^ ^ ^-6`);
          await rcon.run(`execute at ${KING} run particle minecraft:explosion_emitter ~ ~1 ~`);
          await rcon.run(`execute at ${KING} run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 1`);
          await rcon.run('title @a actionbar {"text":"Le Roi repousse les monstres !","color":"gold"}');
        }
      }
      // les sapeurs creusent un tunnel d'un bloc sur deux devant eux, dans la pierre et les briques
      await rcon.run(`execute as @e[tag=sapeur] at @s rotated ~ 0 run fill ^ ^ ^1 ^ ^1 ^1 minecraft:air replace ${game.map.wall}`);
      await rcon.run('execute as @e[tag=sapeur] at @s rotated ~ 0 run fill ^ ^ ^1 ^ ^1 ^1 minecraft:air replace minecraft:cobblestone');
      if ((await score('#equipe', 'p_murs')) > 0) await rcon.run('execute as @e[type=creeper,tag=vague] run data merge entity @s {ExplosionRadius:2b}');
      await rcon.run('bossbar set minecraft:roi players @a');
      const left = number(await rcon.run('execute if entity @e[tag=vague]'));
      remaining = left;
      await rcon.run(`bossbar set minecraft:vague value ${left}`);
      await rcon.run(`bossbar set minecraft:vague name {"text":"Vague ${n} : ${left} monstre${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}","color":"red"}`);
      // au bout d'une minute, les retardataires brillent à travers les murs
      if (!glowing && Date.now() - started > 60_000) {
        glowing = true;
        await rcon.run('effect give @e[tag=vague] minecraft:glowing infinite 0 true');
      }
      if (left === 0) break;
    }
    // récompense et répit : flèches, pomme dorée, un peu de vie pour le Roi
    await rcon.run('give @a minecraft:arrow 16');
    await rcon.run('give @a minecraft:golden_apple 1');
    await rcon.run('give @a minecraft:emerald 5');
    await rcon.run(`effect give ${KING} minecraft:instant_health 1 1 true`);
    await rcon.run('weather clear');
    await rcon.run('time set day');
    remaining = 0;
    if (n % 5 === 0) {
      await rcon.run('setblock 0 -60 15 minecraft:chest[facing=south]');
      const picks = [...LOOT].sort(() => Math.random() - 0.5).slice(0, 4);
      for (const [k, item] of picks.entries()) {
        const [id, count = '1'] = item.split(' ');
        await rcon.run(`item replace block 0 -60 15 container.${11 + k} with minecraft:${id} ${count}`);
      }
      await rcon.run('title @a actionbar {"text":"Un coffre de butin est apparu dans la cour !","color":"light_purple"}');
    }
    await kingSays(pick(KING_LINES.victoire));
    if (Math.random() < BLACK_MARKET_CHANCE) {
      await rcon.run(
        `summon minecraft:wandering_trader 0 -60 15 {CustomName:'{"text":"Marchand masqué","color":"dark_purple"}',CustomNameVisible:1b,` +
          'NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Silent:1b,DespawnDelay:0,Tags:["marchenoir"],Rotation:[180f,0f],Offers:{Recipes:[]}}',
      );
      for (const a of BLACK_MARKET) {
        const sell = `{id:"minecraft:${a.item}",count:1${a.components ? `,components:{${a.components}}` : ''}}`;
        await rcon.run(
          `execute as @e[tag=marchenoir] run data modify entity @s Offers.Recipes append value {buy:{id:"minecraft:emerald",count:${a.price}},sell:${sell},` +
            'maxUses:1,rewardExp:0b,priceMultiplier:0f,demand:0,specialPrice:0,xp:0}',
        );
      }
      await rcon.run('title @a actionbar {"text":"Un marchand masqué est dans la cour… jusqu’à la prochaine vague !","color":"dark_purple"}');
      await kingSays(pick(KING_LINES.marche));
    }
    await say(`Vague ${n} repoussée !`, 'Marchez sur la plaque dorée quand vous êtes prêts');
    await waitForStart(n + 1, PAUSE_S, 'green');
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
