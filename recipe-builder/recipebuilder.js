/**
 * Lindsay's recipe and menu builder page (21/11/2026). The rules in ONE place: names and units, what To pick, To check
 * and Done mean, the progress counts, how a card's extras are worked out, what may be saved, and the door (which key may
 * read, which may change). Used by the page (recipe-builder/page/, a copy made at deploy), its own Edge Function
 * (supabase/functions/badger-recipebuilder/, a copy made at deploy), the seed (server/recipebuilderseed.js) and
 * test/recipebuilder.test.js.
 *
 * Spec: clients/wild-mongoo/badger/spec/2026-11-21-recipe-builder/02-spec.md. Section 20 ("Changes after review") wins.
 *
 * No imports, no Node or Deno features: it must run in a browser, in Deno and in Node unchanged.
 *
 * A wrong pre-fill is worse than a blank. A pre-fill is To check, never Done, until she confirms or changes it.
 * A blank amount is "not entered", never zero.
 */

// ---------------------------------------------------------------- the five sections, in her order (spec 3.3)

export const HEADINGS = {
  104: 'Brekkie', 105: 'Midday Munch', 98: 'Everyday Favourites', 107: 'Wild Wednesdays',
  87: 'Hot & Happening', 82: "We've Got The Tea",
  74: 'Cool Confidence Drinks', 81: 'Movers and Shakers', 85: 'The Usual Sipspects',
  100: 'Chips', 101: 'Chocolates', 102: 'Sweets', 103: 'Biltong, Nuts and Health Bars', 106: 'Biscuits',
}
export const SECTIONS = [
  { key: 'batches', title: 'Batches', headings: [], word: 'batch' },
  { key: 'meals', title: 'Menu meals', headings: [104, 105, 98, 107], word: 'meal' },
  { key: 'drinks', title: 'Drinks', headings: [87, 82], word: 'hot drink' },
  { key: 'cold', title: 'Cold drinks', headings: [74, 81, 85], word: 'cold drink' },
  { key: 'snacks', title: 'Snacks', headings: [100, 101, 102, 103, 106], word: 'snack' },
]
/** The 14 categories a card may be moved to (13 sub-headings plus Wild Wednesdays). */
export const MOVE_TO = SECTIONS.flatMap((s) => s.headings)
/** Which section a menu heading sits in. No heading is Menu meals ("No category yet"); anything else is not on the page. */
export function sectionOf(headingId) {
  if (headingId === null || headingId === undefined) return 'meals'
  const s = SECTIONS.find((x) => x.headings.includes(Number(headingId)))
  return s ? s.key : null
}
/** A recipe that is on no menu card shows in the section of its review category. */
export const sectionOfCat = (cat) => (cat === 'Hot Drinks' ? 'drinks' : cat === 'Cold Drinks' ? 'cold' : 'meals')
const DRINK_CATS = new Set(['Hot Drinks', 'Cold Drinks'])

// ---------------------------------------------------------------- names (spec 4.4, 6.1)

/** Lower case, "&" read as "and", punctuation and brackets dropped, spaces collapsed. */
export function normName(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}
/** Check A's words: plural "-ies" as "-y", "-oes" as "-o", a final "s" dropped on words over three letters, "coffe" as
 * "coffee", and the one compound "loafbread" read as "loaf bread". */
export function wordsOf(s) {
  const out = new Set()
  for (let w of normName(s).split(' ')) {
    if (!w) continue
    if (w === 'loafbread') { out.add('loaf'); out.add('bread'); continue }
    if (w === 'coffe') w = 'coffee'
    if (w.length > 3 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
    else if (w.length > 3 && w.endsWith('oes')) w = w.slice(0, -2)
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    out.add(w)
  }
  return out
}
/** Check A: every word of one name is in the other. */
export function namesAgree(a, b) {
  const A = wordsOf(a)
  const B = wordsOf(b)
  if (!A.size || !B.size) return false
  const inside = (x, y) => [...x].every((w) => y.has(w))
  return inside(A, B) || inside(B, A)
}

// ---------------------------------------------------------------- units (spec 5.3)

/** The base unit a line's amount is in: the stock item's (g, ml, each) or a batch's makes unit. */
export const baseUnit = (target) => (target ? (target.kind === 'batch' ? target.makes_unit : target.use_unit) || null : null)
const EACH_WORDS = new Set(['each', 'piece', 'slice', 'portion'])
/** The recipe's amount in the picked item's own unit, only when the units agree without guessing; else null. */
export function toItemQty(qty, unit, target) {
  const q = typeof qty === 'number' ? qty : qty === null || qty === undefined || qty === '' ? NaN : Number(qty)
  if (!Number.isFinite(q) || q <= 0) return null
  const to = baseUnit(target)
  if (!to) return null
  let v = null
  if (unit === to) v = q
  else if (unit === 'kg' && to === 'g') v = q * 1000
  else if (unit === 'L' && to === 'ml') v = q * 1000
  else if (EACH_WORDS.has(unit) && to === 'each') v = q
  return v === null || v > MAX ? null : round3(v)
}
/** The word beside the amount box: g, ml, or the piece name (slices for bread). */
export function unitWord(target, qty = 2) {
  const u = baseUnit(target)
  if (u === 'g' || u === 'ml') return u
  const p = target && target.piece_name && target.piece_name !== 'each' ? target.piece_name : null
  if (target && target.kind === 'batch') return target.makes_word === 'portions' ? (qty === 1 ? 'portion' : 'portions') : 'each'
  if (!p) return 'each'
  return qty === 1 ? p : `${p}s`
}

// ---------------------------------------------------------------- amounts the South African way (spec 20.5)

export const MAX = 100000
const FRACTION = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 }
const round3 = (n) => Math.round(n * 1000) / 1000
const ok = (value) => ({ ok: true, value })
const no = (problem) => ({ ok: false, problem })
/** An amount: 2, 2.5, 2,5, ½, 1 1/2, 1 000. Above 0, at most 100,000, three decimals. Blank is null (not entered).
 * "1,500" could be 1.5 or 1500: it reads as the decimal and `ask` holds both; the page asks, the server refuses. */
