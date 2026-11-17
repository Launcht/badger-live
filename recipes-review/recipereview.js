/**
 * Lindsay's recipe review page (17/11/2026). The rules in ONE place: what may be saved, how a recipe's cost is worked
 * out, and the door (which key may read, which may change). Used by the page (recipe-review/page/, a copy made at
 * deploy), its own Edge Function (supabase/functions/badger-recipes/, a copy made at deploy) and test/recipereview.test.js.
 *
 * Tarryn's cost rule (15/11/2026): a recipe's cost is never typed. It is worked out from its ingredients at the prices
 * we hold, batches rolled up per unit of what they make. A missing price names the ingredient; it is never R0.
 *
 * No imports, no Node or Deno features: it must run in a browser, in Deno and in Node unchanged.
 */

// ---------------------------------------------------------------- what may be saved

export const FIELDS = new Set(['name', 'category', 'kind', 'makes', 'needed', 'notes', 'ingredients', 'takeaway', 'choices', 'anything_else', 'measure'])
// 'piece' is a shared kitchen measure (a slice of THIS loaf): only on a line that names its measure
export const UNITS = ['g', 'kg', 'ml', 'L', 'each', 'slice', 'portion', 'part', 'piece']
export const UNIT_WORDS = { g: 'g', kg: 'kg', ml: 'ml', L: 'L', each: 'each', slice: 'slice', portion: 'portion', part: 'of one' }
export const MAKES_UNITS = ['g', 'kg', 'ml', 'L', 'each', 'portion']
const PRICE_UNITS = ['g', 'ml', 'each', 'slice', 'portion']
const PRICE_FROM = ['Loyverse', 'Odoo']
const LIMIT = { name: 120, category: 60, notes: 4000, anything_else: 8000, lines: 60, takeaway: 20, groups: 10, options: 12, optionLines: 10, lineText: 300, qty: 100000 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF = /^[a-z0-9-]{1,40}$/
export const MEASURE_KEY = /^m-[a-z0-9-]{1,40}$/
const LID = /^[A-Za-z0-9_-]{1,24}$/

const ok = (value) => ({ ok: true, value })
const no = (problem) => ({ ok: false, problem })
const text = (v, max, ask) => {
  if (typeof v !== 'string') return no(ask)
  const t = v.trim()
  if (!t) return no(ask)
  if (t.length > max) return no(`Keep it under ${max} letters.`)
  return ok(t)
}
const freeText = (v, max) => {
  if (v === null || v === undefined) return ok('')
  if (typeof v !== 'string') return no('That could not be read as words.')
  if (v.length > max) return no(`Keep it under ${max} letters.`)
  return ok(v)
}
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN)
let idSeq = 0
const newId = () => `n${Date.now().toString(36)}${(idSeq++).toString(36)}`

