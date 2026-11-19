/*
 * Lindsay's recipe review page (17/11/2026; where we buy it, one product list and Sue's recipes 19/11/2026). Plain
 * browser code, no build. The rules (what may be saved, how a cost is worked out, the guard, the pack reader) are in
 * recipereview.js and buylines.js, copies of shared/ made at deploy, so the page and the server cannot disagree. The key
 * is in the link after # (never sent to a web server's log), and goes in the request body.
 */
import { recipeCost, lineCost, fmtQty, fmtRand, progress, UNIT_WORDS, MAKES_UNITS } from './recipereview.js'
import { guard, readPack, figureWords, plural as plu, resolveKey, normName, crossKind, unitCost, sueAmount, readNumber } from './buylines.js'

const API = 'https://nptyrtjdvqglgwkaepce.supabase.co/functions/v1/badger-recipes'
const key = new URLSearchParams(location.hash.slice(1)).get('k') || new URLSearchParams(location.search).get('k') || ''
const MENU_ORDER = ['Breakfast', 'Midday Munch', 'Everyday Favourites', 'Hot Drinks', 'Cold Drinks', 'Bakes', 'Batches']
const SHELVES = ['Bread', 'Fruit and veg', 'Dairy', 'Meat', 'Dry goods and spices', 'Sauces', 'Drinks', 'Packaging']
const SUE_SAYS = 'Sue: "these have not been finally approved by chef, so there might be some small changes".'