export function parseAmount(v) {
  if (v === null || v === undefined) return ok(null)
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 && v <= MAX ? ok(round3(v)) : no(`type an amount above 0, up to ${MAX}.`)
  if (typeof v !== 'string') return no('type an amount, like 2 or 2.5.')
  const t = v.trim()
  if (!t) return ok(null)
  let n = null
  let m
  if ((m = /^(\d{1,6})?\s*([½¼¾⅓⅔])$/.exec(t))) n = Number(m[1] || 0) + FRACTION[m[2]]
  else if ((m = /^(?:(\d{1,6})\s+)?(\d{1,4})\/(\d{1,4})$/.exec(t))) n = Number(m[3]) ? Number(m[1] || 0) + Number(m[2]) / Number(m[3]) : null
  else if (/^\d{1,3}( \d{3})+$/.test(t)) n = Number(t.replace(/ /g, ''))
  else if (/^\d{0,6}([.,]\d{1,3})?$/.test(t) && /\d/.test(t)) n = Number(t.replace(',', '.'))
  if (n === null || !Number.isFinite(n) || n <= 0 || n > MAX) return no(`type an amount above 0, up to ${MAX}, like 2 or 2.5.`)
  const r = ok(round3(n))
  if (/^[1-9]\d{0,2},\d{3}$/.test(t)) r.ask = [round3(n), Number(t.replace(',', ''))]
  return r
}
/** What a typed amount reads as, shown under the box when it is not plainly the number ("2,5" shows "= 2.5"). */
export function readBack(text) {
  const t = String(text ?? '').trim()
  const r = parseAmount(t)
  if (!r.ok || r.value === null || r.ask || String(r.value) === t) return ''
  return `= ${r.value}`
}

// ---------------------------------------------------------------- flavours (spec 4.3)

/** Choices that are never a flavour: how it is served, the milk, the shots, the bread, and the recipe's own choices. */
const NOT_FLAVOUR = new Set(['dining option', 'cutlery', 'milk', 'shot', 'coffee type', 'bread', 'jam', 'over night oats'])
/** The flavour a variant stands for ("Coke Zero"), or null. */
export function flavourOf(choiceValues) {
  if (!Array.isArray(choiceValues)) return null
  const f = choiceValues.filter((p) => Array.isArray(p) && !NOT_FLAVOUR.has(String(p[0]).toLowerCase()))
  return f.length === 1 ? String(f[0][1]) : null
}

// ---------------------------------------------------------------- the stored shapes and the fields she may change

export const TABLES = ['recipes', 'lines', 'cards', 'rules', 'extras']
export const FIELDS = {
  recipes: ['name', 'makes', 'make_at_base', 'notes', 'kind', 'grp', 'left_out', 'we_make_this', 'removed'],
  lines: ['pick', 'qty', 'confirmed', 'removed'],
  cards: ['name', 'heading_id', 'on_menu', 'made', 'item_qty', 'confirmed', 'removed'],
  rules: ['active'],
  extras: ['item_id', 'qty', 'serve', 'confirmed', 'removed'],
}
export const ROW_ID = /^[a-z]-[a-z0-9-]{1,70}$/
const ITEM_ID = /^[A-Za-z0-9-]{1,64}$/
const MAKES_WORDS = ['g', 'kg', 'ml', 'L', 'each', 'portions']
const bool = (v, ask) => (typeof v === 'boolean' ? ok(v) : no(ask))
const ref = (v) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' && ITEM_ID.test(v) ? v : undefined)

/** A compound field read the same way everywhere (page, server, database), keys always in this order. */
export function fieldValue(tbl, row, field) {
  if (!row) return null
  if (tbl === 'lines' && field === 'pick') {
    return { item_id: row.item_id ?? null, batch_id: row.batch_id ?? null, not_counted: !!row.not_counted, not_in_stock: !!row.not_in_stock }
  }
  if (tbl === 'cards' && field === 'made') return { made_from: row.made_from ?? null, recipe_id: row.recipe_id ?? null, item_id: row.item_id ?? null }
  if (tbl === 'recipes' && field === 'makes') {
    return { qty: row.makes_qty === null || row.makes_qty === undefined ? null : Number(row.makes_qty), unit: row.makes_unit ?? null, word: row.makes_word ?? null }
  }
  const v = row[field]
  if (v === undefined) return null
  return ['qty', 'item_qty', 'make_at_base'].includes(field) && v !== null ? Number(v) : v
}
/** The other side: put a field's value back on a row. */
export function setField(tbl, row, field, value) {
  if (tbl === 'lines' && field === 'pick') Object.assign(row, value)
  else if (tbl === 'cards' && field === 'made') Object.assign(row, value)
  else if (tbl === 'recipes' && field === 'makes') Object.assign(row, { makes_qty: value.qty, makes_unit: value.unit, makes_word: value.word })
  else row[field] = value
  return row
}