function cleanLine(l) {
  if (!l || typeof l !== 'object') return no('An ingredient could not be read.')
  const name = text(l.name, LIMIT.name, 'Each ingredient needs a name.')
  if (!name.ok) return name
  let qty = null
  if (l.qty !== null && l.qty !== undefined && l.qty !== '') {
    qty = num(l.qty)
    if (!Number.isFinite(qty) || qty <= 0 || qty > LIMIT.qty) return no(`${name.value}: the amount must be a number above nought.`)
  }
  if (!UNITS.includes(l.unit)) return no(`${name.value}: pick a unit (g, ml, each, slice).`)
  const item = l.item == null ? null : String(l.item)
  if (item !== null && !UUID.test(item)) return no(`${name.value}: that kitchen item could not be found.`)
  const batch = l.batch == null ? null : String(l.batch)
  if (batch !== null && !REF.test(batch)) return no(`${name.value}: that batch could not be found.`)
  let price = null
  if (l.price != null) {
    const p = l.price
    const per = num(p.per)
    if (typeof p !== 'object' || !Number.isFinite(per) || per < 0 || per > LIMIT.qty || !PRICE_UNITS.includes(p.unit) || !PRICE_FROM.includes(p.from)) {
      return no(`${name.value}: its price could not be read.`)
    }
    price = { per, unit: p.unit, from: p.from }
  }
  const side = (v) => (v == null ? null : String(v).slice(0, LIMIT.lineText))
  // a choice's line can count only with another choice (a double shot of whichever beans): { g: group id, o: option id }
  let when = null
  if (l.when != null) {
    if (typeof l.when !== 'object' || !LID.test(String(l.when.g || '')) || !LID.test(String(l.when.o || ''))) return no(`${name.value}: its "only with" could not be read.`)
    when = { g: String(l.when.g), o: String(l.when.o) }
  }
  const measure = l.measure == null ? null : String(l.measure)
  if (measure !== null && !MEASURE_KEY.test(measure)) return no(`${name.value}: its kitchen measure could not be found.`)
  if (l.unit === 'piece' && !measure) return no(`${name.value}: pick a unit (g, ml, each, slice).`)
  const out = { id: LID.test(String(l.id || '')) ? String(l.id) : newId(), name: name.value, qty, unit: l.unit, item, batch, price, was: side(l.was), flag: side(l.flag) }
  if (when) out.when = when
  if (measure) out.measure = measure
  // a suggested line (Tarryn, 17/11/2026): what it was, and the rounding kept so the cost does not drift
  if (l.adj != null) {
    const adj = num(l.adj)
    if (!Number.isFinite(adj) || adj < 0.9 || adj > 1.1) return no(`${name.value}: its amount could not be read.`)
    if (adj !== 1) out.adj = adj
  }
  // a packaging tick (Tarryn, 17/11/2026: "lets do check boxes"): which packaging on her list this line is
  if (l.pack != null) {
    if (!/^p-[a-z0-9-]{1,40}$/.test(String(l.pack))) return no(`${name.value}: that packaging could not be found.`)
    out.pack = String(l.pack)
  }
  if (l.sug != null) {
    if (typeof l.sug !== 'object' || typeof l.sug.was !== 'string') return no(`${name.value}: its suggestion could not be read.`)
    out.sug = { was: l.sug.was.slice(0, LIMIT.lineText) }
  }
  return ok(out)
}

function cleanLines(v, max) {
  if (!Array.isArray(v)) return no('That list could not be read.')
  if (v.length > max) return no(`Up to ${max} lines, please.`)
  const out = []
  for (const l of v) {
    const c = cleanLine(l)
    if (!c.ok) return c
    out.push(c.value)
  }
  return ok(out)
}

function cleanChoices(v) {
  if (!Array.isArray(v)) return no('The choices could not be read.')
  if (v.length > LIMIT.groups) return no(`Up to ${LIMIT.groups} groups of choices, please.`)
  const out = []
  for (const g of v) {
    if (!g || typeof g !== 'object') return no('A group of choices could not be read.')
    const gname = text(g.name, 60, 'Each group of choices needs a name, like Milk or Bread.')
    if (!gname.ok) return gname
    if (!Array.isArray(g.options) || g.options.length > LIMIT.options) return no(`${gname.value}: up to ${LIMIT.options} choices, please.`)
    const options = []
    for (const o of g.options) {
      if (!o || typeof o !== 'object') return no(`${gname.value}: a choice could not be read.`)
      const oname = text(o.name, 60, `${gname.value}: each choice needs a name.`)
      if (!oname.ok) return oname
      const lines = cleanLines(o.lines || [], LIMIT.optionLines)
      if (!lines.ok) return lines
      options.push({ id: LID.test(String(o.id || '')) ? String(o.id) : newId(), name: oname.value, usual: o.usual === true, lines: lines.value })
    }
    const usual = options.filter((o) => o.usual).length
    if (usual > 1) return no(`${gname.value}: only one choice can be the usual one.`)
    if (usual === 0 && options.length) options[0].usual = true
    out.push({ id: LID.test(String(g.id || '')) ? String(g.id) : newId(), name: gname.value, options })
  }
  // every "only with" must point at a choice of ANOTHER group that is still there
  for (const g of out) {
    for (const o of g.options) {
      for (const l of o.lines) {
        if (!l.when) continue
        const tg = out.find((x) => x.id === l.when.g)
        if (!tg || tg === g || !tg.options.some((x) => x.id === l.when.o)) return no(`${g.name}, ${o.name}: "${l.name}" is only with a choice that is not there any more. Pick another or "always".`)
      }
    }
  }
  return ok(out)
}

