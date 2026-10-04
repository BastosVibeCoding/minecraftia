import { describe, expect, it, vi } from 'vitest';
import { untilAborted } from '../src/core/abort.js';
import { ManualClock } from '../src/core/clock.js';
import { ReflexEngine, type ReflexExecutor, type ReflexHost } from '../src/reflexes/engine.js';
import { evaluateReflexes } from '../src/reflexes/rules.js';
import type { ReflexDecision, SurvivalSnapshot } from '../src/reflexes/types.js';
import { ActionController, type ActionResult } from '../src/skills/actionController.js';
import { safeSnapshot, silentLogger, THRESHOLDS } from './helpers.js';

describe('règles de survie', () => {
  const ev = (o: Partial<SurvivalSnapshot>) => evaluateReflexes(safeSnapshot(o), THRESHOLDS);

  it('rien à faire quand tout va bien', () => expect(ev({})).toBeNull());
  it('lave en priorité absolue', () => expect(ev({ inLava: true, onFire: true, health: 2 })?.kind).toBe('escape_lava'));
  it('noyade', () => expect(ev({ headInWater: true, inWater: true, oxygen: 5 })?.kind).toBe('surface'));
  it('pas de noyade tant que l\'oxygène suffit', () => expect(ev({ headInWater: true, inWater: true, oxygen: 15 })).toBeNull());
  it('feu', () => expect(ev({ onFire: true })?.kind).toBe('extinguish'));
  it('le feu dans l\'eau ne déclenche rien', () => expect(ev({ onFire: true, inWater: true })).toBeNull());
  it('chute dangereuse avec seau d\'eau', () =>
    expect(ev({ onGround: false, velocityY: -1.2, heightAboveGround: 20, hasWaterBucket: true })?.kind).toBe('break_fall'));
  it('petite chute ignorée', () => expect(ev({ onGround: false, velocityY: -0.6, heightAboveGround: 2, hasWaterBucket: true })).toBeNull());
  it('creeper proche → fuite', () =>
    expect(ev({ hostiles: [{ name: 'creeper', distance: 3, position: { x: 3, y: 64, z: 0 } }] })?.kind).toBe('flee'));
  it('trop d\'hostiles → fuite', () => {
    const z = (d: number) => ({ name: 'zombie', distance: d, position: { x: d, y: 64, z: 0 } });
    expect(ev({ hostiles: [z(3), z(5), z(7)] })?.kind).toBe('flee');
    expect(ev({ hostiles: [z(3), z(5)] })).toBeNull();
  });
  it('vie basse sans menace → manger', () => expect(ev({ health: 5, food: 15 })?.kind).toBe('eat'));
  it('vie basse avec menace proche → fuir', () =>
    expect(ev({ health: 5, hostiles: [{ name: 'zombie', distance: 4, position: { x: 4, y: 64, z: 0 } }] })?.kind).toBe('flee'));
  it('faim → manger', () => expect(ev({ food: 4 })?.kind).toBe('eat'));
  it('faim sans nourriture → rien', () => expect(ev({ food: 4, hasFood: false })).toBeNull());
});

class FakeHost implements ReflexHost {
  snap: SurvivalSnapshot = safeSnapshot();
  private cbs = new Set<() => void>();
  snapshot() {
    return this.snap;
  }
  onTick(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  tick() {
    for (const cb of this.cbs) cb();
  }
}

class FakeExecutor implements ReflexExecutor {
  executed: ReflexDecision[] = [];
  stops = 0;
  finish: (() => void) | null = null;
  execute(d: ReflexDecision, signal: AbortSignal) {
    this.executed.push(d);
    return new Promise<void>((resolve) => {
      this.finish = resolve;
      void untilAborted(signal).then(resolve);
    });
  }
  stop() {
    this.stops++;
  }
}

function setup() {
  const clock = new ManualClock();
  const host = new FakeHost();
  const exec = new FakeExecutor();
  const results: ActionResult[] = [];
  const actions = new ActionController(clock, () => {}, (r) => results.push(r));
  const llm = vi.fn();
  const engine = new ReflexEngine(host, actions, exec, THRESHOLDS, clock, silentLogger, () => {}, 8000, 500);
  engine.start();
  return { clock, host, exec, actions, results, llm, engine };
}

describe('moteur de réflexes', () => {
  it('interrompt une action en cours dès le tick suivant, sans appel LLM', async () => {
    const { host, exec, actions, llm } = setup();
    const running = actions.run({ name: 'construire_mur', domain: 'build', timeoutMs: 600000, run: (s) => untilAborted(s) });
    host.tick(); // tout va bien
    expect(actions.isBusy).toBe(true);

    host.snap = safeSnapshot({ inLava: true });
    host.tick(); // un seul tick
    expect(actions.isBusy).toBe(false); // préemption synchrone, dans ce même tick
    const r = await running;
    expect(r.status).toBe('preempted');
    expect(r.reason).toContain('lave');
    expect(exec.executed.map((d) => d.kind)).toEqual(['escape_lava']);
    expect(llm).not.toHaveBeenCalled();
  });

  it('bloque les nouvelles actions pendant le réflexe puis libère', async () => {
    const { host, exec, actions } = setup();
    host.snap = safeSnapshot({ food: 2 });
    host.tick();
    const blocked = await actions.run({ name: 'miner', domain: 'mine', timeoutMs: 1000, run: async () => {} });
    expect(blocked.status).toBe('preempted');
    exec.finish?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.blockReason).toBeNull();
  });

  it('un réflexe plus urgent remplace un réflexe en cours, pas l\'inverse', () => {
    const { host, exec, engine } = setup();
    host.snap = safeSnapshot({ food: 2 });
    host.tick();
    expect(engine.activeReflex).toBe('eat');
    host.snap = safeSnapshot({ food: 2, inLava: true });
    host.tick();
    expect(engine.activeReflex).toBe('escape_lava');
    host.snap = safeSnapshot({ food: 2 });
    host.tick();
    expect(engine.activeReflex).toBe('escape_lava');
    expect(exec.executed.map((d) => d.kind)).toEqual(['eat', 'escape_lava']);
  });

  it('le délai maximal d\'un réflexe libère le verrou', () => {
    const { host, clock, actions, engine } = setup();
    host.snap = safeSnapshot({ onFire: true });
    host.tick();
    expect(actions.blockReason).not.toBeNull();
    host.snap = safeSnapshot();
    clock.advance(8001);
    expect(engine.activeReflex).toBeNull();
    expect(actions.blockReason).toBeNull();
  });

  it('un instantané en erreur ne casse pas le moteur', () => {
    const { host, engine } = setup();
    host.snapshot = () => {
      throw new Error('monde non chargé');
    };
    expect(() => host.tick()).not.toThrow();
    expect(engine.activeReflex).toBeNull();
  });
});

