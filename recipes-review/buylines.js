/**
 * Where we buy each product, and how much of our unit one of it is (Tarryn, 19/11/2026). The rules in ONE place, used
 * by the recipe review page (a copy made at deploy), its Edge Function (a copy made at deploy), the seed and the tests.
 *
 * Spec: clients/wild-mongoo/badger/spec/2026-11-19-recipes-and-suppliers/01-spec-editable-page.md (with its fixes after
 * review) and 01b-product-names.md.
 *
 *   guard(product, line)       is this invoice line a different product? refuse, warn, or fine (spec section 3)
 *   readPack(product, line)    "1 of these = N of our unit", worked out, or gold (Please confirm) (spec section 2)
 *   pickTicks(...)             our pre-ticks, by the written rule (spec section 3)
 *   splitOneOption, choiceOnly the Jam and Toast fixes (spec 2.7)
 *   crossKind                  never carry a number across kinds (spec 2.5)
 *   extrasFromTakeaway         menu extras pre-fill (spec 2.8)
 *   unitCost                   what one of our unit costs, from the ticked line with the latest invoice date
 *
 * No imports, no Node or Deno features: it must run in a browser, in Deno and in Node unchanged.
 */

// ---------------------------------------------------------------- words

// One spelling for every word the guard compares (the build_page.py list, widened by 01b rule 7).
const SPELL = {
  mozarella: 'mozzarella', hellmanns: 'hellmans', hellmann: 'hellmans', marmelade: 'marmalade', yogurt: 'yoghurt',
  tumeric: 'turmeric', ecofresh: 'fresh', smok: 'smoked', dry: 'dried', sundried: 'dried', can: 'canned', tin: 'canned',
  tinned: 'canned', choc: 'chocolate', ched: 'cheddar', blk: 'black', mix: 'mixed',
}
/** Plural to singular, so Blueberry and Blueberries are one word. */
export function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1)
  return w
}
export function words(s) {
  const raw = String(s || '').toLowerCase().replace(/long[\s-]*life/g, ' longlife ').match(/[a-z]+/g) || []
  return raw.map((w) => { const a = SPELL[w] || w; const b = stem(a); return SPELL[b] || b })
}

// The words that make a different product (01b rules 1 and 2). Each maps a word to its value in one family.
const FORM = { grated: 'grated', block: 'block', loaf: 'block', bulk: 'block', sliced: 'sliced', slice: 'sliced', portion: 'portion', sachet: 'portion', tube: 'tube', stick: 'tube', ground: 'ground', powder: 'ground', whole: 'whole', seed: 'seed', flake: 'flake', ring: 'ring', tidbit: 'piece', piece: 'piece', chunk: 'piece' }
// a strong form is a different product from the plain one even when only one side says it (honey portions vs honey)
const STRONG_FORM = new Set(['grated', 'sliced', 'portion', 'tube', 'flake'])
const STATE = { fresh: 'fresh', frozen: 'frozen', canned: 'canned', dried: 'dried', smoked: 'smoked', longlife: 'long life', pickled: 'pickled' }
const COLOUR = new Set(['red', 'white', 'green', 'yellow', 'black', 'brown', 'mixed'])
const CHEESES = ['cheddar', 'mozzarella', 'feta', 'gouda', 'parmesan', 'halloumi']
const SAY = { ground: 'powder', longlife: 'long life', 'long life': 'long life', 'cheddar-style': 'a cheddar-style cheese' }

