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
 * Barres de vie au-dessus des monstres ; cœurs des joueurs sous leur pseudo. Équipement des joueurs incassable. Pièces : une émeraude par monstre tué, 5 par vague repoussée ; boutique : le marchand à côté du Roi.
 * Tout passe par RCON (aucun bot dans la partie).
 * À lancer avec `docker run --restart unless-stopped` : après la mort du Roi, le script s'arrête et une nouvelle partie démarre.
 * Usage : node dist/scripts/zombie-waves.js [hôte RCON] [secondes avant la 1re vague] [numéro de la 1re vague] [difficulté : 1 normal, 2 dur…]
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { Rcon } from './rcon.js';

const [rconHost = 'localhost', firstDelay = '60', resumeWave = '1', power = '1'] = process.argv.slice(2);
/** Marque laissée dans le conteneur après une défaite : au redémarrage, nouvelle partie depuis la vague 1. */
const GAME_OVER_MARK = '/tmp/partie-finie';
const firstWave = existsSync(GAME_OVER_MARK) ? '1' : resumeWave;
rmSync(GAME_OVER_MARK, { force: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Points d'apparition hors des murs, surtout côté porte (sud, z positif), sol à y = -60. */
const SPAWNS: [number, number][] = [
  [-30, 50], [0, 55], [30, 50], [-50, 30], [50, 30], [-45, -10], [45, -10], [0, -45],
];
const KING = '@e[tag=roi,limit=1]';
/** Équipement incassable et réparé : seulement les objets qui ont une durabilité (flèches et blocs intacts). */
const UNBREAKABLE =
  '{"function":"minecraft:filtered","item_filter":{"predicates":{"minecraft:damage":{}}},' +
  '"modifier":{"function":"minecraft:set_components","components":{"minecraft:unbreakable":{},"minecraft:damage":0}}}';
const SLOTS = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet', 'weapon.offhand', ...Array.from({ length: 9 }, (_, i) => `hotbar.${i}`), ...Array.from({ length: 27 }, (_, i) => `inventory.${i}`)];
const PAUSE_S = 20;
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

function mobCommand(n: number, i: number, x: number, z: number, p: number, id: string): { command: string; name: string; health: number } {
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
  const zombieLike = type === 'zombie' || type === 'husk';
  const archer = type === 'skeleton' || type === 'stray';
  // sapeurs : un zombie sur quatre creuse les murs de pierre (voir la boucle principale)
  const sapper = zombieLike && !boss && !giant && i % 4 === 2;
  const charged = creeper && e >= 6 && i % 12 === 11 ? 'powered:1b,' : '';
  const baby = zombieLike && !boss && !giant && e >= 4 && i % 4 === 3 ? 'IsBaby:1b,' : '';
  const health = boss ? 100 + 15 * n : giant ? 36 + 6 * n : ravager ? 70 + 6 * n : 18 + 3 * n;
  const metal = e >= 9 ? 'iron' : e >= 5 ? 'chainmail' : 'leather';
  const armor = (zombieLike || archer) && e >= 2 ? `ArmorItems:[{id:"minecraft:${metal}_boots",count:1},{},{id:"minecraft:${metal}_chestplate",count:1},{id:"minecraft:${metal}_helmet",count:1,components:{"minecraft:unbreakable":{}}}],` : '';
  const weapon = archer ? 'HandItems:[{id:"minecraft:bow",count:1},{}],' : vindicator ? 'HandItems:[{id:"minecraft:iron_axe",count:1},{}],' : sapper ? 'HandItems:[{id:"minecraft:iron_pickaxe",count:1},{}],' : zombieLike && e >= 5 ? `HandItems:[{id:"minecraft:${e >= 9 ? 'iron' : 'stone'}_sword",count:1},{}],` : '';
  const scale = boss ? 4 : giant ? (p > 1 && i % 2 === 0 ? 2.8 : 1.9) : 0;
  const name = boss ? 'Zombie Géant' : giant ? (archer ? 'Archer géant' : type === 'spider' ? 'Araignée géante' : 'Géant') : ravager ? 'Bélier' : '';
  const attrs = [
    scale ? `{id:"minecraft:generic.scale",base:${scale}}` : '',
    `{id:"minecraft:generic.max_health",base:${health}}`,
    '{id:"minecraft:generic.follow_range",base:64}',
    giant || boss ? `{id:"minecraft:generic.attack_damage",base:${(boss ? 6 : 4) + Math.floor(n / 3)}}` : zombieLike ? `{id:"minecraft:generic.attack_damage",base:${3 + Math.floor(n / 4)}}` : '',
    zombieLike ? `{id:"minecraft:generic.movement_speed",base:${(giant || boss ? 0.2 : 0.23 + 0.006 * e).toFixed(3)}}` : '',
  ].filter(Boolean);
  const command =
    `summon minecraft:${type} ${x} -60 ${z} {Tags:["vague","${id}"${sapper ? ',"sapeur"' : ''}],PersistenceRequired:1b,${baby}${charged}` +
    `CustomName:'${healthBar(name, health, health)}',CustomNameVisible:1b,${armor}${weapon}` +
    `ArmorDropChances:[0f,0f,0f,0f],HandDropChances:[0f,0f],Health:${health}f,attributes:[${attrs.join(',')}]}`;
  return { command, name, health };
}

/** Nom affiché au-dessus d'un monstre : son nom éventuel et une barre de vie (verte, jaune, rouge). */
function healthBar(name: string, hp: number, max: number): string {
  const filled = Math.max(0, Math.min(10, Math.ceil((hp / max) * 10)));
  const color = filled > 6 ? 'green' : filled > 3 ? 'yellow' : 'red';
  const parts = [
    ...(name ? [`{"text":"${name} ","color":"white"}`] : []),
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

/** Équipement de départ, redonné à chaque nouvelle partie. */
const KIT = [
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'iron_sword[enchantments={levels:{"minecraft:sharpness":2}}]',
  'bow[enchantments={levels:{"minecraft:power":2,"minecraft:infinity":1}}]',
  'arrow 64', 'shield', 'flint_and_steel', 'cooked_beef 32', 'cobblestone 64',
];
/** Copie intacte du château, 1000 blocs plus à l'est, recopiée sur le château à chaque nouvelle partie. */
const MODEL_DX = 1000;

/**
 * Nouvelle partie : château remis à neuf (blocs posés retirés, brèches rebouchées, coffre rempli),
 * inventaires vidés puis kit de départ, scores à zéro, nouveau Roi, tout le monde dans la cour.
 */
async function newGame(rcon: Rcon): Promise<void> {
  await rcon.run('kill @e[tag=vague]');
  await rcon.run('kill @e[tag=roi]');
  await rcon.run('kill @e[type=minecraft:zombie_villager]');
  await rcon.run(`forceload add ${MODEL_DX - 32} -32 ${MODEL_DX + 32} 32`);
  await rcon.run('forceload add -32 -32 32 32');
  for (const [x0, x1] of [[-32, -11], [-10, 11], [12, 32]] as const) {
    await rcon.run(`clone ${x0 + MODEL_DX} -62 -32 ${x1 + MODEL_DX} -43 32 ${x0} -62 -32`);
  }
  await rcon.run(`forceload remove ${MODEL_DX - 32} -32 ${MODEL_DX + 32} 32`);
  await rcon.run('forceload remove -32 -32 32 32');
  await rcon.run('kill @e[type=minecraft:item]');
  await rcon.run('kill @e[type=minecraft:iron_golem]');
  await rcon.run('kill @e[type=minecraft:snow_golem]');
  await rcon.run('kill @e[tag=tourelle]');
  await rcon.run('kill @e[tag=marchenoir]');
  // passifs remis à zéro : ils ne servent que pendant la partie en cours (Bénédiction du Roi comprise)
  for (const p of [...PASSIVES, BLESSING, REPAIR, ...UPGRADES]) await rcon.run(`scoreboard players reset * p_${p.key}`);
  await rcon.run(
    "summon minecraft:villager 0 -60 -3 {CustomName:'\"Le Roi\"',CustomNameVisible:1b,NoAI:1b,PersistenceRequired:1b,Tags:[\"roi\"],Glowing:1b," +
      'Rotation:[0f,0f],VillagerData:{profession:"minecraft:cleric",level:5,type:"minecraft:plains"},Health:150f,attributes:[{id:"minecraft:generic.max_health",base:150}]}',
  );
  // vie maximale du Roi selon la Bénédiction (remise à zéro juste avant : le Roi repart à 150)
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
const TURRET_DAMAGE: Record<string, [number, number, number]> = { fleche: [5, 8, 12], glace: [3, 4, 6], feu: [4, 6, 9], canon: [4, 6, 9] };
/** Emplacements d'un support d'armure tous verrouillés : on ne peut rien lui prendre ni lui mettre. */
const LOCKED_SLOTS = 4144959;
const turretComponents = (k: TurretKind) =>
  `"minecraft:custom_name":'{"text":"${k.name}","color":"${k.color}","italic":false}',"minecraft:entity_data":{id:"minecraft:armor_stand",` +
  `Tags:["tourelle","${k.tag}"],Invulnerable:1b,NoBasePlate:1b,DisabledSlots:${LOCKED_SLOTS},CustomName:'"${k.name}"',CustomNameVisible:1b,` +
  `ArmorItems:[{},{},{},{id:"minecraft:${k.head}",count:1}]}`;
/** Sélecteur d'un type (les tourelles posées avant les types, étiquette « tourelle » seule, tirent des flèches). */
const kindSelector = (k: TurretKind) => (k.tag === 'fleche' ? 'tag=!glace,tag=!feu,tag=!canon' : `tag=${k.tag}`);
/** Parchemin d'amélioration de tourelle : à garder sur soi en s'approchant d'une tourelle (3 niveaux). */
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
  // tourelles : supports d'armure verrouillés à poser où l'on veut, qui tirent sur les monstres
  ...TURRET_KINDS.map((k) => ({ price: k.price, item: 'armor_stand', components: turretComponents(k) })),
  { price: 10, item: 'paper', components: scrollComponents(TURRET_UPGRADE) },
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
  { key: 'fortune', short: 'Fortune', label: '+1 émeraude par monstre', color: 'green', price: 15, max: 3 },
];

/** Bénédiction du Roi : passif d'équipe (score de « #equipe »), +25 de vie maximale pour le Roi par niveau, jusqu'à la fin de la partie. */
const BLESSING: Passive = { key: 'roi', short: 'Roi', label: '+25 vie max du Roi', color: 'gold', price: 15, max: 10 };
const KING_BASE_HEALTH = 150;
const kingHealth = (level: number) => KING_BASE_HEALTH + 25 * level;

/** Parchemin d'un passif (objet unique, reconnu par son étiquette `passif`). */
const scroll = (p: Passive) =>
  `{id:"minecraft:paper",count:1,components:{"minecraft:custom_data":{passif:"${p.key}"},` +
  `"minecraft:custom_name":'{"text":"Passif : ${p.label}","color":"${p.color}","italic":false}',"minecraft:enchantment_glint_override":1b}}`;


/** Améliorations d'équipe, vendues en parchemins par les marchands, valables jusqu'à la fin de la partie. */
const REPAIR: Passive = { key: 'reparation', short: 'Réparation', label: 'Réparation des murs', color: 'green', price: 10, max: 99 };
const UPGRADES: Passive[] = [
  { key: 'murs', short: 'Murs renforcés', label: 'Murs renforcés (sapeurs et creepers moins efficaces)', color: 'dark_gray', price: 25, max: 1 },
  { key: 'douves', short: 'Douves', label: 'Douves autour du château', color: 'blue', price: 20, max: 1 },
  { key: 'tours', short: "Tours d’archers", label: "Deux tours d’archers dans la cour", color: 'gold', price: 20, max: 1 },
];

/** Effet d'une amélioration du château (réparation : recopie des murs intacts, sans effacer les blocs posés). */
async function applyUpgrade(rcon: Rcon, key: string): Promise<void> {
  await rcon.run(`forceload add ${MODEL_DX - 32} -32 ${MODEL_DX + 32} 32`);
  await rcon.run('forceload add -32 -32 32 32');
  if (key === 'reparation') {
    for (const [x0, x1] of [[-32, -11], [-10, 11], [12, 32]] as const) {
      await rcon.run(`clone ${x0 + MODEL_DX} -60 -32 ${x1 + MODEL_DX} -43 32 ${x0} -60 -32 masked`);
    }
    const walls = Number(/has (-?\d+)/.exec(await rcon.run('scoreboard players get #equipe p_murs'))?.[1] ?? 0);
    if (walls > 0) await applyUpgrade(rcon, 'murs');
  } else if (key === 'murs') {
    for (const [x0, x1] of [[-24, -1], [0, 24]] as const) {
      await rcon.run(`fill ${x0} -61 -24 ${x1} -43 24 minecraft:deepslate_bricks replace #minecraft:stone_bricks`);
    }
  } else if (key === 'douves') {
    for (const box of ['-26 -62 -26 26 -61 -23', '-26 -62 23 -3 -61 26', '3 -62 23 26 -61 26', '23 -62 -22 26 -61 22', '-26 -62 -22 -23 -61 22']) {
      await rcon.run(`fill ${box} minecraft:water replace #minecraft:dirt`);
    }
  } else if (key === 'tours') {
    for (const cx of [-12, 12]) {
      const cz = 14;
      await rcon.run(`fill ${cx - 2} -60 ${cz - 2} ${cx + 2} -48 ${cz + 2} minecraft:stone_bricks hollow`);
      await rcon.run(`fill ${cx - 2} -47 ${cz - 2} ${cx + 2} -47 ${cz + 2} minecraft:stone_brick_wall hollow`);
      await rcon.run(`fill ${cx} -60 ${cz + 1} ${cx} -48 ${cz + 1} minecraft:ladder[facing=north]`);
      await rcon.run(`fill ${cx} -60 ${cz - 2} ${cx} -59 ${cz - 2} minecraft:air`);
      await rcon.run(`setblock ${cx} -46 ${cz} minecraft:lantern`);
    }
  }
  await rcon.run(`forceload remove ${MODEL_DX - 32} -32 ${MODEL_DX + 32} 32`);
  await rcon.run('forceload remove -32 -32 32 32');
}

/** Le marchand, à côté du trône du Roi (invincible), avec les articles de la boutique. */
async function setUpShop(rcon: Rcon): Promise<void> {
  // le Maître des passifs, à côté des marchands
  await rcon.run('kill @e[tag=passifs]');
  await rcon.run(
    `summon minecraft:villager 4.5 -60 -2.5 {CustomName:'{"text":"Maître des passifs","color":"light_purple"}',CustomNameVisible:1b,` +
      'NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Silent:1b,' +
      'Tags:["passifs"],Rotation:[0f,0f],VillagerData:{profession:"minecraft:cleric",level:5,type:"minecraft:plains"},Offers:{Recipes:[]}}',
  );
  for (const p of [...PASSIVES, BLESSING]) {
    await rcon.run(
      `data modify entity @e[tag=passifs,limit=1] Offers.Recipes append value {buy:{id:"minecraft:emerald",count:${p.price}},sell:${scroll(p)},` +
        'maxUses:99999,rewardExp:0b,priceMultiplier:0f,demand:0,specialPrice:0,xp:0}',
    );
  }
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

async function main(): Promise<void> {
  const password = process.env.RCON_PASSWORD;
  if (!password) throw new Error('RCON_PASSWORD absent');
  const rcon = new Rcon();
  await rcon.connect(rconHost, Number(process.env.RCON_PORT ?? 25575), password);
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
  for (const rule of ['logAdminCommands false', 'sendCommandFeedback false', 'commandBlockOutput false']) await rcon.run(`gamerule ${rule}`);
  await setUpShop(rcon);
  if (firstWave === '1') await newGame(rcon);
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
  setInterval(() => {
    void (async () => {
      const online = (await rcon.run('list')).split(':').slice(1).join(':').split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of online) {
        const k = await score(name, 'tues');
        const before = kills.get(name);
        kills.set(name, k);
        const levels = new Map<string, number>();
        for (const p of PASSIVES) levels.set(p.key, await score(name, `p_${p.key}`));
        // pièces : une émeraude par monstre tué, plus le passif Fortune
        if (before !== undefined && k > before) await rcon.run(`give ${name} minecraft:emerald ${(k - before) * (1 + (levels.get('fortune') ?? 0))}`);
        // parchemins achetés : consommés, niveau monté (au-delà du maximum, remboursés)
        for (const p of PASSIVES) {
          const bought = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data={passif:"${p.key}"}]`))?.[1] ?? 0);
          if (bought === 0) continue;
          const level = levels.get(p.key) ?? 0;
          const gained = Math.min(bought, p.max - level);
          if (gained > 0) {
            levels.set(p.key, level + gained);
            await rcon.run(`scoreboard players set ${name} p_${p.key} ${level + gained}`);
            await rcon.run(`title ${name} times 5 40 10`);
            await rcon.run(`title ${name} subtitle {"text":"Passif ${p.label} : niveau ${level + gained}/${p.max}","color":"${p.color}"}`);
            await rcon.run(`title ${name} title {"text":""}`);
          }
          if (bought > gained) await rcon.run(`give ${name} minecraft:emerald ${(bought - gained) * p.price}`);
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
        // amélioration de tourelle : le parchemin sert quand on se tient à 3 blocs d'une tourelle pas au maximum
        const scrollItem = `minecraft:paper[minecraft:custom_data={passif:"${TURRET_UPGRADE.key}"}]`;
        if (/Found/.test(await rcon.run(`clear ${name} ${scrollItem} 0`)) && /passed/.test(await rcon.run(`execute at ${name} if entity @e[tag=tourelle,tag=!lvl3,distance=..3]`))) {
          await rcon.run(`clear ${name} ${scrollItem} 1`);
          await rcon.run(`execute at ${name} run tag @e[tag=tourelle,tag=!lvl3,distance=..3,limit=1,sort=nearest] add cible`);
          await rcon.run('tag @e[tag=cible,tag=lvl2] add lvl3');
          await rcon.run('tag @e[tag=cible,tag=lvl3] remove lvl2');
          await rcon.run('tag @e[tag=cible,tag=!lvl2,tag=!lvl3] add lvl2');
          for (const kind of TURRET_KINDS) {
            for (const [lvl, stars] of [[2, '★★'], [3, '★★★']] as const) {
              await rcon.run(`execute as @e[tag=cible,${kindSelector(kind)},tag=lvl${lvl}] run data merge entity @s {CustomName:'{"text":"${kind.name} ${stars}","color":"${kind.color}"}'}`);
            }
          }
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
          if (bought > gained) await rcon.run(`give ${name} minecraft:emerald ${(bought - gained) * u.price}`);
        }
        // Bénédiction du Roi : parchemin consommé, niveau de l'équipe monté, Roi renforcé et soigné
        const blessed = Number(/Removed (\d+)/.exec(await rcon.run(`clear ${name} minecraft:paper[minecraft:custom_data={passif:"${BLESSING.key}"}]`))?.[1] ?? 0);
        if (blessed > 0) {
          const level = await score('#equipe', `p_${BLESSING.key}`);
          const gained = Math.min(blessed, BLESSING.max - level);
          if (gained > 0) {
            await rcon.run(`scoreboard players set #equipe p_${BLESSING.key} ${level + gained}`);
            await rcon.run(`attribute ${KING} minecraft:generic.max_health base set ${kingHealth(level + gained)}`);
            await rcon.run(`effect give ${KING} minecraft:instant_health 1 3 true`);
            await rcon.run('title @a times 5 40 10');
            await rcon.run(`title @a subtitle {"text":"${name} bénit le Roi : niveau ${level + gained}/${BLESSING.max}","color":"gold"}`);
            await rcon.run('title @a title {"text":""}');
          }
          if (blessed > gained) await rcon.run(`give ${name} minecraft:emerald ${(blessed - gained) * BLESSING.price}`);
        }
        // passifs affichés en permanence au-dessus de la barre d'objets (sauf pendant le compte à rebours)
        if (!waiting.has(name)) {
          const owned = PASSIVES.filter((p) => (levels.get(p.key) ?? 0) > 0);
          const parts: string[] = owned.length
            ? owned.map((p, i) => `{"text":"${i ? ' · ' : ''}${p.short} ${levels.get(p.key)}","color":"${p.color}"}`)
            : ['{"text":"Aucun passif : voyez le Maître des passifs","color":"gray"}'];
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
          await rcon.run(`attribute ${name} minecraft:${attribute} base set ${value(levels.get(p.key) ?? 0)}`);
        }
        if (waiting.has(name) || number(await rcon.run(`scoreboard players get ${name} morts`).then((r) => r.replace(/has (-?\d+)/, 'count: $1'))) < 1) continue;
        waiting.add(name);
        await rcon.run(`scoreboard players set ${name} morts 0`);
        await rcon.run(`gamemode spectator ${name}`);
        for (let s = RESPAWN_S; s > 0; s--) {
          await rcon.run(`title ${name} actionbar {"text":"Réapparition dans ${s} s","color":"red"}`);
          await sleep(1000);
        }
        await rcon.run(`tp ${name} 0 -60 12`);
        await rcon.run(`gamemode survival ${name}`);
        await rcon.run(`effect give ${name} minecraft:resistance 3 4 true`);
        waiting.delete(name);
      }
    })();
  }, 1000);

  await rcon.run('scoreboard objectives add record dummy');
  const best = await score('#meilleur', 'record');
  await say('Défendez le Roi !', `Vague ${firstWave} dans ${firstDelay} secondes${best ? ` · record : vague ${best}` : ''}`);
  for (let s = Number(firstDelay); s > 0; s -= 5) {
    await rcon.run(`bossbar set minecraft:vague name {"text":"Vague ${firstWave} dans ${s} s","color":"red"}`);
    await sleep(5000);
  }

  /** Monstres des vagues encore en vie : étiquette unique → nom, vie maximale, dernière vie affichée. */
  const tracked = new Map<string, { name: string; max: number; shown: number }>();
  let nextMob = 0;
  for (let n = Number(firstWave); ; n++) {
    const p = Math.max(1, Number(power));
    const total = Math.round((4 + 3 * n) * p);
    const theme = waveTheme(n);
    const boss = n % (p > 1 ? 3 : 5) === 0;
    await rcon.run('kill @e[tag=marchenoir]');
    if (n === 21) {
      await say('Mode Infini !', 'Les vagues ne s’arrêteront plus : battez le record');
      await kingSays(pick(KING_LINES.infini));
    }
    await kingSays(pick(boss || n % 10 === 0 || n % 15 === 0 || n === 20 ? KING_LINES.boss : KING_LINES.vague));
    await say(n > 20 ? `Vague ${n} (Infini)` : `Vague ${n}`, boss ? 'Un Zombie Géant et son Nécromancien approchent…' : theme === 'araignées' ? 'Vague des araignées : elles escaladent les murs !' : theme === 'squelettes' ? 'Vague des archers squelettes !' : `${total} monstres`);
    await rcon.run(`bossbar set minecraft:vague max ${total}`);
    for (let i = 0; i < total; i++) {
      const [x, z] = SPAWNS[i % SPAWNS.length]!;
      const id = `m${nextMob++}`;
      const mob = mobCommand(n, i, x + ((i * 7) % 5) - 2, z + ((i * 3) % 5) - 2, p, id);
      await rcon.run(mob.command);
      tracked.set(id, { name: mob.name, max: mob.health, shown: mob.health });
      if (i % 4 === 3) await sleep(1000);
    }
    if (boss) {
      const id = `m${nextMob++}`;
      const hp = 60 + 5 * n;
      await rcon.run(
        `summon minecraft:evoker 0 -60 50 {Tags:["vague","${id}"],PersistenceRequired:1b,CustomName:'${healthBar('Nécromancien', hp, hp)}',CustomNameVisible:1b,` +
          `Health:${hp}f,attributes:[{id:"minecraft:generic.max_health",base:${hp}},{id:"minecraft:generic.follow_range",base:64}]}`,
      );
      tracked.set(id, { name: 'Nécromancien', max: hp, shown: hp });
    }
    // boss uniques : Chef des pillards (toutes les 10 vagues), Roi des zombies (toutes les 15), Wither affaibli (vague 20)
    const extraBoss = async (command: string, name: string, hp: number, count: number) => {
      const id = `m${nextMob++}`;
      await rcon.run(command.replace('TAGS', `Tags:["vague","${id}"]`).replace('NAME', `CustomName:'${healthBar(name, hp, hp)}',CustomNameVisible:1b`));
      tracked.set(id, { name, max: hp, shown: hp });
      extra += count;
    };
    let extra = boss ? 1 : 0;
    if (n % 10 === 0) {
      const hp = 150 + 10 * n;
      await extraBoss(
        `summon minecraft:ravager 0 -60 52 {TAGS,NAME,PersistenceRequired:1b,Health:${hp}f,attributes:[{id:"minecraft:generic.max_health",base:${hp}},{id:"minecraft:generic.follow_range",base:64}],` +
          'Passengers:[{id:"minecraft:pillager",Tags:["vague"],PersistenceRequired:1b,HandItems:[{id:"minecraft:crossbow",count:1},{}],attributes:[{id:"minecraft:generic.follow_range",base:64}]}]}',
        'Chef des pillards', hp, 2,
      );
    }
    if (n % 15 === 0) {
      const hp = 200 + 10 * n;
      await extraBoss(
        `summon minecraft:zombie 0 -60 52 {TAGS,NAME,PersistenceRequired:1b,Health:${hp}f,ArmorItems:[{},{},{},{id:"minecraft:golden_helmet",count:1,components:{"minecraft:unbreakable":{}}}],` +
          `HandItems:[{id:"minecraft:golden_sword",count:1},{}],attributes:[{id:"minecraft:generic.max_health",base:${hp}},{id:"minecraft:generic.scale",base:2.5},{id:"minecraft:generic.follow_range",base:64},{id:"minecraft:generic.attack_damage",base:8}]}`,
        'Roi des zombies', hp, 1,
      );
    }
    if (n === 20) {
      await extraBoss('summon minecraft:wither 0 -45 50 {TAGS,NAME,PersistenceRequired:1b,Health:150f}', 'Wither affaibli', 150, 1);
      await rcon.run('title @a actionbar {"text":"Le boss final : le Wither !","color":"dark_purple"}');
    }
    await rcon.run(`bossbar set minecraft:vague max ${total + extra}`);
    let kingCalled = false;
    let eventDone = false;
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
          tracked.delete(id);
          continue;
        }
        const hp = number(reply);
        if (Math.ceil((hp / mob.max) * 10) === Math.ceil((mob.shown / mob.max) * 10)) continue;
        mob.shown = hp;
        await rcon.run(`data merge entity @e[tag=${id},limit=1] {CustomName:'${healthBar(mob.name, hp, mob.max)}'}`);
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
          await rcon.run('execute as @e[tag=vague,sort=random,limit=8] at @s run summon minecraft:tnt ~ ~15 ~ {fuse:45}');
          await say('Pluie de météores !', 'Le ciel tombe sur les monstres');
        } else if (roll < 0.4) {
          await rcon.run('effect give @e[tag=vague] minecraft:speed 20 1 true');
          await say('Ruée !', 'Les monstres accélèrent');
        }
      }
      // les tourelles tirent sur le monstre le plus proche, selon leur type et leur niveau
      for (const level of [1, 2, 3]) {
        const range = 22 + 6 * (level - 1);
        const levelSel = level === 1 ? 'tag=!lvl2,tag=!lvl3' : `tag=lvl${level}`;
        const near = `@e[tag=vague,distance=..${range},limit=1,sort=nearest]`;
        for (const kind of TURRET_KINDS) {
          const turrets = `@e[tag=tourelle,${kindSelector(kind)},${levelSel}]`;
          const damage = TURRET_DAMAGE[kind.tag]![level - 1];
          if (kind.tag === 'canon') {
            // explosion légère : touche tous les monstres à 3 blocs de la cible, sans casser de blocs
            await rcon.run(`execute as ${turrets} at @s at ${near} as @e[tag=vague,distance=..3] run damage @s ${damage} minecraft:explosion`);
            await rcon.run(`execute as ${turrets} at @s at ${near} run particle minecraft:explosion ~ ~1 ~ 1 0.5 1 0 3`);
            await rcon.run(`execute as ${turrets} at @s if entity ${near} run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 0.5 1.4`);
            continue;
          }
          await rcon.run(`execute as ${turrets} at @s run damage ${near} ${damage} minecraft:arrow`);
          if (kind.tag === 'glace') await rcon.run(`execute as ${turrets} at @s as ${near} run effect give @s minecraft:slowness 3 ${level} true`);
          // feu, et flèches enflammées au niveau 3
          if (kind.tag === 'feu' || level === 3) await rcon.run(`execute as ${turrets} at @s as ${near} run data merge entity @s {Fire:120s}`);
          const particle = kind.tag === 'glace' ? 'snowflake' : kind.tag === 'feu' ? 'flame' : 'crit';
          await rcon.run(`execute as ${turrets} at @s as ${near} at @s run particle minecraft:${particle} ~ ~1 ~ 0.3 0.5 0.3 0.05 12`);
          await rcon.run(`execute as ${turrets} at @s if entity ${near} run playsound minecraft:entity.arrow.shoot master @a ~ ~ ~ 0.6 1.2`);
        }
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
      await rcon.run('execute as @e[tag=sapeur] at @s rotated ~ 0 run fill ^ ^ ^1 ^ ^1 ^1 minecraft:air replace #minecraft:stone_bricks');
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
    await say(`Vague ${n} repoussée !`, `Prochaine vague dans ${PAUSE_S} secondes`);
    for (let s = PAUSE_S; s > 0; s -= 5) {
      await rcon.run(`bossbar set minecraft:vague name {"text":"Vague ${n + 1} dans ${s} s","color":"green"}`);
      await kingAlive();
      await sleep(5000);
    }
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
