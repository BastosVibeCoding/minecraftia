import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { Companion } from '../src/app.js';
import { loadConfig } from '../src/config/load.js';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS } from '../src/core/types.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { Decider } from '../src/decider/decider.js';
import { ModelRouter } from '../src/decider/router.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { MirrorStrategy } from '../src/strategy/strategy.js';
import { PlayClock } from '../src/tree/playClock.js';
import { Autonomy } from '../src/autonomy/autonomy.js';
import { ProposalBroker } from '../src/autonomy/proposals.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger } from './helpers.js';

async function companion() {
  const clock = new ManualClock(1_000_000);
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  const cache = new DecisionCache(store.db, clock);
  const router = new ModelRouter('fast', 'strong');
  const decider = new Decider({
    tree,
    llm: null,
    budget: new Budget(store.db, clock, 1),
    cache,
    router,
    strategy: new MirrorStrategy(),
    autonomy: () => Object.fromEntries(DOMAINS.map((d) => [d, { band: 'imitate' as const, score: 0.4 }])) as never,
    clock,
    logger: silentLogger,
  });
  const config = loadConfig({ FOLLOW_PLAYER: 'Bastien' });
  const c = new Companion(config, silentLogger, clock, () => ({}) as Bot, { tree, playClock: new PlayClock(store.db, clock), decider, cache, router, autonomy: new Autonomy(store), proposals: new ProposalBroker(clock) });
  return { c, clock };
}

describe('compagnon', () => {
  it("n'apprend pas de ses propres blocs : ceux qu'il pose ne sont pas attribués au joueur", async () => {
    const { c, clock } = await companion();
    c.touchBlock({ x: 5, y: 64, z: 5 });
    c.observe({ t: clock.now(), type: 'block_placed', player: 'Bastien', pos: { x: 5, y: 64, z: 5 }, block: 'stone_bricks' });
    expect(c.observer.activity()).toEqual([]);
    c.observe({ t: clock.now(), type: 'block_placed', player: 'Bastien', pos: { x: 9, y: 64, z: 5 }, block: 'stone_bricks' });
    expect(c.observer.activity()).toEqual(['build']);
  });

  it('le souvenir de ses propres blocs expire', async () => {
    const { c, clock } = await companion();
    c.touchBlock({ x: 5, y: 64, z: 5 });
    clock.advance(60_000);
    c.observe({ t: clock.now(), type: 'block_placed', player: 'Bastien', pos: { x: 5, y: 64, z: 5 }, block: 'stone_bricks' });
    expect(c.observer.activity()).toEqual(['build']);
  });
});