const S = {
  recipes: [], byId: new Map(), items: [], itemById: new Map(), measures: new Map(), lines: new Map(), offers: [],
  questions: [], aliases: new Map(), canEdit: false, who: '', show: 'all',
}
const $ = (s, el = document) => el.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const SEP = '<span class="dot" aria-hidden="true">/</span>'
const X = '&times;'
let seq = 0
const nid = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`
const trimN = (n) => String(Number(Number(n).toFixed(3)))
const ro = () => (S.canEdit ? '' : ' disabled')

// ---------------------------------------------------------------- talking to the server

async function call(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, key }) })
  let j = {}
  try { j = await r.json() } catch { /* nothing to read */ }
  return { status: r.status, body: j }
}

// One queue for every save: a recipe field (`${recipe}|${field}`), a measure (`M:key|measure`) or any other action
// (`A:<what>|act`, the body itself). A later value for the same key replaces the waiting one.
const queue = new Map()
const timers = new Map()
const after = new Map() // queue key -> what to do with the answer
let busy = false
let lastProblem = ''
const invalid = new Map()
function bad(el, problem) {
  if (!el.dataset.errid) el.dataset.errid = nid()
  invalid.set(el, problem)
  el.classList.add('bad')
  el.setAttribute('aria-invalid', 'true')
  let msg = document.querySelector(`.err[data-for="${el.dataset.errid}"]`)
  if (!msg) {
    msg = document.createElement('div')
    msg.className = 'err'
    msg.dataset.for = el.dataset.errid
    el.insertAdjacentElement('afterend', msg)
  }
  msg.textContent = `Not saved: ${problem}`
  showProblems()
}
function good(el) {
  if (!invalid.has(el) && !el.classList.contains('bad')) return
  invalid.delete(el)
  el.classList.remove('bad')
  el.removeAttribute('aria-invalid')
  const msg = el.dataset.errid && document.querySelector(`.err[data-for="${el.dataset.errid}"]`)
  if (msg) msg.remove()
  showProblems()
}
function showProblems() {
  for (const el of [...invalid.keys()]) if (!el.isConnected) invalid.delete(el)
  if (invalid.size) status('bad', `Not saved: ${[...invalid.values()][0]}`)
  else if (!queue.size && !busy && !lastProblem) status('ok', 'All changes saved')
}
function status(kind, text) {
  const el = $('#status')
  el.className = `status ${kind}`
  el.textContent = text
}
function save(recipeId, field, value, wait = 0) { enqueue(`${recipeId ?? ''}|${field}`, structuredClone(value), wait) }
function act(what, body, wait = 0, then = null) { const k = `A:${what}|act`; if (then) after.set(k, then); enqueue(k, body, wait) }
function enqueue(k, value, wait) {
  queue.set(k, value)
  clearTimeout(timers.get(k))
  status('saving', 'Saving...')
  timers.set(k, setTimeout(flush, wait))
}
async function flush() {
  if (busy) return
  busy = true
  try {
    while (queue.size) {
      const [k, value] = queue.entries().next().value
      queue.delete(k)
      const [rid, field] = k.split('|')
      let r
      try {
        r = rid.startsWith('A:') ? await call(value)
          : rid.startsWith('M:') ? await call({ action: 'save', field: 'measure', measure: rid.slice(2), value })
            : await call({ action: 'save', recipe: rid || null, field, value })
      } catch {
        r = { status: 0, body: {} }
      }
      if (r.status === 200) { lastProblem = ''; const then = after.get(k); after.delete(k); if (then) then(r.body); continue }
      if (r.status === 0 || r.status >= 500) {
        if (!queue.has(k)) queue.set(k, value)
        status('bad', 'Not saved yet: no connection. Trying again...')
        busy = false
        setTimeout(flush, 4000)
        return
      }
      after.delete(k)
      lastProblem = r.body.problem || 'That could not be saved.'
      status('bad', `Not saved: ${lastProblem}`)
    }
    if (invalid.size) showProblems()
    else if (!lastProblem) {
      const t = new Date()
      status('ok', `Saved ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`)
    }
  } finally {
    busy = false
  }
  if (queue.size) flush()
}
addEventListener('beforeunload', (e) => {
  if (queue.size || busy) { e.preventDefault(); e.returnValue = '' }
})

// ---------------------------------------------------------------- products: one list (19/11/2026)

/** The product a line or key is, followed through joins. */
const keyOfLine = (l) => resolveKey(l, S.measures, S.aliases)
const keptKey = (k) => resolveKey({ measure: k }, S.measures, S.aliases)
const prod = (k) => (k ? S.measures.get(k) : null)
const prodName = (k) => (prod(k) ? prod(k).name : '')
const unitWord = (p, n = 2) => (p.kind === 'count' ? (n === 1 ? p.unit : plu(p.unit)) : p.kind)
const groupKeys = (kept) => [...S.measures.keys()].filter((k) => keptKey(k) === kept)
const lineOf = (o) => S.lines.get(o.line)
/** The offers under one product (its joined names too), one per supplier line: the ticked one, else its own row. */
function offersFor(kept) {
  const keys = new Set(groupKeys(kept))
  const by = new Map()
  for (const o of S.offers) {
    if (!keys.has(o.key)) continue
    const have = by.get(o.line)
    if (!have || (o.ticked && !have.ticked) || (!have.ticked && o.key === kept)) by.set(o.line, o)
  }
  return [...by.values()]
}
/** Where a line is ticked under ANOTHER product, that product's key. */
function tickedElsewhere(lineId, kept) {
  const o = S.offers.find((x) => x.line === lineId && x.ticked && keptKey(x.key) !== kept)
  return o ? keptKey(o.key) : null
}
function priceOf(l) {
  const k = keyOfLine(l)
  const p = prod(k)
  if (!p) return null
  if (p.role === 'free') return { free: true }
  const c = unitCost(p, offersFor(k).map((o) => ({ ...o, line: lineOf(o) })))
  return c ? { per: c.per, kind: p.kind === 'count' ? 'count' : p.kind, estimate: c.estimate } : null
}
/** A product's measures for the cost: the row of the kept product, so a joined name costs as its product. */
function measuresForCost() {
  const m = new Map()
  for (const [k] of S.measures) m.set(k, S.measures.get(keptKey(k)) || S.measures.get(k))
  return m
}
let costMeasures = new Map()
const ctx = () => ({ items: S.itemById, recipes: S.byId, measures: costMeasures, priceOf })

// ---------------------------------------------------------------- the cost, worked out, never typed

const money = (n) => (n < 1 ? `${Math.max(1, Math.round(n * 100))}c` : fmtRand(n))
const FROM = { 'Kitchen items': 'kitchen price', Batch: 'from the batch', Invoice: 'invoice price', Estimate: 'Estimate: 1 L counted as 1,000 g', Free: '' }
const fromWords = (c) => (c.from in FROM ? FROM[c.from] : `${c.from} price`)
function lineCostHtml(l) {
  const c = lineCost(l, ctx())
  if (c.from === 'Free') return 'free'
  if (c.rand !== null && c.rand < 0.005) return `under 1c<small>${esc(fromWords(c))}</small>`
  return c.rand !== null ? `${money(c.rand)}<small${c.from === 'Estimate' ? ' class="est"' : ''}>${esc(fromWords(c))}</small>` : '<span class="c-miss">no price yet</span>'
}
const extraLine = (e) => ({ id: 'x', name: prodName(keptKey(e.p)), qty: e.qty ?? 1, unit: 'each', item: null, batch: null, price: null, measure: e.p })
/** Eat in: the recipe plus its eat-in extras. Take away: the recipe plus its take-away extras (spec 2.8). */
function costOf(r) {
  if (r.kind !== 'sold' || !r.extras) return recipeCost(r, ctx())
  const ex = r.extras
  const eat = recipeCost({ ...r, ingredients: [...r.ingredients, ...ex.eatin.filter((e) => e.p).map(extraLine)], takeaway: [] }, ctx()).eat
  const away = recipeCost({ ...r, takeaway: ex.takeaway.filter((e) => e.p).map(extraLine) }, ctx()).away
  return { eat, away }
}
function costHtml(r) {
  const c = costOf(r)
  const part = (label, x) => (x.rand !== null
    ? `<span class="c-ok"><b>${fmtRand(x.rand)}</b> ${label}</span>`
    : `<span class="c-miss">${label}: ${x.so_far > 0 ? `${fmtRand(x.so_far)} so far` : 'not worked out yet'}</span>`)
  const bits = [part(r.kind === 'batch' ? 'the whole batch' : 'eat in', c.eat)]
  if (c.away) bits.push(part('take away', c.away))
  if (r.kind === 'batch' && r.makes && c.eat.rand !== null) {
    const big = { g: ['kg', 1000], ml: ['L', 1000] }[r.makes.unit]
    bits.push(big ? `<span class="c-ok">${fmtRand((c.eat.rand / r.makes.qty) * big[1])} per ${big[0]}</span>` : `<span class="c-ok">${money(c.eat.rand / r.makes.qty)} per ${r.makes.unit === 'portion' ? 'portion' : esc(r.makes.unit)}</span>`)
  }
  const sells = r.seed && r.seed.sells ? `<span class="sells">Sells for ${fmtRand(r.seed.sells)}</span>` : ''
  const miss = [...new Set([...c.eat.missing, ...(c.away ? c.away.missing : [])])]
  const est = [...r.ingredients, ...r.choices.flatMap((g) => g.options.flatMap((o) => o.lines))].some((l) => lineCost(l, ctx()).from === 'Estimate')
  return `<div class="cost-line"><span class="lbl">Cost to make</span>${bits.join(SEP)}${sells}</div>`
    + (est ? '<div class="est-note">Estimate: a litre is counted as 1,000 g until you confirm how much one weighs.</div>' : '')
    + (miss.length ? `<div class="miss">Not complete. ${miss.map(esc).join('; ')}</div>` : '')
}
function miniCost(r) {
  const c = costOf(r)
  if (c.eat.rand === null) return '<span class="c-miss">Cost not complete</span>'
  return `<span>${r.kind === 'batch' ? 'Batch' : 'Eat in'} ${fmtRand(c.eat.rand)}</span>${c.away && c.away.rand !== null ? `${SEP}<span>Take away ${fmtRand(c.away.rand)}</span>` : ''}`
}
function refreshCosts() {
  for (const r of S.recipes) {
    const el = document.getElementById(`cost-${r.id}`)
    if (el) el.innerHTML = costHtml(r)
    const mini = document.getElementById(`mini-${r.id}`)
    if (mini) mini.innerHTML = miniCost(r)
  }
}

// ---------------------------------------------------------------- where we buy it

// no supplier codes on screen (spec 2): a leading item code, a (T451) style code, a trailing ZIBO-500 style code
const supplierCode = (l) => (l.code && l.printed.startsWith(l.code) ? l.printed.slice(l.code.length).replace(/^[\s-]+/, '') : l.printed)
  .replace(/\s*\([A-Z]\d{2,4}\)/g, '').replace(/\s+[A-Z]{3,6}-\d{3,4}\s*$/, '').trim()
const dateWords = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-ZA', { day: '2-digit', month: '2-digit' }) : '')
const vatWords = (l) => ({ Yes: 'incl VAT', No: 'excl VAT' }[l.incl] || 'VAT not shown')
function lineFacts(l) {
  const price = l.price == null ? 'no price' : `${fmtRand(Number(l.price))}${l.price_note ? ` ${l.price_note}` : ''}`
  return `${price} ${vatWords(l)}, ${dateWords(l.last_date)}, on ${l.invoices} invoice${l.invoices === 1 ? '' : 's'}`
}
/** One line in a few words for the ingredient row: "Econo Foods, Foodland 250 g loose, R35.00". */
function tickedSummary(kept) {
  const p = prod(kept)
  if (!p) return ''
  if (p.role === 'kitchen') return '<span class="muted">Made here</span>'
  if (p.role === 'free') return '<span class="muted">Free, not stocked</span>'
  const os = offersFor(kept)
  const t = os.filter((o) => o.ticked).map(lineOf).sort((a, b) => String(b.last_date).localeCompare(String(a.last_date)))
  if (!t.length) return os.length ? '<span class="c-miss">Nothing ticked yet</span>' : '<span class="muted">Not on your invoices yet</span>'
  const first = t[0]
  return `${esc(first.supplier)}, ${esc(first.plain || supplierCode(first))}${first.price != null ? `, ${fmtRand(Number(first.price))}` : ''}${t.length > 1 ? ` <span class="muted">+${t.length - 1} more</span>` : ''}`
}
const goldOf = (o) => o.ticked && o.figure == null && o.gold && o.figure_how !== 'at_delivery' && o.figure_how !== 'weighed'
function figureHtml(p, o) {
  const l = lineOf(o)
  if (o.figure_how === 'weighed') return '<div class="fig muted">Weighed when it arrives</div>'
  if (o.figure_how === 'from_delivery') return `<div class="fig">1 of these = ${esc(figureWords(p, o.figure))} <span class="muted">Set when a delivery was booked in</span></div>`
  if (o.figure_how === 'at_delivery') return `<div class="fig muted">I will ask you when the next one is delivered.${S.canEdit ? ' <button type="button" class="linkish" data-act="fig-undo">Type it now</button>' : ''}</div>`
  const unit = p.kind === 'count' ? plu(p.unit) : p.kind
  const box = `<input class="fig-in" type="text" inputmode="decimal" value="${o.figure == null ? '' : trimN(o.figure)}" aria-label="How many ${esc(unit)} in one"${ro()}>`
  if (o.figure == null && o.gold && !o.ticked) return `<div class="fig muted">${esc(o.gold.replace('___', '?'))}, asked once you tick it</div>`
  if (o.figure == null && o.gold) {
    const q = o.gold.replace(/ = ___ .*/, '')
    return `<div class="fig gold"><span>${esc(q)} =</span>${box}<span>${esc(unit)}</span>
      <p class="g-say">Please confirm. Weigh one, or type what you know.</p>
      ${S.canEdit ? '<button type="button" class="btn ghost small" data-act="fig-later">Not sure: ask me when the next one is delivered</button>' : ''}</div>`
  }
  const how = o.figure_how === 'from_code' ? ' <span class="muted">from the code</span>' : o.figure_how === 'hers' ? ' <span class="muted">yours</span>' : o.per_unit === 'kg' ? ' <span class="muted">a kg, weighed</span>' : ''
  return `<div class="fig"><span>1 of these =</span>${box}<span>${esc(unit)}</span>${how}${l && l.pack_was !== undefined && l.pack_was !== null ? ' <span class="muted">(Sue)</span>' : ''}</div>`
}
function offerHtml(kept, o) {
  const p = prod(kept)
  const l = lineOf(o)
  const other = tickedElsewhere(o.line, kept)
  const answered = p.answer && o.guard && p.answer.toLowerCase().includes((o.guard.match(/as (\w+)/) || [])[1]?.toLowerCase() || '###')
  if (o.guard && p.answer && !answered && !o.ticked) return '' // her answer says it is a different product
  return `<div class="of${o.ticked ? ' on' : ''}${other ? ' elsewhere' : ''}" data-line="${o.line}" data-okey="${esc(o.key)}">
    <label class="of-tick"><input type="checkbox" data-act="tick"${o.ticked ? ' checked' : ''}${other || !S.canEdit ? ' disabled' : ''}>
      <span><b>${esc(l.supplier)}</b> ${esc(supplierCode(l))}</span></label>
    <div class="of-facts">${esc(lineFacts(l))}</div>
    ${other ? `<div class="of-else">Ticked under ${esc(prodName(other))}.${S.canEdit ? ' <button type="button" class="linkish" data-act="move">Move here</button>' : ''}</div>` : figureHtml(p, o)}
    ${o.guard && !answered ? `<div class="of-warn">${esc(o.guard)}</div>` : ''}
  </div>`
}
function rowSuggestion(p, kept) {
  if (p.kind !== 'count' || p.touched_at || !p.suggested) return ''
  const o = offersFor(kept).find((x) => x.ticked && x.figure && x.figure !== Number(p.value) && x.figure_how === 'worked_out')
  if (!o) return ''
  return `<div class="row-sug">Your invoice says ${trimN(o.figure)} in a ${esc(p.pack)}. ${S.canEdit ? `<button type="button" class="linkish" data-act="use-pack" data-n="${o.figure}">Use ${trimN(o.figure)}?</button>` : ''}</div>`
}
function askHtml(kept, where = 'card') {
  const p = prod(kept)
  if (!p || !p.ask) return ''
  const a = p.ask
  if (p.answer) return `<div class="ask done">${esc(a.q)} <b>${esc(p.answer)}</b>${S.canEdit ? ' <button type="button" class="linkish" data-act="re-ask">Change</button>' : ''}</div>`
  const opts = a.options.length
    ? a.options.map((o) => `<button type="button" class="opt-b${o.label === a.pick ? ' pick' : ''}" data-act="answer" data-a="${esc(o.label)}"${o.join ? ` data-join="${esc(o.join)}"` : ''}${ro()}>${esc(o.label)}${o.label === a.pick ? ' <small>my guess</small>' : ''}</button>`).join('')
    : `<input class="ask-text" type="text" maxlength="300" placeholder="Type your answer" aria-label="${esc(a.q)}"${ro()}>`
  return `<div class="ask" data-key="${esc(kept)}" data-where="${where}"><p>${esc(a.q)}</p><div class="opts">${opts}</div></div>`
}
function buyHtml(kept) {
  const p = prod(kept)
  if (!p) return ''
  const keys = groupKeys(kept)
  const was = [...new Set([...(p.was || []), ...keys.filter((k) => k !== kept).flatMap((k) => [S.measures.get(k).name, ...(S.measures.get(k).was || [])])])].filter((n) => n && n !== p.name)
  const os = offersFor(kept).filter((o) => lineOf(o))
  const head = `<div class="wb-head">
      <label class="wb-name"><span>Product name</span><input class="p-name" type="text" maxlength="120" value="${esc(p.name)}" aria-label="Product name"${ro()}></label>
      ${was.length ? `<p class="was-names">Was: ${esc(was.join(', '))}</p>` : ''}
      ${keys.length > 1 && S.canEdit ? '<button type="button" class="linkish" data-act="split">These are not the same</button>' : ''}
    </div>${askHtml(kept)}`
  let body
  if (p.role === 'kitchen') body = '<p class="muted">Made here, so it is not bought. It is a batch in your recipes.</p>'
  else if (p.role === 'free') body = '<p class="muted">Tap water: free, not stocked.</p>'
  else body = `${os.length ? os.map((o) => offerHtml(kept, o)).join('') : '<p class="muted">Not on your invoices yet.</p>'}${rowSuggestion(p, kept)}
      ${S.canEdit ? `<details class="addline"><summary>+ Add a line from your invoices</summary><input class="al-q" type="text" placeholder="Search by supplier or words" aria-label="Search your invoice lines"><div class="al-res"></div></details>` : ''}`
  return `<div class="wb" data-key="${esc(kept)}">${head}${body}
    <label class="wb-note"><span>Note</span><textarea class="p-note" rows="2" maxlength="2000" placeholder="Anything about this product"${ro()}>${esc(p.note || '')}</textarea></label></div>`
}
function addLineResults(kept, q) {
  const p = prod(kept)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  const have = new Set(offersFor(kept).map((o) => o.line))
  const hits = [...S.lines.values()].filter((l) => !have.has(l.id) && words.every((w) => `${l.supplier} ${l.printed} ${l.plain || ''}`.toLowerCase().includes(w))).slice(0, 12)
  if (!hits.length) return '<p class="muted">Nothing found.</p>'
  return hits.map((l) => {
    const g = guard({ name: p.name, warn: p.ask && !p.answer ? p.ask.warn : [] }, l)
    const note = g.level === 'refuse' ? `This reads as ${g.word}. Your product is not.` : g.level === 'warn' ? g.text : ''
    return `<div class="al-hit" data-line="${l.id}"><span><b>${esc(l.supplier)}</b> ${esc(supplierCode(l))}<small>${esc(lineFacts(l))}</small>${note ? `<em>${esc(note)}</em>` : ''}</span>
      <button type="button" class="btn small" data-act="add-line">Add</button></div>`
  }).join('')
}

// ---------------------------------------------------------------- one recipe

const SRC = { loyverse: 'Loyverse', odoo: 'Odoo', both: 'Loyverse and Odoo', new: 'Added here', sue: 'Sue\'s recipe' }
const usualCount = (r) => r.ingredients.length + r.choices.reduce((a, g) => a + (g.options.find((o) => o.usual) || { lines: [] }).lines.length, 0)

function whenSelect(r, l, path) {
  const gi = +path.split('.')[1]
  const others = r.choices.filter((g, i) => i !== gi)
  if (!others.length && !l.when) return ''
  const opts = ['<option value="">always</option>', ...others.flatMap((g) => g.options.map((o) => {
    const v = `${g.id}|${o.id}`
    return `<option value="${esc(v)}"${l.when && l.when.g === g.id && l.when.o === o.id ? ' selected' : ''}>only with ${esc(g.name)}: ${esc(o.name)}</option>`
  }))]
  return `<label class="l-when"><span>Counts</span><select class="l-when-sel" aria-label="When this counts"${ro()}>${opts.join('')}</select></label>`
}

/** What a line puts in, and how its amount reads. */
function lineView(l) {
  if (l.batch) {
    const b = S.byId.get(l.batch)
    return { kind: 'batch', name: b ? b.name : l.name, unit: l.unit, units: ['g', 'ml', 'each', 'portion'] }
  }
  const k = keyOfLine(l)
  const p = prod(k)
  if (!p) return { kind: 'none', name: l.name }
  const from = l.measure && S.measures.get(l.measure)
  const cross = from && from.kind && crossKind(l, from, p)
  return { kind: 'product', key: k, p, name: p.name, unit: p.kind === 'count' ? unitWord(p, Number(l.qty) || 2) : p.kind, cross }
}
function lineRow(l, path, r) {
  const v = lineView(l)
  const nameBtn = v.kind === 'none'
    ? `<button type="button" class="l-prod gold" data-act="pick"${ro()}>${esc(l.name && l.name !== 'New ingredient' ? l.name : 'Pick a product')}</button>`
    : `<button type="button" class="l-prod" data-act="pick"${ro()}>${esc(v.name)}${v.kind === 'batch' ? ' <small>batch</small>' : ''}</button>`
  const unit = v.kind === 'batch'
    ? `<select class="l-unit" aria-label="Unit"${ro()}>${v.units.map((u) => `<option value="${u}"${u === l.unit ? ' selected' : ''}>${esc(UNIT_WORDS[u])}</option>`).join('')}</select>`
    : `<span class="l-unit l-unit-fixed">${esc(v.unit || l.unit)}</span>`
  const flags = []
  if (v.kind === 'none') flags.push(l.ask ? l.ask : 'Pick a product or remove this line.')
  else if (l.ask && l.qty == null) flags.push(l.ask)
  if (v.cross) flags.push(`${v.cross.ask}. Please confirm.`)
  const sueWas = l.was && (r && r.sue) ? `<div class="was">Sue wrote: ${esc(l.was)}${l.part ? ` (${esc(l.part)})` : ''}</div>` : ''
  const buy = v.kind === 'product' && v.p.role === 'stock'
    ? `<details class="l-buy" data-key="${esc(v.key)}"><summary><span class="lb-sum">${tickedSummary(v.key)}</span><span class="lb-go">Where we buy it</span></summary><div class="lb-body"></div></details>`
    : v.kind === 'product' ? `<div class="l-buy-plain">${tickedSummary(v.key)}</div>` : ''
  return `<div class="line${flags.length ? ' has-gold' : ''}" data-path="${esc(path)}" data-id="${esc(l.id)}">
    ${nameBtn}
    <input class="l-qty" type="text" inputmode="decimal" value="${v.cross ? '' : l.qty ?? ''}" aria-label="Amount" placeholder="${v.cross ? esc(v.cross.was) : 'Amount'}"${ro()}>
    ${unit}
    <span class="l-cost">${v.cross ? '<span class="c-miss">no amount yet</span>' : lineCostHtml(l)}</span>
    ${S.canEdit ? `<button type="button" class="x" data-act="del-line" aria-label="Remove">${X}</button>` : ''}
    ${flags.map((f) => `<div class="flag gold-t">${esc(f)}</div>`).join('')}
    ${sueWas}
    ${r && path.startsWith('choices.') ? whenSelect(r, l, path) : ''}
    ${buy}
  </div>`
}
function linesHtml(lines, path, addLabel, r) {
  return `<div class="lines">${lines.map((l) => lineRow(l, path, r)).join('') || '<p class="empty">Nothing here yet.</p>'}</div>
    ${S.canEdit ? `<button type="button" class="add" data-act="add-line" data-path="${esc(path)}">+ ${esc(addLabel)}</button>` : ''}`
}
function choicesHtml(r) {
  const groups = r.choices.map((g, gi) => `<div class="group" data-g="${gi}">
    <div class="g-head"><input class="g-name" type="text" maxlength="60" value="${esc(g.name)}" aria-label="Group name"${ro()}>
      ${S.canEdit ? `<button type="button" class="x" data-act="del-group" aria-label="Remove this group">${X}</button>` : ''}</div>
    ${g.options.map((o, oi) => `<div class="opt" data-o="${oi}">
      <div class="o-head">
        <label class="usual"><input type="radio" name="u-${esc(r.id)}-${gi}" data-act="usual"${o.usual ? ' checked' : ''}${ro()}> usual</label>
        <input class="o-name" type="text" maxlength="60" value="${esc(o.name)}" aria-label="Choice name"${ro()}>
        ${S.canEdit ? `<button type="button" class="x" data-act="del-opt" aria-label="Remove this choice">${X}</button>` : ''}
      </div>
      ${linesHtml(o.lines, `choices.${gi}.${oi}`, 'What it puts in', r)}
    </div>`).join('')}
    ${S.canEdit ? '<button type="button" class="add" data-act="add-opt">+ Add a choice</button>' : ''}
  </div>`).join('')
  return `${groups || '<p class="empty">No choices.</p>'}${S.canEdit ? '<button type="button" class="add" data-act="add-group">+ Add a group of choices (like Bread or Milk)</button>' : ''}`
}
function otherHtml(r) {
  const o = r.seed && r.seed.other
  if (!o) return ''
  const makes = o.makes ? ` <span class="muted">makes ${esc(fmtQty(o.makes.qty, o.makes.unit))}</span>` : ''
  return `<details class="other"><summary>In Odoo: ${esc(o.name)}${makes}</summary>
    <ul>${o.lines.map((l) => `<li>${esc(l.unit === 'piece' ? `${trimN(l.qty)} slices` : fmtQty(l.qty, l.unit))} ${esc(l.name)}</li>`).join('')}</ul></details>`
}

// Menu extras (Tarryn, 19/11/2026: "packaging isn't part of a recipe its part of the menu"): per sold item, which
// packaging goes with it when eaten in and when taken away.
const packProducts = () => [...S.measures.values()].filter((m) => m.grp === 'Packaging' && !m.same_as && m.role === 'stock')
function extrasHtml(r) {
  const ex = r.extras || { eatin: [], takeaway: [] }
  const has = (side, k) => ex[side].find((e) => e.p && keptKey(e.p) === k)
  const row = (p) => {
    const ei = has('eatin', p.key)
    const ta = has('takeaway', p.key)
    const q = (side, e) => (e ? `<input class="ex-qty" data-side="${side}" type="text" inputmode="decimal" value="${e.qty ?? 1}" aria-label="How many ${esc(p.name)}, ${side === 'eatin' ? 'eat in' : 'take away'}"${ro()}>` : '')
    return `<div class="ex${ei || ta ? ' on' : ''}" data-p="${esc(p.key)}"><span class="ex-n">${esc(p.name)}${(ei && ei.sug) || (ta && ta.sug) ? ' <small>suggested</small>' : ''}</span>
      <label class="ex-c"><input type="checkbox" data-act="extra" data-side="eatin"${ei ? ' checked' : ''}${ro()}><span class="sr">Eat in</span></label>${q('eatin', ei)}
      <label class="ex-c"><input type="checkbox" data-act="extra" data-side="takeaway"${ta ? ' checked' : ''}${ro()}><span class="sr">Take away</span></label>${q('takeaway', ta)}</div>`
  }
  const all = packProducts()
  const on = all.filter((p) => has('eatin', p.key) || has('takeaway', p.key))
  const off = all.filter((p) => !on.includes(p))
  const loose = [...ex.eatin, ...ex.takeaway].filter((e) => !e.p)
  return `<div class="exs"><div class="ex ex-h"><span class="ex-n"></span><span>Eat in</span><span>Take away</span></div>${on.map(row).join('') || '<p class="warn">Nothing picked. Tick what goes with it.</p>'}</div>
    ${loose.map((e) => `<p class="flag gold-t">"${esc(e.was || 'A packaging line')}" is not on the list yet. ${S.canEdit ? '<button type="button" class="linkish" data-act="extra-drop">Remove it</button>' : ''}</p>`).join('')}
    ${off.length ? `<details class="pk-more"><summary>+ More packaging (${off.length})</summary><div class="exs">${off.map(row).join('')}</div></details>` : ''}`
}

function sueHtml(r) {
  if (!r.sue) return ''
  const s = r.sue
  const notes = (s.notes || []).filter((n) => !/confirm|say which|twice|as sent/i.test(n))
  return `<div class="sue"><b>From Sue's recipe</b> (${s.from === 'sheet' ? 'printed sheet, WhatsApp' : 'email'} 19/11${s.title ? `: ${esc(s.title)}` : ''}). ${esc(SUE_SAYS)}
    ${s.yield ? `<br>Yield as sent: ${esc(s.yield)}.` : ''}${notes.map((n) => `<br>Sue's note: ${esc(n)}`).join('')}${s.method ? `<br>Method: ${esc(s.method)}` : ''}</div>`
}
function movedHtml(r) {
  if (!r.moved || r.moved.undone) return ''
  return `<p class="moved">${esc(r.moved.text)}${S.canEdit && r.moved.before ? ' <button type="button" class="linkish" data-act="undo-move">Undo</button>' : ''}</p>`
}
function bodyHtml(r) {
  const s = r.seed || {}
  const info = [
    s.fix ? `<p class="fix ${s.fix.level}">${s.fix.level === 'fix' ? 'To fix: ' : 'Worth a look: '}${esc(s.fix.text)}</p>` : '',
    s.moved ? `<p class="moved">${esc(s.moved)}</p>` : '',
    ...(s.info || []).map((t) => `<p class="info">${esc(t)}</p>`),
  ].join('')
  const makes = r.kind === 'batch' ? `<div class="field"><label>Makes how much <span class="req">needed</span></label>
      <div class="row"><input class="m-qty" type="text" inputmode="decimal" value="${r.makes ? r.makes.qty : ''}" placeholder="Amount" aria-label="Makes how much"${ro()}>
      <select class="m-unit" aria-label="Unit"${ro()}>${MAKES_UNITS.filter((u) => u !== 'kg' && u !== 'L').map((u) => `<option value="${u}"${r.makes && r.makes.unit === u ? ' selected' : ''}>${u === 'portion' ? 'portions' : u}</option>`).join('')}</select></div>
      ${r.makes ? '' : '<p class="warn">Please fill this in: dishes that use this batch cannot be costed without it.</p>'}</div>` : ''
  return `${sueHtml(r)}${movedHtml(r)}${info}
    <div class="field"><label>Name</label><input class="r-name" type="text" maxlength="120" value="${esc(r.name)}"${ro()}></div>
    <div class="field"><label>Type</label><div class="seg">
      <button type="button" class="${r.kind === 'sold' ? 'on' : ''}" data-act="kind" data-v="sold"${ro()}>Sold <small>a meal or drink</small></button>
      <button type="button" class="${r.kind === 'batch' ? 'on' : ''}" data-act="kind" data-v="batch"${ro()}>Batch <small>made here, used in other recipes</small></button></div></div>
    ${makes}
    <h3>Ingredients</h3>${linesHtml(r.ingredients, 'ingredients', 'Add an ingredient', r)}
    ${r.kind === 'sold' ? `<h3>Choices <small>the choice decides which ingredient comes off</small></h3>${choicesHtml(r)}` : ''}
    ${r.kind === 'sold' ? `<h3>Menu extras <small>packaging that goes with it, eaten in or taken away</small></h3>${extrasHtml(r)}` : ''}
    <div class="cost" id="cost-${esc(r.id)}">${costHtml(r)}</div>
    ${otherHtml(r)}
    <div class="field"><label>Notes</label><textarea class="r-notes" rows="3" maxlength="4000" placeholder="Anything about this recipe"${ro()}>${esc(r.notes)}</textarea></div>`
}
function cardHtml(r) {
  const s = r.seed || {}
  const pic = s.picture ? `<img class="pic" src="img/${esc(s.picture)}" alt="" loading="lazy" width="64" height="64">` : '<div class="pic none" aria-hidden="true"></div>'
  const flag = s.fix ? `<span class="pill ${s.fix.level}">${s.fix.level === 'fix' ? 'To fix' : 'Worth a look'}</span>` : ''
  const sue = r.sue ? '<span class="pill sue">Sue 19/11</span>' : ''
  return `<article class="card${r.needed === true ? ' yes' : r.needed === false ? ' no' : ''}" id="r-${esc(r.id)}" data-id="${esc(r.id)}">
    <div class="head">${pic}<div class="h-txt">
      <h3 class="r-title">${esc(r.name)}</h3>
      <p class="meta"><span class="src">${esc(SRC[r.source] || r.source)}</span><span class="kind">${r.kind === 'batch' ? 'Batch' : 'Sold'}</span>${flag}${sue}</p>
      <p class="mini" id="mini-${esc(r.id)}">${miniCost(r)}</p></div></div>
    <div class="need"><span>Do we need it?</span>
      <button type="button" class="yn y${r.needed === true ? ' on' : ''}" data-act="need" data-v="true"${ro()}>Yes</button>
      <button type="button" class="yn n${r.needed === false ? ' on' : ''}" data-act="need" data-v="false"${ro()}>No</button></div>
    <details class="more"><summary>Check the ingredients <span class="count">(${usualCount(r)})</span></summary><div class="body" id="body-${esc(r.id)}"></div></details>
  </article>`
}

// ---------------------------------------------------------------- What I need from you (counted once)

function needs() {
  const kept = [...S.measures.values()].filter((m) => !m.same_as)
  const questions = kept.filter((m) => m.ask && !m.answer && usedOrBought(m.key))
  const gold = []
  for (const m of kept) for (const o of offersFor(m.key)) if (goldOf(o)) gold.push([m, o])
  const amounts = []
  const blanks = []
  for (const r of S.recipes) {
    if (r.left_out || r.needed === false) continue
    for (const [path, l] of allLines(r)) {
      const v = lineView(l)
      if (v.kind === 'none' && !(l.ask && /Which product/.test(l.ask))) blanks.push([r, path, l])
      else if (v.kind !== 'none' && l.qty == null && l.ask) amounts.push([r, path, l])
      else if (v.cross) amounts.push([r, path, l])
    }
  }
  const named = S.questions.filter((q) => q.grp === 'Ingredients to name' && !q.answer)
  const sue = S.questions.filter((q) => q.grp !== 'Ingredients to name' && !q.answer)
  return { questions, gold, amounts, blanks, named, sue, total: questions.length + gold.length + amounts.length + blanks.length + named.length + sue.length }
}
function usedOrBought(k) {
  if (offersFor(k).length) return true
  return S.recipes.some((r) => !r.left_out && allLines(r).some(([, l]) => keyOfLine(l) === k)) || (prod(k) && prod(k).grp === 'Packaging')
}
function allLines(r) {
  return [...r.ingredients.map((l) => ['ingredients', l]), ...r.choices.flatMap((g, gi) => g.options.flatMap((o, oi) => o.lines.map((l) => [`choices.${gi}.${oi}`, l])))]
}
function renderNeeds() {
  const n = needs()
  const byShelf = new Map()
  for (const m of n.questions) { const g = m.grp || 'Other'; byShelf.set(g, [...(byShelf.get(g) || []), m]) }
  const bySup = new Map()
  for (const [m, o] of n.gold) { const s = lineOf(o).supplier; bySup.set(s, [...(bySup.get(s) || []), [m, o]]) }
  const byRecipe = new Map()
  for (const x of n.amounts) byRecipe.set(x[0], [...(byRecipe.get(x[0]) || []), x])
  const sect = (title, count, inner, open = false) => (count ? `<details class="nd"${open ? ' open' : ''}><summary>${esc(title)}</summary>${inner}</details>` : '')
  const shelves = [...byShelf].sort((a, b) => SHELVES.indexOf(a[0]) - SHELVES.indexOf(b[0]))
  $('#needs').innerHTML = `<h2>What I need from you <span class="n">${n.total}</span></h2>
    <p class="small">Under each ingredient I have ticked where I think you buy it. Untick anything wrong, tick anything I missed. Where it says Please confirm, tell me how much is in one (weigh it if you need to). Each question is here once, however many recipes use it.</p>
    ${n.total ? '' : '<p class="done-all">Nothing left. Thank you.</p>'}
    ${sect(`Products: ${n.questions.length}`, n.questions.length, shelves.map(([g, list]) => `<div class="nd-g"><h4>${esc(g)}: ${list.length}</h4>${list.map((m) => `<div class="nd-q"><b>${esc(m.name)}</b>${askHtml(m.key, 'needs')}</div>`).join('')}</div>`).join(''), true)}
    ${sect(`How much is in one: ${n.gold.length}`, n.gold.length, [...bySup].map(([s, list]) => `<div class="nd-g"><h4>${esc(s)}: ${list.length} to confirm</h4>${list.map(([m, o]) => `<div class="nd-q"><b>${esc(m.name)}</b><div class="wb" data-key="${esc(m.key)}">${offerHtml(m.key, o)}</div></div>`).join('')}</div>`).join(''))}
    ${sect(`Ingredients to name, from Sue's recipes: ${n.named.length}`, n.named.length, n.named.map((q) => `<div class="nd-q" data-q="${esc(q.key)}"><p>${esc(q.text)}</p>${S.canEdit ? '<button type="button" class="btn ghost small" data-act="name-pick">Pick a product</button>' : ''}</div>`).join(''))}
    ${sect(`Amounts to confirm, from Sue's recipes: ${n.amounts.length}`, n.amounts.length, [...byRecipe].map(([r, list]) => `<div class="nd-g"><h4><a href="#r-${esc(r.id)}" data-open="${esc(r.id)}">${esc(r.name)}</a>: ${list.length}</h4>${list.map(([, path, l]) => {
      const v = lineView(l)
      return `<div class="nd-a" data-r="${esc(r.id)}" data-path="${esc(path)}" data-id="${esc(l.id)}"><span>${esc(v.name)}: ${esc(v.cross ? v.cross.ask : l.ask)}</span><span class="row"><input class="nd-qty" type="text" inputmode="decimal" aria-label="Amount of ${esc(v.name)}"${ro()}><span>${esc(v.kind === 'batch' ? l.unit : v.p.kind === 'count' ? plu(v.p.unit) : v.p.kind)}</span></span></div>`
    }).join('')}</div>`).join(''))}
    ${sect(`From Sue's notes: ${n.sue.length}`, n.sue.length, n.sue.map((q) => `<div class="nd-q" data-q="${esc(q.key)}"><p>${esc(q.text)}</p><textarea class="q-ans" rows="2" maxlength="1000" placeholder="Your answer"${ro()}></textarea></div>`).join(''))}
    ${sect(`Recipe lines to finish: ${n.blanks.length}`, n.blanks.length, n.blanks.map(([r, , l]) => `<p class="nd-q"><a href="#r-${esc(r.id)}" data-open="${esc(r.id)}">${esc(r.name)}</a>: "${esc(l.name)}". Pick a product or remove this line.</p>`).join(''))}`
  const chip = $('#needChip')
  if (chip) chip.textContent = `Only what needs me (${n.total})`
}

// ---------------------------------------------------------------- the product list ("How we measure things")

function measureLines(key) {
  const out = []
  for (const r of S.recipes) {
    if (r.left_out) continue
    const ls = allLines(r).map(([, l]) => l).filter((l) => keyOfLine(l) === key)
    if (ls.length) out.push([r, ls])
  }
  return out
}
function productRow(m) {
  const users = measureLines(m.key)
  const price = m.price == null ? 'no price yet' : m.of === 'unit' ? `${money(Number(m.price))} each` : money(Number(m.price))
  const counted = m.kind === 'count'
  const amount = counted
    ? `<input class="m-count" type="text" inputmode="numeric" value="${esc(trimN(m.value))}" aria-label="How many ${esc(m.unit)}s in one ${esc(m.pack)}"${ro()}>`
    : `<b>${esc(trimN(m.value))}</b>`
  const reads = users.map(([r, ls]) => `<li><a href="#r-${esc(r.id)}" data-open="${esc(r.id)}">${esc(r.name)}</a>: ${ls.map((l) => esc(l.qty == null ? 'amount to confirm' : `${trimN(l.qty)} ${l.unit === 'piece' || l.unit === 'each' ? unitWord(m, Number(l.qty)) : l.unit}`)).join(', ')}</li>`).join('')
  return `<div class="buy" data-key="${esc(m.key)}">
    <div class="b-name">${esc(m.name)}${m.ask && !m.answer ? ' <span class="pill check">question</span>' : ''}</div>
    <div class="b-eq"><span>${/^\d/.test(m.pack) ? '' : '1 '}${esc(m.pack)} <small>(${esc(price)})</small> =</span>${amount}<span>${esc(counted ? unitWord(m, Number(m.value)) : m.kind)}</span></div>
    <p class="b-sum">${tickedSummary(m.key)}</p>
    <details class="l-buy" data-key="${esc(m.key)}"><summary><span class="lb-go">Where we buy it, name and note</span></summary><div class="lb-body"></div></details>
    ${users.length ? `<details class="m-users"><summary>${users.length} recipe${users.length === 1 ? '' : 's'}</summary><ul>${reads}</ul></details>` : ''}
  </div>`
}
function renderShared() {
  const ms = [...S.measures.values()].filter((m) => !m.same_as && m.kind)
  const byGroup = SHELVES.map((g) => [g, ms.filter((m) => (m.grp || 'Dry goods and spices') === g).sort((a, b) => a.name.localeCompare(b.name))]).filter(([, l]) => l.length)
  $('#measures').innerHTML = `<h2>How we measure things</h2>
    <p class="small">One list of products. Every recipe picks from it, so a name changed here changes in every recipe. Tap a product to see where you buy it.</p>
    ${byGroup.map(([g, l]) => `<details class="b-group"><summary>${esc(g)} <span class="n">${l.length}</span></summary>${l.map(productRow).join('')}</details>`).join('')}`
  const batches = S.recipes.filter((r) => r.seed && r.seed.needs_makes && !r.left_out)
  $('#sizes').innerHTML = batches.length ? `<h2>How much each batch makes</h2>
    <p class="small">The same box as on each batch's own card.</p>
    ${batches.map((r) => `<div class="size" data-id="${esc(r.id)}"><a href="#r-${esc(r.id)}" data-open="${esc(r.id)}">${esc(r.name)}</a>
      <div class="row"><input class="s-qty" type="text" inputmode="decimal" value="${r.makes ? r.makes.qty : ''}" placeholder="Amount" aria-label="${esc(r.name)} makes how much"${ro()}>
      <select class="s-unit" aria-label="Unit"${ro()}>${MAKES_UNITS.filter((u) => u !== 'kg' && u !== 'L').map((u) => `<option value="${u}"${r.makes && r.makes.unit === u ? ' selected' : ''}>${u === 'portion' ? 'portions' : u}</option>`).join('')}</select></div></div>`).join('')}` : ''
}

// ---------------------------------------------------------------- the whole list

function groups() {
  const cats = [...new Set(S.recipes.filter((r) => !r.left_out).map((r) => r.category))]
  return cats.sort((a, b) => ((MENU_ORDER.indexOf(a) + 1) || 99) - ((MENU_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b))
}
function render() {
  costMeasures = measuresForCost()
  const cats = groups()
  $('#jump').innerHTML = cats.map((c) => `<a href="#cat-${encodeURIComponent(c)}" class="chip">${esc(c)}</a>`).join('')
  $('#list').innerHTML = cats.map((c) => {
    const rs = S.recipes.filter((r) => !r.left_out && r.category === c)
    return `<section class="cat" id="cat-${encodeURIComponent(c)}"><h2>${esc(c)} <span class="n">${rs.length}</span></h2>${rs.map(cardHtml).join('')}</section>`
  }).join('')
  const out = S.recipes.filter((r) => r.left_out)
  $('#leftOut').innerHTML = out.length ? `<h2>Left out: tell me if you need any</h2>
    <p class="small">These look like copies of other recipes, or are not food, so I left them out of the list above.</p>
    ${out.map((r) => `<div class="lo" data-id="${esc(r.id)}"><span>${esc(r.name)}</span>
      <button type="button" class="yn y${r.needed === true ? ' on' : ''}" data-act="need" data-v="true"${ro()}>Yes</button>
      <button type="button" class="yn n${r.needed === false ? ' on' : ''}" data-act="need" data-v="false"${ro()}>No</button></div>`).join('')}` : ''
  $('#addCat').innerHTML = cats.map((c) => `<option>${esc(c)}</option>`).join('')
  renderNeeds()
  renderShared()
  applyFilter()
  updateProgress()
}
function updateProgress() {
  const p = progress(S.recipes)
  $('#prog').textContent = `${p.checked} of ${p.total} checked`
  $('#fill').style.width = `${p.total ? Math.round((p.checked / p.total) * 100) : 0}%`
}
function applyFilter() {
  for (const el of document.querySelectorAll('.card')) {
    const r = S.byId.get(el.dataset.id)
    el.hidden = S.show === 'todo' && r && r.needed !== null && r.needed !== undefined
  }
}
/** After any product or line change: redraw every open card, open fold-out and the lists at the top. */
function redrawAll() {
  costMeasures = measuresForCost()
  for (const r of S.recipes) {
    const body = document.getElementById(`body-${r.id}`)
    if (body && body.innerHTML) body.innerHTML = bodyHtml(r)
  }
  const openKeys = [...document.querySelectorAll('#measures details.b-group[open]')].map((d) => d.querySelector('summary').firstChild.textContent.trim())
  const openBuy = [...document.querySelectorAll('#measures .l-buy[open]')].map((d) => d.dataset.key)
  const needOpen = [...document.querySelectorAll('#needs details.nd[open]')].map((d) => d.querySelector('summary').firstChild.textContent.split(':')[0])
  renderNeeds()
  for (const d of document.querySelectorAll('#needs details.nd')) d.open = needOpen.includes(d.querySelector('summary').firstChild.textContent.split(':')[0])
  renderShared()
  for (const d of document.querySelectorAll('#measures details.b-group')) if (openKeys.includes(d.querySelector('summary').firstChild.textContent.trim())) d.open = true
  for (const k of openBuy) { const d = document.querySelector(`#measures .l-buy[data-key="${CSS.escape(k)}"]`); if (d) { d.open = true; d.querySelector('.lb-body').innerHTML = buyHtml(k) } }
  refreshCosts()
}