/** One field, cleaned, or the reason it cannot be saved. Whether a pick is a live stock item is checked by the store. */
export function validate(tbl, field, value) {
  if (!FIELDS[tbl] || !FIELDS[tbl].includes(field)) {
    if (tbl === 'recipes' && field === 'makes_unit') return ['g', 'ml', 'each'].includes(value) || value === null ? ok(value) : no('choose g, ml or each.')
    return no('That cannot be changed here.')
  }
  if (['confirmed', 'removed', 'on_menu', 'left_out', 'we_make_this', 'active'].includes(field)) return bool(value, 'Tap it again.')
  if (field === 'make_at_base') {
    // spec 8: above 0 and BELOW 100,000, as the database holds it (test N-1: 100,000 itself jammed the save)
    const a = parseAmount(value)
    return a.ok && a.value !== null && a.value >= MAX ? no(`type an amount below ${MAX}.`) : a
  }
  if (['qty', 'item_qty'].includes(field)) return parseAmount(value)
  if (field === 'name') {
    if (value === null || value === undefined) return tbl === 'cards' ? ok(null) : no('it needs a name.')
    if (typeof value !== 'string') return no('That could not be read as words.')
    const t = value.trim().replace(/\s+/g, ' ')
    if (t.length > 120) return no('keep it to 120 letters or fewer.')
    if (!t) return tbl === 'cards' ? ok(null) : no('it needs a name.')
    return ok(t)
  }
  if (field === 'notes') return typeof value === 'string' && value.length <= 2000 ? ok(value) : value === null ? ok('') : no('keep the note to 2000 letters.')
  if (field === 'kind') return ['sold', 'batch'].includes(value) ? ok(value) : no('That cannot be changed here.')
  if (field === 'grp') return value === null || ['Bakes', 'Made ahead'].includes(value) ? ok(value) : no('choose Bakes or Made ahead.')
  if (field === 'serve') return ['both', 'eat_in', 'take_away'].includes(value) ? ok(value) : no('choose Eat in, Take-away or Both.')
  if (field === 'heading_id') {
    const n = Number(value)
    return MOVE_TO.includes(n) ? ok(n) : no('choose one of the menu categories.')
  }
  if (field === 'item_id') {
    const r = ref(value)
    return r === undefined ? no('choose an item from the list.') : ok(r)
  }
  if (field === 'makes') {
    if (!value || typeof value !== 'object') return no('type how much one batch makes.')
    const q = parseAmount(value.qty)
    if (!q.ok) return q
    if (q.ask) return no(`say whether you mean ${q.ask[0]} or ${q.ask[1]}.`)
    if (q.value === null) return ok({ qty: null, unit: value.unit ?? null, word: value.word ?? null })
    if (!['g', 'ml', 'each'].includes(value.unit)) return no('choose g, ml or each.')
    if (value.word !== null && value.word !== undefined && !MAKES_WORDS.includes(value.word)) return no('choose a unit from the list.')
    return ok({ qty: q.value, unit: value.unit, word: value.word ?? value.unit })
  }
  if (field === 'pick') {
    if (!value || typeof value !== 'object') return no('choose an item from the list.')
    const item = ref(value.item_id)
    const batch = ref(value.batch_id)
    if (item === undefined || batch === undefined) return no('choose an item from the list.')
    const v = { item_id: item, batch_id: batch, not_counted: value.not_counted === true, not_in_stock: value.not_in_stock === true }
    if ([v.item_id, v.batch_id, v.not_counted, v.not_in_stock].filter(Boolean).length > 1) return no('one pick at a time.')
    return ok(v)
  }
  if (field === 'made') {
    if (!value || typeof value !== 'object') return no('choose what it is made from.')
    const mf = value.made_from ?? null
    if (![null, 'recipe', 'as_is'].includes(mf)) return no('choose what it is made from.')
    const r = ref(value.recipe_id)
    const i = ref(value.item_id)
    if (r === undefined || i === undefined) return no('choose from the list.')
    if (r && i) return no('a recipe or one stock item, never both.')
    if (mf === 'as_is' && r) return no('sold as it is has no recipe.')
    if (mf === 'recipe' && i) return no('made from a recipe has no single stock item.')
    return ok({ made_from: mf, recipe_id: r, item_id: i })
  }
  return no('That cannot be changed here.')
}

// ---------------------------------------------------------------- To pick, To check, Done (spec 20.1)

const has = (x) => x !== null && x !== undefined
const live = (rows) => rows.filter((r) => !r.removed)
/** One line: 'off' (removed), 'pick', 'check' or 'done'. */
export function lineState(l) {
  if (l.removed) return 'off'
  if (l.not_counted || l.not_in_stock) return 'done'
  if (!has(l.item_id) && !has(l.batch_id)) return 'pick'
  if (!has(l.qty)) return 'pick'
  if (l.prefill_rule && !l.confirmed && (l.item_id ?? null) === (l.prefill_item_id ?? null) && (l.batch_id ?? null) === (l.prefill_batch_id ?? null)) return 'check'
  return 'done'
}
/** A card's link (made-from, or a flavour's pick): 'pick', 'check' or 'done'. */
function madeState(c, parent) {
  const mf = parent ? parent.made_from : c.made_from
  if (parent) {
    if (!mf) return 'none'
    if (mf === 'as_is' ? !has(c.item_id) || !has(c.item_qty) : !has(c.recipe_id)) return 'pick'
  } else {
    if (c.combo) return 'done'
    if (!mf) return 'pick'
    if (mf === 'as_is' && !kids(c.id).length && (!has(c.item_id) || !has(c.item_qty))) return 'pick'
    if (mf === 'recipe' && !kids(c.id).length && !has(c.recipe_id)) return 'pick'
  }
  const ours = c.prefill_rule && !c.confirmed && (parent ? true : c.prefill_made_from === c.made_from) &&
    (c.recipe_id ?? null) === (c.prefill_recipe_id ?? null) && (c.item_id ?? null) === (c.prefill_item_id ?? null)
  return ours ? 'check' : 'done'
}
let KIDS = new Map()
const kids = (id) => KIDS.get(id) || []
function index(D) {
  KIDS = new Map()
  for (const c of D.cards) if (c.parent_id && !c.removed) { if (!KIDS.has(c.parent_id)) KIDS.set(c.parent_id, []); KIDS.get(c.parent_id).push(c) }
  for (const l of KIDS.values()) l.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
}
const recipeLines = (rid, D) => live(D.lines.filter((l) => l.recipe_id === rid))