function families(t) {
  const s = new Set(t)
  const f = {}
  const style = t.some((w) => /^cheddar.+/.test(w) || w === 'style')
  if (s.has('cheese') || CHEESES.some((c) => s.has(c)) || style) {
    f.cheese = style ? ['cheddar-style'] : s.has('cream') ? ['cream cheese'] : CHEESES.filter((c) => s.has(c))
  } else if (['yoghurt', 'cream', 'milk', 'butter', 'buttermilk', 'margarine'].some((w) => s.has(w)) && !s.has('peanut') && !s.has('chocolate') && !s.has('coconut')) {
    const d = ['yoghurt', 'milk', 'butter', 'buttermilk', 'margarine'].filter((w) => s.has(w))
    f.dairy = d.length ? d : ['cream']
  }
  if (s.has('jam') || s.has('marmalade')) f.jam = ['apricot', 'strawberry', 'marmalade'].filter((w) => s.has(w))
  if (s.has('mayonnaise')) f.mayo = ['nola', 'hellmans'].filter((w) => s.has(w))
  if (s.has('milk') && !s.has('chocolate')) { const m = ['almond', 'oat', 'soya', 'coconut'].filter((w) => s.has(w)); f.milk = m.length ? m : ['cow'] }
  if (s.has('vinegar')) f.vinegar = ['white', 'balsamic', 'cider'].filter((w) => s.has(w))
  if (s.has('yoghurt')) f.yoghurt = ['greek', 'double'].filter((w) => s.has(w))
  if (s.has('chocolate')) f.chocolate = ['milk', 'dark', 'white'].filter((w) => s.has(w))
  if (s.has('salted') || s.has('unsalted')) f.salt = ['salted', 'unsalted'].filter((w) => s.has(w))
  if (s.has('oil')) f.oil = ['sunflower', 'canola', 'olive', 'coconut'].filter((w) => s.has(w))
  if (s.has('whipped') || s.has('whipping')) f.whip = ['whipped']
  for (const k of Object.keys(f)) if (!f[k].length) delete f[k]
  f.form = [...new Set(t.map((w) => FORM[w]).filter(Boolean))]
  f.state = [...new Set(t.map((w) => STATE[w]).filter(Boolean))]
  f.colour = [...new Set(t.filter((w) => COLOUR.has(w) && (w !== 'mixed' || s.has('pepper'))))]
  return f
}

/**
 * Is this invoice line a different product from ours? product: { name, was?: [], warn?: [] (words its open question is
 * still asking about) }, line: { printed, plain }.
 * Returns { level: 'refuse' | 'warn' | null, word, why }. Refuse: never shown under it. Warn: shown unticked with one
 * plain line ("This reads as Greek."), never pre-ticked.
 */
export function guard(product, line) {
  const a = families(words(product.name))
  const b = families(words(`${line.printed || ''} ${line.plain || ''}`))
  const why = [] // [word on the line, reason]
  const differ = (x, y) => !(x.length === y.length && x.every((v) => y.includes(v)))
  for (const fam of ['cheese', 'dairy', 'jam', 'mayo', 'milk', 'vinegar']) {
    if (a[fam] && b[fam] && differ(a[fam], b[fam])) why.push([b[fam].join(' and '), `${fam}: ${a[fam].join(', ')} vs ${b[fam].join(', ')}`])
  }
  // yoghurt kind, chocolate kind, salted: the line names one ours does not
  for (const fam of ['yoghurt', 'chocolate', 'salt', 'oil', 'whip']) {
    const extra = (b[fam] || []).filter((w) => !(a[fam] || []).includes(w))
    if (extra.length && (fam !== 'yoghurt' || extra.includes('greek'))) why.push([extra[0], `${fam}: ${extra[0]} on the line only`])
    // an oil of another kind (canola under Sunflower Oil)
    if (fam === 'oil' && a.oil && b.oil && !extra.length && a.oil.some((w) => !b.oil.includes(w)) && b.oil.length) why.push([b.oil[0], `oil: ${a.oil.join(', ')} vs ${b.oil.join(', ')}`])
  }
  // form: both say one and they differ, or a strong form on one side only
  const fa = a.form
  const fb = b.form
  if (fa.length && fb.length && !fa.some((x) => fb.includes(x))) why.push([fb[0], `form: ${fa.join(', ')} vs ${fb.join(', ')}`])
  else {
    for (const x of fb) if (STRONG_FORM.has(x) && !fa.includes(x)) why.push([x, `form: ${x} on the line only`])
    for (const x of fa) if (STRONG_FORM.has(x) && !fb.includes(x)) why.push([`not ${x}`, `form: ${x} on ours only`])
  }
  // state: frozen and smoked on the line only, and smoked on ours only; a canned, dried, long life or pickled line under
  // a product that does not say so; two different states
  const sa = a.state.filter((x) => x !== 'fresh')
  const sb = b.state.filter((x) => x !== 'fresh')
  if (a.state.length && b.state.length && !a.state.some((x) => b.state.includes(x))) why.push([b.state[0], `state: ${a.state.join(', ')} vs ${b.state.join(', ')}`])
  else {
    for (const x of sb) if (!sa.includes(x)) why.push([x, `state: ${x} on the line only`])
    if (sa.includes('smoked') && !sb.includes('smoked')) why.push(['not smoked', 'state: smoked on ours only'])
  }
  // colour or variety: both name one and they differ
  if (a.colour.length && b.colour.length && !a.colour.some((x) => b.colour.includes(x))) why.push([b.colour[0], `colour: ${a.colour.join(', ')} vs ${b.colour.join(', ')}`])
  if (!why.length) return { level: null, word: null, why: null }
  const warn = new Set((product.warn || []).map((w) => { const x = words(w)[0]; return FORM[x] || STATE[x] || x }))
  const norm = (w) => { const x = words(w)[0] || w; return FORM[x] || STATE[x] || x }
  if (warn.size && why.every(([w]) => warn.has(norm(w)))) {
    const w = why[0][0]
    return { level: 'warn', word: w, why: why.map((x) => x[1]).join('; '), text: `This reads as ${SAY[w] || (w === 'greek' ? 'Greek' : w)}.` }
  }
  return { level: 'refuse', word: why[0][0], why: why.map((x) => x[1]).join('; ') }
}

