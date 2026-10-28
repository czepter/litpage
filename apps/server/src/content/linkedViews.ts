// Linked database views, server side (the client's counterpart is features/database/sources/sources.ts): a database
// block whose views show data sources of other databases. Each view points at its source (format.collection_pointer);
// the block keeps collection_id (its first source) and format.collection_pointers (every source it shows). Filters and
// sorts are stored the way the client stores them (query2.filter / query2.sort), so a linked view is live: it shows
// the source's rows as they are now, filtered and sorted as asked — one page can carry the views of several databases
// (an overall roadmap over the roadmaps of several teams).
// Shared by the agent / MCP tool create_linked_views (ai/tools/write.ts) and the public API (/v1/views).
// Nothing here writes: callers apply the operations as the acting user (the TxGuard checks that every linked source is
// one the user can open).
import { newId } from '@nc/shared/ids.ts';
import { op as mk, type Operation } from '@nc/shared/ops.ts';
import type { BlockRecord, CollectionRecord, CollectionViewRecord, PropertySchema } from '@nc/shared/records.ts';
import { filterOperatorsFor, propertyTypeMeta, RELATIVE_DATE_VALUES, RELATIVE_RANGE_PRESETS } from '@nc/shared/database/schema.ts';
import type { FilterGroup, FilterNode, FilterValue, PropertyFilterLeaf, SortSpec } from '@nc/shared/database/types.ts';
import { getRecord } from '../db.ts';
import { chartConfigFor, type AgentViewInput } from '../ai/edit.ts';
import { OpsBuilder } from './spec.ts';

type Schema = Record<string, PropertySchema>;

export const LINKED_VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'chart'] as const;
export type LinkedViewType = (typeof LINKED_VIEW_TYPES)[number];

/** Neutral filter conditions (the public API's names; the agent tool maps its own onto them). */
export const VIEW_FILTER_CONDITIONS = [
  'equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with',
  'greater_than', 'less_than', 'greater_than_or_equal_to', 'less_than_or_equal_to',
  'before', 'after', 'on_or_before', 'on_or_after',
  'past_week', 'past_month', 'past_year', 'this_week', 'next_week', 'next_month', 'next_year',
  'is_empty', 'is_not_empty',
] as const;
export type ViewFilterCondition = (typeof VIEW_FILTER_CONDITIONS)[number];

/** A filter, sort or group that doesn't fit the source; callers turn it into their own error. */
export class ViewSpecError extends Error {}

const RANGE_PRESET: Record<string, string> = {
  past_week: 'the_past_week', past_month: 'the_past_month', past_year: 'the_past_year',
  this_week: 'this_week', next_week: 'the_next_week', next_month: 'the_next_month', next_year: 'the_next_year',
};

const STORED_BY_KIND: Record<string, Partial<Record<ViewFilterCondition, string>>> = {
  text: {
    equals: 'string_is', does_not_equal: 'string_is_not', contains: 'string_contains', does_not_contain: 'string_does_not_contain',
    starts_with: 'string_starts_with', ends_with: 'string_ends_with',
  },
  place: { contains: 'string_contains', does_not_contain: 'string_does_not_contain' },
  number: {
    equals: 'number_equals', does_not_equal: 'number_does_not_equal', greater_than: 'number_greater_than', less_than: 'number_less_than',
    greater_than_or_equal_to: 'number_greater_than_or_equal_to', less_than_or_equal_to: 'number_less_than_or_equal_to',
  },
  checkbox: { equals: 'checkbox_is', does_not_equal: 'checkbox_is_not' },
  select: { equals: 'enum_is', does_not_equal: 'enum_is_not', contains: 'enum_is', does_not_contain: 'enum_is_not' },
  multi_select: { contains: 'enum_contains', does_not_contain: 'enum_does_not_contain', equals: 'enum_contains', does_not_equal: 'enum_does_not_contain' },
  status: { equals: 'status_is', does_not_equal: 'status_is_not', contains: 'status_is', does_not_contain: 'status_is_not' },
  person: { contains: 'person_contains', does_not_contain: 'person_does_not_contain', equals: 'person_contains', does_not_equal: 'person_does_not_contain' },
  relation: { contains: 'relation_contains', does_not_contain: 'relation_does_not_contain', equals: 'relation_contains', does_not_equal: 'relation_does_not_contain' },
  date: {
    equals: 'date_is', before: 'date_is_before', after: 'date_is_after', on_or_before: 'date_is_on_or_before', on_or_after: 'date_is_on_or_after',
    ...Object.fromEntries(Object.keys(RANGE_PRESET).map((k) => [k, 'date_is_within'])),
  },
};

