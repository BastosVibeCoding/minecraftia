import { describe, expect, it } from 'vitest';
import { untilAborted } from '../src/core/abort.js';
import { ManualClock } from '../src/core/clock.js';
import { ActionController, type Action } from '../src/skills/actionController.js';

function longAction(name = 'long'): Action {
  return { name, domain: 'build', timeoutMs: 60000, run: (signal) => untilAborted(signal) };
}

describe('ActionController', () => {
  it('rapporte un succès', async () => {
    const ctl = new ActionController(new ManualClock(), () => {});
    const r = await ctl.run({ name: 'ok', domain: 'mine', timeoutMs: 1000, run: async () => ({ detail: { n: 1 } }) });
    expect(r.status).toBe('success');
    expect(r.detail).toEqual({ n: 1 });
    expect(ctl.isBusy).toBe(false);
  });

  it('transforme une exception en échec, sans la propager', async () => {
    const ctl = new ActionController(new ManualClock(), () => {});
    const r = await ctl.run({
      name: 'ko',
      domain: 'mine',
      timeoutMs: 1000,
      run: async () => {
        throw new Error('pioche cassée');
      },
    });
    expect(r.status).toBe('failure');
    expect(r.reason).toBe('pioche cassée');
  });

  it('applique le délai maximal et annule le signal', async () => {
    const clock = new ManualClock();
    const ctl = new ActionController(clock, () => {});
    let aborted = false;
    const p = ctl.run({
      name: 'lent',
      domain: 'explore',
      timeoutMs: 5000,
      run: async (signal) => {
        await untilAborted(signal);
        aborted = true;
      },
    });
    clock.advance(5001);
    const r = await p;
    expect(r.status).toBe('timeout');
    expect(aborted).toBe(true);
  });

  it('préempte de façon synchrone et coupe les moteurs', async () => {
    let stops = 0;
    const ctl = new ActionController(new ManualClock(), () => stops++);
    const p = ctl.run(longAction());
    expect(ctl.abort('danger')).toBe(true);
    expect(ctl.isBusy).toBe(false);
    const r = await p;
    expect(r.status).toBe('preempted');
    expect(r.reason).toBe('danger');
    expect(stops).toBe(1);
  });

  it('une nouvelle action remplace la précédente', async () => {
    const ctl = new ActionController(new ManualClock(), () => {});
    const first = ctl.run(longAction('a'));
    void ctl.run(longAction('b'));
    expect((await first).status).toBe('preempted');
    expect(ctl.current?.name).toBe('b');
  });

  it('refuse toute action tant qu\'un réflexe tient le verrou', async () => {
    const ctl = new ActionController(new ManualClock(), () => {});
    ctl.block('réflexe flee');
    const r = await ctl.run(longAction());
    expect(r.status).toBe('preempted');
    expect(r.reason).toContain('réflexe flee');
    ctl.unblock();
    void ctl.run(longAction());
    expect(ctl.isBusy).toBe(true);
  });

  it('distingue la mort', async () => {
    const ctl = new ActionController(new ManualClock(), () => {});
    const p = ctl.run(longAction());
    ctl.abort('mort', 'death');
    expect((await p).status).toBe('death');
  });
});