// ---------------------------------------------------------------- editing

function at(r, path) {
  if (path === 'ingredients' || path === 'takeaway') return r[path]
  const [, gi, oi] = path.split('.')
  return r.choices[+gi].options[+oi].lines
}
const fieldOf = (path) => path.split('.')[0]
function rerenderBody(r) {
  const body = document.getElementById(`body-${r.id}`)
  if (body) body.innerHTML = bodyHtml(r)
  const card = document.getElementById(`r-${r.id}`)
  if (card) {
    card.querySelector('details').open = true
    card.querySelector('.count').textContent = `(${usualCount(r)})`
  }
  refreshCosts()
}

// the product picker: a search of the one list (and the batches); "Add a product" builds a name by the rule
let picking = null // { recipe, path, id } or { question }
function openPicker(target) {
  picking = target
  const dlg = $('#picker')
  $('#pk-q').value = ''
  $('#pk-res').innerHTML = pickerResults('')
  $('#pk-new').hidden = true
  dlg.hidden = false
  $('#pk-q').focus()
}
function pickerResults(q) {
  const words = normName(q).split(' ').filter(Boolean)
  const prods = [...S.measures.values()].filter((m) => !m.same_as && m.role !== 'none' && m.grp !== 'Packaging')
  const hit = (s) => { const t = normName(s); return words.every((w) => t.includes(w)) }
  const ps = prods.filter((m) => hit(`${m.name} ${(m.was || []).join(' ')}`)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)
  const bs = picking && picking.question ? [] : S.recipes.filter((r) => r.kind === 'batch' && !r.left_out && hit(r.name)).slice(0, 15)
  return `${ps.map((m) => `<button type="button" class="pk-hit" data-key="${esc(m.key)}">${esc(m.name)} <small>${esc(m.kind === 'count' ? plu(m.unit) : m.kind)}</small></button>`).join('')}
    ${bs.map((r) => `<button type="button" class="pk-hit" data-batch="${esc(r.id)}">${esc(r.name)} <small>batch</small></button>`).join('')}
    ${!ps.length && !bs.length ? '<p class="muted">Not on the list.</p>' : ''}`
}
function applyPick(k, batchId) {
  if (!picking) return
  if (picking.question) {
    const q = S.questions.find((x) => x.key === picking.question)
    const name = q.name
    const touched = new Set()
    for (const r of S.recipes) {
      for (const [path, l] of allLines(r)) {
        if (l.measure || l.batch || l.name !== name) continue
        const p = prod(k)
        l.measure = k
        l.name = p.name
        l.unit = p.kind === 'count' ? 'each' : p.kind
        const amt = sueAmount(l.was || '', p.kind, p.unit)
        l.qty = amt.qty ?? null
        if (amt.qty != null) delete l.ask
        else l.ask = `Sue wrote "${l.was || 'no amount'}". How many ${p.kind === 'count' ? plu(p.unit) : p.kind} is that?`
        touched.add(`${r.id}|${fieldOf(path)}`)
      }
    }
    for (const t of touched) { const [rid, f] = t.split('|'); save(rid, f, S.byId.get(rid)[f]) }
    q.answer = prodName(k)
    act(`q:${q.key}`, { action: 'answer', question: q.key, value: `${prodName(k)} (picked from the list)` })
  } else {
    const r = S.byId.get(picking.recipe)
    const l = at(r, picking.path).find((x) => x.id === picking.id)
    if (batchId) { l.batch = batchId; l.measure = undefined; delete l.measure; l.name = S.byId.get(batchId).name; l.unit = ['g', 'ml', 'each', 'portion'].includes(l.unit) ? l.unit : 'g' }
    else {
      const p = prod(k)
      const was = l.measure && S.measures.get(l.measure)
      if (was && was.kind !== p.kind) { l.qty = null; l.ask = `It was ${l.qty ?? ''} ${l.unit}. How many ${p.kind === 'count' ? plu(p.unit) : p.kind}?` }
      l.measure = k
      l.batch = null
      l.item = null
      l.price = null
      l.name = p.name
      l.unit = p.kind === 'count' ? (/^m-(sourdough|health)/.test(k) ? 'piece' : 'each') : p.kind
      if (l.qty == null && l.was) { const amt = sueAmount(l.was, p.kind, p.unit); if (amt.qty != null) l.qty = amt.qty }
      if (l.qty != null) delete l.ask
    }
    save(r.id, fieldOf(picking.path), r[fieldOf(picking.path)])
  }
  $('#picker').hidden = true
  picking = null
  redrawAll()
}

