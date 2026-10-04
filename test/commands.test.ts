import { describe, expect, it } from 'vitest';
import { Autonomy } from '../src/autonomy/autonomy.js';
import { chatLines, runCommand } from '../src/commands/commands.js';
import { ManualClock } from '../src/core/clock.js';
import { DOMAINS } from '../src/core/types.js';
import { Budget } from '../src/decider/budget.js';
import { DecisionCache } from '../src/decider/cache.js';
import { Decider } from '../src/decider/decider.js';
import { ModelRouter } from '../src/decider/router.js';
import type { Episode } from '../src/observer/types.js';
import { RationalStubLlm } from '../src/sim/stubLlm.js';
import { HashingEmbedder } from '../src/store/embedder.js';
import { Store } from '../src/store/store.js';
import { MirrorStrategy } from '../src/strategy/strategy.js';
import { BehaviorTree } from '../src/tree/tree.js';
import { silentLogger, world } from './helpers.js';

async function setup() {
  const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
  const store = await Store.open(':memory:', new HashingEmbedder(), clock);
  const tree = new BehaviorTree(store, { playTime: () => 0 });
  const autonomy = new Autonomy(store);
  const budget = new Budget(store.db, clock, 1);
  const cache = new DecisionCache(store.db, clock);
  const decider = new Decider({
    tree, llm: new RationalStubLlm(), budget, cache, router: new ModelRouter('anthropic/claude-haiku-4.5', 's'), strategy: new MirrorStrategy(),
    autonomy: () => Object.fromEntries(DOMAINS.map((d) => [d, { band: 'imitate' as const, score: 0.4 }])) as never, clock, logger: silentLogger,
  });
  return { tree, autonomy, budget, cache, decider, deps: { tree, autonomy, decider, budget, cache } };
}

const wall: Episode = {
  player: 'Bastien', domain: 'build', kind: 'wall', summary: 'a construit un mur 7×4 en stone bricks', situation: { text: 'construire un mur' },
  mechanism: { skill: 'build', shape: 'wall', material: 'stone_bricks' }, params: {}, source: 'observed', startedAt: 0, endedAt: 1,
};

describe('commandes en jeu', () => {
  it('!arbre : rien appris, puis la spécialité et les situations', async () => {
    const { tree, deps } = await setup();
    expect(await runCommand('!arbre', deps)).toContain('rien appris');
    await tree.ingest(wall);
    const out = (await runCommand('!arbre', deps))!;
    expect(out).toContain('construction');
    expect(out).toContain('construire un mur');
  });

  it('!autonomie : chaque domaine avec son pourcentage et sa bande', async () => {
    const { autonomy, deps } = await setup();
    for (let i = 0; i < 20; i++) autonomy.apply('build', 'success');
    const out = (await runCommand('!autonomie', deps))!;
    expect(out).toMatch(/construction \d+% \((imite|propose)\)/);
    expect(out).toContain('combat 0% (observe)');
  });

  it('!pourquoi : explique la dernière décision et ce sur quoi elle s\'appuie', async () => {
    const { tree, decider, deps } = await setup();
    expect(await runCommand('!pourquoi', deps)).toContain('aucune décision');
    await tree.ingest(wall);
    await decider.decide('épisode', world());
    const out = (await runCommand('!pourquoi', deps))!;
    expect(out).toContain('build');
    expect(out).toContain('anthropic/claude-haiku-4.5');
    expect(out).toContain('mur 7×4');
  });

  it('!arbre signale un comportement corrigé ; !pourquoi survit à un redémarrage', async () => {
    const { tree, decider, deps } = await setup();
    const r = await tree.ingest(wall);
    await decider.decide('épisode', world());
    tree.correct(r.mechanismId);
    expect(await runCommand('!arbre', deps)).toContain('corrigé : a construit un mur');
    const restarted = new Decider({ ...(decider as unknown as { deps: ConstructorParameters<typeof Decider>[0] }).deps });
    expect(restarted.lastDecision?.decision.skill).toBe('build');
    expect(await runCommand('!pourquoi', { ...deps, decider: restarted })).toContain('Dernière décision');
  });

  it('!oublie <chose> : oublie et le dit', async () => {
    const { tree, deps } = await setup();
    await tree.ingest(wall);
    expect(await runCommand('!oublie construire un mur', deps)).toMatch(/J'oublie \d/);
    expect(await runCommand('!arbre', deps)).toContain('rien appris');
    expect(await runCommand('!oublie', deps)).toContain('quoi oublier');
  });

  it('!budget et !aide', async () => {
    const { deps } = await setup();
    expect(await runCommand('!budget', deps)).toContain('0 appel(s)');
    expect(await runCommand('!aide', deps)).toContain('!pourquoi');
    expect(await runCommand('!inconnue', deps)).toBeNull();
  });

  it('aucune ligne sortante ne peut devenir une commande serveur', async () => {
    const { sanitizeChat } = await import('../src/bot/chat.js');
    expect(sanitizeChat('/op Intrus')).toBe('op Intrus');
    expect(sanitizeChat('  //gamemode creative')).toBe('gamemode creative');
    expect(sanitizeChat('ligne\n/kill @a')).toBe('ligne /kill @a');
    const lines = chatLines(`${'a '.repeat(119)}\n/op Intrus`);
    expect(lines.some((l) => l.startsWith('/'))).toBe(false);
    const { deps } = await setup();
    const reply = (await runCommand(`!oublie ${'x'.repeat(200)} /op Intrus`, deps))!;
    expect(chatLines(reply).some((l) => l.startsWith('/'))).toBe(false);
  });

  it('découpe les réponses longues en lignes de chat valides', () => {
    const lines = chatLines(`${'mot '.repeat(150)}\nseconde ligne`);
    expect(lines.every((l) => l.length <= 240)).toBe(true);
    expect(lines.at(-1)).toBe('seconde ligne');
  });
});