// ---------------------------------------------------------------- the figure: 1 of these = N of our unit

const MASS = { kg: 1000, g: 1, gr: 1 }
const VOL = { l: 1000, lt: 1000, ltr: 1000, ml: 1 }
const unitKind = (u) => (u in MASS ? 'g' : u in VOL ? 'ml' : null)
const unitMult = (u) => MASS[u] || VOL[u] || 1
const num = (s) => Number(String(s).replace(',', '.'))
const UNIT_SAY = { kg: 'kg', g: 'g', gr: 'g', l: 'L', lt: 'L', ltr: 'L', ml: 'ml' }

/**
 * How much of our unit one of this supplier line is. product: { kind: 'g' | 'ml' | 'count', unit (the piece word for a
 * counted product) }, line: { printed, pack, weighed }.
 * Returns { figure, how, per_unit, gold } where gold is the question ("1 L = ___ g") when it cannot be worked out, and
 * how is 'worked_out', 'from_code' or 'weighed'. The pack is read from the printed pack, never from other numbers in the
 * description ("Smoothie 350ml (100)" is 100 cups).
 */
export function readPack(product, line) {
  const p = String(line.pack || '').toLowerCase()
  const printed = String(line.printed || '')
  const k = product.kind
  const piece = product.kind === 'count' ? product.unit || 'piece' : product.kind
  const gold = (q) => ({ figure: null, how: null, per_unit: null, gold: q })
  const done = (figure, how = 'worked_out', per_unit = null) => ({ figure: Number(figure.toPrecision(12)), how, per_unit, gold: null })
  const ask = (from) => gold(`${from} = ___ ${k === 'count' ? `${piece}s` : k}`)
  // weight changes every delivery: receiving weighs it
  if (/pre-weighed|weight not printed/.test(p)) return { figure: null, how: 'weighed', per_unit: null, gold: null }
  // weighed, priced by the kg
  if (line.weighed === true || line.weighed === 'Yes' || /\bper kg\b|p\/kg|by the kg/.test(p)) {
    return k === 'g' ? done(1000, 'worked_out', 'kg') : ask('1 kg')
  }
  // priced per piece inside a box: "... (500/BOX) EACH" is 1 container, never 500. A pack someone answered (Sue,
  // 19/11: "Whipped Cream Clover EACH" is 250 g) is read as answered instead.
  if (!line.confirmed && /(^|[\s)])(each|ea)\s*$/i.test(printed)) return k === 'count' ? done(1) : ask('1')
  // a pack that reads two ways ("2 for 23 ... 1 x 1kg (1 PACK) x10")
  if (/combo|\b\d+\s+for\s+\d+/.test(p) || /combo|\b\d+\s+for\s+\d+/i.test(printed)) return gold(`1 of these = ___ ${k === 'count' ? `${piece}s` : k}`)
  // N x M unit: 200 x 15 g, 6 x 1 L
  let m = p.match(/(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ml|ltr|lt|l)\b/)
  if (m) {
    const n = num(m[1])
    const each = num(m[2]) * unitMult(m[3])
    if (k === 'count') return done(n)
    if (unitKind(m[3]) === k) return done(n * each)
    return ask(`1 of ${n} x ${m[2]} ${UNIT_SAY[m[3]]}`)
  }
  m = p.match(/^(\d+)\s*x\s*(\d+)$/)
  if (m && k === 'count') return done(Number(m[1]) * Number(m[2]))
  // a count: pack of 100, tray of 30, 500 cups (printed ZIBO-500), 60 eggs
  m = p.match(/\b(?:pack|tray|box|sleeve|case|bag|carton)\s+of\s+(\d+)/) || p.match(/^(\d+)\s+(?:cups?|lids?|eggs?|bags?|pieces?|portions?|straws?|serviettes?)\b/)
  if (m) {
    const n = num(m[1])
    if (k === 'count') return done(n, /printed/.test(p) ? 'from_code' : 'worked_out')
    return ask(n === 1 ? '1' : `1 pack of ${n}`)
  }
  // a weight or volume: 500 g, 1 kg bag, 2 L, 435 ml bottle
  m = p.match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ml|ltr|lt|l)\b/)
  if (m) {
    const q = num(m[1]) * unitMult(m[2])
    if (unitKind(m[2]) === k) return done(q)
    return ask(`${m[1]} ${UNIT_SAY[m[2]]}`)
  }
  if (/\beach\b|\b1\s*each\b/.test(p)) return k === 'count' ? done(1) : ask('1')
  return gold(`1 of these = ___ ${k === 'count' ? `${piece}s` : k}`)
}

