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
import { BehaviorTree } from './tree/tree.js';

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

  if (config.strategy !== 'mirror') {
    logger.fatal({ strategy: config.strategy }, 'stratégie non implémentée : seule "mirror" est disponible');
    process.exit(1);
  }

  const embedder = await createEmbedder('transformers', join(config.dataDir, 'models'), logger);
  const store = await Store.open(join(config.dataDir, 'minecraftia.db'), embedder, systemClock, { logger });
  logger.info({ embedder: embedder.name, vectorIndex: store.index.kind }, 'mémoire ouverte');
  const tree = new BehaviorTree(store, { logger: logger.child({ module: 'arbre' }) });

  const companion = new Companion(config, logger, systemClock, mineflayer.createBot, { tree });
  companion.start();
  logger.info({ follow: config.followPlayer, server: `${config.minecraft.host}:${config.minecraft.port}` }, 'Minecraftia démarré');

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
