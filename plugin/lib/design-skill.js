import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bundled design skill.
 *
 * The tools say what may be written; this says what is worth writing. A model
 * reading only tool schemas will happily place thirty absolutely-positioned
 * rectangles and call it a screen, because nothing in a JSON schema objects to
 * that. The skill is where the objections live: stacks before coordinates,
 * tokens before literals, components before copies, and a check before the word
 * "done".
 */

const PROVIDER = 'moments-design';
const SKILL_NAME = 'moments-design';
const RANK = 600;
const INVOCATION = { modelInvocable: true, userInvocable: true };

/** The skill ships beside lib/, in both the source tree and the package. */
function skillDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../skills/moments-design');
}

function frontmatterField(front, key) {
  return new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mu').exec(front)?.[1]?.replace(/^['"]|['"]$/gu, '');
}

/** Read SKILL.md once; a broken skill must not take the plugin down. */
function loadSkill() {
  const path = resolve(skillDirectory(), 'SKILL.md');
  const raw = readFileSync(path, 'utf8');
  if (!raw.startsWith('---\n')) throw new Error('moments-design SKILL.md has no frontmatter');
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('moments-design SKILL.md has no closing frontmatter fence');
  const front = raw.slice(4, end);
  const description = frontmatterField(front, 'description');
  if (!description) throw new Error('moments-design SKILL.md has no description');
  return { path, description, content: raw.slice(end + 5).trim() };
}

/**
 * Register the skill with the Harness skill registry.
 *
 * @returns {(() => void) | null} a disposer, or null when the host has no
 *   skill registry (older hosts) — the plugin still works without it.
 */
export function registerDesignSkill(ctx) {
  const registry = ctx?.skills;
  if (!registry || typeof registry.registerProvider !== 'function') return null;
  let skill;
  try {
    skill = loadSkill();
  } catch (error) {
    ctx?.logger?.warn?.(`Moments design skill is unavailable: ${String(error)}`);
    return null;
  }
  const metadata = {
    name: SKILL_NAME,
    description: skill.description,
    invocation: INVOCATION,
    source: 'bundled',
    provider: PROVIDER,
    path: skill.path,
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
    rank: RANK,
    locator: skill.path,
  };
  return registry.registerProvider(() => ({
    name: PROVIDER,
    list: async () => [metadata],
    get: async () => ({ ...metadata, content: skill.content }),
  }));
}