/** The figure in words: "1 of these = 250 g", "1 of these = 100 cups". */
export function figureWords(product, figure) {
  if (figure == null) return ''
  const n = Number(Number(figure).toFixed(3))
  const shown = n >= 1000 ? n.toLocaleString('en-ZA').replace(/ /g, ',') : String(n)
  if (product.kind === 'count') return `${shown} ${n === 1 ? product.unit : plural(product.unit)}`
  return `${shown} ${product.kind}`
}
export const plural = (w) => (/s$/.test(w) ? w : /(ch|sh|x)$/.test(w) ? `${w}es` : `${w}s`)

// ---------------------------------------------------------------- our pre-ticks

const shared = (a, b) => { const x = new Set(words(a)); return words(b).filter((w) => x.has(w)).length }

/**
 * Our pre-ticks (spec section 3). groups: [{ key, name, offers: [{ line, found, guard, figure, gold }] }] where line is
 * { id, invoices, last_date, price, plain, printed } and found is 'match' | 'check' | 'rule'. A rule offer wins outright.
 * Returns Map(lineId -> productKey): at most one product per line.
 */
export function pickTicks(groups) {
  const wins = new Map() // lineId -> [{ key, found, name, line }]
  for (const g of groups) {
    const ok = g.offers.filter((o) => o.found === 'rule' || (o.guard == null && (o.found === 'match' || o.found === 'check')))
    if (!ok.length) continue
    const rules = ok.filter((o) => o.found === 'rule')
    let pick
    if (rules.length) pick = rules
    else {
      const matches = ok.filter((o) => o.found === 'match')
      const pool = matches.length ? matches : ok
      const per = (o) => (o.figure ? Number(o.line.price) / o.figure : Infinity)
      const sorted = [...pool].sort((x, y) => (y.line.invoices - x.line.invoices) || String(y.line.last_date).localeCompare(String(x.line.last_date)) || (per(x) - per(y)))
      pick = [sorted[0]]
      // a gold winner also ticks the best worked-out line, so she is never left at a dead end
      if (sorted[0].gold) { const w = sorted.find((o) => !o.gold && o.figure); if (w) pick.push(w) }
    }
    for (const o of pick) {
      if (!wins.has(o.line.id)) wins.set(o.line.id, [])
      wins.get(o.line.id).push({ key: g.key, found: o.found, name: g.name, line: o.line })
    }
  }
  const out = new Map()
  for (const [id, ws] of wins) {
    if (ws.length === 1) { out.set(id, ws[0].key); continue }
    const rule = ws.filter((w) => w.found === 'rule')
    if (rule.length === 1) { out.set(id, rule[0].key); continue }
    const match = ws.filter((w) => w.found === 'match')
    if (match.length === 1) { out.set(id, match[0].key); continue }
    const scored = ws.map((w) => [shared(w.name, `${w.line.printed} ${w.line.plain || ''}`), w]).sort((a, b) => b[0] - a[0])
    if (scored[0][0] > scored[1][0]) out.set(id, scored[0][1].key)
    // still tied: nowhere, both show it unticked
  }
  return out
}

