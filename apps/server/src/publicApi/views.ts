// Views (public API): the views of a database, and linked views — a database block on a page whose views show other
// databases' data sources, filtered and sorted, live (content/linkedViews.ts). One page can so carry an overall view
// over several databases (e.g. the roadmaps of several teams):
//   POST   /v1/views                    a view of data_source_id: a new linked database at the end of parent.page_id,
//                                       or a new tab of parent.database_id
//   GET    /v1/views/{id}               the view (type, name, source, filter, sorts)
//   PATCH  /v1/views/{id}               name, filter, sorts (null clears)
//   DELETE /v1/views/{id}               remove a view (a database keeps its last one)
//   POST   /v1/views/{id}/query         the rows the view shows (its saved filter and sorts), paginated
//   GET    /v1/databases/{id}/views     the views of a database
// Filters take the data source query's filter objects (property conditions, and / or up to two levels deep) and are
// stored the way the app stores them, so the view in the app filters the same way. Everything runs as the principal:
// the source must be one it can read, and the writes go through applyTransactions like every other /v1 write.
import { op as mk, type Operation } from '@nc/shared/ops.ts';
import type { BlockRecord, CollectionRecord, CollectionViewRecord, PropertySchema } from '@nc/shared/records.ts';
import { runQuery } from '@nc/shared/database/index.ts';
import type { FilterGroup, FilterNode, PropertyFilterLeaf, SortSpec } from '@nc/shared/database/types.ts';
import { RELATIVE_RANGE_PRESETS } from '@nc/shared/database/schema.ts';
import { toPlainText, type RichText } from '@nc/shared/richtext.ts';
import { expandId } from '@nc/shared/ids.ts';
import { getRecord } from '../db.ts';
import { blockRole } from '../records.ts';
import { pageLink } from '../notify.ts';
import { canEditDatabaseStructure } from '@nc/shared/database/access.ts';
import {
  addLinkedViewOps, filterLeaf, LINKED_VIEW_TYPES, newLinkedDatabase, propertyIdOf, sourceIdsOf, STORED_FILTER_CONDITIONS, viewSorts, ViewSpecError,
  type LinkedViewSpec, type LinkedViewType,
} from '../content/linkedViews.ts';
import { OpsBuilder } from '../content/spec.ts';
import { invalid, notFound, restricted } from './errors.ts';
import { DATABASE_TYPES, listObject, pageObject, type ReadCtx } from './objects.ts';
import { iso } from './richtext.ts';
import { applyAs, idParam, need, pageSize, paginate, readable, type Handler } from './routes.ts';

type Json = Record<string, any>;
type Schema = Record<string, PropertySchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bodyUuid(raw: unknown, path: string): string {
  const id = expandId(String(raw ?? '').trim()).toLowerCase();
  if (!UUID.test(id)) throw invalid(`${path} must be a valid uuid, instead was \`${JSON.stringify(raw)?.slice(0, 60)}\`.`);
  return id;
}

const API_TYPE: Record<string, string> = {
  title: 'title', text: 'rich_text', number: 'number', select: 'select', multi_select: 'multi_select', status: 'status', date: 'date',
  person: 'people', file: 'files', checkbox: 'checkbox', url: 'url', email: 'email', phone_number: 'phone_number', formula: 'formula',
  relation: 'relation', rollup: 'rollup', created_time: 'created_time', created_by: 'created_by', last_edited_time: 'last_edited_time',
  last_edited_by: 'last_edited_by', auto_increment_id: 'unique_id', place: 'place',
};

function sourceOfView(v: CollectionViewRecord, block: BlockRecord): string | undefined {
  return (v.format as { collection_pointer?: { id?: string } } | undefined)?.collection_pointer?.id ?? block.collection_id ?? undefined;
}

/** A data source the principal can read (as it may see it). */
function readableSource(r: { p: any; ctx: ReadCtx }, id: string): CollectionRecord {
  const col = getRecord<CollectionRecord>('collection', id);
  const host = col ? getRecord<BlockRecord>('block', col.parent_id) : undefined;
  if (!col || col.alive === false || !host || host.alive === false || host.space_id !== r.p.spaceId || blockRole(host.id, r.p.id) === 'none') throw notFound('data_source', id);
  return r.ctx.collection(col);
}