describe('délais par type de réflexe', () => {
  it('la remontée à la surface dispose de plus de temps qu\'un réflexe ordinaire', () => {
    const { host, clock, engine } = setup();
    host.snap = safeSnapshot({ headInWater: true, inWater: true, oxygen: 4 });
    host.tick();
    host.snap = safeSnapshot();
    clock.advance(8001);
    expect(engine.activeReflex).toBe('surface');
    clock.advance(12000);
    expect(engine.activeReflex).toBeNull();
  });
});

describe('normalisation de l\'oxygène', () => {
  it('ramène les ticks d\'air bruts sur 20', async () => {
    const { normalizeOxygen } = await import('../src/bot/mineflayerTypes.js');
    expect(normalizeOxygen(300, true)).toBe(20);
    expect(normalizeOxygen(120, true)).toBe(8);
    expect(normalizeOxygen(-20, true)).toBe(0);
    expect(normalizeOxygen(288, false)).toBe(19); // valeur brute reçue par erreur dans oxygenLevel
    expect(normalizeOxygen(7, false)).toBe(7);
  });
});

describe("combat sur ordre : la survie ne le sabote plus (cas réel : « défends-moi » annulé par la fuite)", () => {
  const ev = (o: Partial<SurvivalSnapshot>) => evaluateReflexes(safeSnapshot(o), THRESHOLDS);
  const z = (d: number) => ({ name: 'zombie', distance: d, position: { x: d, y: 64, z: 0 } });

  it("3 zombies pendant un combat : il reste ; encerclé (6) : il fuit", () => {
    expect(ev({ fighting: true, hostiles: [z(2), z(3), z(4)] })).toBeNull();
    expect(ev({ fighting: true, hostiles: [z(2), z(3), z(4), z(5), z(6), z(7)] })?.kind).toBe('flee');
  });

  it("les vraies urgences restent prioritaires en combat : vie basse au contact, creeper", () => {
    expect(ev({ fighting: true, health: 4, hostiles: [z(2)] })?.kind).toBe('flee');
    expect(ev({ fighting: true, hostiles: [{ name: 'creeper', distance: 2, position: { x: 2, y: 64, z: 0 } }] })?.kind).toBe('flee');
  });

  it("le moteur considère l'attaque en cours comme un combat", async () => {
    const clock = new ManualClock(0);
    const actions = new ActionController(clock, () => {});
    let snap = safeSnapshot({ hostiles: [z(2), z(3), z(4)] });
    let tick: () => void = () => {};
    const host: ReflexHost = { snapshot: () => snap, onTick: (cb) => ((tick = cb), () => {}) };
    const executor: ReflexExecutor = { execute: (_d, s) => untilAborted(s), stop: () => {} };
    const engine = new ReflexEngine(host, actions, executor, THRESHOLDS, clock, silentLogger);
    engine.start();
    void actions.run({ name: 'attack', domain: 'combat', timeoutMs: 60_000, run: (s) => untilAborted(s) });
    tick();
    expect(engine.activeReflex).toBeNull();
    expect(actions.current?.name).toBe('attack');
    snap = { ...snap };
    engine.stop();
  });
});