// ---------------------------------------------------------------- one product list

/**
 * The product a recipe line points at (spec 2.6): its row, followed through joins (same_as); a line with no row is
 * found by its name among the product names and the old names (aliases). Returns the product's key or null.
 */
export function resolveKey(line, products, aliases) {
  let key = line && line.measure && products.has(line.measure) ? line.measure : null
  if (!key && line && line.name) key = aliases.get(normName(line.name)) || null
  const seen = new Set()
  while (key && products.get(key) && products.get(key).same_as && !seen.has(key)) { seen.add(key); key = products.get(key).same_as }
  return key
}
export const normName = (s) => words(s).join(' ')

/**
 * Never carry a number across kinds (spec 2.5): a recipe line written in one kind (cubes) that now points at a product
 * in another (grams) keeps its old amount for show and asks: "5 cubes = ___ g".
 */
export function crossKind(line, fromRow, toRow) {
  if (!fromRow || !toRow || fromRow.key === toRow.key) return null
  if (fromRow.kind === toRow.kind) return null
  const was = fromRow.kind === 'count' ? `${line.qty} ${line.qty === 1 ? fromRow.unit : plural(fromRow.unit)}` : `${line.qty} ${fromRow.kind}`
  return { was, ask: `${was} = ___ ${toRow.kind === 'count' ? plural(toRow.unit) : toRow.kind}` }
}

// ---------------------------------------------------------------- the jam fixes (spec 2.7)

/**
 * A group with exactly one option is not a choice: when that option holds two or more lines, each line becomes its own
 * option, named after its product, 1 each. Returns the new choices or null when nothing changes.
 */
export function splitOneOption(choices, nameOf, newId) {
  let changed = false
  const out = (choices || []).map((g) => {
    if (g.options.length !== 1 || g.options[0].lines.length < 2) return g
    changed = true
    const options = g.options[0].lines.map((l, i) => ({ id: newId(), name: nameOf(l), usual: i === 0, lines: [{ ...l, qty: 1 }] }))
    return { ...g, options }
  })
  return changed ? out : null
}

/**
 * In the choice only (spec 2.7): an ingredient line is moved into a choice when a group in the same recipe has two or
 * more options that each put in a different product, and one of them puts in the same product as the ingredient. The
 * ingredient line goes and that option becomes the usual one. A group that only adds more of the same (Single and
 * Double coffee beans) fails the first test and is left alone. keyOf(line) gives the line's product key.
 * Returns { ingredients, choices, moved: [{ name, group }] } or null.
 */
export function choiceOnly(r, keyOf, nameOfKey) {
  const moved = []
  let ingredients = [...(r.ingredients || [])]
  const choices = structuredClone(r.choices || [])
  for (const g of choices) {
    const per = g.options.map((o) => new Set(o.lines.map(keyOf).filter(Boolean)))
    const singles = per.map((s) => (s.size === 1 ? [...s][0] : null))
    if (g.options.length < 2 || singles.some((x) => !x) || new Set(singles).size !== singles.length) continue
    for (const l of [...ingredients]) {
      const k = keyOf(l)
      const at = singles.indexOf(k)
      if (!k || at < 0) continue
      ingredients = ingredients.filter((x) => x !== l)
      g.options.forEach((o, i) => { o.usual = i === at })
      moved.push({ name: nameOfKey(k), group: g.name })
    }
  }
  return moved.length ? { ingredients, choices, moved } : null
}

