/**
 * Défense du château : des vagues de zombies de plus en plus fortes attaquent le château ; les joueurs
 * défendent le Roi (un villageois immobile, étiqueté « roi »). Barre « Vague » (zombies restants),
 * barre « Vie du Roi », tableau des zombies tués. La partie s'arrête quand le Roi meurt.
 * Les sapeurs (zombies à pioche) creusent les murs de pierre ; les creepers marchent jusqu'aux murs et les font sauter.
 * Réapparition des joueurs après 5 secondes (spectateur, puis retour dans la cour).
 * Nouvelle partie (vague 1) : château remis à neuf, inventaires et scores remis à zéro, nouveau Roi.
 * Passifs permanents (vie, force, armure…) achetés au Maître des passifs, gardés d'une partie à l'autre.
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
function mobCommand(n: number, i: number, x: number, z: number, p: number, id: string): { command: string; name: string; health: number } {
  // e : vague « effective », plus avancée quand la partie est plus dure
  const e = n + (p - 1);
  const boss = n % (p > 1 ? 3 : 5) === 0 && i === 0;
  const giants = p > 1 ? Math.floor((n * p) / 2) : n >= 2 ? Math.floor(n / 2) : 0;
  const giant = !boss && i >= 1 && i <= giants;
  const ravager = n >= (p > 1 ? 3 : 6) && i === giants + 1;
  const vindicator = !giant && !ravager && n >= (p > 1 ? 2 : 3) && i % 5 === 4;
  // creepers : ils font sauter les murs (chargés quand la partie avance)
  const creeper = !giant && !ravager && !vindicator && !boss && e >= 3 && i % 6 === 5;
  const type = creeper ? 'creeper' : ravager ? 'ravager' : vindicator ? 'vindicator' : e >= 5 && i % 3 === 1 && !giant ? 'husk' : 'zombie';
  const zombieLike = type === 'zombie' || type === 'husk';
  // sapeurs : un zombie sur quatre creuse les murs de pierre (voir la boucle principale)
  const sapper = zombieLike && !boss && !giant && i % 4 === 2;
  const charged = creeper && e >= 6 && i % 12 === 11 ? 'powered:1b,' : '';
  const baby = zombieLike && !boss && !giant && e >= 4 && i % 4 === 3 ? 'IsBaby:1b,' : '';
  const health = boss ? 100 + 15 * n : giant ? 36 + 6 * n : ravager ? 70 + 6 * n : 18 + 3 * n;
  const metal = e >= 9 ? 'iron' : e >= 5 ? 'chainmail' : 'leather';
  const armor = zombieLike && e >= 2 ? `ArmorItems:[{id:"minecraft:${metal}_boots",count:1},{},{id:"minecraft:${metal}_chestplate",count:1},{id:"minecraft:${metal}_helmet",count:1,components:{"minecraft:unbreakable":{}}}],` : '';
  const weapon = vindicator ? 'HandItems:[{id:"minecraft:iron_axe",count:1},{}],' : sapper ? 'HandItems:[{id:"minecraft:iron_pickaxe",count:1},{}],' : zombieLike && e >= 5 ? `HandItems:[{id:"minecraft:${e >= 9 ? 'iron' : 'stone'}_sword",count:1},{}],` : '';
  const scale = boss ? 4 : giant ? (p > 1 && i % 2 === 0 ? 2.8 : 1.9) : 0;
  const name = boss ? 'Zombie Géant' : giant ? 'Géant' : ravager ? 'Bélier' : '';
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
    await rcon.run(`clone ${x0 + MODEL_DX} -61 -32 ${x1 + MODEL_DX} -43 32 ${x0} -61 -32`);
  }
  await rcon.run(`forceload remove ${MODEL_DX - 32} -32 ${MODEL_DX + 32} 32`);
  await rcon.run('forceload remove -32 -32 32 32');
  await rcon.run('kill @e[type=minecraft:item]');
  await rcon.run('kill @e[type=minecraft:iron_golem]');
  await rcon.run(
    "summon minecraft:villager 0 -60 -3 {CustomName:'\"Le Roi\"',CustomNameVisible:1b,NoAI:1b,PersistenceRequired:1b,Tags:[\"roi\"],Glowing:1b," +
      'Rotation:[0f,0f],VillagerData:{profession:"minecraft:cleric",level:5,type:"minecraft:plains"},Health:150f,attributes:[{id:"minecraft:generic.max_health",base:150}]}',
  );
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

/** Articles du marchand (prix en émeraudes) ; `components` au format NBT des objets. */
const SHOP: { price: number; item: string; count?: number; components?: string }[] = [
  { price: 1, item: 'flint_and_steel' },
  { price: 2, item: 'arrow', count: 32 },
  { price: 3, item: 'cooked_beef', count: 16 },
  { price: 4, item: 'golden_apple', count: 2 },
  { price: 4, item: 'shield', components: '"minecraft:enchantments":{levels:{"minecraft:unbreaking":3}}' },
  { price: 6, item: 'splash_potion', count: 3, components: '"minecraft:potion_contents":{potion:"minecraft:strong_healing"}' },
  { price: 6, item: 'tnt', count: 8 },
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
 * aussitôt et monte le niveau du passif (score `p_<clé>`), gardé d'une partie à l'autre, même après la mort du Roi.
 */
interface Passive {
  key: string;
  label: string;
  color: string;
  price: number;
  max: number;
  /** Attribut du joueur et sa valeur de base au niveau donné ; absent pour la fortune (émeraudes en plus). */
  attribute?: [string, (level: number) => number];
}
const PASSIVES: Passive[] = [
  { key: 'vie', label: '+1 cœur', color: 'red', price: 10, max: 10, attribute: ['generic.max_health', (l) => 20 + 2 * l] },
  { key: 'force', label: '+1 dégât', color: 'dark_red', price: 12, max: 5, attribute: ['generic.attack_damage', (l) => 1 + l] },
  { key: 'armure', label: "+1 point d'armure", color: 'gray', price: 10, max: 10, attribute: ['generic.armor', (l) => l] },
  { key: 'vitesse', label: '+6 % de vitesse', color: 'aqua', price: 8, max: 5, attribute: ['generic.movement_speed', (l) => 0.1 * (1 + 0.06 * l)] },
  { key: 'stabilite', label: '-10 % de recul', color: 'dark_green', price: 6, max: 5, attribute: ['generic.knockback_resistance', (l) => 0.1 * l] },
  { key: 'allonge', label: '+0,5 bloc de portée', color: 'yellow', price: 8, max: 4, attribute: ['player.entity_interaction_range', (l) => 3 + 0.5 * l] },
  { key: 'fortune', label: '+1 émeraude par monstre', color: 'green', price: 15, max: 3 },
];

/** Parchemin d'un passif (objet unique, reconnu par son étiquette `passif`). */
const scroll = (p: Passive) =>
  `{id:"minecraft:paper",count:1,components:{"minecraft:custom_data":{passif:"${p.key}"},` +
  `"minecraft:custom_name":'{"text":"Passif : ${p.label}","color":"${p.color}","italic":false}',"minecraft:enchantment_glint_override":1b}}`;

/** Le marchand, à côté du trône du Roi (invincible), avec les articles de la boutique. */
async function setUpShop(rcon: Rcon): Promise<void> {
  // le Maître des passifs, à côté des marchands
  await rcon.run('kill @e[tag=passifs]');
  await rcon.run(
    `summon minecraft:villager 4.5 -60 -2.5 {CustomName:'{"text":"Maître des passifs","color":"light_purple"}',CustomNameVisible:1b,` +
      'NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Silent:1b,' +
      'Tags:["passifs"],Rotation:[0f,0f],VillagerData:{profession:"minecraft:cleric",level:5,type:"minecraft:plains"},Offers:{Recipes:[]}}',
  );
  for (const p of PASSIVES) {
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
  for (const a of SHOP) {
    const sell = `{id:"minecraft:${a.item}",count:${a.count ?? 1}${a.components ? `,components:{${a.components}}` : ''}}`;
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
    await rcon.run(`bossbar set minecraft:roi value ${Math.max(0, Math.round(number(reply)))}`);
    return true;
  };

  // réapparition après 5 secondes : spectateur avec compte à rebours, puis retour en survie dans la cour
  await rcon.run('gamerule doImmediateRespawn true');
  await rcon.run('scoreboard objectives add morts deathCount');
  for (const p of PASSIVES) await rcon.run(`scoreboard objectives add p_${p.key} dummy`);
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
            await rcon.run(`title ${name} actionbar {"text":"Passif ${p.label} : niveau ${level + gained}/${p.max}","color":"${p.color}"}`);
          }
          if (bought > gained) await rcon.run(`give ${name} minecraft:emerald ${(bought - gained) * p.price}`);
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

  await say('Défendez le Roi !', `Vague ${firstWave} dans ${firstDelay} secondes`);
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
    await say(`Vague ${n}`, n % (p > 1 ? 3 : 5) === 0 ? 'Un Zombie Géant approche…' : `${total} monstres`);
    await rcon.run(`bossbar set minecraft:vague max ${total}`);
    for (let i = 0; i < total; i++) {
      const [x, z] = SPAWNS[i % SPAWNS.length]!;
      const id = `m${nextMob++}`;
      const mob = mobCommand(n, i, x + ((i * 7) % 5) - 2, z + ((i * 3) % 5) - 2, p, id);
      await rcon.run(mob.command);
      tracked.set(id, { name: mob.name, max: mob.health, shown: mob.health });
      if (i % 4 === 3) await sleep(1000);
    }
    const started = Date.now();
    let glowing = false;
    for (;;) {
      await sleep(2000);
      if (!(await kingAlive())) {
        await rcon.run('kill @e[tag=vague]');
        await rcon.run('bossbar set minecraft:vague name {"text":"Le Roi est mort","color":"dark_red"}');
        await say('Le Roi est mort !', `Vous avez tenu ${n - 1} vague${n - 1 > 1 ? 's' : ''}`);
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
      // le jour, les monstres ne brûlent pas
      await rcon.run('effect give @e[tag=vague] minecraft:fire_resistance infinite 0 true');
      for (const slot of SLOTS) await rcon.run(`item modify entity @a ${slot} ${UNBREAKABLE}`);
      await rcon.run(`execute at ${KING} run team join chateau @e[tag=vague,type=!creeper,distance=..12]`);
      // les creepers marchent vers le château ; arrivés contre un mur, ils s'allument et font une brèche
      await rcon.run('execute as @e[type=creeper,tag=vague] at @s facing 0 -60 0 rotated ~ 0 if block ^ ^ ^1 minecraft:air if block ^ ^1 ^1 minecraft:air run tp @s ^ ^ ^0.8');
      await rcon.run('execute as @e[type=creeper,tag=vague] at @s facing 0 -60 0 rotated ~ 0 unless block ^ ^ ^1 minecraft:air run data merge entity @s {ignited:1b}');
      // les sapeurs creusent un tunnel d'un bloc sur deux devant eux, dans la pierre et les briques
      await rcon.run('execute as @e[tag=sapeur] at @s rotated ~ 0 run fill ^ ^ ^1 ^ ^1 ^1 minecraft:air replace #minecraft:mineable/pickaxe');
      await rcon.run('bossbar set minecraft:roi players @a');
      const left = number(await rcon.run('execute if entity @e[tag=vague]'));
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
