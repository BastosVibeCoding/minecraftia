import { describe, expect, it } from 'vitest';
import { analyzeBreaking, analyzeBuild, analyzeCombat } from '../src/observer/analyzers.js';
import { newPlayerState } from '../src/observer/context.js';
import { Observer } from '../src/observer/observer.js';
import type { Episode, RawEvent } from '../src/observer/types.js';
import { builderLog, fighterLog } from '../src/sim/players.js';

const P = 'Bastien';

function wall(len: number, h: number, block = 'stone_bricks', t0 = 0): RawEvent[] {
  const out: RawEvent[] = [];
  let t = t0;
  for (let y = 0; y < h; y++) for (let x = 0; x < len; x++) out.push({ t: (t += 300), type: 'block_placed', player: P, pos: { x, y: 64 + y, z: 5 }, block });
  return out;
}

describe('analyseur de construction', () => {
  it('reconnaît un mur 7×4 en pierre taillée, symétrique, posé de bas en haut', () => {
    const ep = analyzeBuild(wall(7, 4), newPlayerState())!;
    expect(ep.kind).toBe('wall');
    expect(ep.mechanism).toMatchObject({ shape: 'wall', dims: { width: 7, height: 4, depth: 1 }, material: 'stone_bricks', symmetric: true, order: 'bottom_up' });
    expect(ep.summary).toBe('a construit un mur 7×4 en stone bricks (symétrique, de bas en haut)');
  });

  it('détecte l\'asymétrie et l\'échafaudage', () => {
    const events = wall(6, 3);
    // un bloc de couleur différente à une extrémité casse la symétrie
    events.push({ t: 9000, type: 'block_placed', player: P, pos: { x: 0, y: 67, z: 5 }, block: 'gold_block' });
    events.push({ t: 9100, type: 'block_placed', player: P, pos: { x: 3, y: 63, z: 4 }, block: 'dirt' });
    events.push({ t: 9500, type: 'block_broken', player: P, pos: { x: 3, y: 63, z: 4 }, block: 'dirt' });
    const ep = analyzeBuild(events, newPlayerState())!;
    expect(ep.mechanism.scaffolding).toBe(true);
    expect(ep.params.scaffolding).toBe(1);
  });

  it('reconnaît une maison (contour puis toit)', () => {
    const events: RawEvent[] = [];
    let t = 0;
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 5; x++)
        for (let z = 0; z < 5; z++)
          if (x === 0 || x === 4 || z === 0 || z === 4) events.push({ t: (t += 200), type: 'block_placed', player: P, pos: { x, y: 64 + y, z }, block: 'oak_planks' });
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) events.push({ t: (t += 200), type: 'block_placed', player: P, pos: { x, y: 67, z }, block: 'oak_planks' });
    const ep = analyzeBuild(events, newPlayerState())!;
    expect(ep.kind).toBe('house');
    expect(ep.mechanism.order).toBe('bottom_up');
  });

  it('ignore les poses isolées', () => {
    expect(analyzeBuild(wall(3, 1), newPlayerState())).toBeNull();
  });
});

describe('analyseur de minage', () => {
  it('reconnaît un escalier vers le fer', () => {
    const events: RawEvent[] = [];
    for (let i = 0; i < 12; i++) events.push({ t: i * 500, type: 'block_broken', player: P, pos: { x: i, y: 60 - i, z: 0 }, block: i % 4 === 3 ? 'iron_ore' : 'stone', tool: 'stone_pickaxe' });
    const ep = analyzeBreaking(events, newPlayerState(), 'mine')!;
    expect(ep.kind).toBe('staircase');
    expect(ep.mechanism).toMatchObject({ skill: 'collect', targets: ['iron_ore'], tool: 'stone_pickaxe', pattern: 'staircase' });
    expect(ep.situation.text).toContain('iron ore');
  });

  it('reconnaît un tunnel', () => {
    const events: RawEvent[] = [];
    for (let i = 0; i < 10; i++) for (const dy of [0, 1]) events.push({ t: i * 500 + dy, type: 'block_broken', player: P, pos: { x: i, y: 12 + dy, z: 0 }, block: 'deepslate' });
    expect(analyzeBreaking(events, newPlayerState(), 'mine')!.kind).toBe('tunnel');
  });
});

describe('analyseur de combat', () => {
  it('mesure la distance d\'engagement, l\'arme, le bouclier et le repli', () => {
    const state = newPlayerState();
    state.equipment.offhand = 'shield';
    const events: RawEvent[] = [
      { t: 0, type: 'attack', player: P, target: 'zombie', distance: 2.4, weapon: 'iron_sword' },
      { t: 300, type: 'damaged', player: P, health: 14 },
      { t: 700, type: 'attack', player: P, target: 'zombie', distance: 2.6, weapon: 'iron_sword' },
      { t: 900, type: 'damaged', player: P, health: 7 },
      { t: 1200, type: 'attack', player: P, target: 'zombie', distance: 2.5, weapon: 'iron_sword' },
    ];
    const ep = analyzeCombat(events, state)!;
    expect(ep.mechanism).toMatchObject({ skill: 'attack', engageDistance: 2.5, weapon: 'iron_sword', useShield: true, retreatHp: 7, style: 'cautious' });
  });
});