/** Stored operator → its neutral condition (the first one that maps to it: enum_is → equals). */
export const STORED_FILTER_CONDITIONS: Record<string, ViewFilterCondition> = {};
for (const map of Object.values(STORED_BY_KIND)) {
  for (const [cond, stored] of Object.entries(map)) if (stored && stored !== 'date_is_within' && !STORED_FILTER_CONDITIONS[stored]) STORED_FILTER_CONDITIONS[stored] = cond as ViewFilterCondition;
}

/** The filter kind of a property (formulas and rollups by their result type). */
function filterKind(prop: PropertySchema): string | null {
  const vt = propertyTypeMeta(prop.type).filterValueType;
  if (vt !== 'formula' && vt !== 'rollup') return vt;
  const ops = filterOperatorsFor(prop, (prop as { formula2?: { result_type?: { type?: string } } }).formula2?.result_type?.type);
  if (ops.includes('number_equals')) return 'number';
  if (ops.includes('checkbox_is')) return 'checkbox';
  if (ops.includes('date_is')) return 'date';
  if (ops.includes('person_contains')) return 'person';
  if (ops.includes('relation_contains')) return 'relation';
  return 'text';
}

/** Property id by id or (case-insensitive) name. */
export function propertyIdOf(schema: Schema, key: string): string | undefined {
  if (schema[key]) return key;
  if (key === 'title') return Object.keys(schema).find((k) => schema[k]?.type === 'title');
  const n = key.trim().toLowerCase();
  return Object.keys(schema).find((k) => schema[k]?.name?.toLowerCase() === n);
}

export interface FilterValueResolvers {
  /** person names / emails / ids → user ids ("me" is kept relative) */
  person?(value: string): string | null;
}

/** One stored filter leaf for `condition` on a property, or a ViewSpecError naming what doesn't fit. */
export function filterLeaf(schema: Schema, property: string, condition: string, value: unknown, resolve: FilterValueResolvers = {}): PropertyFilterLeaf {
  const pid = propertyIdOf(schema, property);
  if (!pid) throw new ViewSpecError(`Unknown property “${property}”.`);
  const prop = schema[pid];
  const kind = filterKind(prop);
  if (!kind) throw new ViewSpecError(`“${prop.name}” (${prop.type}) can’t be filtered.`);
  if (condition === 'is_empty' || condition === 'is_not_empty') {
    if (!filterOperatorsFor(prop, (prop as any).formula2?.result_type?.type).includes(condition) && kind !== 'text') throw new ViewSpecError(`“${prop.name}” has no “${condition}” filter.`);
    return { property: pid, filter: { operator: condition } };
  }
  const operator = STORED_BY_KIND[kind]?.[condition as ViewFilterCondition];
  if (!operator) {
    const allowed = Object.keys(STORED_BY_KIND[kind] ?? {});
    throw new ViewSpecError(`“${prop.name}” (${prop.type}) can’t be filtered with “${condition}”${allowed.length ? `; use ${[...allowed, 'is_empty', 'is_not_empty'].join(', ')}` : ''}.`);
  }
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
  let fv: FilterValue | FilterValue[];
  switch (kind) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(text);
      if (!text || !Number.isFinite(n)) throw new ViewSpecError(`The filter on “${prop.name}” needs a number.`);
      fv = { type: 'exact', value: n };
      break;
    }
    case 'checkbox': {
      const b = value === true || /^(true|yes|1|checked)$/i.test(text) ? true : value === false || /^(false|no|0|unchecked)$/i.test(text) ? false : null;
      if (b === null) throw new ViewSpecError(`The filter on “${prop.name}” needs true or false.`);
      fv = { type: 'exact', value: b };
      break;
    }
    case 'date': {
      if (RANGE_PRESET[condition]) {
        fv = { ...RELATIVE_RANGE_PRESETS[RANGE_PRESET[condition]] };
        break;
      }
      const rel = text.toLowerCase().replace(/[\s-]+/g, '_');
      if ((RELATIVE_DATE_VALUES as readonly string[]).includes(rel)) fv = { type: 'relative', value: rel };
      else if (/^\d{4}-\d{2}-\d{2}/.test(text)) fv = { type: 'exact', value: { type: 'date', start_date: text.slice(0, 10) } };
      else throw new ViewSpecError(`The filter on “${prop.name}” needs a date (YYYY-MM-DD) or one of ${RELATIVE_DATE_VALUES.join(', ')}.`);
      break;
    }
    case 'select': case 'multi_select': {
      if (!text) throw new ViewSpecError(`The filter on “${prop.name}” needs an option.`);
      const opt = (prop.options ?? []).find((o) => o.value.toLowerCase() === text.toLowerCase());
      if (!opt) throw new ViewSpecError(`“${prop.name}” has no option “${text}”${prop.options?.length ? ` (options: ${prop.options.map((o) => o.value).join(', ')})` : ''}.`);
      fv = { type: 'exact', value: opt.value };
      break;
    }
    case 'status': {
      if (!text) throw new ViewSpecError(`The filter on “${prop.name}” needs a status.`);
      const opt = (prop.options ?? []).find((o) => o.value.toLowerCase() === text.toLowerCase());
      const group = !opt ? ((prop as { groups?: { id: string; name: string }[] }).groups ?? []).find((g) => g.name.toLowerCase() === text.toLowerCase()) : undefined;
      if (!opt && !group) throw new ViewSpecError(`“${prop.name}” has no status or status group “${text}”.`);
      fv = opt ? { type: 'is_option', value: opt.value } : { type: 'is_group', value: group!.id };
      break;
    }
    case 'person': {
      if (/^@?me$/i.test(text)) {
        fv = { type: 'relative', value: 'me' };
        break;
      }
      const id = resolve.person?.(text) ?? null;
      if (!id) throw new ViewSpecError(`No one in this workspace matches “${text}”.`);
      fv = { type: 'exact', value: { id, table: 'lit_user' } };
      break;
    }
    case 'relation': {
      if (!text) throw new ViewSpecError(`The filter on “${prop.name}” needs a page id.`);
      fv = { type: 'exact', value: { id: text, table: 'block' } };
      break;
    }
    default:
      if (!text) throw new ViewSpecError(`The filter on “${prop.name}” needs a value.`);
      fv = { type: 'exact', value: text };
  }
  return { property: pid, filter: { operator, value: fv } };
}