// A shared kitchen measure (Tarryn, 17/11/2026): what ONE kitchen unit is, set once for every recipe that uses the item.
// Kept as she typed it: "1 slice = 0.09 of a loaf" (how 'share') or "1 loaf = 11 slices" (how 'count'), never rounded.
function cleanMeasure(v) {
  if (!v || typeof v !== 'object') return no('That measure could not be read.')
  const unit = text(v.unit, 20, 'Say what the kitchen calls one piece, like slice.')
  if (!unit.ok) return unit
  const pack = text(v.pack, 20, 'Say what it comes in, like loaf or bottle.')
  if (!pack.ok) return pack
  let how = null
  let value = null
  if (v.how != null || (v.value != null && v.value !== '')) {
    if (v.how !== 'share' && v.how !== 'count') return no('Pick how you want to say it.')
    value = num(v.value)
    if (v.how === 'share' && !(Number.isFinite(value) && value > 0 && value <= 1)) return no(`One ${unit.value} must be part of one ${pack.value}: a number above nought and up to 1, like 0.09.`)
    if (v.how === 'count' && !(Number.isFinite(value) && value >= 1 && value <= 10000)) return no(`How many ${unit.value}s in one ${pack.value}: a number like 11.`)
    how = v.how
  }
  let grams = null
  if (v.grams != null && v.grams !== '') {
    grams = num(v.grams)
    if (!Number.isFinite(grams) || grams <= 0 || grams > LIMIT.qty) return no(`What one ${unit.value} weighs must be a number of grams above nought.`)
  }
  return ok({ unit: unit.value, pack: pack.value, how, value, grams })
}

/** The part of one pack in one kitchen unit (0.09 of a loaf in a slice), or null while it is not set. */
export function shareOf(m) {
  if (!m || m.value == null) return null
  return m.how === 'count' ? 1 / m.value : m.how === 'share' ? m.value : null
}

/**
 * A measured line in kitchen units: { n, clean }. A line written as part of a pack (0.09 of a loaf) is divided by what one
 * slice is; it is clean only when that comes out whole or a half, and otherwise it is flagged, never rounded. A line
 * written in slices is her number of slices. null while the measure is not set.
 */
export function piecesOf(line, m) {
  if (line.unit === 'piece') return { n: line.qty, clean: true }
  const share = shareOf(m)
  if (!share || line.qty == null) return null
  const n = line.qty / share
  const halves = n * 2
  const clean = Math.abs(halves - Math.round(halves)) < 1e-6 && Math.round(halves) > 0
  return { n: clean ? Math.round(halves) / 2 : n, clean }
}

/** Check one field's value. Returns { ok, value } with the value cleaned, or { ok: false, problem } in plain words. */
export function validate(field, value) {
  if (!FIELDS.has(field)) return no('That cannot be changed here.')
  switch (field) {
    case 'name': return text(value, LIMIT.name, 'The recipe needs a name.')
    case 'category': return text(value, LIMIT.category, 'Pick where it goes on the menu.')
    case 'kind': return value === 'sold' || value === 'batch' ? ok(value) : no('Pick Sold or Batch.')
    case 'needed': return value === true || value === false || value === null ? ok(value) : no('Pick Yes or No.')
    case 'notes': return freeText(value, LIMIT.notes)
    case 'anything_else': return freeText(value, LIMIT.anything_else)
    case 'makes': {
      if (value === null) return ok(null)
      const q = num(value && value.qty)
      if (!Number.isFinite(q) || q <= 0 || q > LIMIT.qty) return no('How much one batch makes must be a number above nought.')
      if (!MAKES_UNITS.includes(value.unit)) return no('Pick a unit for how much it makes (g, kg, ml, L, each or portions).')
      return ok({ qty: q, unit: value.unit })
    }
    case 'ingredients': return cleanLines(value, LIMIT.lines)
    case 'takeaway': return cleanLines(value, LIMIT.takeaway)
    case 'choices': return cleanChoices(value)
    case 'measure': return cleanMeasure(value)
  }
  return no('That cannot be changed here.')
}