describe('observateur', () => {
  function run(events: RawEvent[], player = P) {
    const episodes: Episode[] = [];
    const obs = new Observer(player, (e) => episodes.push(e));
    for (const e of events) obs.push(e);
    obs.flush();
    return { episodes, obs };
  }

  it('agrège des poses en un seul épisode, pas une ligne par bloc', () => {
    const { episodes } = run(wall(7, 4));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.source).toBe('observed');
  });

  it('ignore les autres joueurs', () => {
    expect(run(wall(7, 4), 'QuelquUnDAutre').episodes).toHaveLength(0);
  });

  it('coupe en deux épisodes après un silence', () => {
    const { episodes } = run([...wall(5, 3), ...wall(5, 3, 'cobblestone', 60_000).map((e) => ({ ...e, pos: { ...(e as { pos: { x: number; y: number; z: number } }).pos, z: 8 } }) as RawEvent)]);
    expect(episodes.map((e) => e.mechanism.material)).toEqual(['stone_bricks', 'cobblestone']);
  });

  it('marque les épisodes de la fenêtre d\'enseignement', () => {
    const episodes: Episode[] = [];
    const obs = new Observer(P, (e) => episodes.push(e));
    obs.startTeaching(10_000);
    for (const e of wall(7, 4)) obs.push(e);
    obs.flush();
    expect(episodes[0]!.source).toBe('taught');
  });

  it('un joueur simulé bâtisseur produit surtout des épisodes de construction', () => {
    const { episodes } = run(builderLog(30), 'Batisseur');
    const domains = episodes.map((e) => e.domain);
    const build = domains.filter((d) => d === 'build').length;
    expect(build).toBeGreaterThan(domains.filter((d) => d === 'combat').length);
    expect(domains.filter((d) => d === 'combat')).toHaveLength(0);
    expect(episodes.some((e) => e.kind === 'house')).toBe(true);
    expect(episodes.some((e) => e.kind === 'wall' && e.mechanism.material === 'stone_bricks')).toBe(true);
  });

  it('un joueur simulé combattant produit surtout des épisodes de combat', () => {
    const { episodes } = run(fighterLog(30), 'Combattant');
    const combat = episodes.filter((e) => e.domain === 'combat');
    expect(combat.length).toBeGreaterThan(5);
    expect(episodes.filter((e) => e.domain === 'build')).toHaveLength(0);
    expect(combat.every((e) => e.mechanism.weapon === 'iron_sword')).toBe(true);
    expect(combat.some((e) => e.mechanism.useShield === true)).toBe(true);
  });
});

describe('analyseur d\'artisanat', () => {
  it('garde l\'ordre des fabrications', async () => {
    const { analyzeCraft } = await import('../src/observer/analyzers.js');
    const ep = analyzeCraft(
      [
        { t: 0, type: 'craft', player: P, item: 'oak_planks', count: 4 },
        { t: 1, type: 'craft', player: P, item: 'oak_planks', count: 4 },
        { t: 2, type: 'craft', player: P, item: 'crafting_table', count: 1 },
      ],
      newPlayerState(),
    )!;
    expect(ep.mechanism.sequence).toBe('oak_planks > crafting_table');
    expect(ep.mechanism.counts).toEqual({ oak_planks: 8, crafting_table: 1 });
  });
});

describe('semis et torches', () => {
  it('semer du blé devient un mécanisme « plant », pas une construction', () => {
    const episodes: Episode[] = [];
    const obs = new Observer(P, (e) => episodes.push(e));
    for (let i = 0; i < 6; i++) obs.push({ t: i * 400, type: 'block_placed', player: P, pos: { x: i, y: 64, z: 0 }, block: 'wheat' });
    obs.flush();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ domain: 'gather', kind: 'plant', mechanism: { skill: 'plant', seed: 'wheat_seeds', count: 6 } });
  });

  it('poser des torches devient un mécanisme « torch »', () => {
    const episodes: Episode[] = [];
    const obs = new Observer(P, (e) => episodes.push(e));
    for (let i = 0; i < 3; i++) obs.push({ t: i * 400, type: 'block_placed', player: P, pos: { x: i * 4, y: 64, z: 0 }, block: 'torch' });
    obs.flush();
    expect(episodes[0]).toMatchObject({ domain: 'survive', kind: 'light', mechanism: { skill: 'torch', count: 3 } });
  });
});
