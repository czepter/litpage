// Feature level of this install (NC_FEATURE_LEVEL): free, pro, business or enterprise (default). Litpage is
// self-hosted and has no billing, so the level is set by whoever runs the server and applies to every workspace.
// New workspaces are created at this level, and syncFeatureLevel() moves existing ones to it on start.
import type { SpaceRecord } from '@nc/shared/records.ts';
import { db, putRecord, tx } from './db.ts';

export type FeatureLevel = SpaceRecord['plan_type'];

const ALIASES: Record<string, FeatureLevel> = { free: 'free', pro: 'plus', plus: 'plus', business: 'business', enterprise: 'enterprise' };

export function featureLevel(): FeatureLevel {
  const raw = process.env.NC_FEATURE_LEVEL?.trim().toLowerCase();
  if (!raw) return 'enterprise';
  const level = ALIASES[raw];
  if (!level) throw new Error(`NC_FEATURE_LEVEL must be free, pro, business or enterprise (got "${raw}")`);
  return level;
}

/** Moves every workspace to the configured level. Returns how many changed. */
export function syncFeatureLevel(skip: string[] = []): number {
  const level = featureLevel();
  const rows = db.prepare(`SELECT data FROM records WHERE tbl = 'space'`).all() as { data: string }[];
  let changed = 0;
  tx(() => {
    for (const r of rows) {
      const space = JSON.parse(r.data) as SpaceRecord;
      if (space.plan_type === level || skip.includes(space.id)) continue;
      putRecord('space', { ...space, plan_type: level, version: (space.version ?? 0) + 1 });
      changed++;
    }
  });
  return changed;
}
