/**
 * Lindsay's stock take entry page (20/11/2026). The rules in ONE place: what a count is, what may be saved, the likely
 * units, the progress and the summary, and the door (which key may read, which may change). Used by the page
 * (stock-take/page/, a copy made at deploy), its own Edge Function (supabase/functions/badger-stocktake/, a copy made at
 * deploy) and test/stocktake.test.js.
 *
 * Spec and build: clients/wild-mongoo/badger/spec/2026-11-20-stock-take-entry/
 *
 * No imports, no Node or Deno features: it must run in a browser, in Deno and in Node unchanged.
 *
 * A blank count is NOT COUNTED and is null everywhere. It is never treated as zero; "None in stock" is a 0 she taps.
 * Tarryn 20/11: she may rename any item (the paper's name stays, as sheet_name), remove any item (never deleted; a
 * reason from the list is optional; "same as" another item for a duplicate) and put it back, and note any item.
 * Tarryn 20/11, later: an "Add an item" at the top and bottom of every shelf; and lines we pre-add ourselves (ours:
 * true, "Added by us - check") for what is repacked and stickered, removable like any other.
 */

// ---------------------------------------------------------------- what may be saved

/** The paper's last block, "Anything on the shelf that is not on this sheet": a shelf of its own on the page. */
export const OTHER_SHELF = 'Not on the sheet'
export const SHEET_FIELDS = ['date', 'counted_by', 'checked_by']
// reorder (Tarryn 20/11, later): the level to reorder at, in the unit picked for the count; blank is no level, never 0
export const ITEM_FIELDS = ['count', 'unit', 'note', 'name', 'gone', 'gone_reason', 'same_as', 'reorder']
export const FIELDS = new Set([...SHEET_FIELDS, ...ITEM_FIELDS])
export const GONE_REASONS = [['duplicate', 'Duplicate'], ['wrong', 'Wrong item'], ['not_stocked', 'We don\'t stock this']]
export const ID = /^(t-\d{3}|new-[a-z0-9]{4,30})$/
export const MAX_COUNT = 100000
const LIMIT = { unit: 30, note: 300, name: 120, counted_by: 60, checked_by: 60 }

const ok = (value) => ({ ok: true, value })
const no = (problem) => ({ ok: false, problem })
const FRACTION = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 }
const round3 = (n) => Math.round(n * 1000) / 1000

/**
 * A count as written on paper: 3, 2.5, 2,5, 1/2, 1 1/2, ½, 2½, 1 000. Zero or more, at most MAX_COUNT, three decimals
 * kept. Blank (null, empty, spaces) is null: not counted. Anything else is refused with a reason that never repeats it.
 * A comma and exactly three digits (1,500) could be 1.5 or 1500 (test N-3): it reads as the decimal, and `ask` holds
 * both, so the page asks her and the server refuses it as typed. Never read silently.
 */
export function parseCount(v) {
  if (v === null || v === undefined) return ok(null)
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? ok(round3(v)) : no(`type a number from 0 to ${MAX_COUNT}, like 3 or 2.5.`)
  }
  if (typeof v !== 'string') return no('type a number, like 3 or 2.5.')
  const t = v.trim()
  if (!t) return ok(null)
  let n = null
  let m
  if ((m = /^(\d{1,6})?\s*([½¼¾⅓⅔])$/.exec(t))) n = Number(m[1] || 0) + FRACTION[m[2]]
  else if ((m = /^(?:(\d{1,6})\s+)?(\d{1,4})\/(\d{1,4})$/.exec(t))) n = Number(m[3]) ? Number(m[1] || 0) + Number(m[2]) / Number(m[3]) : null
  else if (/^\d{1,3}( \d{3})+$/.test(t)) n = Number(t.replace(/ /g, ''))
  else if (/^\d{0,6}([.,]\d{1,3})?$/.test(t) && /\d/.test(t)) n = Number(t.replace(',', '.'))
  if (n === null || !Number.isFinite(n) || n < 0 || n > MAX_COUNT) return no(`type a number from 0 to ${MAX_COUNT}, like 3 or 2.5.`)
  const r = ok(round3(n))
  if (/^[1-9]\d{0,2},\d{3}$/.test(t)) r.ask = [round3(n), Number(t.replace(',', ''))]
  return r
}