// ---------------------------------------------------------------- the cost, worked out

const BASE = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], L: ['ml', 1000], each: ['each', 1], slice: ['slice', 1], portion: ['portion', 1], part: ['each', 1] }
export function toBase(q, unit) {
  const b = BASE[unit]
  return b ? { q: Number((q * b[1]).toPrecision(12)), u: b[0] } : null
}
const MEASURE = { g: 'by weight', ml: 'by volume', each: 'each', slice: 'by the slice', portion: 'by the portion' }

/**
 * One line's cost. ctx: { items: Map(id -> { per, unit, mixed }), recipes: Map(id -> recipe) }.
 * Order: the kitchen item's price (unless it covers several kinds, like regular and almond milk), then the line's own
 * Loyverse or Odoo price, then nothing: { rand: null, missing: '<ingredient>...' }. Never a nought for a missing price.
 */
export function lineCost(line, ctx, seen = new Set()) {
  // a rounded suggestion carries its difference: 2 slices that were 0.091 of a loaf cost 0.091 of a loaf
  if (line.adj && line.adj !== 1) {
    const c = lineCost({ ...line, adj: null }, ctx, seen)
    return c.rand === null ? c : { ...c, rand: c.rand * line.adj }
  }
  if (line.qty == null) return { rand: null, missing: `${line.name}: no amount`, from: null }
  if (line.unit === 'piece') {
    const m = line.measure && ctx.measures ? ctx.measures.get(line.measure) : null
    const share = shareOf(m)
    if (!share) return { rand: null, missing: `${line.name}: how big one ${m ? m.unit : 'piece'} is not set yet`, from: null }
    return lineCost({ ...line, qty: line.qty * share, unit: 'part' }, ctx, seen)
  }
  const b = toBase(line.qty, line.unit)
  if (line.batch) {
    const r = ctx.recipes.get(line.batch)
    if (!r) return { rand: null, missing: `${line.name}: no recipe for it`, from: null }
    if (seen.has(r.id)) return { rand: null, missing: `${r.name} uses itself`, from: null }
    const total = recipeCost(r, ctx, new Set([...seen, r.id])).eat
    if (total.rand === null) return { rand: null, missing: total.missing.join(', '), from: null }
    if (line.unit === 'part') return { rand: total.rand * line.qty, missing: null, from: 'Batch' }
    if (!r.makes) return { rand: null, missing: `${r.name}: how much one batch makes`, from: null }
    const m = toBase(r.makes.qty, r.makes.unit)
    if (!m || m.u !== b.u) return { rand: null, missing: `${line.name}: written ${MEASURE[b.u] || b.u}, the batch makes ${MEASURE[m.u] || m.u}`, from: null }
    return { rand: (total.rand / m.q) * b.q, missing: null, from: 'Batch' }
  }
  const it = line.item ? ctx.items.get(line.item) : null
  if (it && !it.mixed && it.per != null && it.unit === b.u) return { rand: it.per * b.q, missing: null, from: 'Kitchen items' }
  const p = line.price
  if (p && p.unit === b.u) return { rand: p.per * b.q, missing: null, from: p.from }
  if ((it && it.per != null && !it.mixed) || p) {
    const have = it && it.per != null && !it.mixed ? it.unit : p.unit
    return { rand: null, missing: `${line.name}: written ${MEASURE[b.u] || b.u}, bought ${MEASURE[have] || have}`, from: null }
  }
  return { rand: null, missing: `${line.name}: no price yet`, from: null }
}

