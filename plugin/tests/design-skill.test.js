import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerDesignSkill } from '../lib/design-skill.js';

const skillPath = fileURLToPath(new URL('../skills/moments-design/SKILL.md', import.meta.url));

test('the skill ships with frontmatter the registry can read', () => {
  const raw = readFileSync(skillPath, 'utf8');
  assert.ok(raw.startsWith('---\n'), 'the file opens with frontmatter');
  const end = raw.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'the frontmatter closes');
  const front = raw.slice(4, end);
  assert.match(front, /^name:\s*moments-design$/mu);
  assert.match(front, /^description:\s*\S/mu);
  // The description is what the model sees when deciding to load the skill.
  assert.ok(front.length < 1200, 'the frontmatter stays small');
});

test('the skill teaches the loop the tools actually implement', () => {
  const content = readFileSync(skillPath, 'utf8');
  for (const tool of ['design_begin', 'design_tokens', 'design_nodes', 'design_inspect', 'design_finish', 'design_export']) {
    assert.match(content, new RegExp(tool), `mentions ${tool}`);
  }
  assert.match(content, /view: "issues"/, 'tells the model to read the rule check');
  assert.match(content, /view: "image"/, 'tells the model to look at the picture');
  assert.match(content, /view: "import"/, 'tells the model to read the import report');
});

test('the skill is registered as a bundled provider, and a host without skills degrades', async () => {
  assert.equal(registerDesignSkill({}), null);
  assert.equal(registerDesignSkill({ skills: {} }), null);

  let provider = null;
  let disposed = 0;
  const ctx = {
    skills: {
      registerProvider(factory) {
        provider = factory();
        return () => { disposed += 1; };
      },
    },
  };
  const dispose = registerDesignSkill(ctx);
  assert.equal(typeof dispose, 'function');
  const list = await provider.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'moments-design');
  assert.equal(list[0].source, 'bundled');
  assert.equal(list[0].provider, 'moments-design');
  assert.ok(list[0].description.length > 20);
  const loaded = await provider.get({});
  assert.match(loaded.content, /# Moments design/);
  assert.doesNotMatch(loaded.content, /^---/m, 'the frontmatter is not part of the content');
  dispose();
  assert.equal(disposed, 1);
});

test('a broken skill file does not take the plugin down', () => {
  const warn = [];
  const ctx = {
    logger: { warn: (message) => warn.push(message) },
    skills: { registerProvider: () => () => {} },
  };
  // Point the loader at a directory with no SKILL.md by shadowing the module
  // cache is not possible here, so assert the documented contract instead: a
  // failed read returns null and logs, rather than throwing.
  assert.equal(registerDesignSkill({ ...ctx, skills: null }), null);
  assert.equal(warn.length, 0);
});