/** What a typed count reads as, shown under the box when it is not plainly the number ("2,5" shows "= 2.5"). */
export function readBack(text) {
  const t = String(text ?? '').trim()
  const r = parseCount(t)
  if (!r.ok || r.value === null || r.ask || String(r.value) === t) return ''
  return `= ${r.value}`
}
const askProblem = (ask) => `say whether you mean ${ask[0]} or ${ask[1]}.`

function words(v, max, need) {
  if (v === null || v === undefined) v = ''
  if (typeof v !== 'string') return no('That could not be read as words.')
  const t = v.trim().replace(/\s+/g, ' ')
  if (need && !t) return no('every item needs a name.')
  if (t.length > max) return no(`keep it to ${max} letters or fewer.`)
  return ok(t)
}

function dateOk(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v))
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2026 && +m[1] <= 2030
}

/** One field, cleaned, or the reason it cannot be saved. same_as is checked against the list by the door. */
export function validate(field, value) {
  switch (field) {
    case 'count':
    case 'reorder': return parseCount(value)
    case 'unit':
    case 'note':
    case 'counted_by':
    case 'checked_by': return words(value, LIMIT[field], false)
    case 'name': return words(value, LIMIT.name, true)
    case 'gone': return typeof value === 'boolean' ? ok(value) : no('Tap Remove or Undo.')
    case 'gone_reason':
      if (value === null || value === undefined || value === '') return ok(null)
      return GONE_REASONS.some(([k]) => k === value) ? ok(value) : no('choose a reason from the list.')
    case 'same_as':
      if (value === null || value === undefined || value === '') return ok(null)
      return typeof value === 'string' && ID.test(value) ? ok(value) : no('choose the item it is the same as.')
    case 'date':
      if (value === null || value === undefined || value === '') return ok(null)
      return dateOk(value) ? ok(String(value)) : no('choose the date the stock was counted.')
    default: return no('That cannot be changed here.')
  }
}

// ---------------------------------------------------------------- units

/** Every unit offered by a tap. Anything else she types in Other. */
export const ALL_UNITS = ['each', 'g', 'kg', 'ml', 'L', 'pack', 'box', 'bag', 'tin', 'bottle', 'tray', 'case', 'slice', 'portion', 'tub', 'jar', 'packet', 'roll', 'punnet', 'can', 'block', 'drum', 'bucket']
const FROM_TEXT = [
  [/\bdrums?\b/i, 'drum'], [/\bbuckets?\b/i, 'bucket'], [/\bpunnets?\b/i, 'punnet'], [/\bportions?\b/i, 'portion'], [/\bslices?\b/i, 'slice'],
  [/\bpacks?\b/i, 'pack'], [/\bpackets?\b/i, 'packet'], [/\bbox(es)?\b/i, 'box'], [/\bbags?\b/i, 'bag'], [/\btins?\b/i, 'tin'],
  [/\bbottles?\b/i, 'bottle'], [/\btrays?\b/i, 'tray'], [/\bcases?\b/i, 'case'], [/\btubs?\b/i, 'tub'], [/\bjars?\b/i, 'jar'], [/\brolls?\b/i, 'roll'],
  [/\d\s*kg\b|\bper kg\b|\bby the kg\b/i, 'kg'], [/\d\s*g\b/i, 'g'], [/\d\s*ml\b/i, 'ml'], [/\d\s*l\b|\blitres?\b/i, 'L'],
  [/\beach\b|\bcups?\b|\blids?\b|\d+\s*x\s*\d/i, 'each'],
]
const BY_SHELF = {
  'Packaging': ['each', 'pack', 'box', 'case'],
  'Extras (handed with the order)': ['each', 'pack', 'box'],
  'Cold drinks': ['each', 'case', 'tray', 'bottle', 'can'],
  'Coffee, tea and drink powders': ['bag', 'kg', 'g', 'tin', 'each'],
  'Snacks': ['each', 'box', 'pack'],
  'Sweets and chocolates': ['each', 'box', 'pack'],
  'Meat and poultry': ['kg', 'g', 'pack', 'each'],
  'Dairy and eggs': ['each', 'kg', 'L', 'tub', 'block', 'tray'],
  'Bread and rolls': ['each', 'pack', 'bag'],
  'Fruit and veg': ['kg', 'each', 'bag', 'punnet', 'box'],
  'Ready-made (bought in)': ['kg', 'g', 'tub'],
  'Frozen': ['bag', 'kg', 'each'],
  'Tins and jars': ['tin', 'jar', 'each', 'kg'],
  'Sauces and spreads': ['bottle', 'each', 'L', 'tub', 'jar'],
  'Syrups': ['bottle', 'each', 'L'],
  'Dry goods and baking': ['kg', 'g', 'bag', 'pack', 'tub'],
  'Spices and seasoning': ['g', 'kg', 'tub', 'jar', 'pack'],
  'Oils': ['L', 'bottle', 'drum'],
  'Made in our kitchen (batches)': ['portion', 'each', 'g', 'kg', 'tub', 'L'],
  'Other food on an invoice': ['each', 'kg', 'pack', 'box'],
  'Cleaning and kitchen': ['each', 'pack', 'box', 'bottle'],
  [OTHER_SHELF]: ['each', 'kg', 'pack', 'box', 'bag', 'L'],
}
/** The units most likely for this item, first: what the paper says it comes as, then the shelf's. Never chosen for her. */
export function unitsFor(it) {
  const text = String(it.comes_as || '')
  // what it comes in (a drum, a bag, a pack) before what is inside it (20 L, 1 kg): a shelf is counted in containers
  const MEASURE = new Set(['kg', 'g', 'ml', 'L'])
  const found = FROM_TEXT.map(([re, u]) => [text.search(re), u]).filter(([at]) => at >= 0)
    .map(([at, u]) => [MEASURE.has(u) ? 1000 + at : at, u]).sort((a, b) => a[0] - b[0]).map(([, u]) => u)
  const out = []
  for (const u of [...found, ...(BY_SHELF[it.shelf] || ['each', 'kg', 'pack', 'box'])]) if (!out.includes(u)) out.push(u)
  return out.slice(0, 6)
}