/** A view the principal can read: the view, its database block and its source (when readable). */
function viewOr404(r: { p: any; ctx: ReadCtx }, id: string): { view: CollectionViewRecord; block: BlockRecord; source?: CollectionRecord } {
  const view = getRecord<CollectionViewRecord>('collection_view', id);
  const block = view ? getRecord<BlockRecord>('block', view.parent_id) : undefined;
  if (!view || view.alive === false || !block || block.alive === false || !DATABASE_TYPES.has(block.type) || block.space_id !== r.p.spaceId || blockRole(block.id, r.p.id) === 'none') {
    throw notFound('view', id);
  }
  const sid = sourceOfView(view, block);
  let source: CollectionRecord | undefined;
  try {
    source = sid ? readableSource(r, sid) : undefined;
  } catch {
    source = undefined;
  }
  return { view, block, source };
}

function requireStructure(p: { id: string }, block: BlockRecord) {
  if (!canEditDatabaseStructure(blockRole(block.id, p.id), block as { format?: Record<string, unknown> })) throw restricted(block.format?.block_locked ? 'this database is locked.' : 'Insufficient permissions for this resource.');
}

// ---------------------------------------------------------------- filters (API ⇄ stored)

/** API filter object → stored view filter (always a group at the top). */
export function filterFromApi(raw: unknown, schema: Schema, path = 'body.filter', depth = 0): FilterNode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${path} must be an object.`);
  const f = raw as Json;
  if (Array.isArray(f.and) || Array.isArray(f.or)) {
    if (depth >= 2) throw invalid(`${path} exceeds the maximum filter depth of 2.`);
    const key = f.and ? 'and' : 'or';
    const list = f[key] as unknown[];
    if (list.length > 100) throw invalid(`${path} has too many filters.`);
    return { operator: key, filters: list.map((x, i) => filterFromApi(x, schema, `${path}.${key}[${i}]`, depth + 1)) };
  }
  if (f.timestamp !== undefined) throw invalid(`${path}: timestamp filters can’t be saved in a view; filter on a Created time or Last edited time property instead.`);
  if (typeof f.property !== 'string') throw invalid(`${path} must specify a property.`);
  const pid = propertyIdOf(schema, f.property);
  if (!pid) throw invalid(`No property named or identified by ${f.property} is available to this connection.`);
  const typeKey = Object.keys(f).find((k) => k !== 'property');
  if (!typeKey) throw invalid(`${path} must specify a condition for ${f.property}.`);
  let cond = f[typeKey] as Json;
  // formula / rollup conditions are nested one level ({ formula: { string: { contains: … } } })
  if ((typeKey === 'formula' || typeKey === 'rollup') && cond && typeof cond === 'object') {
    const inner = Object.keys(cond);
    if (inner.length === 1 && cond[inner[0]] && typeof cond[inner[0]] === 'object') cond = cond[inner[0]];
  }
  if (!cond || typeof cond !== 'object' || Object.keys(cond).length !== 1) throw invalid(`${path}.${typeKey} must specify exactly one condition.`);
  const [condition] = Object.keys(cond);
  const value = cond[condition];
  try {
    return filterLeaf(schema, pid, condition, condition === 'is_empty' || condition === 'is_not_empty' || /^(past|next|this)_/.test(condition) ? undefined : value, {
      person: (v) => (UUID.test(v) ? v : null),
    });
  } catch (e) {
    if (e instanceof ViewSpecError) throw invalid(`${path}: ${e.message}`);
    throw e;
  }
}

function groupOf(node: FilterNode): FilterGroup {
  return 'filters' in node ? node : { operator: 'and', filters: [node] };
}

const RANGE_BY_PRESET = Object.fromEntries(Object.entries(RELATIVE_RANGE_PRESETS).map(([k, v]) => [JSON.stringify(v), k.replace(/^the_/, '')]));

/** Stored view filter → API filter object (what GET returns; leaves the API can't express are left out). */
export function filterToApi(node: FilterNode | undefined, schema: Schema): Json | null {
  if (!node) return null;
  if ('filters' in node) {
    const parts = node.filters.map((n) => filterToApi(n, schema)).filter((x): x is Json => !!x);
    if (!parts.length) return null;
    return { [node.operator === 'or' ? 'or' : 'and']: parts };
  }
  const leaf = node as PropertyFilterLeaf;
  const prop = schema[leaf.property];
  if (!prop) return null;
  const op = leaf.filter?.operator;
  const typeKey = API_TYPE[prop.type] ?? 'rich_text';
  if (op === 'is_empty' || op === 'is_not_empty') return { property: prop.name, [typeKey]: { [op]: true } };
  const fv = Array.isArray(leaf.filter.value) ? leaf.filter.value[0] : leaf.filter.value;
  if (op === 'date_is_within' || op === 'date_is_relative_to') {
    const { type: _t, ...rest } = (fv ?? {}) as Json;
    const name = RANGE_BY_PRESET[JSON.stringify({ type: 'relative', ...rest })];
    return name ? { property: prop.name, [typeKey]: { [name]: {} } } : null;
  }
  const condition = STORED_FILTER_CONDITIONS[op ?? ''];
  if (!condition || !fv) return null;
  let value: unknown = fv.value;
  if (fv.type === 'relative') value = fv.value;
  else if (fv.type === 'is_group') value = ((prop as { groups?: { id: string; name: string }[] }).groups ?? []).find((g) => g.id === fv.value)?.name ?? fv.value;
  else if (value && typeof value === 'object') value = (value as Json).start_date ?? (value as Json).id ?? null;
  return { property: prop.name, [typeKey]: { [condition]: value } };
}

// ---------------------------------------------------------------- objects

export function viewObject(view: CollectionViewRecord, block: BlockRecord, source: CollectionRecord | undefined): Json {
  const schema = source?.schema ?? {};
  const q = (view.query2 ?? {}) as { filter?: FilterGroup; sort?: SortSpec[]; group_by?: string; calendar_by?: string; timeline_by?: string };
  const name = (pid: string | undefined) => (pid && schema[pid] ? schema[pid].name : null);
  const sid = sourceOfView(view, block);
  return {
    object: 'view', id: view.id, type: view.type, name: view.name ?? '',
    parent: { type: 'database_id', database_id: block.id },
    data_source_id: source ? source.id : null,
    data_source_name: source ? toPlainText(source.name as RichText | undefined) : null,
    is_linked: !!sid && getRecord<CollectionRecord>('collection', sid)?.parent_id !== block.id,
    filter: filterToApi(q.filter, schema),
    sorts: (q.sort ?? []).filter((s) => schema[s.property]).map((s) => ({ property: schema[s.property].name, direction: s.direction })),
    group_by: name(q.group_by ?? (view.format as { board_columns_by?: { property?: string } } | undefined)?.board_columns_by?.property),
    date_property: name(view.type === 'calendar' ? q.calendar_by : view.type === 'timeline' ? q.timeline_by : undefined),
    url: `${pageLink(block.id)}?v=${view.id}`,
    created_time: iso(block.created_time),
  };
}

// ---------------------------------------------------------------- handlers

/** The requested view over its source: layout, grouping, filter and sorts. */
function viewSpecFromBody(body: Json, source: CollectionRecord): LinkedViewSpec {
  const schema = source.schema ?? {};
  const type = (body.type ?? 'table') as string;
  if (!(LINKED_VIEW_TYPES as readonly string[]).includes(type)) throw invalid(`body.type must be one of ${LINKED_VIEW_TYPES.join(', ')}.`);
  if (body.name !== undefined && typeof body.name !== 'string') throw invalid('body.name must be a string.');
  const prop = (raw: unknown, path: string, types?: string[]) => {
    if (raw === undefined || raw === null) return undefined;
    const pid = typeof raw === 'string' ? propertyIdOf(schema, raw) : undefined;
    if (!pid || (types && !types.includes(schema[pid].type))) throw invalid(`${path} must name a${types ? ` ${types.join(' / ')}` : ''} property of the data source.`);
    return pid;
  };
  let sort: SortSpec[] | undefined;
  if (body.sorts !== undefined && body.sorts !== null) {
    if (!Array.isArray(body.sorts) || body.sorts.length > 10) throw invalid('body.sorts must be an array of at most 10 sorts.');
    try {
      sort = viewSorts(schema, body.sorts.map((s: Json, i: number) => {
        if (s?.timestamp) throw invalid(`body.sorts[${i}]: timestamp sorts can’t be saved in a view; sort by a Created time property instead.`);
        return { property: String(s?.property ?? ''), direction: s?.direction };
      }));
    } catch (e) {
      if (e instanceof ViewSpecError) throw invalid(`body.sorts: ${e.message}`);
      throw e;
    }
  }
  const chart = body.chart && typeof body.chart === 'object' ? body.chart as Json : {};
  return {
    source, type: type as LinkedViewType, name: typeof body.name === 'string' ? body.name : undefined,
    groupBy: prop(body.group_by, 'body.group_by', type === 'board' ? ['select', 'status', 'multi_select', 'person'] : undefined),
    dateProperty: prop(body.date_property, 'body.date_property', ['date', 'created_time', 'last_edited_time']),
    filter: body.filter ? groupOf(filterFromApi(body.filter, schema)) : undefined,
    sort,
    chart: type === 'chart' ? { type: 'chart', chart_type: chart.type, aggregate: chart.aggregate } : undefined,
  };
}

const viewsCreate: Handler = (r) => {
  const { p, body } = r;
  need(p, 'insert_content');
  const dsRaw = body.data_source_id ?? body.source?.data_source_id;
  if (!dsRaw) throw invalid('body.data_source_id is required: the data source the view shows.');
  const source = readableSource(r, bodyUuid(dsRaw, 'body.data_source_id'));
  const spec = viewSpecFromBody(body, source);
  const parent = (body.parent ?? {}) as Json;
  if (parent.database_id) {
    const block = readable(p, bodyUuid(parent.database_id, 'body.parent.database_id'), 'database');
    if (!DATABASE_TYPES.has(block.type)) throw invalid('body.parent.database_id must be a database.');
    requireStructure(p, block);
    const { ops, viewIds } = addLinkedViewOps(block, [spec]);
    ops.push(mk.update({ table: 'block', id: block.id, spaceId: block.space_id }, [], { last_edited_time: Date.now(), last_edited_by_id: p.id, last_edited_by_table: 'lit_user' }));
    applyAs(p, ops, 'createView');
    return viewObject(getRecord<CollectionViewRecord>('collection_view', viewIds[0])!, getRecord<BlockRecord>('block', block.id)!, source);
  }
  if (!parent.page_id) throw invalid('body.parent must be { page_id } (a new linked database on that page) or { database_id } (a new view of that database).');
  const page = readable(p, bodyUuid(parent.page_id, 'body.parent.page_id'), 'page');
  if (page.type !== 'page') throw invalid('body.parent.page_id must be a page.');
  const db = newLinkedDatabase(p.spaceId, [spec]);
  const b = new OpsBuilder(p.spaceId, p.id);
  b.block({ type: 'collection_view', id: db.blockId, format: db.format }, page.id, 'block');
  b.ops.push(...db.ops);
  b.ops.push(mk.listAfter({ table: 'block', id: page.id, spaceId: page.space_id }, ['content'], db.blockId));
  b.ops.push(mk.update({ table: 'block', id: page.id, spaceId: page.space_id }, [], { last_edited_time: Date.now(), last_edited_by_id: p.id, last_edited_by_table: 'lit_user' }));
  applyAs(p, b.ops, 'createLinkedDatabase');
  return viewObject(getRecord<CollectionViewRecord>('collection_view', db.viewIds[0])!, getRecord<BlockRecord>('block', db.blockId)!, source);
};

const viewsGet: Handler = (r) => {
  need(r.p, 'read_content');
  const { view, block, source } = viewOr404(r, idParam(r.params.id, 'view_id'));
  return viewObject(view, block, source);
};

const viewsUpdate: Handler = (r) => {
  const { p, body } = r;
  need(p, 'update_content');
  const { view, block, source } = viewOr404(r, idParam(r.params.id, 'view_id'));
  requireStructure(p, block);
  const vp = { table: 'collection_view' as const, id: view.id, spaceId: view.space_id };
  const ops: Operation[] = [];
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('body.name must be a non-empty string.');
    ops.push(mk.set(vp, ['name'], body.name.trim().slice(0, 100)));
  }
  if (body.filter !== undefined || body.sorts !== undefined) {
    if (!source) throw restricted('the data source of this view isn’t available to this connection.');
    const schema = source.schema ?? {};
    if (body.filter !== undefined) ops.push(mk.set(vp, ['query2', 'filter'], body.filter === null ? undefined : groupOf(filterFromApi(body.filter, schema))));
    if (body.sorts !== undefined) ops.push(mk.set(vp, ['query2', 'sort'], body.sorts === null ? undefined : viewSpecFromBody({ type: view.type === 'chart' || (LINKED_VIEW_TYPES as readonly string[]).includes(view.type) ? view.type : 'table', sorts: body.sorts }, source).sort));
  }
  if (!ops.length) throw invalid('body must change name, filter or sorts.');
  applyAs(p, ops, 'updateView');
  return viewObject(getRecord<CollectionViewRecord>('collection_view', view.id)!, block, source);
};

const viewsDelete: Handler = (r) => {
  const { p } = r;
  need(p, 'update_content');
  const { view, block, source } = viewOr404(r, idParam(r.params.id, 'view_id'));
  requireStructure(p, block);
  const live = (block.view_ids ?? []).filter((id) => getRecord<CollectionViewRecord>('collection_view', id)?.alive !== false);
  if (live.length <= 1 && live.includes(view.id)) throw invalid('a database keeps at least one view: delete the database block instead.');
  const ops: Operation[] = [
    mk.listRemove({ table: 'block', id: block.id, spaceId: block.space_id }, ['view_ids'], view.id),
    mk.update({ table: 'collection_view', id: view.id, spaceId: view.space_id }, [], { alive: false }),
  ];
  // the block's source pointers follow the views that remain
  const after = { ...block, view_ids: live.filter((id) => id !== view.id) };
  const remaining = sourceIdsOf({ ...after, format: { ...(block.format ?? {}), collection_pointers: [] } } as BlockRecord);
  const owned = (getRecord<CollectionRecord>('collection', block.collection_id ?? '')?.parent_id === block.id) ? [block.collection_id!] : [];
  const keep = [...new Set([...owned, ...remaining])].map((id) => getRecord<CollectionRecord>('collection', id)).filter((c): c is CollectionRecord => !!c);
  ops.push(mk.update({ table: 'block', id: block.id, spaceId: block.space_id }, ['format'], { collection_pointers: keep.map((c) => ({ id: c.id, table: 'collection', spaceId: c.space_id })) }));
  if (block.collection_id && !keep.some((c) => c.id === block.collection_id) && keep[0]) ops.push(mk.update({ table: 'block', id: block.id, spaceId: block.space_id }, [], { collection_id: keep[0].id }));
  applyAs(p, ops, 'deleteView');
  return { ...viewObject({ ...view, alive: false } as CollectionViewRecord, block, source), in_trash: true };
};

const viewsQuery: Handler = (r) => {
  const { p, body, ctx } = r;
  need(p, 'read_content');
  const { view, block, source } = viewOr404(r, idParam(r.params.id, 'view_id'));
  if (!source) throw notFound('data_source', sourceOfView(view, block) ?? '');
  // the principal's rows and values only: the saved filter and sorts never read what it can't see
  const res = runQuery(ctx.query.rowsOf?.(source.id) ?? [], source, view, ctx.query);
  const { page, next } = paginate(res.rows, (b) => b.id, body.start_cursor, pageSize(body.page_size));
  return listObject(page.map((b) => pageObject(b, ctx)), next, 'page_or_data_source');
};

const databaseViewsList: Handler = (r) => {
  need(r.p, 'read_content');
  const block = readable(r.p, idParam(r.params.id, 'database_id'), 'database');
  if (!DATABASE_TYPES.has(block.type)) throw notFound('database', block.id);
  const views = (block.view_ids ?? [])
    .map((id) => getRecord<CollectionViewRecord>('collection_view', id))
    .filter((v): v is CollectionViewRecord => !!v && v.alive !== false && !(v.format as Json | undefined)?.dashboard_view_id)
    .map((v) => {
      const sid = sourceOfView(v, block);
      let source: CollectionRecord | undefined;
      try {
        source = sid ? readableSource(r, sid) : undefined;
      } catch {
        source = undefined;
      }
      return viewObject(v, block, source);
    });
  const { page, next } = paginate(views, (v) => v.id as string, r.query.start_cursor, pageSize(r.query.page_size));
  return listObject(page, next, 'view');
};

export const VIEW_ROUTES: [string, string, Handler][] = [
  ['POST', '/views', viewsCreate],
  ['GET', '/views/:id', viewsGet],
  ['PATCH', '/views/:id', viewsUpdate],
  ['DELETE', '/views/:id', viewsDelete],
  ['POST', '/views/:id/query', viewsQuery],
  ['GET', '/databases/:id/views', databaseViewsList],
];