/** Sorts by property name or id. */
export function viewSorts(schema: Schema, sorts: { property: string; direction?: string }[]): SortSpec[] {
  return sorts.map((s) => {
    const pid = propertyIdOf(schema, String(s.property ?? ''));
    if (!pid) throw new ViewSpecError(`Unknown sort property “${s.property}”.`);
    return { property: pid, direction: s.direction === 'descending' ? 'descending' : 'ascending' };
  });
}

/** A linked view to build: its source, layout and (stored-format) filter / sort. */
export interface LinkedViewSpec {
  source: CollectionRecord;
  type: LinkedViewType;
  name?: string;
  /** board columns / chart X axis (property id) */
  groupBy?: string;
  /** calendar / timeline date property (property id) */
  dateProperty?: string;
  filter?: FilterGroup;
  sort?: SortSpec[];
  /** chart: chart_type / aggregate as the agent tools take them */
  chart?: AgentViewInput;
}

const VIEW_NAMES: Record<string, string> = { table: 'Table', board: 'Board', list: 'List', gallery: 'Gallery', calendar: 'Calendar', timeline: 'Timeline', chart: 'Chart' };

function pointer(c: CollectionRecord) {
  return { id: c.id, table: 'collection', spaceId: c.space_id };
}

/** The collection_view record of one linked view under `blockId` (not yet listed in the block's view_ids). */
function viewRecord(spaceId: string, blockId: string, v: LinkedViewSpec): CollectionViewRecord {
  const schema = v.source.schema ?? {};
  const id = newId();
  const name = (v.name?.trim() || VIEW_NAMES[v.type] || 'View').slice(0, 100);
  let format: Record<string, unknown>;
  let query2: Record<string, unknown> = {};
  if (v.type === 'chart') {
    format = { chart_config: chartConfigFor({ type: 'chart', ...(v.chart ?? {}), group_by: v.groupBy ?? v.chart?.group_by }, schema) };
  } else {
    // the view defaults (visible properties, board columns) the database builder uses
    const tmp = new OpsBuilder(spaceId, '');
    tmp.database({ name: '', schema: Object.fromEntries(Object.entries(schema).map(([pid, p]) => [pid, { name: p.name, type: p.type }])), rows: [], views: [{ type: v.type, ...(v.groupBy ? { groupBy: v.groupBy } : {}) }] }, blockId);
    const built = (tmp.ops.find((o) => o.pointer.table === 'collection_view')?.args ?? {}) as { format?: Record<string, unknown>; query2?: Record<string, unknown> };
    format = built.format ?? {};
    query2 = { ...(built.query2 ?? {}) };
  }
  if (v.dateProperty && (v.type === 'calendar' || v.type === 'timeline')) query2[`${v.type}_by`] = v.dateProperty;
  if (v.filter?.filters.length) query2.filter = v.filter;
  if (v.sort?.length) query2.sort = v.sort;
  return {
    id, type: v.type, name, format: { ...format, collection_pointer: pointer(v.source) }, query2,
    parent_id: blockId, parent_table: 'block', alive: true, space_id: spaceId, page_sort: [],
  } as unknown as CollectionViewRecord;
}