/** The extras that go out with a card: its section's rules (less what she left off), and its own. Spec 7 and 20.9. */
export function extrasFor(card, D) {
  if (!card || card.combo || card.parent_id || card.on_menu === false || card.removed) return []
  const section = sectionOf(card.heading_id)
  const recipe = card.made_from === 'recipe' && card.recipe_id ? D.recipes.find((r) => r.id === card.recipe_id) : null
  const drink = !!(recipe && DRINK_CATS.has(recipe.cat))
  const shake = !!(recipe && recipe.cat === 'Cold Drinks')
  const mine = live(D.extras.filter((e) => e.card_id === card.id))
  const skips = new Set(mine.filter((e) => e.action === 'skip').map((e) => e.rule_id))
  const adds = mine.filter((e) => e.action === 'add')
  const out = []
  const rules = [...D.rules].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  for (const r of rules) {
    if (!r.active) continue
    let applies = r.section === section
    if ((section === 'meals' || section === 'snacks') && drink) applies = false
    if (r.section === 'shakes') applies = shake && section !== 'cold'
    if (!applies) continue
    if (r.slot === 'packaging') {
      const fill = adds.find((e) => e.slot === 'packaging')
      if (skips.has(r.id)) out.push({ rule_id: r.id, item_id: null, slot: 'packaging', qty: r.qty, serve: r.serve, from: 'rule', label: r.label, skipped: true, state: 'done' })
      else if (fill) out.push({ ...extraOf(fill), rule_id: r.id, slot: 'packaging', from: 'card', label: r.label })
      else out.push({ rule_id: r.id, item_id: null, slot: 'packaging', qty: r.qty, serve: r.serve, from: 'rule', label: r.label, state: 'pick' })
      continue
    }
    if (out.some((x) => x.item_id === r.item_id && x.from === 'rule' && !x.skipped)) continue
    out.push({ rule_id: r.id, item_id: r.item_id, slot: null, qty: r.qty, serve: r.serve, from: 'rule', label: r.label, skipped: skips.has(r.id), state: 'done' })
  }
  for (const e of adds) {
    if (e.slot === 'packaging' && out.some((x) => x.extra_id === e.id)) continue
    if (has(e.item_id) && out.some((x) => x.from === 'rule' && !x.skipped && x.item_id === e.item_id)) continue
    out.push({ ...extraOf(e), from: 'card' })
  }
  return out
}
function extraOf(e) {
  let state = 'done'
  if (!has(e.item_id) || !has(e.qty)) state = 'pick'
  else if (e.prefill_rule && !e.confirmed && e.item_id === e.prefill_item_id) state = 'check'
  return { extra_id: e.id, rule_id: e.rule_id ?? null, item_id: e.item_id ?? null, slot: e.slot ?? null, qty: e.qty === null || e.qty === undefined ? null : Number(e.qty), serve: e.serve, skipped: false, state }
}

const isBatch = (r) => r.kind === 'batch'
const counted = (r) => !r.removed && (!r.not_made_yet || r.we_make_this)
/** Recipes no card uses ("Not on the menu yet?"). */
export function strays(D) {
  const used = new Set()
  for (const c of D.cards) if (!c.removed && c.recipe_id) used.add(c.recipe_id)
  return D.recipes.filter((r) => !r.removed && !isBatch(r) && !used.has(r.id))
}

/**
 * One card's status. `id` is a card (c-...) or a recipe shown as its own card (r-...: a batch, or a recipe on no menu
 * card). { pick, check, done, label, off }.
 */