// ---------------------------------------------------------------- progress

const live = (items) => items.filter((i) => !i.gone)
/** Counted (more than 0), None in stock (0), not counted yet (blank), added by her; removed items are left out. */
export function summary(items) {
  const l = live(items)
  return {
    total: l.length,
    counted: l.filter((i) => typeof i.count === 'number' && i.count > 0).length,
    zero: l.filter((i) => i.count === 0).length,
    blank: l.filter((i) => i.count === null || i.count === undefined).length,
    added: l.filter((i) => i.added && !i.ours).length,
    removed: items.filter((i) => i.gone).length,
  }
}
export function shelfProgress(items, shelf) {
  const l = live(items).filter((i) => i.shelf === shelf)
  return { entered: l.filter((i) => typeof i.count === 'number').length, total: l.length }
}

// ---------------------------------------------------------------- the door

const KEY = /^[A-Za-z0-9_-]{32,128}$/
const reply = (status, body) => ({ status, body })
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const NOT_RIGHT = 'This link is not right. Ask Tarryn for it again.'

/**
 * One request from the page. store: { who(key), list() -> { items, sheet }, save(id|null, field, value, who, base) ->
 * { at, changed } | { missing } | { stale, current }, add(row, who), history() } (memoryStore below, or the Supabase one in the function).
 * A wrong key is a plain 404 whatever was asked.
 */