/** Every source a database block shows: its own, the pointers it keeps and its views' sources. */
export function sourceIdsOf(block: BlockRecord): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  };
  add(block.collection_id);
  for (const p of ((block.format as { collection_pointers?: { id?: string }[] } | undefined)?.collection_pointers ?? [])) add(p?.id);
  for (const vid of block.view_ids ?? []) {
    const v = getRecord<CollectionViewRecord>('collection_view', vid);
    if (v && v.alive !== false) add((v.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer?.id);
  }
  return out;
}

/**
 * A new linked database block (inline `collection_view` in a page, or a full page `collection_view_page`) showing
 * `views`. Returns the block's fields for the caller to place (OpsBuilder.block / placeUnder with spec.id = blockId)
 * and the operations to apply right after the block's own set operation.
 */
export function newLinkedDatabase(spaceId: string, views: LinkedViewSpec[]): { blockId: string; format: Record<string, unknown>; ops: Operation[]; viewIds: string[] } {
  if (!views.length) throw new ViewSpecError('A linked database needs at least one view.');
  const blockId = newId();
  const ops: Operation[] = [];
  const viewIds: string[] = [];
  for (const v of views) {
    const rec = viewRecord(spaceId, blockId, v);
    ops.push(mk.set({ table: 'collection_view', id: rec.id, spaceId }, [], rec));
    viewIds.push(rec.id);
  }
  const sources = [...new Map(views.map((v) => [v.source.id, v.source])).values()];
  ops.push(mk.update({ table: 'block', id: blockId, spaceId }, [], { collection_id: sources[0].id, view_ids: viewIds }));
  return { blockId, format: { collection_pointer: pointer(sources[0]), collection_pointers: sources.map(pointer) }, ops, viewIds };
}

/** Linked views added to an existing database block (after its last view); its source pointers follow. */
export function addLinkedViewOps(block: BlockRecord, views: LinkedViewSpec[]): { ops: Operation[]; viewIds: string[] } {
  const spaceId = block.space_id;
  const ops: Operation[] = [];
  const viewIds: string[] = [];
  for (const v of views) {
    const rec = viewRecord(spaceId, block.id, v);
    ops.push(mk.set({ table: 'collection_view', id: rec.id, spaceId }, [], rec));
    ops.push(mk.listAfter({ table: 'block', id: block.id, spaceId }, ['view_ids'], rec.id));
    viewIds.push(rec.id);
  }
  const ids = sourceIdsOf(block);
  for (const v of views) if (!ids.includes(v.source.id)) ids.push(v.source.id);
  const pointers = ids.map((id) => getRecord<CollectionRecord>('collection', id) ?? views.find((v) => v.source.id === id)?.source).filter((c): c is CollectionRecord => !!c).map(pointer);
  ops.push(mk.update({ table: 'block', id: block.id, spaceId }, ['format'], { collection_pointers: pointers }));
  if (!block.collection_id) ops.push(mk.update({ table: 'block', id: block.id, spaceId }, [], { collection_id: views[0].source.id }));
  return { ops, viewIds };
}

/** Group of leaves joined by `and` / `or`. */
export function filterGroup(operator: 'and' | 'or', filters: FilterNode[]): FilterGroup {
  return { operator, filters };
}
