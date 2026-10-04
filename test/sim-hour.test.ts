import { describe, expect, it } from 'vitest';
import type { RawEvent } from '../src/observer/types.js';
import { simulateSession } from '../src/sim/hour.js';
import { builderLog, fighterLog } from '../src/sim/players.js';
import { silentLogger } from './helpers.js';

const BUDGET = 1; // dollars par jour (valeur par défaut de DAILY_BUDGET_USD)

describe('une heure de jeu simulée', () => {
  it.each([
    ['bâtisseur', builderLog(60), 'Batisseur'],
    ['combattant', fighterLog(60), 'Combattant'],
  ] as [string, RawEvent[], string][])('%s : reste sous le budget, sans appel par tick', async (_name, log, player) => {
    const r = await simulateSession({ log, player, dailyBudgetUsd: BUDGET, logger: silentLogger });
    expect(r.minutes).toBeGreaterThanOrEqual(59);
    expect(r.costUsd).toBeLessThan(BUDGET);
    expect(r.costUsd).toBeLessThan(0.4); // estimation du plan : 0,15 à 0,35 $/h
    // jamais un appel par tick : au plus un appel toutes les 5 s, en pratique bien moins
    expect(r.llmCalls).toBeLessThan((60 * 60) / 5);
    expect(r.llmCalls).toBeLessThan(r.events / 3);
    // le cache et les replis sans modèle évitent une part des appels
    expect(r.bySource.cache + r.bySource.fallback).toBeGreaterThan(0);
  });

  it('budget minuscule : arrêt propre, le reste des décisions passe en repli sans appel', async () => {
    const r = await simulateSession({ log: builderLog(30), player: 'Batisseur', dailyBudgetUsd: 0.01, logger: silentLogger });
    expect(r.costUsd).toBeLessThan(0.02); // au plus le dernier appel en cours au moment du dépassement
    expect(r.bySource.fallback).toBeGreaterThan(r.bySource.llm);
  });
});
