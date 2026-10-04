import type { Bot } from 'mineflayer';
/** Le Vec3 de mineflayer (une autre copie de vec3 existe dans node_modules). */
type Vec3 = Bot['entity']['position'];
import pathfinderPkg from 'mineflayer-pathfinder';
import { isHostile, isOnFire, oxygenOf, physicsFlags, playerEntity } from '../bot/mineflayerTypes.js';
import { canSee } from '../bot/sight.js';
import { abortableSleep } from '../core/abort.js';
import type { ReflexExecutor } from './engine.js';
import type { ReflexDecision } from './types.js';

const { goals } = pathfinderPkg;
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew']);

/** Exécution physique des réflexes avec mineflayer. Tout s'arrête dès que le signal est annulé. */
export class MineflayerReflexExecutor implements ReflexExecutor {
  constructor(
    private readonly bot: Bot,
    private readonly followPlayer: string,
  ) {}

  stop(): void {
    this.bot.pathfinder?.setGoal(null);
    this.bot.clearControlStates();
    try {
      this.bot.deactivateItem();
    } catch {
      // rien en main : rien à désactiver
    }
  }

  async execute(d: ReflexDecision, signal: AbortSignal): Promise<void> {
    switch (d.kind) {
      case 'escape_lava':
        return this.escapeTo((name) => name !== 'lava' && name !== 'fire', 8, signal, () => !physicsFlags(this.bot.entity).isInLava);
      case 'extinguish':
        return this.extinguish(signal);
      case 'surface':
        return this.surface(signal);
      case 'break_fall':
        return this.breakFall(signal);
      case 'flee':
        return this.flee(signal);
      case 'eat':
        return this.eat(signal);
    }
  }

  /**
   * Se dégage vers le bloc praticable le plus proche dont les blocs vérifient `ok`.
   * Pilotage direct (regard + avancer + sauter) : le pathfinder refuse de partir d'un bloc de lave.
   * Sans cible, on s'éloigne du barycentre des blocs dangereux.
   */
  private async escapeTo(ok: (name: string) => boolean, radius: number, signal: AbortSignal, done: () => boolean) {
    const bot = this.bot;
    bot.pathfinder?.setGoal(null);
    const target = bot.findBlock({
      maxDistance: radius,
      matching: (b) => b.boundingBox === 'block' && ok(b.name),
      useExtraInfo: (b) => {
        const feet = bot.blockAt(b.position.offset(0, 1, 0));
        const head = bot.blockAt(b.position.offset(0, 2, 0));
        return Boolean(feet && head && feet.boundingBox === 'empty' && head.boundingBox === 'empty' && ok(feet.name) && ok(head.name));
      },
    });
    const me = bot.entity.position;
    // `me.offset` garde le type Vec3 de mineflayer (les blocs viennent d'une autre copie de vec3)
    let aim: typeof me | undefined = target
      ? me.offset(target.position.x + 0.5 - me.x, target.position.y + 1 - me.y, target.position.z + 0.5 - me.z)
      : undefined;
    if (!aim) {
      const danger = bot.findBlocks({ matching: (b) => !ok(b.name), maxDistance: 4, count: 64 });
      if (danger.length > 0) {
        const cx = danger.reduce((s, p) => s + p.x, 0) / danger.length + 0.5;
        const cz = danger.reduce((s, p) => s + p.z, 0) / danger.length + 0.5;
        const ax = me.x - cx;
        const az = me.z - cz;
        const n = Math.hypot(ax, az) || 1;
        aim = me.offset((ax / n) * 6, 0, (az / n) * 6);
      }
    }
    await this.steer(aim, signal, done, 1.6);
  }

  /** Regarde la cible et avance en sautant jusqu'à `done()`, puis continue un court instant. */
  private async steer(aim: Vec3 | undefined, signal: AbortSignal, done: () => boolean, eyeOffset: number) {
    const bot = this.bot;
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    bot.setControlState('forward', aim !== undefined);
    while (!signal.aborted && !done()) {
      if (aim) await bot.lookAt(aim.offset(0, eyeOffset, 0), true);
      else await bot.look(bot.entity.yaw, Math.PI / 2, true);
      await abortableSleep(50, signal);
    }
    if (!signal.aborted && aim) await abortableSleep(400, signal);
    bot.clearControlStates();
  }

  /** Bloc d'air le plus proche posé sur de l'eau ou du solide : une surface où respirer. */
  private nearestAir(radius: number): Vec3 | undefined {
    const bot = this.bot;
    const me = bot.entity.position;
    const air = bot.findBlock({
      maxDistance: radius,
      matching: (b) => b.name === 'air' || b.name === 'cave_air',
      useExtraInfo: (b) => {
        const below = bot.blockAt(b.position.offset(0, -1, 0));
        return Boolean(below && (below.name === 'water' || below.boundingBox === 'block'));
      },
    });
    return air ? me.offset(air.position.x + 0.5 - me.x, air.position.y - me.y, air.position.z + 0.5 - me.z) : undefined;
  }