export function cardStatus(id, D) {
  index(D)
  let pick = 0
  let check = 0
  let notInStock = 0
  const add = (s) => { if (s === 'pick') pick++; else if (s === 'check') check++ }
  const lineCounts = (rid, seen = new Set()) => {
    if (!rid || seen.has(rid)) return
    seen.add(rid)
    for (const l of recipeLines(rid, D)) { add(lineState(l)); if (l.not_in_stock) notInStock++ }
  }
  const words = (extra) => {
    if (!pick && !check) return { pick, check, done: true, label: 'Done', notInStock }
    const parts = []
    if (extra) parts.push(extra)
    if (pick) parts.push(`${pick} to pick`)
    if (check) parts.push(`${check} to check`)
    return { pick, check, done: false, label: parts.join(', '), notInStock }
  }
  if (id.startsWith('r-')) {
    const r = D.recipes.find((x) => x.id === id)
    if (!r) return { pick: 0, check: 0, done: true, label: 'Done', notInStock: 0 }
    if (r.left_out) return { pick: 0, check: 0, done: true, label: 'We don\'t make this', off: true, notInStock: 0 }
    if (isBatch(r)) {
      lineCounts(r.id)
      if (!has(r.makes_qty)) { pick++; return { ...words(), label: words('How much does one batch make?').label } }
      return words()
    }
    pick++ // "Say where this goes"
    lineCounts(r.id)
    return { ...words(), label: pick + check > 1 ? `Say where this goes, ${words().label}` : 'Say where this goes' }
  }
  const c = D.cards.find((x) => x.id === id)
  if (!c) return { pick: 0, check: 0, done: true, label: 'Done', notInStock: 0 }
  if (c.combo) return { pick: 0, check: 0, done: true, label: 'A combo', notInStock: 0 }
  if (c.on_menu === false) return { pick: 0, check: 0, done: true, label: 'Not on the menu', off: true, notInStock: 0 }
  const ms = madeState(c)
  if (!c.made_from) return { pick: 1, check: 0, done: false, label: 'Say what it is made from', notInStock: 0 }
  add(ms)
  const fl = kids(c.id).filter((k) => k.on_menu !== false)
  for (const k of fl) {
    add(madeState(k, c))
    if (c.made_from === 'recipe') lineCounts(k.recipe_id)
  }
  if (c.made_from === 'recipe' && !fl.length && !kids(c.id).length) lineCounts(c.recipe_id)
  for (const e of extrasFor(c, D)) if (!e.skipped) add(e.state)
  return words()
}

/** "All correct": the saves that confirm this card's To check items, and nothing else (spec 20.2). */
export function allCorrect(id, D) {
  index(D)
  const out = []
  const conf = (tbl, rid) => out.push({ tbl, id: rid, field: 'confirmed', value: true, base: false })
  const lines = (rid) => { for (const l of recipeLines(rid, D)) if (lineState(l) === 'check') conf('lines', l.id) }
  if (id.startsWith('r-')) { lines(id); return out }
  const c = D.cards.find((x) => x.id === id)
  if (!c || c.combo || c.on_menu === false) return out
  if (madeState(c) === 'check') conf('cards', c.id)
  const fl = kids(c.id).filter((k) => k.on_menu !== false)
  for (const k of fl) {
    if (madeState(k, c) === 'check') conf('cards', k.id)
    if (c.made_from === 'recipe') lines(k.recipe_id)
  }
  if (c.made_from === 'recipe' && !kids(c.id).length) lines(c.recipe_id)
  for (const e of extrasFor(c, D)) if (!e.skipped && e.state === 'check' && e.extra_id) conf('extras', e.extra_id)
  return out
}

/** Every card on the page, in page order, with its section and group: what the page draws and what the counts count. */
export function layout(D) {
  index(D)
  const out = []
  const rs = D.recipes.filter((r) => isBatch(r) && !r.removed)
  for (const grp of ['Bakes', 'Made ahead']) {
    for (const r of rs.filter((x) => (x.grp || 'Made ahead') === grp && !x.not_made_yet).sort(byName)) out.push({ id: r.id, section: 'batches', group: grp, kind: 'batch' })
  }
  for (const r of rs.filter((x) => x.not_made_yet).sort(byName)) out.push({ id: r.id, section: 'batches', group: 'notmade', kind: 'batch' })
  const top = D.cards.filter((c) => !c.parent_id && !c.removed)
  const st = strays(D)
  for (const s of SECTIONS.slice(1)) {
    const groups = s.key === 'meals' ? [...s.headings, null] : s.headings
    for (const h of groups) {
      const here = top.filter((c) => (h === null ? c.heading_id === null || c.heading_id === undefined : Number(c.heading_id) === h))
      const on = here.filter((c) => c.on_menu !== false).sort(byMenu)
      const off = here.filter((c) => c.on_menu === false).sort(byMenu)
      for (const c of [...on, ...off]) out.push({ id: c.id, section: s.key, group: h === null ? 'none' : String(h), kind: 'card' })
    }
    const mine = st.filter((r) => sectionOfCat(r.cat) === s.key)
    for (const r of mine.filter((x) => !x.not_made_yet).sort(byName)) out.push({ id: r.id, section: s.key, group: 'stray', kind: 'stray' })
    for (const r of mine.filter((x) => x.not_made_yet).sort(byName)) out.push({ id: r.id, section: s.key, group: 'notmade', kind: 'stray' })
  }
  return out
}
const byName = (a, b) => String(a.name).localeCompare(String(b.name))
const byMenu = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name || a.menu_name).localeCompare(String(b.name || b.menu_name))

/** Cards done per section, per group, and for the page; to pick and to check in words; make-more set on batches. */
export function progress(D) {
  const sections = {}
  for (const s of SECTIONS) sections[s.key] = { done: 0, total: 0, pick: 0, check: 0, notInStock: 0, makeAtSet: 0, batches: 0, groups: {} }
  const total = { done: 0, total: 0 }
  const cards = {}
  for (const x of layout(D)) {
    const r = x.id.startsWith('r-') ? D.recipes.find((y) => y.id === x.id) : null
    const st = cardStatus(x.id, D)
    cards[x.id] = st
    if (r && !counted(r)) continue
    const s = sections[x.section]
    const g = (s.groups[x.group] ||= { done: 0, total: 0 })
    s.total++
    g.total++
    total.total++
    if (st.done) { s.done++; g.done++; total.done++ }
    s.pick += st.pick
    s.check += st.check
    s.notInStock += st.notInStock || 0
    if (x.section === 'batches') { s.batches++; if (has(r.make_at_base)) s.makeAtSet++ }
  }
  return { sections, total, cards }
}

