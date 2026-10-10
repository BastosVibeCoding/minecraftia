/**
 * Défense du château : des vagues de zombies de plus en plus fortes attaquent le château ; les joueurs
 * défendent le Roi (un villageois immobile, étiqueté « roi »). Barre « Vague » (zombies restants),
 * barre « Vie du Roi », tableau des zombies tués. La partie s'arrête quand le Roi meurt.
 * Les sapeurs (zombies à pioche) creusent les murs de pierre ; les creepers marchent jusqu'aux murs et les font sauter.
 * Réapparition des joueurs après 5 secondes (spectateur, puis retour dans la cour).
 * Équipement des joueurs incassable. Pièces : une émeraude par monstre tué, 5 par vague repoussée ; boutique : le marchand à côté du Roi.
 * Tout passe par RCON (aucun bot dans la partie).
 * Usage : node dist/scripts/zombie-waves.js [hôte RCON] [secondes avant la 1re vague] [numéro de la 1re vague] [difficulté : 1 normal, 2 dur…]
 */
import { Rcon } from './rcon.js';

const [rconHost = 'localhost', firstDelay = '60', firstWave = '1', power = '1'] = process.argv.slice(2);
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
function mobCommand(n: number, i: number, x: number, z: number, p: number): string {
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
  const health = Math.round((boss ? 120 + 20 * n : giant ? 40 + 8 * n : ravager ? 80 + 8 * n : 18 + 3 * n) * (1 + (p - 1) / 4));
  const metal = e >= 6 ? 'iron' : e >= 3 ? 'chainmail' : 'leather';
  const armor = zombieLike && e >= 2 ? `ArmorItems:[{id:"minecraft:${metal}_boots",count:1},{},{id:"minecraft:${metal}_chestplate",count:1},{id:"minecraft:${metal}_helmet",count:1}],` : '';
  const weapon = vindicator ? 'HandItems:[{id:"minecraft:iron_axe",count:1},{}],' : sapper ? 'HandItems:[{id:"minecraft:iron_pickaxe",count:1},{}],' : zombieLike && e >= 3 ? `HandItems:[{id:"minecraft:${e >= 7 ? 'iron' : 'stone'}_sword",count:1},{}],` : '';
  const scale = boss ? 4 : giant ? (p > 1 && i % 2 === 0 ? 2.8 : 1.9) : 0;
  const name = boss ? 'Zombie Géant' : giant ? 'Géant' : ravager ? 'Bélier' : '';
  const attrs = [
    scale ? `{id:"minecraft:generic.scale",base:${scale}}` : '',
    `{id:"minecraft:generic.max_health",base:${health}}`,
    '{id:"minecraft:generic.follow_range",base:64}',
    giant || boss ? `{id:"minecraft:generic.attack_damage",base:${(boss ? 6 : 4) + Math.floor(n / 2)}}` : '',
    zombieLike ? `{id:"minecraft:generic.movement_speed",base:${(giant || boss ? 0.2 : 0.23 + 0.006 * e).toFixed(3)}}` : '',
  ].filter(Boolean);
  return (
    `summon minecraft:${type} ${x} -60 ${z} {Tags:["vague"${sapper ? ',"sapeur"' : ''}],PersistenceRequired:1b,${baby}${charged}` +
    `${name ? `CustomName:'"${name}"',CustomNameVisible:1b,` : ''}${armor}${weapon}` +
    `ArmorDropChances:[0f,0f,0f,0f],HandDropChances:[0f,0f],Health:${health}f,attributes:[${attrs.join(',')}]}`
  );
}

/** Articles du marchand (prix en émeraudes) ; `components` au format NBT des objets. */
const SHOP: { price: number; item: string; count?: number; components?: string }[] = [
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

/** Le marchand, à côté du trône du Roi (invincible), avec les articles de la boutique. */
async function setUpShop(rcon: Rcon): Promise<void> {
  await rcon.run('kill @e[tag=marchand]');
  await rcon.run(
    "summon minecraft:villager 2.5 -60 -2.5 {CustomName:'\"Marchand\"',CustomNameVisible:1b," +
      'NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Silent:1b,' +
      'Tags:["marchand"],Rotation:[0f,0f],VillagerData:{profession:"minecraft:weaponsmith",level:5,type:"minecraft:plains"},Offers:{Recipes:[]}}',
  );
  for (const a of SHOP) {
    const sell = `{id:"minecraft:${a.item}",count:${a.count ?? 1}${a.components ? `,components:{${a.components}}` : ''}}`;
    await rcon.run(
      `data modify entity @e[tag=marchand,limit=1] Offers.Recipes append value {buy:{id:"minecraft:emerald",count:${a.price}},sell:${sell},` +
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
  await setUpShop(rcon);
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
        if (before !== undefined && k > before) await rcon.run(`give ${name} minecraft:emerald ${k - before}`);
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

  for (let n = Number(firstWave); ; n++) {
    const p = Math.max(1, Number(power));
    const total = Math.round((4 + 3 * n) * p);
    await say(`Vague ${n}`, n % (p > 1 ? 3 : 5) === 0 ? 'Un Zombie Géant approche…' : `${total} monstres`);
    await rcon.run(`bossbar set minecraft:vague max ${total}`);
    for (let i = 0; i < total; i++) {
      const [x, z] = SPAWNS[i % SPAWNS.length]!;
      await rcon.run(mobCommand(n, i, x + ((i * 7) % 5) - 2, z + ((i * 3) % 5) - 2, p));
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
        return;
      }
      await rcon.run('bossbar set minecraft:vague players @a');
      // près du Roi (12 blocs), les monstres rejoignent l'équipe des joueurs : ils les ignorent et attaquent le Roi
      await rcon.run('team join chateau @a');
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
