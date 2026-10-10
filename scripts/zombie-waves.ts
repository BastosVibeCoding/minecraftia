/**
 * Défense du château : des vagues de zombies de plus en plus fortes attaquent le château ; les joueurs
 * défendent le Roi (un villageois immobile, étiqueté « roi »). Barre « Vague » (zombies restants),
 * barre « Vie du Roi », tableau des zombies tués. La partie s'arrête quand le Roi meurt.
 * Tout passe par RCON (aucun bot dans la partie).
 * Usage : node dist/scripts/zombie-waves.js [hôte RCON] [secondes avant la 1re vague] [numéro de la 1re vague]
 */
import { Rcon } from './rcon.js';

const [rconHost = 'localhost', firstDelay = '60', firstWave = '1'] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Points d'apparition hors des murs, surtout côté porte (sud, z positif), sol à y = -60. */
const SPAWNS: [number, number][] = [
  [-30, 50], [0, 55], [30, 50], [-50, 30], [50, 30], [-45, -10], [45, -10], [0, -45],
];
const KING = '@e[tag=roi,limit=1]';
const PAUSE_S = 20;

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
function mobCommand(n: number, i: number, x: number, z: number): string {
  const boss = n % 5 === 0 && i === 0;
  const giant = !boss && n >= 2 && i >= 1 && i <= Math.floor(n / 2);
  const ravager = n >= 6 && i === Math.floor(n / 2) + 1;
  const vindicator = !giant && !ravager && n >= 3 && i % 5 === 4;
  const type = ravager ? 'ravager' : vindicator ? 'vindicator' : n >= 5 && i % 3 === 1 && !giant ? 'husk' : 'zombie';
  const zombieLike = type === 'zombie' || type === 'husk';
  const baby = zombieLike && !boss && !giant && n >= 4 && i % 4 === 3 ? 'IsBaby:1b,' : '';
  const health = boss ? 150 + 25 * n : giant ? 50 + 10 * n : ravager ? 100 + 10 * n : 20 + 4 * n;
  const metal = n >= 6 ? 'iron' : n >= 3 ? 'chainmail' : 'leather';
  const armor = zombieLike && n >= 2 ? `ArmorItems:[{id:"minecraft:${metal}_boots",count:1},{},{id:"minecraft:${metal}_chestplate",count:1},{id:"minecraft:${metal}_helmet",count:1}],` : '';
  const weapon = vindicator ? 'HandItems:[{id:"minecraft:iron_axe",count:1},{}],' : zombieLike && n >= 3 ? `HandItems:[{id:"minecraft:${n >= 7 ? 'iron' : 'stone'}_sword",count:1},{}],` : '';
  const scale = boss ? 4 : giant ? 1.9 : 0;
  const name = boss ? 'Zombie Géant' : giant ? 'Géant' : ravager ? 'Bélier' : '';
  const attrs = [
    scale ? `{id:"minecraft:generic.scale",base:${scale}}` : '',
    `{id:"minecraft:generic.max_health",base:${health}}`,
    '{id:"minecraft:generic.follow_range",base:64}',
    giant || boss ? `{id:"minecraft:generic.attack_damage",base:${6 + n}}` : '',
    zombieLike ? `{id:"minecraft:generic.movement_speed",base:${(giant || boss ? 0.2 : 0.23 + 0.006 * n).toFixed(3)}}` : '',
  ].filter(Boolean);
  return (
    `summon minecraft:${type} ${x} -60 ${z} {Tags:["vague"],PersistenceRequired:1b,${baby}` +
    `${name ? `CustomName:'"${name}"',CustomNameVisible:1b,` : ''}${armor}${weapon}` +
    `ArmorDropChances:[0f,0f,0f,0f],HandDropChances:[0f,0f],Health:${health}f,attributes:[${attrs.join(',')}]}`
  );
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

  await say('Défendez le Roi !', `Vague ${firstWave} dans ${firstDelay} secondes`);
  for (let s = Number(firstDelay); s > 0; s -= 5) {
    await rcon.run(`bossbar set minecraft:vague name {"text":"Vague ${firstWave} dans ${s} s","color":"red"}`);
    await sleep(5000);
  }

  for (let n = Number(firstWave); ; n++) {
    const total = 4 + 3 * n;
    await say(`Vague ${n}`, n % 5 === 0 ? 'Un Zombie Géant approche…' : `${total} monstres`);
    await rcon.run(`bossbar set minecraft:vague max ${total}`);
    for (let i = 0; i < total; i++) {
      const [x, z] = SPAWNS[i % SPAWNS.length]!;
      await rcon.run(mobCommand(n, i, x + ((i * 7) % 5) - 2, z + ((i * 3) % 5) - 2));
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