export async function handle(req, store) {
  const key = req && typeof req.key === 'string' ? req.key : ''
  if (!KEY.test(key)) return reply(404, { problem: NOT_RIGHT })
  const me = await store.who(key)
  if (!me) return reply(404, { problem: NOT_RIGHT })
  if (req.action === 'open') {
    const all = await store.list()
    const body = { who: me.who, canEdit: me.edit, items: all.items, sheet: all.sheet }
    if (!me.edit) body.changes = await store.history()
    return reply(200, body)
  }
  if (req.action === 'save' || req.action === 'add') {
    if (!me.edit) return reply(403, { problem: 'This link can look but not change anything.' })
  }
  if (req.action === 'save') {
    const field = String(req.field || '')
    if (!FIELDS.has(field)) return reply(400, { problem: 'That cannot be changed here.' })
    const v = validate(field, req.value)
    if (!v.ok) return reply(400, { problem: v.problem })
    if (v.ask) return reply(400, { problem: askProblem(v.ask) })
    // test N-1: every save says what the screen last knew (base); an older screen never overwrites a newer value
    if (!req || !('base' in req)) return reply(400, { problem: 'this page is out of date. Please refresh it.' })
    const b = field === 'name' && typeof req.base === 'string' ? ok(req.base.trim()) : validate(field, req.base)
    if (!b.ok) return reply(400, { problem: 'this page is out of date. Please refresh it.' })
    const stale = (r) => reply(409, { problem: 'Updated on another screen.', stale: true, current: r.current ?? null })
    if (SHEET_FIELDS.includes(field)) {
      const r = await store.save(null, field, v.value, me.who, b.value)
      if (r.stale) return stale(r)
      return reply(200, { at: r.at, changed: r.changed, value: v.value })
    }
    if (!(typeof req.item === 'string' && ID.test(req.item))) return reply(404, { problem: 'That item could not be found.' })
    if (field === 'same_as' && v.value !== null) {
      if (v.value === req.item) return reply(400, { problem: 'choose another item, not this one.' })
      const all = await store.list()
      if (!all.items.some((i) => i.id === v.value)) return reply(400, { problem: 'choose the item it is the same as.' })
    }
    const r = await store.save(req.item, field, v.value, me.who, b.value)
    if (r.missing) return reply(404, { problem: 'That item could not be found.' })
    if (r.badSame) return reply(400, { problem: 'choose the item it is the same as.' })
    if (r.stale) return stale(r)
    return reply(200, { at: r.at, changed: r.changed, value: v.value })
  }
  if (req.action === 'add') {
    const name = validate('name', req.name)
    if (!name.ok) return reply(400, { problem: name.problem })
    const count = parseCount(req.count)
    if (!count.ok) return reply(400, { problem: count.problem })
    if (count.ask) return reply(400, { problem: askProblem(count.ask) })
    const unit = validate('unit', req.unit)
    if (!unit.ok) return reply(400, { problem: unit.problem })
    const note = validate('note', req.note)
    if (!note.ok) return reply(400, { problem: note.problem })
    const all = await store.list()
    const shelves = new Set(all.items.filter((i) => !i.added).map((i) => i.shelf))
    shelves.add(OTHER_SHELF)
    if (typeof req.shelf !== 'string' || !shelves.has(req.shelf)) return reply(400, { problem: 'choose the shelf it was on.' })
    const shelfSort = req.shelf === OTHER_SHELF ? 99 : (all.items.find((i) => i.shelf === req.shelf) || {}).shelf_sort || 99
    // test N-2: added from the top of a shelf, it stays at the top after a refresh; from the bottom, at the bottom
    const sorts = all.items.filter((i) => i.shelf === req.shelf).map((i) => i.sort)
    const sort = req.where === 'top' ? (sorts.length ? Math.min(...sorts) : 1) - 1 : Math.max(9000, ...sorts.map((x) => x + 1))
    const row = {
      id: `new-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 34), sort, shelf: req.shelf,
      shelf_sort: shelfSort, name: name.value, sheet_name: '', comes_as: '', on_invoice: null, on_menu: null, count: count.value,
      unit: unit.value, note: note.value, reorder: null, added: true, ours: false, gone: false, gone_reason: null, same_as: null,
    }
    const saved = await store.add(row, me.who)
    return reply(200, { item: saved })
  }
  return reply(400, { problem: 'That could not be done.' })
}

/** The store, in memory, answering as the database does (a save and its change line together). For tests. */
export function memoryStore({ keys, items, sheet = { date: null, counted_by: '', checked_by: '' } }) {
  const s = {
    items: new Map(items.map((x) => [x.id, structuredClone(x)])),
    sheet: structuredClone(sheet),
    changes: [],
    async who(key) { return keys[key] || null },
    async list() { return { items: [...s.items.values()], sheet: { ...s.sheet } } },
    async save(id, field, value, who, base) {
      const at = new Date().toISOString()
      if (id === null) {
        if (same(s.sheet[field], value)) return { at, changed: false }
        if (!same(s.sheet[field], base)) return { stale: true, current: s.sheet[field] ?? null }
        s.changes.push({ at, who, item: null, name: null, shelf: null, field, before: s.sheet[field] ?? null, after: value })
        s.sheet[field] = value
        return { at, changed: true }
      }
      const r = s.items.get(id)
      if (!r) return { missing: true }
      if (same(r[field], value)) return { at, changed: false }
      if (!same(r[field], base)) return { stale: true, current: r[field] ?? null }
      s.changes.push({ at, who, item: id, name: r.name, shelf: r.shelf, field, before: r[field] ?? null, after: value })
      r[field] = value
      r.touched_at = at
      return { at, changed: true }
    },
    async add(row, who) {
      s.items.set(row.id, row)
      s.changes.push({ at: new Date().toISOString(), who, item: row.id, name: row.name, shelf: row.shelf, field: 'added', before: null, after: row.name })
      return row
    },
    async history() { return [...s.changes].reverse() },
  }
  return s
}