// ---------------------------------------------------------------- batches inside batches (spec 5.2, 04 R7)

/** Why a batch cannot be picked inside a recipe: 'loop' (it would sit inside itself), 'deep' (more than three deep), or null. */
export function loopReason(recipeId, batchId, D) {
  if (recipeId === batchId) return 'loop'
  const inside = (rid) => live(D.lines.filter((l) => l.recipe_id === rid && l.batch_id)).map((l) => l.batch_id)
  const holders = (rid) => [...new Set(live(D.lines.filter((l) => l.batch_id === rid)).map((l) => l.recipe_id))]
  const contains = (rid, target, seen = new Set()) => {
    if (seen.has(rid)) return false
    seen.add(rid)
    return inside(rid).some((b) => b === target || contains(b, target, seen))
  }
  if (contains(batchId, recipeId)) return 'loop'
  const down = (rid, seen = new Set()) => (seen.has(rid) ? 0 : (seen.add(rid), 1 + Math.max(0, ...inside(rid).map((b) => down(b, seen)))))
  const rec = D.recipes.find((r) => r.id === recipeId)
  const up = (rid, seen = new Set()) => (seen.has(rid) ? 0 : (seen.add(rid), 1 + Math.max(0, ...holders(rid).filter((h) => (D.recipes.find((r) => r.id === h) || {}).kind === 'batch').map((h) => up(h, seen)))))
  const above = rec && rec.kind === 'batch' ? up(recipeId) : 0
  return above + down(batchId) > 3 ? 'deep' : null
}
export const wouldLoop = (recipeId, batchId, D) => loopReason(recipeId, batchId, D) !== null

// ---------------------------------------------------------------- fixes after the independent test (05-test-report.md)

/** B-1: where the page opens. The first visit stays at the top with the how-to showing; a link to one card wins. */
export function openingPlan({ seenHowto, deep, first }) {
  if (deep) return { open: deep, scroll: true }
  if (!first) return { open: null, scroll: false }
  return { open: first, scroll: !!seenHowto }
}

/** The units she may say a batch makes in, each with its base unit and factor. */
export const MAKES_WORDS_TO_BASE = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], L: ['ml', 1000], each: ['each', 1], portions: ['each', 1] }
export const shownAmount = (base, word) => (base === null || base === undefined ? null : round3(Number(base) / (MAKES_WORDS_TO_BASE[word] || ['', 1])[1]))
export const toBase = (n, word) => (n === null || n === undefined ? null : round3(Number(n) * (MAKES_WORDS_TO_BASE[word] || ['', 1])[1]))
/**
 * B-2: a new unit for what a batch makes. The same kind of unit says the same amount another way (3,000 g is 3 kg);
 * another kind keeps the number she sees, in the new unit (2 L becomes 2 kg). Over the limit is refused, never saved.
 */
export function rewordMakes(cur, word) {
  const to = MAKES_WORDS_TO_BASE[word]
  if (!to) return no('choose a unit from the list.')
  if (!cur || cur.qty === null || cur.qty === undefined) return ok({ qty: null, unit: null, word: null })
  if (to[0] === cur.unit) return ok({ qty: Number(cur.qty), unit: cur.unit, word })
  const base = toBase(shownAmount(cur.qty, cur.word || cur.unit), word)
  if (!(base > 0) || base > MAX) return no(`that would be more than ${MAX} ${to[0]}. Type the amount again in ${word}.`)
  return ok({ qty: base, unit: to[0], word })
}

/**
 * B-3: the page's saves, one entry per field. A change made while an earlier save of the same field is still on its way
 * (an Undo tapped at once) is kept and sent next, from the value that was sent, so it always lands. A refused save
 * hands back the saved value to put on screen, so the next save starts from the truth.
 *   change(meta, old, value)  meta: { tbl, id, field }; old: what the screen showed before
 *   take()                    the entries to send now (moved to "on its way")
 *   settle(result)            one answer: { set: false } or { set: true, value, problem?, stale? }
 *   retry(entries)            no connection: send them again later
 */
export function saveQueue(initial = []) {
  const queued = new Map()
  const sending = new Map()
  const k = (m) => `${m.tbl}|${m.id}|${m.field}`
  for (const e of initial) if (e && e.tbl && e.id && e.field && 'base' in e) queued.set(k(e), { tbl: e.tbl, id: e.id, field: e.field, v: e.v, base: e.base })
  return {
    change(m, old, value) {
      const key = k(m)
      const q = queued.get(key)
      const s = sending.get(key)
      const base = q ? q.base : s ? s.v : old
      if (same(base, value)) { queued.delete(key); return }
      queued.set(key, { tbl: m.tbl, id: m.id, field: m.field, v: value, base })
    },
    take(max = 250) {
      const out = []
      for (const [key, e] of queued) {
        if (sending.has(key)) continue // one save of a field at a time: the next waits for the answer
        if (out.length >= max) break
        out.push(e)
      }
      for (const e of out) { queued.delete(k(e)); sending.set(k(e), e) }
      return out.map((e) => ({ ...e }))
    },
    settle(r) {
      const key = k(r)
      const e = sending.get(key)
      sending.delete(key)
      const next = queued.get(key)
      if (r.ok) return { set: false }
      if (r.stale) {
        queued.delete(key)
        return { set: true, value: r.current ?? null, stale: true }
      }
      // refused: the server still holds what it held before this save
      if (next && e) {
        if (same(next.v, e.base)) { queued.delete(key); return { set: true, value: e.base, problem: r.problem } }
        next.base = e.base
        return { set: false, problem: r.problem }
      }
      return { set: true, value: e ? e.base : null, problem: r.problem }
    },
    retry(entries) {
      for (const e of entries) {
        const key = k(e)
        sending.delete(key)
        const next = queued.get(key)
        if (!next) { queued.set(key, e); continue }
        if (same(next.v, e.base)) queued.delete(key)
        else next.base = e.base
      }
    },
    size() { return queued.size + sending.size },
    waiting() { return queued.size },
    pending() { return [...sending.values(), ...queued.values()].map((e) => ({ ...e })) },
  }
}