function sumLines(lines, ctx, seen, acc) {
  for (const l of lines) {
    const c = lineCost(l, ctx, seen)
    if (c.rand === null) acc.missing.push(c.missing)
    else acc.sum += c.rand
  }
}

/**
 * A recipe's cost: eat in (ingredients plus the usual choice in each group) and take away (that plus the take-away
 * extras; null for a batch). Each is { rand, so_far, missing[] }: rand is null whenever anything is missing.
 */
/** The usual choice in each group, by group id. */
export function usualPicks(r) {
  const picks = {}
  for (const g of r.choices || []) { const u = g.options.find((o) => o.usual) || g.options[0]; if (u) picks[g.id] = u.id }
  return picks
}
/** The lines a choice puts in, given what is picked in the other groups. */
export function optionLines(o, picks) {
  return o.lines.filter((l) => !l.when || picks[l.when.g] === l.when.o)
}

export function recipeCost(r, ctx, seen = new Set([r.id])) {
  const eat = { sum: 0, missing: [] }
  sumLines(r.ingredients || [], ctx, seen, eat)
  const picks = usualPicks(r)
  for (const g of r.choices || []) {
    const usual = g.options.find((o) => o.id === picks[g.id])
    if (usual) sumLines(optionLines(usual, picks), ctx, seen, eat)
    // choices with nothing in any of them (Badger Chi's sauces) are not a cost of nought
    if (g.options.length && !g.options.some((o) => o.lines.length)) eat.missing.push(`${g.name}: no choice has anything in it yet`)
  }
  // nothing in it yet is not a cost of nought
  const lines = (r.ingredients || []).length + (r.choices || []).reduce((a, g) => a + ((g.options.find((o) => o.usual) || g.options[0] || { lines: [] }).lines.length), 0)
  if (!lines) eat.missing.push(`${r.name}: no ingredients yet`)
  const done = (a) => ({ rand: a.missing.length ? null : a.sum, so_far: a.sum, missing: [...new Set(a.missing)] })
  if (r.kind === 'batch') return { eat: done(eat), away: null }
  const away = { sum: eat.sum, missing: [...eat.missing] }
  sumLines(r.takeaway || [], ctx, seen, away)
  return { eat: done(eat), away: done(away) }
}

