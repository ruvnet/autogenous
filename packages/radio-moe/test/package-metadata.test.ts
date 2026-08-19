import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package repository matches GitHub Actions provenance identity', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { repository?: unknown };

  assert.equal(packageJson.repository, 'https://github.com/ruvnet/autogenous');
});
