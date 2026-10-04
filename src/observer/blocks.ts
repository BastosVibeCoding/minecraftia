import type { Domain } from '../core/types.js';

/** Catégories de blocs, par motifs de noms Minecraft. Sert à classer une activité, pas à la juger. */
const GATHER = [/_log$/, /_wood$/, /_stem$/, /_leaves$/, /^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sugar_cane|bamboo|cactus|sweet_berry_bush|kelp|kelp_plant)$/, /^(short_grass|tall_grass|fern|large_fern|dead_bush|vine)$/, /_mushroom$/, /^(sand|red_sand|gravel|clay|dirt|grass_block|coarse_dirt|podzol|mud|snow|snow_block)$/];
const MINE = [/_ore$/, /^ancient_debris$/, /^(stone|deepslate|cobbled_deepslate|granite|diorite|andesite|tuff|calcite|netherrack|basalt|blackstone|obsidian|end_stone|dripstone_block|cobblestone)$/];
const ORE = /(_ore$|^ancient_debris$)/;

/** Cultures (le bloc posé quand on sème) et graine correspondante. */
export const CROP_SEED: Record<string, string> = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' };

export function isCrop(block: string): boolean {
  return block in CROP_SEED;
}

export function isTorch(block: string): boolean {
  return block === 'torch' || block === 'wall_torch' || block === 'soul_torch' || block === 'soul_wall_torch';
}

export function isOre(block: string): boolean {
  return ORE.test(block);
}

/** Domaine d'un bloc cassé : récolte (bois, plantes, terre), minage (pierre, minerais) ou construction (retouche). */
export function brokenBlockDomain(block: string): Domain {
  if (GATHER.some((r) => r.test(block))) return 'gather';
  if (MINE.some((r) => r.test(block))) return 'mine';
  return 'build';
}

/** Nom lisible d'un bloc : « stone_bricks » → « stone bricks ». */
export function readable(block: string): string {
  return block.replace(/^minecraft:/, '').replace(/_/g, ' ');
}

export function stripNamespace(id: string): string {
  return id.replace(/^minecraft:/, '');
}