// ---------------------------------------------------------------- menu extras (spec 2.8)

const DRINK_CATS = new Set(['Hot Drinks', 'Cold Drinks'])
/** Tarryn, 19/11: "if a cold drink or milk shake / juice is sold it goes with a straw". A rule, not a hand list. */
export const getsStraw = (r) => r.category === 'Cold Drinks' || /milk\s?shake|smoothie|frappe|freezo|juice|iced/i.test(r.name || '')
/**
 * Menu extras for one sold item, pre-filled from its take-away ticks: each tick becomes its product(s) (a split row like
 * Milkshake Cup and Lid becomes both), Straw 12mm on eat in for every item whose take-away carries a straw, and the
 * Serviette on take away for food. keysOf(line) -> [product keys]. Returns { eatin: [], takeaway: [] } of
 * { p, qty, sug: true }; a line we could not place keeps its old name in `was` for her to pick or remove.
 */
export function extrasFromTakeaway(r, keysOf, { straw = 'm-straws-12mm', serviette = 'm-serviette' } = {}) {
  const takeaway = []
  const seen = new Set()
  for (const l of r.takeaway || []) {
    const keys = keysOf(l)
    if (!keys.length) { takeaway.push({ p: null, qty: l.qty ?? null, was: l.name || 'Packaging', sug: true }); continue }
    for (const p of keys) if (!seen.has(p)) { seen.add(p); takeaway.push({ p, qty: l.qty ?? 1, sug: true }) }
  }
  if (serviette && !DRINK_CATS.has(r.category) && !seen.has(serviette)) takeaway.push({ p: serviette, qty: 1, sug: true })
  const wantStraw = getsStraw(r)
  if (wantStraw && !seen.has(straw)) { seen.add(straw); takeaway.push({ p: straw, qty: 1, sug: true }) }
  const eatin = wantStraw || seen.has(straw) ? [{ p: straw, qty: 1, sug: true }] : []
  return { eatin, takeaway }
}

// ---------------------------------------------------------------- what one of our unit costs

/**
 * The cost of one of our unit (one gram, one ml, one cup), from the ticked line with the latest invoice date that has
 * a figure. A ticked line still waiting for its figure counts 1 L as 1,000 g for the cost line only, marked estimate;
 * that number is never saved. offers: [{ ticked, figure, gold, line: { price, last_date, printed, supplier } }].
 * Returns { per, from, estimate, line } or null when no ticked line can be costed.
 */
export function unitCost(product, offers) {
  const ticked = offers.filter((o) => o.ticked && o.line && o.line.price != null && Number(o.line.price) > 0)
    .sort((a, b) => String(b.line.last_date).localeCompare(String(a.line.last_date)))
  for (const o of ticked) {
    if (o.figure > 0) return { per: Number(o.line.price) / Number(o.figure), from: 'Invoice', estimate: false, line: o.line }
    const lit = /^(\d+(?:[.,]\d+)?)\s*(l|lt|ltr)\b/i.exec(String(o.line.pack || '').toLowerCase())
    if (product.kind === 'g' && lit) return { per: Number(o.line.price) / (num(lit[1]) * 1000), from: 'Invoice', estimate: true, line: o.line }
  }
  return null
}

// ---------------------------------------------------------------- what may be saved

/** A number as typed in South Africa: "1,030" and "1 030" are a thousand and thirty; "1,5" is one and a half. */
export function readNumber(v) {
  if (typeof v === 'number') return v
  if (typeof v !== 'string' || !v.trim()) return NaN
  const t = v.trim().replace(/\s+/g, '')
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''))
  return /^-?\d*[.,]?\d+$/.test(t) ? Number(t.replace(',', '.')) : NaN
}

export const FIGURE_HOW = ['worked_out', 'from_code', 'from_row', 'estimate', 'hers', 'from_delivery', 'at_delivery', 'weighed']
const ok = (value) => ({ ok: true, value })
const no = (problem) => ({ ok: false, problem })
const KEY = /^m-[a-z0-9-]{1,40}$/

