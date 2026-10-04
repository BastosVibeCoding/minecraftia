import 'dotenv/config';
import mineflayer from 'mineflayer';
import { Companion } from './app.js';
import { ConfigError, loadConfig } from './config/load.js';
import { systemClock } from './core/clock.js';
import { installProcessGuards } from './core/guards.js';
import { createLogger } from './core/logger.js';
import { join } from 'node:path';
import { createEmbedder } from './store/embedder.js';
import { Store } from './store/store.js';
import { PlayClock } from './tree/playClock.js';
import { BehaviorTree } from './tree/tree.js';
import { Autonomy } from './autonomy/autonomy.js';
import { ProposalBroker } from './autonomy/proposals.js';
import { UtteranceClassifier } from './feedback/classifier.js';
import { Budget } from './decider/budget.js';
import { DecisionCache } from './decider/cache.js';
import { Decider } from './decider/decider.js';
import { OpenRouterClient } from './decider/llm.js';
import { ModelRouter } from './decider/router.js';
import { createStrategy, StrategyNotImplementedError, type RoleStrategy } from './strategy/strategy.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, process.env.CONFIG_FILE ?? 'config/minecraftia.json');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    secrets: [config.openrouter.apiKey ?? ''],
  });
  installProcessGuards(logger);

  let strategy: RoleStrategy;
  try {
    strategy = createStrategy(config.strategy);
  } catch (err) {
    if (err instanceof StrategyNotImplementedError) {
      logger.fatal(err.message);
      process.exit(1);
    }
    throw err;
  }

  const embedder = await createEmbedder('transformers', join(config.dataDir, 'models'), logger);
  const store = await Store.open(join(config.dataDir, 'minecraftia.db'), embedder, systemClock, { logger });
  logger.info({ embedder: embedder.name, vectorIndex: store.index.kind }, 'mémoire ouverte');
  const playClock = new PlayClock(store.db, systemClock);
  const tree = new BehaviorTree(store, { playTime: () => playClock.now(), logger: logger.child({ module: 'arbre' }) });

  const budget = new Budget(store.db, systemClock, config.openrouter.dailyBudgetUsd);
  const cache = new DecisionCache(store.db, systemClock);
  const router = new ModelRouter(config.openrouter.modelFast, config.openrouter.modelStrong);
  const llm = config.openrouter.apiKey ? new OpenRouterClient({ apiKey: config.openrouter.apiKey, baseUrl: config.openrouter.baseUrl }) : null;
  if (!llm) logger.warn('OPENROUTER_API_KEY absente : le bot suit et survit, sans décideur LLM');
  const autonomy = new Autonomy(store);
  const proposals = new ProposalBroker(systemClock);
  const persona = { name: config.minecraft.username, gender: config.gender };
  const decider = new Decider({ tree, llm, budget, cache, router, strategy, persona, autonomy: () => autonomy.all(), clock: systemClock, logger: logger.child({ module: 'décideur' }) });

  const companion = new Companion(config, logger, systemClock, mineflayer.createBot, {
    tree, playClock, decider, cache, router, autonomy, proposals,
    classifier: new UtteranceClassifier(llm, budget, config.openrouter.modelFast, config.minecraft.username),
    budget,
  });
  companion.start();
  logger.info({ follow: config.followPlayer, server: `${config.minecraft.host}:${config.minecraft.port}` }, `${config.minecraft.username} démarre`);

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'arrêt demandé');
    companion.stop();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