function onLineInput(r, lineEl, target, final) {
  const path = lineEl.dataset.path
  const l = at(r, path).find((x) => x.id === lineEl.dataset.id)
  if (!l) return
  if (target.classList.contains('l-qty')) {
    const q = target.value.trim().replace(',', '.')
    if (q === '') l.qty = null
    else if (Number.isFinite(Number(q)) && Number(q) > 0) l.qty = Number(q)
    else { bad(target, 'the amount must be a number above nought, like 150 or 0.5.'); return }
    const v = lineView(l)
    if (v.cross && l.qty != null) { l.was = l.was || v.cross.was; l.measure = v.key; l.unit = v.p.kind === 'count' ? 'each' : v.p.kind }
    if (l.qty != null) delete l.ask
    delete l.sug; delete l.adj
    good(target)
    if (final) setTimeout(() => { if (!lineEl.contains(document.activeElement)) rerenderBody(r) }, 0)
  } else if (target.classList.contains('l-unit')) {
    l.unit = target.value
    delete l.sug; delete l.adj
  } else if (target.classList.contains('l-when-sel')) {
    if (!final) return
    const [g, o] = target.value.split('|')
    if (target.value) l.when = { g, o }
    else delete l.when
  }
  const cost = lineEl.querySelector('.l-cost')
  if (cost) cost.innerHTML = lineCostHtml(l)
  refreshCosts()
  const field = fieldOf(path)
  save(r.id, field, r[field], final ? 0 : 800)
}

