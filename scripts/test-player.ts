/**
 * Joueur scripté pour les essais réels : pose un mur, casse des blocs, fabrique, combat.
 * Il génère de vrais événements serveur (captés par Easy LLM et par l'observateur du bot).
 * Prérequis (RCON) : plateforme plate, inventaire fourni, zombie immobile à proximité.
 * Usage : npx tsx scripts/test-player.ts <hôte> [port] [scénario: all|build|craft|fight]
 */
import mineflayer from 'mineflayer';

const [host = 'localhost', port = '25565', scenario = 'all'] = process.argv.slice(2);
const bot = mineflayer.createBot({ host, port: Number(port), username: 'Testeur', version: '1.21', auth: 'offline', hideErrors: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[Testeur] ${msg}`);

async function buildWall(len: number, height: number): Promise<void> {
  const item = bot.inventory.items().find((i) => i.name === 'stone_bricks');
  if (!item) throw new Error('pas de stone_bricks dans l\'inventaire');
  await bot.equip(item, 'hand');
  const base = bot.entity.position.floored();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < len; x++) {
      const target = base.offset(x - Math.floor(len / 2), y, 3);
      const below = bot.blockAt(target.offset(0, -1, 0));
      if (!below || below.boundingBox !== 'block') continue;
      try {
        await bot.placeBlock(below, below.position.minus(below.position).offset(0, 1, 0));
      } catch (err) {
        log(`pose impossible en ${target} : ${(err as Error).message}`);
      }
      await sleep(250);
    }
  }
  log(`mur ${len}×${height} terminé`);
}

async function breakSome(n: number): Promise<void> {
  const base = bot.entity.position.floored();
  for (let i = 0; i < n; i++) {
    const b = bot.blockAt(base.offset(i - 1, 2, 3));
    if (b && b.name !== 'air') {
      await bot.dig(b, true);
      await sleep(200);
    }
  }
  log(`${n} blocs cassés`);
}

async function craftThings(): Promise<void> {
  const planks = bot.registry.itemsByName.oak_planks!.id;
  const recipe = bot.recipesFor(planks, null, 1, null)[0];
  if (!recipe) throw new Error('aucune recette de planches (pas de bûches ?)');
  await bot.craft(recipe, 2, undefined);
  const table = bot.registry.itemsByName.crafting_table!.id;
  const tableRecipe = bot.recipesFor(table, null, 1, null)[0];
  if (tableRecipe) await bot.craft(tableRecipe, 1, undefined);
  log('artisanat terminé');
}

async function fight(): Promise<void> {
  const sword = bot.inventory.items().find((i) => i.name.endsWith('_sword'));
  if (sword) await bot.equip(sword, 'hand');
  for (let i = 0; i < 6; i++) {
    const target = bot.nearestEntity((e) => e.name === 'zombie');
    if (!target) break;
    await bot.lookAt(target.position.offset(0, 1.6, 0), true);
    bot.attack(target);
    await sleep(700);
  }
  log('combat terminé');
}

bot.once('spawn', async () => {
  log(`apparu en ${bot.entity.position}`);
  await sleep(8000); // laisse le temps à la préparation RCON (téléportation, terrain, inventaire)
  try {
    if (scenario === 'all' || scenario === 'build') {
      await buildWall(7, 3);
      await sleep(1500);
      await breakSome(3);
    }
    if (scenario === 'all' || scenario === 'craft') {
      await sleep(2000);
      await craftThings();
    }
    if (scenario === 'all' || scenario === 'fight') {
      await sleep(2000);
      await fight();
    }
  } catch (err) {
    log(`échec : ${(err as Error).message}`);
  }
  await sleep(12000);
  bot.quit();
  process.exit(0);
});
bot.on('kicked', (r) => log(`expulsé : ${JSON.stringify(r)}`));
bot.on('error', (e) => log(`erreur : ${e.message}`));