/** One supplier line under one product: { ticked?, figure?, at_delivery?, move? }. */
export function validateOffer(v) {
  if (!v || typeof v !== 'object') return no('That could not be read.')
  const out = {}
  if ('ticked' in v) { if (typeof v.ticked !== 'boolean') return no('Tick or untick it.'); out.ticked = v.ticked }
  if ('figure' in v) {
    if (v.figure === null) out.figure = null
    else {
      const f = readNumber(v.figure)
      if (!Number.isFinite(f) || f <= 0 || f > 1000000) return no('How much is in one must be a number above nought, like 1000.')
      out.figure = f
    }
  }
  if ('at_delivery' in v) { if (v.at_delivery !== true) return no('That could not be read.'); out.at_delivery = true }
  if ('move' in v) { if (v.move !== true) return no('That could not be read.'); out.move = true; out.ticked = true }
  if (!Object.keys(out).length) return no('Nothing to save.')
  return ok(out)
}

/** One product field: name, note, answer, join (same_as) or split. */
export function validateProduct(field, v) {
  if (field === 'name') {
    if (typeof v !== 'string' || !v.trim()) return no('The product needs a name.')
    if (v.trim().length > 120) return no('Keep it under 120 letters.')
    return ok(v.trim().replace(/\s+/g, ' '))
  }
  if (field === 'note') {
    if (v !== null && typeof v !== 'string') return no('That could not be read as words.')
    if (v && v.length > 2000) return no('Keep it under 2000 letters.')
    return ok(v || '')
  }
  if (field === 'answer') {
    if (v === '') return ok('') // Undo of a settled answer: the question comes back
    if (typeof v !== 'string' || !v.trim()) return no('Pick an answer.')
    if (v.length > 300) return no('Keep it under 300 letters.')
    return ok(v.trim())
  }
  if (field === 'same_as') {
    if (v === null) return ok(null)
    if (typeof v !== 'string' || !KEY.test(v)) return no('That product could not be found.')
    return ok(v)
  }
  return no('That cannot be changed here.')
}

/** A product she adds (spec 2.6): what it is, variety or type, form; the unit set from the form. */
export function newProduct({ what, variety, form }) {
  const t = (s) => String(s || '').trim().replace(/\s+/g, ' ')
  const cap = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
  const w = t(what)
  if (!w) return no('Say what it is, like Jam.')
  if ([w, t(variety), t(form)].some((x) => x.length > 40)) return no('Keep each box under 40 letters.')
  const name = cap([t(variety), w, t(form)].filter(Boolean).join(' '))
  const f = words(form || '')[0] || ''
  const counted = { portion: 'portion', sachet: 'portion', roll: 'roll', cup: 'cup', lid: 'lid', egg: 'egg', slice: 'slice', piece: 'piece', bag: 'bag', box: 'box', straw: 'straw', wrap: 'wrap', each: 'piece' }
  const liquid = /sauce|syrup|juice|vinegar|milk|oil|essence|cream$/i.test(w) && !/powder|block|grated/i.test(form || '')
  const kind = counted[f] ? 'count' : liquid ? 'ml' : 'g'
  const unit = counted[f] || kind
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 38)
  return ok({ key: `m-${slug}`, name, kind, unit })
}

/** Menu extras for one sold item: { eatin: [{ p, qty }], takeaway: [{ p, qty }] }. */
export function validateExtras(v) {
  if (!v || typeof v !== 'object') return no('The menu extras could not be read.')
  const out = {}
  for (const side of ['eatin', 'takeaway']) {
    const list = v[side] || []
    if (!Array.isArray(list) || list.length > 20) return no('Up to 20 extras, please.')
    out[side] = []
    for (const x of list) {
      if (!x || typeof x !== 'object') return no('An extra could not be read.')
      if (x.p !== null && !KEY.test(String(x.p))) return no('That packaging could not be found.')
      const q = x.qty == null || x.qty === '' ? null : Number(String(x.qty).replace(',', '.'))
      if (q !== null && (!Number.isFinite(q) || q <= 0 || q > 1000)) return no('How many must be a number above nought, like 1 or 2.')
      const e = { p: x.p, qty: q }
      if (x.sug === true) e.sug = true
      if (typeof x.was === 'string') e.was = x.was.slice(0, 120)
      out[side].push(e)
    }
  }
  return ok(out)
}