function forgetChoice(r, g, option) {
  const usual = (g.options.find((o) => o.usual) || g.options[0] || {}).id
  for (const x of r.choices) {
    for (const o of x.options) {
      o.lines = o.lines.filter((l) => {
        if (!l.when || l.when.g !== g.id) return true
        if (option) return l.when.o !== option.id
        if (l.when.o === usual) { delete l.when; return true }
        return false
      })
    }
  }
}
function presetGroup(name) {
  const find = (pred) => { for (const r of S.recipes) for (const l of [...r.ingredients, ...r.choices.flatMap((g) => g.options.flatMap((o) => o.lines))]) if (pred(l)) return l; return null }
  const copy = (l, qty) => { const { sug, adj, when, ask, ...rest } = l; return { ...rest, id: nid(), qty } }
  const opt = (n, lines, usual) => ({ id: nid(), name: n, usual, lines })
  if (name === 'Bread') {
    const sour = find((l) => l.measure === 'm-sourdough-loafbread' && l.unit === 'piece')
    const health = find((l) => l.measure === 'm-health-bread-loaf' && l.unit === 'piece')
    return { id: nid(), name: 'Bread', options: [opt('Sourdough', sour ? [copy(sour, 2)] : [], true), opt('Health', health ? [copy(health, 2)] : [], false)] }
  }
  if (name === 'Sauce') {
    const sauces = [['Ranch', /^ranch sauce$/i], ['Chipotle', /^chipotle a(i)?oli$/i], ['Buffalo', /^buffalo sauce$/i]]
    return { id: nid(), name: 'Sauce', options: sauces.map(([n, re], i) => { const b = S.recipes.find((r) => r.kind === 'batch' && re.test(r.name)); return opt(n, b ? [{ id: nid(), name: b.name, qty: 30, unit: 'ml', item: null, batch: b.id, price: null, was: null, flag: null }] : [], i === 0) }) }
  }
  return { id: nid(), name: 'New choice', options: [opt('Usual', [], true), opt('Other', [], false)] }
}