export function fmtRand(n) {
  const [whole, cents] = Math.abs(n).toFixed(2).split('.')
  return `${n < 0 ? '-' : ''}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}
const trim = (n) => String(Number(n.toFixed(3)))
/** An amount the way a kitchen says it: 150 g, 1.5 kg, 300 ml, 2 each, 0.09 of one. */
export function fmtQty(q, unit) {
  if (q == null) return ''
  if (unit === 'g' && q >= 1000) return `${trim(q / 1000)} kg`
  if (unit === 'ml' && q >= 1000) return `${trim(q / 1000)} L`
  return `${trim(q)} ${UNIT_WORDS[unit] || unit}`
}

export function progress(recipes) {
  const live = recipes.filter((r) => !r.left_out)
  return { checked: live.filter((r) => r.needed === true || r.needed === false).length, total: live.length }
}

// ---------------------------------------------------------------- the door

const KEY = /^[A-Za-z0-9_-]{32,128}$/
const reply = (status, body) => ({ status, body })
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * One request from the page. store: { who(key), list(), save(recipeId|null, field, value, who), add(recipe, who),
 * history() } (memoryStore below, or the Supabase one in the function). A wrong key is a plain 404 whatever was asked.
 */
export async function handle(req, store) {
  const key = req && typeof req.key === 'string' ? req.key : ''
  if (!KEY.test(key)) return reply(404, { problem: 'This link is not right. Ask Tarryn for it again.' })
  const me = await store.who(key)
  if (!me) return reply(404, { problem: 'This link is not right. Ask Tarryn for it again.' })
  if (req.action === 'open') {
    const all = await store.list()
    const body = { who: me.who, canEdit: me.edit, recipes: all.recipes, notes: all.notes, items: all.items, measures: all.measures || [], packaging: all.packaging || [] }
    if (!me.edit) body.changes = await store.history()
    return reply(200, body)
  }
  if (req.action === 'save' || req.action === 'add') {
    if (!me.edit) return reply(403, { problem: 'This link can look but not change anything.' })
  }
  if (req.action === 'save' && req.field === 'measure') {
    const v = validate('measure', req.value)
    if (!v.ok) return reply(400, { problem: v.problem })
    if (!(typeof req.measure === 'string' && MEASURE_KEY.test(req.measure))) return reply(404, { problem: 'That measure could not be found.' })
    const r = await store.saveMeasure(req.measure, v.value, me.who)
    if (r.missing) return reply(404, { problem: 'That measure could not be found.' })
    return reply(200, { at: r.at, changed: r.changed, value: v.value })
  }
  if (req.action === 'save') {
    const field = String(req.field || '')
    const v = validate(field, req.value)
    if (!v.ok) return reply(400, { problem: v.problem })
    if (field !== 'anything_else' && !(typeof req.recipe === 'string' && REF.test(req.recipe))) return reply(404, { problem: 'That recipe could not be found.' })
    const r = await store.save(field === 'anything_else' ? null : req.recipe, field, v.value, me.who)
    if (r.missing) return reply(404, { problem: 'That recipe could not be found.' })
    return reply(200, { at: r.at, changed: r.changed, value: v.value })
  }
  if (req.action === 'add') {
    const name = validate('name', req.name)
    if (!name.ok) return reply(400, { problem: name.problem })
    const cat = validate('category', req.category)
    if (!cat.ok) return reply(400, { problem: cat.problem })
    const recipe = {
      id: `new-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 40), sort: 9000,
      category: cat.value, name: name.value, kind: 'sold', makes: null, source: 'new', needed: true, left_out: false,
      notes: '', ingredients: [], takeaway: [], choices: [], seed: {},
    }
    const saved = await store.add(recipe, me.who)
    return reply(200, { recipe: saved })
  }
  return reply(400, { problem: 'That could not be done.' })
}

/** The store, in memory, answering as the database does (a save and its change line together). For tests. */
export function memoryStore({ keys, recipes, items = [], notes = '', measures = [] }) {
  const s = {
    recipes: new Map(recipes.map((r) => [r.id, structuredClone(r)])),
    measures: new Map(measures.map((m) => [m.key, structuredClone(m)])),
    async saveMeasure(key, value, who) {
      const m = s.measures.get(key)
      if (!m) return { missing: true }
      const at = new Date().toISOString()
      const before = { unit: m.unit, pack: m.pack, how: m.how ?? null, value: m.value ?? null, grams: m.grams ?? null }
      if (same(before, value)) return { at, changed: false }
      s.changes.push({ at, who, recipe: null, measure: key, name: m.name, field: 'measure', before, after: value })
      Object.assign(m, value)
      return { at, changed: true }
    },
    notes,
    changes: [],
    async who(key) { return keys[key] || null },
    async list() { return { recipes: [...s.recipes.values()], notes: s.notes, items, measures: [...s.measures.values()] } },
    async save(id, field, value, who) {
      const at = new Date().toISOString()
      if (id === null) {
        if (same(s.notes, value)) return { at, changed: false }
        s.changes.push({ at, who, recipe: null, name: null, field, before: s.notes, after: value })
        s.notes = value
        return { at, changed: true }
      }
      const r = s.recipes.get(id)
      if (!r) return { missing: true }
      if (same(r[field], value)) return { at, changed: false }
      s.changes.push({ at, who, recipe: id, name: r.name, field, before: r[field] ?? null, after: value })
      r[field] = value
      return { at, changed: true }
    },
    async add(recipe, who) {
      s.recipes.set(recipe.id, recipe)
      s.changes.push({ at: new Date().toISOString(), who, recipe: recipe.id, name: recipe.name, field: 'added', before: null, after: recipe.name })
      return recipe
    },
    async history() { return [...s.changes].reverse() },
  }
  return s
}