// ---------------------------------------------------------------- the door

const KEY = /^[A-Za-z0-9_-]{32,128}$/
const reply = (status, body) => ({ status, body })
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const NOT_RIGHT = 'This link does not work. Ask Tarryn for it again.'
const LOOP_WORDS = { loop: 'This would put the batch inside itself.', deep: 'Batches can sit at most three deep. Pick the item itself instead.' }
const newId = (p) => `${p}-new-${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`.slice(0, 40)

/**
 * One save, checked. store.save(tbl, id, field, value, who, base) -> { at, changed } | { missing } | { stale, current }
 * | { badItem }. A pick of a batch is checked for loops against store.graph().
 */
async function saveOne(s, store, who) {
  const tbl = String(s && s.tbl || '')
  const field = String(s && s.field || '')
  if (!TABLES.includes(tbl)) return reply(400, { problem: 'That cannot be changed here.' })
  if (!(typeof s.id === 'string' && ROW_ID.test(s.id))) return reply(404, { problem: 'That could not be found.' })
  const v = validate(tbl, field, s.value)
  if (!v.ok) return reply(400, { problem: v.problem })
  if (v.ask) return reply(400, { problem: `say whether you mean ${v.ask[0]} or ${v.ask[1]}.` })
  if (!('base' in s)) return reply(400, { problem: 'this page is out of date. Please refresh it.' })
  const b = s.base === null ? ok(null) : validate(tbl, field, s.base)
  if (!b.ok) return reply(400, { problem: 'this page is out of date. Please refresh it.' })
  if (tbl === 'lines' && field === 'pick' && v.value.batch_id) {
    const g = await store.graph()
    const ln = g.lines.find((l) => l.id === s.id)
    if (!ln) return reply(404, { problem: 'That could not be found.' })
    const bt = g.recipes.find((r) => r.id === v.value.batch_id)
    if (!bt || bt.kind !== 'batch' || bt.removed) return reply(400, { problem: 'choose one of our batches.' })
    const why = ln.recipe_id ? loopReason(ln.recipe_id, v.value.batch_id, g) : null
    if (why) return reply(400, { problem: LOOP_WORDS[why] })
  }
  const r = await store.save(tbl, s.id, field, v.value, who, b.value)
  if (r.missing) return reply(404, { problem: 'That could not be found.' })
  if (r.badItem) return reply(400, { problem: 'that item is no longer in our stock. Pick another.' })
  if (r.stale) return reply(409, { problem: 'Changed on another screen.', stale: true, current: r.current ?? null })
  return reply(200, { at: r.at, changed: r.changed, value: v.value })
}

/** A new row: a line, a menu item she adds, an extra (or a Leave off), or a recipe written for a card. */
function newRow(tbl, row) {
  if (!row || typeof row !== 'object') return no('That could not be added.')
  const id = (x) => (x === null || x === undefined ? null : typeof x === 'string' && ROW_ID.test(x) ? x : undefined)
  if (tbl === 'lines') {
    const rid = id(row.recipe_id)
    const oid = id(row.option_id)
    if (!rid || oid === undefined) return no('That recipe could not be found.')
    return ok({ id: newId('l'), recipe_id: rid, place: oid ? 'option' : 'ingredient', option_id: oid, sort: 9000, src_qty: null, src_unit: null, src_name: '',
      src_was: null, review_line_id: null, item_id: null, batch_id: null, not_counted: false, not_in_stock: false, qty: null, prefill_rule: null, prefill_item_id: null,
      prefill_batch_id: null, confirmed: false, removed: false, added: true })
  }
  if (tbl === 'cards') {
    const n = validate('cards', 'name', row.name)
    if (!n.ok || !n.value) return no('type the menu item\'s name.')
    const h = validate('cards', 'heading_id', row.heading_id)
    if (!h.ok) return h
    const rid = id(row.recipe_id)
    if (rid === undefined) return no('That recipe could not be found.')
    return ok({ id: newId('c'), parent_id: null, menu_item_id: null, flavour: null, variant_ids: [], menu_name: n.value, name: null, live_heading_id: null,
      heading_id: h.value, on_menu: true, added: true, combo: false, made_from: rid ? 'recipe' : null, recipe_id: rid, item_id: null, item_qty: 1, prefill_made_from: null,
      prefill_recipe_id: null, prefill_item_id: null, prefill_rule: null, confirmed: false, removed: false, sort: 9000 })
  }
  if (tbl === 'extras') {
    const cid = id(row.card_id)
    if (!cid) return no('That menu item could not be found.')
    if (row.action === 'skip') {
      const rid = id(row.rule_id)
      if (!rid) return no('That could not be left off.')
      return ok({ id: newId('e'), card_id: cid, action: 'skip', item_id: null, slot: null, qty: null, serve: null, prefill_rule: null, prefill_item_id: null,
        confirmed: true, rule_id: rid, removed: false })
    }
    if (row.action !== 'add') return no('That could not be added.')
    const it = validate('extras', 'item_id', row.item_id)
    const q = parseAmount(row.qty ?? 1)
    const sv = validate('extras', 'serve', row.serve || 'both')
    if (!it.ok) return it
    if (!q.ok || q.ask) return no('type how many go out with it.')
    if (!sv.ok) return sv
    const slot = row.slot === 'packaging' ? 'packaging' : null
    return ok({ id: newId('e'), card_id: cid, action: 'add', item_id: it.value, slot, qty: q.value, serve: sv.value, prefill_rule: null, prefill_item_id: null,
      confirmed: true, rule_id: slot ? id(row.rule_id) || null : null, removed: false })
  }
  if (tbl === 'recipes') {
    const n = validate('recipes', 'name', row.name)
    if (!n.ok) return n
    return ok({ id: newId('r'), review_id: null, kind: 'sold', name: n.value, grp: null, cat: typeof row.cat === 'string' ? row.cat.slice(0, 60) : 'Midday Munch',
      source_tag: 'new', makes_qty: null, makes_unit: null, makes_word: null, make_at_base: null, not_made_yet: false, we_make_this: false, left_out: false,
      notes: '', removed: false, sort: 9000 })
  }
  return no('That could not be added.')
}