// one supplier line: tick, figure, later, move
function findOffer(el) {
  const of = el.closest('.of')
  const wb = el.closest('.wb')
  return { o: S.offers.find((x) => x.line === Number(of.dataset.line) && x.key === of.dataset.okey), kept: wb.dataset.key, of }
}
function offerSaved(o, kept) { return () => { redrawAll(); void o; void kept } }
function onBuyClick(b) {
  const a = b.dataset.act
  if (a === 'tick') {
    const { o, kept } = findOffer(b)
    if (tickedElsewhere(o.line, kept)) { b.checked = false; return true }
    o.ticked = b.checked
    act(`offer:${o.line}:${o.key}:tick`, { action: 'offer', line: o.line, product: o.key, value: { ticked: o.ticked } }, 0, offerSaved(o, kept))
    redrawAll()
    return true
  }
  if (a === 'move') {
    const { o, kept } = findOffer(b)
    for (const x of S.offers) if (x.line === o.line && x.ticked) x.ticked = false
    o.ticked = true
    act(`offer:${o.line}:move`, { action: 'offer', line: o.line, product: o.key, value: { move: true } }, 0, offerSaved(o, kept))
    redrawAll()
    return true
  }
  if (a === 'fig-later') {
    const { o } = findOffer(b)
    o.figure = null
    o.figure_how = 'at_delivery'
    act(`offer:${o.line}:${o.key}:fig`, { action: 'offer', line: o.line, product: o.key, value: { at_delivery: true } })
    redrawAll()
    return true
  }
  if (a === 'fig-undo') {
    const { o } = findOffer(b)
    o.figure_how = null
    act(`offer:${o.line}:${o.key}:fig`, { action: 'offer', line: o.line, product: o.key, value: { figure: null } })
    redrawAll()
    return true
  }
  if (a === 'use-pack') {
    const kept = b.closest('.wb').dataset.key
    const m = prod(kept)
    m.how = 'count'
    m.value = Number(b.dataset.n)
    m.touched_at = new Date().toISOString()
    save(`M:${kept}`, 'measure', { unit: m.unit, pack: m.pack, how: 'count', value: m.value, grams: m.grams ?? null })
    redrawAll()
    return true
  }
  if (a === 'split') {
    const kept = b.closest('.wb').dataset.key
    if (!confirm('Split these back into separate products? Each keeps its own invoice lines.')) return true
    for (const k of groupKeys(kept)) if (k !== kept) { S.measures.get(k).same_as = null; act(`prod:${k}:split`, { action: 'product', product: k, field: 'same_as', value: null }) }
    redrawAll()
    return true
  }
  if (a === 'answer' || a === 're-ask') {
    const box = b.closest('.ask')
    const k = box ? box.dataset.key : b.closest('.wb').dataset.key
    const m = prod(k)
    if (a === 're-ask') { m.answer = null; redrawAll(); return true }
    m.answer = b.dataset.a
    const join = b.dataset.join || null
    if (join) m.same_as = join
    act(`prod:${k}:answer`, { action: 'product', product: k, field: 'answer', value: { answer: m.answer, join } })
    redrawAll()
    return true
  }
  if (a === 'add-line') {
    const kept = b.closest('.wb').dataset.key
    const p = prod(kept)
    const lineId = Number(b.closest('.al-hit').dataset.line)
    const l = S.lines.get(lineId)
    const fig = readPack({ kind: p.kind, unit: p.unit }, { ...l, confirmed: l.pack_was != null })
    const g = guard({ name: p.name, warn: p.ask && !p.answer ? p.ask.warn : [] }, l)
    const other = S.offers.find((x) => x.line === lineId && x.ticked)
    const o = { line: lineId, key: kept, found: 'added', our_pick: false, ticked: !other, figure: fig.figure, figure_how: fig.figure != null ? fig.how : fig.how === 'weighed' ? 'weighed' : null, per_unit: fig.per_unit, guard: g.level === 'warn' ? g.text : g.level === 'refuse' ? `This reads as ${g.word}. Your product is not.` : null, gold: fig.gold }
    S.offers.push(o)
    act(`addline:${lineId}:${kept}`, { action: 'add-offer', line: lineId, product: kept, value: { figure: o.figure, figure_how: o.figure_how, per_unit: o.per_unit, guard: o.guard, gold: o.gold } })
    redrawAll()
    return true
  }
  return false
}

