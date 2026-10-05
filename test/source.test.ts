import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

it("aucun caractère de contrôle invisible dans le code (cas réels : \b devenu un retour arrière dans deux expressions régulières)", () => {
  const bad = files('src').filter((p) => /[\u0000-\u0008]/.test(readFileSync(p, 'utf8')));
  expect(bad).toEqual([]);
});