// ---------------------------------------------------------------- Sue's amounts (19/11)

const WORDS = { cup: 'cup', cups: 'cup', tsp: 'tsp', tspn: 'tsp', tspns: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', tbs: 'tbsp', tbsp: 'tbsp', tbsn: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  bulb: 'bulb', bulbs: 'bulb', clove: 'clove', cloves: 'clove', punnet: 'punnet', punnets: 'punnet', handful: 'handful', bunch: 'bunch', scoop: 'scoop', scoops: 'scoop',
  squeeze: 'squeeze', squeezes: 'squeeze', pkt: 'packet', packet: 'packet', tin: 'tin', tins: 'tin', pinch: 'pinch', large: 'each', medium: 'each', slices: 'slice', slice: 'slice', litre: 'litre' }
/**
 * Sue's amount as a number and a measure word, so one question per product and measure can answer every line:
 * "1½ tsp (10g)" -> { n: 1.5, word: 'tsp' }; "2" -> { n: 2, word: 'each' }; "26cm" -> { n: 1, word: 'size' };
 * "half cup" -> { n: 0.5, word: 'cup' }; "to taste" -> null.
 */
export function measureOf(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (/^\d+\s*cm$/i.test(raw)) return { n: 1, word: 'size' }
  let t = raw.toLowerCase().replace(/(\d)\s*([½¼¾⅓])/g, (m, d, f) => String(Number(d) + FRAC[f])).replace(/[½¼¾⅓]/g, (f) => String(FRAC[f]))
    .replace(/^half\b/, '0.5').replace(/^a\b/, '1')
    .replace(/^(\d+)\s*(?:&|and)\s*(\d+)\/(\d+)/, (m, d, x, y) => String(Number(d) + Number(x) / Number(y)))
    .replace(/^(\d+)\/(\d+)/, (m, x, y) => String(Number(x) / Number(y)))
  t = t.replace(/\(.*$/, '').trim()
  const m = t.match(/^(\d+(?:[.,]\d+)?|\.\d+)?\s*(?:x\s*\d+\s*)?([a-z]+)?/)
  if (!m) return null
  const n = m[1] ? Number(m[1].replace(',', '.')) : 1
  const w = m[2] ? WORDS[m[2]] || (/^(g|gr|kg|ml|l|lt)$/.test(m[2]) ? m[2] : null) : 'each'
  if (!w || !Number.isFinite(n)) return null
  return { n, word: w }
}

const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3 }

/**
 * Sue's amount as written, in the product's unit where it is the same kind ("1 cup (210g)" is 210 g for a product in
 * grams; "1.5L" is 1500 ml). Otherwise her words stay and she is asked: { ask: 'Sue wrote "2 punnets"' }.
 */
export function sueAmount(text, kind, unit) {
  const raw = String(text || '').trim()
  if (!raw) return { ask: 'No amount on Sue\'s recipe' }
  const t = raw.replace(/(\d)\s*([½¼¾⅓])/g, (m, d, f) => String(Number(d) + FRAC[f])).replace(/[½¼¾⅓]/g, (f) => String(FRAC[f]))
  const re = /(\d+(?:[.,]\d+)?|[.,]\d+)\s*(kg|gr|g|ml|litres?|liters?|ltr|lt|l)\b/gi
  for (const m of t.matchAll(re)) {
    const u = m[2].toLowerCase()
    const k = /^(kg|gr|g)$/.test(u) ? 'g' : 'ml'
    const mult = u === 'kg' || /^(l|lt|ltr|litres?|liters?)$/.test(u) ? 1000 : 1
    const n = Number(m[1].replace(',', '.'))
    if (k === kind && Number.isFinite(n) && n > 0) return { qty: Number((n * mult).toPrecision(10)) }
  }
  if (kind === 'count') {
    const m = t.match(/^(\d+(?:\.\d+)?)\s*(large|slices?|x|each)?\s*$/i) || t.match(/^(\d+)\s+(large|slices?)\b/i)
    if (m) return { qty: Number(m[1]) }
  }
  return { ask: `Sue wrote "${raw}"` }
}