  private async extinguish(signal: AbortSignal) {
    const water = this.bot.findBlock({ matching: (b) => b.name === 'water', maxDistance: 10 });
    if (water) {
      this.bot.pathfinder.setGoal(new goals.GoalNear(water.position.x, water.position.y, water.position.z, 0));
    } else {
      // pas d'eau : quitter les blocs de feu, les flammes s'éteignent seules ensuite
      const notInFire = () => {
        const here = this.bot.blockAt(this.bot.entity.position);
        return here?.name !== 'fire' && here?.name !== 'soul_fire';
      };
      await this.escapeTo((name) => name !== 'fire' && name !== 'soul_fire' && name !== 'lava', 6, signal, notInFire);
    }
    while (!signal.aborted && isOnFire(this.bot.entity)) await abortableSleep(100, signal);
  }

  private async surface(signal: AbortSignal) {
    const bot = this.bot;
    bot.pathfinder?.setGoal(null);
    const headOut = () => bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name !== 'water';
    // plafond possible (grotte immergée) : nager vers la poche d'air la plus proche, sinon tout droit vers le haut
    await this.steer(this.nearestAir(12), signal, headOut, 0);
    while (!signal.aborted && oxygenOf(bot) < 18) {
      if (!headOut()) return; // replongé : le moteur relancera le réflexe si l'oxygène est encore bas
      bot.setControlState('jump', true);
      await abortableSleep(100, signal);
    }
    // air récupéré : rejoindre la terre ferme pour ne pas recouler
    const dry = (name: string) => name !== 'water' && name !== 'lava' && name !== 'kelp' && name !== 'seagrass';
    const onLand = () => bot.entity.onGround && !physicsFlags(bot.entity).isInWater;
    if (!signal.aborted && !onLand()) await this.escapeTo(dry, 16, signal, onLand);
  }

  private async breakFall(signal: AbortSignal) {
    const bot = this.bot;
    const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
    if (!bucket) return;
    await bot.equip(bucket, 'hand');
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    while (!signal.aborted && !bot.entity.onGround) {
      const below = bot.blockAt(bot.entity.position.offset(0, -2.5, 0));
      if (below && below.boundingBox === 'block') {
        bot.activateItem();
        break;
      }
      await abortableSleep(10, signal);
    }
    while (!signal.aborted && !bot.entity.onGround && !physicsFlags(bot.entity).isInWater) await abortableSleep(20, signal);
    // à l'atterrissage, reprendre l'eau dans le seau
    const water = bot.findBlock({ matching: (b) => b.name === 'water', maxDistance: 3 });
    const empty = bot.inventory.items().find((i) => i.name === 'bucket');
    if (water && empty && !signal.aborted) {
      await bot.equip(empty, 'hand');
      await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true);
      bot.activateItem();
    }
  }

  private threatsWithin(radius: number) {
    const me = this.bot.entity.position;
    return Object.values(this.bot.entities).filter(
      (e) => e !== this.bot.entity && e.position && isHostile(e) && e.position.distanceTo(me) < radius && canSee(this.bot, e),
    );
  }

  private async flee(signal: AbortSignal) {
    const bot = this.bot;
    const threats = this.threatsWithin(16);
    if (threats.length === 0) return;
    const me = bot.entity.position;
    const centroid = threats.reduce((acc, e) => acc.plus(e.position), me.scaled(0)).scaled(1 / threats.length);
    let away = me.minus(centroid);
    away = away.norm() > 0 ? away.scaled(1 / away.norm()) : me.scaled(0).offset(1, 0, 0);
    const player = playerEntity(bot, this.followPlayer)?.position;
    if (player) {
      // fuir de préférence vers le joueur, s'il n'est pas du côté des menaces
      const toPlayer = player.minus(me);
      if (toPlayer.norm() > 0 && toPlayer.dot(away) > 0) away = away.plus(toPlayer.scaled(1 / toPlayer.norm())).scaled(0.5);
    }
    const goal = me.plus(away.scaled(16));
    bot.setControlState('sprint', true);
    bot.pathfinder.setGoal(new goals.GoalNearXZ(goal.x, goal.z, 2));
    while (!signal.aborted && this.threatsWithin(10).length > 0) await abortableSleep(200, signal);
  }

  private async eat(signal: AbortSignal) {
    const bot = this.bot;
    const foods = bot.registry.foodsByName;
    const food = bot.inventory
      .items()
      .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name))
      .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0))[0];
    if (!food || signal.aborted) return;
    bot.pathfinder.setGoal(null);
    await bot.equip(food, 'hand');
    if (signal.aborted) return;
    await bot.consume();
  }
}
