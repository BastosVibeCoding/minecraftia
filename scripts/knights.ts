/**
 * Bataille de chevaliers : deux équipes de bots (Rouge_1… contre Bleu_1…) partent de leur château,
 * marchent vers le château adverse et combattent à l'épée les chevaliers ennemis qu'ils croisent ;
 * arrivés chez l'ennemi, ils repartent vers le leur (patrouille), et ainsi de suite.
 * Équipes, armures, épées et points de réapparition sont donnés par RCON (sans rendre les bots admins).
 * Prérequis : les pseudos sont dans la liste d'accès (UUID hors ligne) ; RCON_PASSWORD dans l'environnement.
 * Usage : node dist/scripts/knights.js <hôte> [port] [chevaliers par équipe] [hôte RCON]
 */
import { Socket } from 'node:net';
import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';

const { pathfinder, Movements, goals } = pathfinderPkg;
const [host = 'localhost', port = '25565', perTeam = '5', rconHost = host] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Team {
  name: string;
  prefix: string;
  color: string;
  rgb: number;
  home: { x: number; z: number };
}
/** Intérieur des deux châteaux (sol à y = -60), de part et d'autre du spawn. */
const TEAMS: [Team, Team] = [
  { name: 'rouge', prefix: 'Rouge_', color: 'red', rgb: 0xe02020, home: { x: -35, z: 0 } },
  { name: 'bleu', prefix: 'Bleu_', color: 'blue', rgb: 0x2050e0, home: { x: 35, z: 0 } },
];
const GROUND_Y = -60;
/** Distance à laquelle un chevalier repère un ennemi et fonce sur lui. */
const SIGHT = 40;

/** Client RCON minimal (protocole Source) : une connexion, des commandes l'une après l'autre. */
class Rcon {
  private socket = new Socket();
  private buffer = Buffer.alloc(0);
  private waiting: ((body: string) => void)[] = [];
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  async connect(h: string, p: number, password: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.connect(p, h, () => resolve());
    });
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const len = this.buffer.readInt32LE(0);
        if (this.buffer.length < len + 4) break;
        const body = this.buffer.toString('utf8', 12, len + 2);
        this.buffer = this.buffer.subarray(len + 4);
        this.waiting.shift()?.(body);
      }
    });
    await this.send(3, password);
  }

  private send(type: number, body: string): Promise<string> {
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(payload.length + 14);
    packet.writeInt32LE(payload.length + 10, 0);
    packet.writeInt32LE(this.nextId++, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.socket.write(packet);
    });
  }

  /** Commande serveur ; les appels sont mis en file pour ne jamais se croiser. */
  run(command: string): Promise<string> {
    const next = this.chain.then(() => this.send(2, command));
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Armure (plastron aux couleurs de l'équipe) et épée, remises à chaque apparition. */
async function equip(rcon: Rcon, name: string, team: Team): Promise<void> {
  await rcon.run(`item replace entity ${name} armor.head with minecraft:iron_helmet`);
  await rcon.run(`item replace entity ${name} armor.chest with minecraft:leather_chestplate[dyed_color={rgb:${team.rgb}}]`);
  await rcon.run(`item replace entity ${name} armor.legs with minecraft:iron_leggings`);
  await rcon.run(`item replace entity ${name} armor.feet with minecraft:iron_boots`);
  await rcon.run(`item replace entity ${name} weapon.mainhand with minecraft:iron_sword`);
}

function knight(rcon: Rcon, name: string, team: Team, enemy: Team): void {
  const bot: Bot = mineflayer.createBot({ host, port: Number(port), username: name, version: '1.21', auth: 'offline', hideErrors: true });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);
  // en route vers le château adverse ; une fois arrivé, retour au sien (patrouille)
  let heading = enemy.home;
  let timer: NodeJS.Timeout | undefined;

  bot.once('spawn', () => {
    const moves = new Movements(bot);
    moves.canDig = false;
    moves.allow1by1towers = false;
    bot.pathfinder.setMovements(moves);
    bot.pvp.attackRange = 3;
    timer = setInterval(() => {
      if (!bot.entity) return;
      const current = bot.pvp.target;
      if (current?.isValid && current.position.distanceTo(bot.entity.position) < SIGHT) return;
      const foe = bot.nearestEntity(
        (e) => e.type === 'player' && (e.username ?? '').startsWith(enemy.prefix) && e.position.distanceTo(bot.entity.position) < SIGHT,
      );
      if (foe) {
        void bot.pvp.attack(foe);
        return;
      }
      const p = bot.entity.position;
      if (Math.hypot(p.x - heading.x, p.z - heading.z) < 5) heading = heading === enemy.home ? team.home : enemy.home;
      if (!bot.pathfinder.isMoving()) bot.pathfinder.setGoal(new goals.GoalNear(heading.x, GROUND_Y, heading.z, 3));
    }, 500);
  });
  // à chaque apparition (et réapparition au château) : équipement neuf, puis à l'attaque
  bot.on('spawn', () => {
    heading = enemy.home;
    setTimeout(() => void equip(rcon, name, team), 1000);
  });
  bot.on('death', () => console.log(`[${name}] mort au combat`));
  bot.on('kicked', (reason) => console.log(`[${name}] exclu : ${JSON.stringify(reason)}`));
  bot.on('error', (err) => console.log(`[${name}] erreur : ${err.message}`));
  bot.on('end', () => {
    if (timer) clearInterval(timer);
    console.log(`[${name}] déconnecté`);
  });
  process.once('SIGTERM', () => bot.quit());
}

async function main(): Promise<void> {
  const password = process.env.RCON_PASSWORD;
  if (!password) throw new Error('RCON_PASSWORD absent');
  const rcon = new Rcon();
  await rcon.connect(rconHost, Number(process.env.RCON_PORT ?? 25575), password);
  const n = Number(perTeam);
  await rcon.run('scoreboard objectives add morts deathCount "Morts au combat"');
  await rcon.run('scoreboard objectives setdisplay sidebar morts');
  for (const team of TEAMS) {
    await rcon.run(`team add ${team.name}`);
    await rcon.run(`team modify ${team.name} color ${team.color}`);
    await rcon.run(`team modify ${team.name} friendlyFire false`);
    for (let i = 1; i <= n; i++) {
      const name = `${team.prefix}${i}`;
      await rcon.run(`team join ${team.name} ${name}`);
    }
  }
  for (let i = 1; i <= n; i++) {
    for (const [team, enemy] of [TEAMS, [TEAMS[1], TEAMS[0]]] as [Team, Team][]) {
      const name = `${team.prefix}${i}`;
      knight(rcon, name, team, enemy);
      await sleep(1500);
      // réapparition dans son château (le joueur doit être connecté pour la commande)
      await rcon.run(`spawnpoint ${name} ${team.home.x} ${GROUND_Y} ${team.home.z}`);
      await rcon.run(`tp ${name} ${team.home.x} ${GROUND_Y} ${team.home.z}`);
    }
  }
  console.log(`bataille lancée : ${n} contre ${n}`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