function wire() {
  const main = $('#main')
  main.addEventListener('toggle', (e) => {
    const d = e.target
    if (!(d instanceof HTMLDetailsElement) || !d.open) return
    if (d.classList.contains('more')) {
      const r = S.byId.get(d.closest('.card').dataset.id)
      const body = d.querySelector('.body')
      if (r && !body.innerHTML) body.innerHTML = bodyHtml(r)
    } else if (d.classList.contains('l-buy')) {
      d.querySelector('.lb-body').innerHTML = buyHtml(d.dataset.key)
    }
  }, true)

  main.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]')
    if (open) { const card = document.getElementById(`r-${open.dataset.open}`); if (card) card.querySelector('details').open = true }
    const b = e.target.closest('[data-act]')
    if (!b || !S.canEdit) return
    if (b.closest('.wb, .ask') && onBuyClick(b)) return
    if (b.dataset.act === 'name-pick') { openPicker({ question: b.closest('[data-q]').dataset.q }); return }
    const holder = b.closest('.card, .lo')
    const r = holder && S.byId.get(holder.dataset.id)
    const actName = b.dataset.act
    if (!r) return
    if (actName === 'need') {
      const v = b.dataset.v === 'true'
      r.needed = r.needed === v ? null : v
      for (const x of holder.querySelectorAll(':scope > .need .yn, :scope > .yn')) x.classList.toggle('on', r.needed !== null && x.dataset.v === String(r.needed))
      holder.classList.toggle('yes', r.needed === true)
      holder.classList.toggle('no', r.needed === false)
      updateProgress()
      save(r.id, 'needed', r.needed)
      return
    }
    if (actName === 'kind') {
      if (r.kind === b.dataset.v) return
      r.kind = b.dataset.v
      save(r.id, 'kind', r.kind)
      holder.querySelector('.kind').textContent = r.kind === 'batch' ? 'Batch' : 'Sold'
      rerenderBody(r)
      return
    }
    if (actName === 'pick') { const lineEl = b.closest('.line'); openPicker({ recipe: r.id, path: lineEl.dataset.path, id: lineEl.dataset.id }); return }
    if (actName === 'add-line') {
      const path = b.dataset.path
      const l = { id: nid(), name: 'New ingredient', qty: null, unit: 'g', item: null, batch: null, price: null, was: null, flag: null }
      at(r, path).push(l)
      save(r.id, fieldOf(path), r[fieldOf(path)])
      rerenderBody(r)
      openPicker({ recipe: r.id, path, id: l.id })
      return
    }
    if (actName === 'del-line') {
      const lineEl = b.closest('.line')
      const arr = at(r, lineEl.dataset.path)
      const i = arr.findIndex((x) => x.id === lineEl.dataset.id)
      if (i >= 0 && !confirm(`Remove ${lineView(arr[i]).name || arr[i].name}?`)) return
      if (i >= 0) arr.splice(i, 1)
      rerenderBody(r)
      save(r.id, fieldOf(lineEl.dataset.path), r[fieldOf(lineEl.dataset.path)])
      renderNeeds()
      return
    }
    if (actName === 'undo-move') {
      const m = r.moved
      r.ingredients = structuredClone(m.before.ingredients)
      r.choices = structuredClone(m.before.choices)
      r.moved = { ...m, undone: true }
      save(r.id, 'ingredients', r.ingredients)
      save(r.id, 'choices', r.choices)
      save(r.id, 'moved', r.moved)
      rerenderBody(r)
      return
    }
    if (actName === 'extra' || actName === 'extra-drop') {
      r.extras = r.extras || { eatin: [], takeaway: [] }
      if (actName === 'extra-drop') {
        for (const side of ['eatin', 'takeaway']) r.extras[side] = r.extras[side].filter((e) => e.p)
      } else {
        const p = b.closest('.ex').dataset.p
        const side = b.dataset.side
        const list = r.extras[side]
        const i = list.findIndex((e) => e.p && keptKey(e.p) === p)
        if (i >= 0) list.splice(i, 1)
        else list.push({ p, qty: 1 })
      }
      save(r.id, 'extras', r.extras)
      rerenderBody(r)
      return
    }
    const gEl = b.closest('.group')
    const g = gEl ? r.choices[+gEl.dataset.g] : null
    if (actName === 'preset') {
      const pg = presetGroup(b.dataset.v)
      if (pg) r.choices.push(pg)
      save(r.id, 'choices', r.choices)
      rerenderBody(r)
      return
    }
    if (actName === 'add-group') {
      const menu = b.parentElement.querySelector('.presets')
      if (!menu) { b.insertAdjacentHTML('afterend', `<div class="presets">${['Bread', 'Sauce', 'Other'].map((n) => `<button type="button" class="btn ghost" data-act="preset" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>`); return }
      menu.remove()
      return
    } else if (actName === 'del-group' && g) {
      if (!confirm(`Remove the ${g.name} choices?`)) return
      r.choices.splice(+gEl.dataset.g, 1)
      forgetChoice(r, g, null)
    } else if (actName === 'add-opt' && g) {
      g.options.push({ id: nid(), name: 'New choice', usual: false, lines: [] })
    } else if (actName === 'del-opt' && g) {
      const oi = +b.closest('.opt').dataset.o
      const wasUsual = g.options[oi].usual
      const gone = g.options.splice(oi, 1)[0]
      forgetChoice(r, g, gone)
      if (wasUsual && g.options[0]) g.options[0].usual = true
    } else if (actName === 'usual' && g) {
      const oi = +b.closest('.opt').dataset.o
      g.options.forEach((o, i) => { o.usual = i === oi })
      save(r.id, 'choices', r.choices)
      refreshCosts()
      return
    } else return
    save(r.id, 'choices', r.choices)
    rerenderBody(r)
  })

  const onEdit = (e, final) => {
    if (!S.canEdit) return
    const t = e.target
    // where we buy it: a figure, a product name, a note, a typed answer, a search
    if (t.classList.contains('fig-in')) {
      const { o } = findOffer(t)
      const raw = t.value.trim()
      const f = readNumber(raw)
      if (raw === '') { good(t); if (final) { o.figure = null; o.figure_how = null; act(`offer:${o.line}:${o.key}:fig`, { action: 'offer', line: o.line, product: o.key, value: { figure: null } }) } return }
      if (!(Number.isFinite(f) && f > 0 && f <= 1000000)) { bad(t, 'how much is in one must be a number above nought, like 1000.'); return }
      good(t)
      o.figure = f
      o.figure_how = 'hers'
      act(`offer:${o.line}:${o.key}:fig`, { action: 'offer', line: o.line, product: o.key, value: { figure: f } }, final ? 0 : 900)
      if (final) redrawAll()
      else refreshCosts()
      return
    }
    if (t.classList.contains('p-name')) {
      const k = t.closest('.wb').dataset.key
      const v = t.value.trim()
      if (!v) { bad(t, 'the product needs a name.'); return }
      good(t)
      prod(k).name = v
      act(`prod:${k}:name`, { action: 'product', product: k, field: 'name', value: v }, final ? 0 : 900)
      if (final) redrawAll()
      return
    }
    if (t.classList.contains('p-note')) {
      const k = t.closest('.wb').dataset.key
      prod(k).note = t.value
      act(`prod:${k}:note`, { action: 'product', product: k, field: 'note', value: t.value }, final ? 0 : 1000)
      return
    }
    if (t.classList.contains('ask-text')) {
      if (!final || !t.value.trim()) return
      const k = t.closest('.ask').dataset.key
      prod(k).answer = t.value.trim()
      act(`prod:${k}:answer`, { action: 'product', product: k, field: 'answer', value: { answer: prod(k).answer, join: null } })
      redrawAll()
      return
    }
    if (t.classList.contains('al-q')) {
      t.parentElement.querySelector('.al-res').innerHTML = addLineResults(t.closest('.wb').dataset.key, t.value)
      return
    }
    if (t.classList.contains('q-ans')) {
      const k = t.closest('[data-q]').dataset.q
      if (!t.value.trim()) return
      const q = S.questions.find((x) => x.key === k)
      act(`q:${k}`, { action: 'answer', question: k, value: t.value }, final ? 0 : 1200, () => { if (final) { q.answer = t.value; renderNeeds() } })
      return
    }
    if (t.classList.contains('nd-qty')) {
      const box = t.closest('.nd-a')
      const r = S.byId.get(box.dataset.r)
      const l = at(r, box.dataset.path).find((x) => x.id === box.dataset.id)
      const raw = t.value.trim().replace(',', '.')
      const q = Number(raw)
      if (raw === '') return
      if (!(Number.isFinite(q) && q > 0)) { bad(t, 'the amount must be a number above nought.'); return }
      good(t)
      if (!final) return
      const v = lineView(l)
      if (v.cross) { l.was = l.was || v.cross.was; l.measure = v.key; l.unit = v.p.kind === 'count' ? 'each' : v.p.kind }
      l.qty = q
      delete l.ask
      save(r.id, fieldOf(box.dataset.path), r[fieldOf(box.dataset.path)])
      redrawAll()
      return
    }
    if (t.classList.contains('ex-qty')) {
      const card = t.closest('.card')
      const r = S.byId.get(card.dataset.id)
      const p = t.closest('.ex').dataset.p
      const e2 = r.extras[t.dataset.side].find((x) => x.p && keptKey(x.p) === p)
      const q = Number(t.value.trim().replace(',', '.'))
      if (!(Number.isFinite(q) && q > 0)) { bad(t, 'how many must be a number above nought, like 1 or 2.'); return }
      good(t)
      e2.qty = q
      delete e2.sug
      refreshCosts()
      save(r.id, 'extras', r.extras, final ? 0 : 800)
      return
    }
    if (t.closest('#measures .buy') && t.classList.contains('m-count')) {
      const k = t.closest('.buy').dataset.key
      const m = prod(k)
      const raw = t.value.trim().replace(',', '.')
      const q = Number(raw)
      if (!(raw !== '' && Number.isFinite(q) && q >= 1 && q <= 1000000)) { bad(t, `how many ${m.unit}s in one ${m.pack}: a whole number, like 12.`); return }
      good(t)
      m.how = 'count'
      m.value = q
      if (final) m.touched_at = m.touched_at || new Date().toISOString()
      save(`M:${k}`, 'measure', { unit: m.unit, pack: m.pack, how: 'count', value: q, grams: m.grams ?? null }, final ? 0 : 900)
      refreshCosts()
      return
    }
    const size = t.closest('.size')
    if (size) {
      const r = S.byId.get(size.dataset.id)
      const qBox = size.querySelector('.s-qty')
      const raw = qBox.value.trim().replace(',', '.')
      if (raw === '') r.makes = null
      else if (Number.isFinite(Number(raw)) && Number(raw) > 0) r.makes = { qty: Number(raw), unit: size.querySelector('.s-unit').value }
      else { bad(qBox, 'how much it makes must be a number above nought, like 2 or 1.5.'); return }
      good(qBox)
      save(r.id, 'makes', r.makes, final ? 0 : 800)
      refreshCosts()
      return
    }
    const card = t.closest('.card')
    if (!card) return
    const r = S.byId.get(card.dataset.id)
    const lineEl = t.closest('.line')
    if (lineEl && !t.closest('.l-buy')) return onLineInput(r, lineEl, t, final)
    if (t.classList.contains('r-name')) {
      if (!t.value.trim()) { bad(t, 'the recipe needs a name.'); return }
      good(t)
      r.name = t.value.trim()
      card.querySelector('.r-title').textContent = r.name
      save(r.id, 'name', r.name, final ? 0 : 800)
    } else if (t.classList.contains('r-notes')) {
      r.notes = t.value
      save(r.id, 'notes', r.notes, final ? 0 : 1000)
    } else if (t.classList.contains('m-qty') || t.classList.contains('m-unit')) {
      const body = t.closest('.body')
      const box = $('.m-qty', body)
      const raw = box.value.trim().replace(',', '.')
      const q = Number(raw)
      if (raw === '') r.makes = null
      else if (Number.isFinite(q) && q > 0) r.makes = { qty: q, unit: $('.m-unit', body).value }
      else { bad(box, 'how much it makes must be a number above nought, like 2 or 1.5.'); return }
      good(box)
      refreshCosts()
      save(r.id, 'makes', r.makes, final ? 0 : 800)
    } else if (t.classList.contains('g-name') || t.classList.contains('o-name')) {
      const g = r.choices[+t.closest('.group').dataset.g]
      if (!t.value.trim()) { bad(t, 'each choice needs a name.'); return }
      good(t)
      if (t.classList.contains('g-name')) g.name = t.value.trim()
      else g.options[+t.closest('.opt').dataset.o].name = t.value.trim()
      save(r.id, 'choices', r.choices, final ? 0 : 800)
    }
  }
  main.addEventListener('input', (e) => onEdit(e, false))
  main.addEventListener('change', (e) => onEdit(e, true))

  $('#anythingElse').addEventListener('input', (e) => { if (S.canEdit) save(null, 'anything_else', e.target.value, 1000) })
  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]')
    if (!b) return
    if (b.dataset.show === 'needs') { const d = $('#needs'); d.scrollIntoView({ behavior: 'smooth', block: 'start' }); for (const x of d.querySelectorAll('details.nd')) x.open = true; return }
    S.show = b.dataset.show
    for (const x of document.querySelectorAll('#filter .chip[data-show="all"], #filter .chip[data-show="todo"]')) x.classList.toggle('on', x === b)
    applyFilter()
  })
  $('#addBtn').addEventListener('click', async () => {
    const name = $('#addName').value.trim()
    if (!name) { $('#addName').focus(); return }
    status('saving', 'Adding...')
    let r
    try { r = await call({ action: 'add', name, category: $('#addCat').value }) } catch { r = { status: 0, body: {} } }
    if (r.status !== 200) { status('bad', `Not added: ${r.body.problem || 'please try again.'}`); return }
    const rec = { makes: null, ingredients: [], takeaway: [], choices: [], seed: {}, notes: '', extras: { eatin: [], takeaway: [] }, ...r.body.recipe }
    S.recipes.push(rec)
    S.byId.set(rec.id, rec)
    $('#addName').value = ''
    render()
    status('ok', 'Added')
    const card = document.getElementById(`r-${rec.id}`)
    if (card) { card.querySelector('details').open = true; card.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  })
  // the picker
  $('#pk-q').addEventListener('input', (e) => { $('#pk-res').innerHTML = pickerResults(e.target.value) })
  $('#pk-res').addEventListener('click', (e) => { const h = e.target.closest('.pk-hit'); if (h) applyPick(h.dataset.key, h.dataset.batch) })
  $('#pk-close').addEventListener('click', () => { $('#picker').hidden = true; picking = null })
  $('#pk-add').addEventListener('click', () => { $('#pk-new').hidden = !$('#pk-new').hidden })
  $('#pk-make').addEventListener('click', async () => {
    const value = { what: $('#pk-what').value, variety: $('#pk-var').value, form: $('#pk-form').value }
    status('saving', 'Adding...')
    const r = await call({ action: 'add-product', value })
    if (r.status !== 200) { status('bad', `Not added: ${r.body.problem || 'please try again.'}`); return }
    const p = r.body.product
    const k = r.body.exists || p.key
    if (!S.measures.has(k)) S.measures.set(k, { key: k, name: p.name, unit: p.unit, kind: p.kind, grp: 'Dry goods and spices', pack: p.kind === 'count' ? 'pack' : p.kind === 'ml' ? '1 L' : '1 kg', how: 'count', value: p.kind === 'count' ? 1 : 1000, was: [], role: 'stock', note: '' })
    status('ok', r.body.exists ? 'That product is already on the list' : 'Added')
    applyPick(k)
  })
}

// ---------------------------------------------------------------- Tarryn's view: every change

const FIELD_WORDS = { measure: 'how we measure it', name: 'name', category: 'menu group', kind: 'type', makes: 'makes how much', needed: 'do we need it', notes: 'notes', ingredients: 'ingredients', takeaway: 'take-away extras', choices: 'choices', anything_else: 'anything else', added: 'added a recipe', offer: 'where we buy it', product: 'product', extras: 'menu extras', moved: 'moved into a choice', question: 'question' }
function said(field, v) {
  if (v === null || v === undefined || v === '') return '<i>empty</i>'
  if (field === 'measure') return esc(v.how === 'count' ? `1 ${v.pack} = ${trimN(v.value)} ${v.unit}s` : v.how === 'share' ? `1 ${v.unit} = ${trimN(v.value)} of a ${v.pack}` : `${v.unit}, ${v.pack}, not set`)
  if (field === 'needed') return v ? 'Yes' : 'No'
  if (field === 'makes') return esc(fmtQty(v.qty, v.unit))
  if (field === 'kind') return v === 'batch' ? 'Batch' : 'Sold'
  if (field === 'offer') {
    if (v.added) return `added from her invoices${v.ticked ? ', ticked' : ''}${v.ticked_under ? ` (ticked under ${esc(prodName(v.ticked_under) || v.ticked_under)})` : ''}`
    return esc(`${v.ticked ? 'ticked' : 'not ticked'}${v.figure != null ? `, 1 of these = ${trimN(v.figure)}` : ''}${v.figure_how === 'at_delivery' ? ', ask at the next delivery' : ''}${v.ticked_under ? `, ticked under ${prodName(v.ticked_under) || v.ticked_under}` : ''}`)
  }
  if (field === 'product') {
    if (v.added) return esc(`added ${v.added}${v.suggested ? ' (suggested)' : ''}`)
    const bits = []
    if ('name' in v) bits.push(`name ${v.name}`)
    if ('unit' in v) bits.push(`unit ${v.unit}`)
    if ('answer' in v) bits.push(`answer ${v.answer ?? 'none'}`)
    if ('same_as' in v) bits.push(v.same_as ? `same as ${prodName(v.same_as) || v.same_as}` : 'its own product')
    if ('note' in v) bits.push(`note ${v.note || 'empty'}`)
    return esc(bits.join(', ') + (v.suggested ? ' (suggested)' : ''))
  }
  if (field === 'extras') return esc(['eatin', 'takeaway'].map((s) => `${s === 'eatin' ? 'Eat in' : 'Take away'}: ${(v[s] || []).map((e) => `${e.qty ?? 1} ${prodName(keptKey(e.p)) || e.was || '?'}`).join(', ') || 'none'}`).join('; '))
  if (field === 'moved') return esc(`${v.text}${v.undone ? ' (undone)' : ''}`)
  return esc(typeof v === 'string' ? v : JSON.stringify(v))
}
const lineWords = (l) => { const v = lineView(l); return `${l.qty == null ? 'no amount' : `${trimN(l.qty)} ${v.unit || l.unit}`} ${v.name || l.name}` }
function listDiff(before, afterL) {
  const b = new Map((before || []).map((l) => [l.id, l]))
  const a = new Map((afterL || []).map((l) => [l.id, l]))
  const out = []
  for (const [id, l] of a) {
    const o = b.get(id)
    if (!o) out.push(`<li class="plus">added ${esc(lineWords(l))}</li>`)
    else if (lineWords(o) !== lineWords(l)) out.push(`<li>${esc(lineWords(o))} <b>to</b> ${esc(lineWords(l))}</li>`)
  }
  for (const [id, l] of b) if (!a.has(id)) out.push(`<li class="minus">removed ${esc(lineWords(l))}</li>`)
  return out.length ? `<ul>${out.join('')}</ul>` : '<ul><li>details changed</li></ul>'
}
function choiceWords(cs) {
  return (cs || []).map((g) => `${g.name}: ${g.options.map((o) => `${o.usual ? '(usual) ' : ''}${o.name}${o.lines.length ? ` = ${o.lines.map(lineWords).join(', ')}` : ''}`).join(' / ')}`).join('; ')
}
function renderChanges(changes) {
  const el = $('#changes')
  el.hidden = false
  const when = (t) => new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  el.innerHTML = `<h2>Every change <span class="n">${changes.length}</span></h2>
    ${changes.length ? '' : '<p class="small">No changes yet.</p>'}
    <ol class="clist">${changes.map((c) => {
      let what
      if (c.field === 'ingredients' || c.field === 'takeaway') what = listDiff(c.before, c.after)
      else if (c.field === 'choices') what = `<p>${esc(choiceWords(c.before)) || '<i>none</i>'} <b>to</b> ${esc(choiceWords(c.after)) || '<i>none</i>'}</p>`
      else if (c.field === 'added') what = `<p>${said('name', c.after)}</p>`
      else if (c.field === 'question') what = `<p>${esc(c.question || '')} <b>Answer:</b> ${said('question', c.after)}</p>`
      else what = `<p>${said(c.field, c.before)} <b>to</b> ${said(c.field, c.after)}</p>`
      const subject = c.recipe ? `<a href="#r-${esc(c.recipe)}" data-open="${esc(c.recipe)}">${esc(c.name || c.recipe)}</a>, ` : c.measure ? `${esc(c.name || c.measure)}, ` : ''
      return `<li><div class="c-top"><b>${esc(c.who)}</b> <span class="muted">${when(c.at)}</span></div>
        <div>${subject}${esc(FIELD_WORDS[c.field] || c.field)}${c.line_text ? `: ${esc(c.line_text)}` : ''}</div>${what}</li>`
    }).join('')}</ol>`
}

// ---------------------------------------------------------------- start

async function start() {
  if (!key) {
    $('#list').innerHTML = '<p class="loading">This link is missing its key. Please use the link Tarryn sent.</p>'
    $('#prog').textContent = ''
    return
  }
  let r
  try { r = await call({ action: 'open' }) } catch { r = { status: 0, body: {} } }
  if (r.status !== 200) {
    $('#list').innerHTML = `<p class="loading">${esc(r.body.problem || 'The recipes could not be loaded. Check your connection and refresh.')}</p>`
    $('#prog').textContent = ''
    return
  }
  const d = r.body
  if (d.intro) {
    document.querySelector('h1').textContent = d.intro.title
    $('#whoLine').textContent = d.intro.sub
    $('#notes').innerHTML = d.intro.notes
    $('#foot').textContent = d.intro.foot
  }
  S.canEdit = d.canEdit
  S.who = d.who
  S.recipes = d.recipes
  S.byId = new Map(S.recipes.map((x) => [x.id, x]))
  S.items = d.items
  S.itemById = new Map(d.items.map((i) => [i.id, i]))
  S.measures = new Map((d.measures || []).map((m) => [m.key, { ...m, value: m.value == null ? null : Number(m.value), grams: m.grams == null ? null : Number(m.grams), price: m.price == null ? null : Number(m.price), was: m.was || [] }]))
  S.lines = new Map((d.lines || []).map((l) => [l.id, { ...l, price: l.price == null ? null : Number(l.price) }]))
  S.offers = (d.offers || []).map((o) => ({ ...o, figure: o.figure == null ? null : Number(o.figure) }))
  S.questions = d.questions || []
  S.aliases = new Map()
  for (const m of S.measures.values()) for (const n of [m.name, ...(m.was || [])]) if (!S.aliases.has(normName(n))) S.aliases.set(normName(n), m.key)
  $('#anythingElse').value = d.notes || ''
  if (!S.canEdit) {
    document.body.classList.add('view')
    $('#whoLine').textContent = 'Tarryn\'s view: every change, newest first. This link can only look.'
    $('#anythingElse').disabled = true
    renderChanges(d.changes || [])
  } else {
    $('#addBlock').hidden = false
  }
  render()
  wire()
  status('ok', S.canEdit ? 'Changes save as you go' : 'Read only')
}
start()
