// The roles a worker can be hired as: a name, and the brief its prompt starts with. The registry is
// the project's own .agent-office/roles.json, so whoever works in the project decides what a "qa" or
// a "design" worker is told (see docs/configuration.md). No file, or one the office can't read,
// leaves hiring exactly as it was: a role is a briefing, never a requirement.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What a role tells its worker's prompt. */
export interface RoleSpec {
  /** What the worker is for, in the office's voice. */
  brief: string;
  /** The skills it works by (gstack `/qa`, `/design-review`, …), for showing in the hire window. */
  skills?: string[];
}

/** What the hire window offers one role: its name and the skills its brief works by. */
export type RoleChoice = { id: string; skills: string[] };

/** The roles a project starts with, written the first time anyone looks for one. */
export const DEFAULT_ROLES: Record<string, RoleSpec> = {
  qa: { brief: 'You are the QA worker: you check that a change does what it says and nothing more. Drive the running app in a real browser, read the console, and report what breaks.', skills: ['qa', 'qa-only'] },
  dev: { brief: 'You are the developer: you write the change and prove it works. Ship every change as a PR branched from freshly fetched origin/main, and verify with the typecheck, the tests and the build.', skills: ['ship', 'land-and-deploy'] },
  design: { brief: 'You are the design worker: you make interfaces that read as one deliberate thing. Check the result in a real browser at desktop and phone widths before you call it done.', skills: ['design-review', 'design-shotgun'] },
  security: { brief: 'You are the security worker: you look for what an attacker would reach first, then fix it rather than only reporting it. Anything you touch, verify with a test that fails without the fix.', skills: ['cso', 'careful'] },
};

/** A read-once-per-edit registry of a project's roles. */
export class Roles {
  private roles = new Map<string, RoleSpec>();
  /** What roles.json was read at; 0 when there was nothing to read. */
  private mtime = 0;
  /** Whether a broken roles.json has already been said out loud. */
  private warned = false;

  constructor(readonly file: string) {}

  /** Where a floor's roles live, given the project's .agent-office folder. */
  static in(dataDir: string): Roles {
    return new Roles(path.join(dataDir, 'roles.json'));
  }

  /** The roles as they are now, read again when the file has changed since the last read. */
  all(): Map<string, RoleSpec> {
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      this.mtime = 0;
      return this.roles;
    }
    if (mtime === this.mtime) return this.roles;
    this.mtime = mtime;
    this.roles = this.read();
    return this.roles;
  }

  /** Role names available in the registry, empty when the registry is empty. */
  names(): string[] {
    return [...this.all().keys()];
  }

  /** What a role tells its worker's prompt, or '' for no role or one this registry doesn't have. */
  brief(role: string | undefined): string {
    return (role && this.all().get(role)?.brief) || '';
  }

  /** What the hire window offers: each role's name and its skills, for the label under it. */
  choices(): RoleChoice[] {
    return [...this.all()].map(([id, spec]) => ({ id, skills: spec.skills ?? [] }));
  }

  private read(): Map<string, RoleSpec> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      // One line, once: a project with a broken registry still hires workers, just without briefings.
      if (!this.warned) {
        this.warned = true;
        console.warn(`agent-office: couldn't read ${this.file} (${(err as Error).message}) — hiring without role briefings`);
      }
      return new Map();
    }
    const out = new Map<string, RoleSpec>();
    // A role with no brief says nothing, so it isn't one: skip it rather than start a worker on a blank.
    for (const [id, spec] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
      const { brief, skills } = (spec ?? {}) as Partial<RoleSpec>;
      if (typeof brief !== 'string' || !brief.trim()) continue;
      out.set(id.trim(), { brief: brief.trim(), ...(Array.isArray(skills) ? { skills: skills.filter((s): s is string => typeof s === 'string') } : {}) });
    }
    return out;
  }
}

/**
 * What a worker starts on: `station` (a board's brief) and its role's skill brief, joined, before its
 * task; the briefs alone when it was hired with no task yet; the task alone when there was no brief.
 */
export function briefedPrompt(roles: Roles, role: string | undefined, prompt?: string, station?: string): string | undefined {
  const lead = [station ?? '', roles.brief(role)].filter(Boolean).join('\n\n');
  return lead ? (prompt ? `${lead}\n\n${prompt}` : lead) : prompt;
}

/**
 * The roles a floor's project starts with, written out the first time anyone asks: the file is the
 * project's own, kept out of git by excludeFromGit, so whoever works in the project edits it.
 */
export function seedRoles(dataDir: string): Roles {
  const roles = Roles.in(dataDir);
  if (!existsSync(roles.file)) {
    try {
      writeFileSync(roles.file, `${JSON.stringify(DEFAULT_ROLES, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // a read-only checkout: the office works without roles
    }
  }
  return roles;
}