/**
 * One request from the page. store: { who(key), list(), stock(), graph(), save(...), add(tbl, row, who), history() }
 * (memoryStore below, or the Supabase one in the function). A wrong key is a plain 404 whatever was asked.
 */
export async function handle(req, store) {
  const key = req && typeof req.key === 'string' ? req.key : ''
  if (!KEY.test(key)) return reply(404, { problem: NOT_RIGHT })
  const me = await store.who(key)
  if (!me) return reply(404, { problem: NOT_RIGHT })
  if (req.action === 'open') {
    const [data, stock] = await Promise.all([store.list(), store.stock()])
    const body = { who: me.who, canEdit: me.edit, data: { ...data, stock } }
    if (!me.edit) body.changes = await store.history()
    return reply(200, body)
  }
  if (!['save', 'many', 'add'].includes(req.action)) return reply(400, { problem: 'That could not be done.' })
  if (!me.edit) return reply(403, { problem: 'This link can look but not change anything.' })
  if (req.action === 'save') return saveOne(req, store, me.who)
  if (req.action === 'many') {
    if (!Array.isArray(req.saves) || !req.saves.length || req.saves.length > 300) return reply(400, { problem: 'That could not be done.' })
    const results = []
    for (const s of req.saves) {
      // test N-1: one save the database refuses must never take the others down with it
      let r
      try { r = await saveOne(s, store, me.who) } catch { r = reply(500, { problem: 'that could not be saved. Please try it again.' }) }
      results.push({ tbl: s && s.tbl, id: s && s.id, field: s && s.field, ok: r.status === 200, ...r.body })
    }
    return reply(200, { results })
  }
  const tbl = String(req.tbl || '')
  const n = newRow(tbl, req.row)
  if (!n.ok) return reply(400, { problem: n.problem })
  const r = await store.add(tbl, n.value, me.who)
  if (r.missing) return reply(404, { problem: 'That could not be found.' })
  if (r.badItem) return reply(400, { problem: 'that item is no longer in our stock. Pick another.' })
  return reply(200, { row: r.row })
}

/** The store, in memory, answering as the database does (a save and its change line together). For tests. */
export function memoryStore({ keys, data }) {
  const D = structuredClone(data)
  const changes = []
  const parentOf = { lines: (row) => (row.recipe_id ? D.recipes.find((r) => r.id === row.recipe_id) : true), extras: (row) => D.cards.find((c) => c.id === row.card_id) }
  const liveItem = (id) => id === null || D.stock.some((k) => k.id === id)
  return {
    changes,
    async who(key) { return keys[key] || null },
    async list() { const { stock, ...rest } = structuredClone(D); return rest },
    async stock() { return structuredClone(D.stock) },
    async graph() { return { recipes: D.recipes.map((r) => ({ id: r.id, kind: r.kind, removed: !!r.removed })), lines: D.lines.map((l) => ({ id: l.id, recipe_id: l.recipe_id, batch_id: l.batch_id, removed: !!l.removed })) } },
    async save(tbl, id, field, value, who, base) {
      const at = new Date().toISOString()
      const row = D[tbl].find((r) => r.id === id)
      if (!row) return { missing: true }
      const before = fieldValue(tbl, row, field)
      if (same(before, value)) return { at, changed: false }
      if (!same(before, base)) return { stale: true, current: before }
      if (field === 'pick' && !liveItem(value.item_id)) return { badItem: true }
      if ((field === 'item_id' && !liveItem(value)) || (field === 'made' && !liveItem(value.item_id))) return { badItem: true }
      setField(tbl, row, field, value)
      row.touched_at = at
      row.touched_by = who
      changes.push({ id: changes.length + 1, at, who, tbl, row_id: id, field, before, after: value })
      return { at, changed: true }
    },
    async add(tbl, row, who) {
      if (parentOf[tbl] && !parentOf[tbl](row)) return { missing: true }
      if (tbl === 'extras' && !liveItem(row.item_id)) return { badItem: true }
      const at = new Date().toISOString()
      const r = { ...row, touched_at: at, touched_by: who }
      D[tbl].push(r)
      changes.push({ id: changes.length + 1, at, who, tbl, row_id: r.id, field: 'added', before: null, after: r })
      return { row: r }
    },
    async history() { return [...changes].reverse() },
  }
}
