/*
 * Lindsay's recipe review page (17/11/2026). Plain browser code, no build. The rules (what may be saved, how a cost is
 * worked out) are in recipereview.js, a copy of shared/recipereview.js made at deploy, so the page and the server
 * cannot disagree. The key is in the link after # (never sent to a web server's log), and goes in the request body.
 */
import { recipeCost, lineCost, fmtQty, fmtRand, progress, UNITS, UNIT_WORDS, MAKES_UNITS, shareOf, piecesOf } from './recipereview.js'

const API = 'https://nptyrtjdvqglgwkaepce.supabase.co/functions/v1/badger-recipes'
const key = new URLSearchParams(location.hash.slice(1)).get('k') || new URLSearchParams(location.search).get('k') || ''
const MENU_ORDER = ['Breakfast', 'Midday Munch', 'Everyday Favourites', 'Hot Drinks', 'Cold Drinks', 'Bakes', 'Batches']

const S = { recipes: [], byId: new Map(), items: [], itemById: new Map(), itemByName: new Map(), measures: new Map(), packaging: [], canEdit: false, who: '', show: 'all' }
const $ = (s, el = document) => el.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const SEP = '<span class="dot" aria-hidden="true">/</span>'
const X = '&times;'
let seq = 0
const nid = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`

// ---------------------------------------------------------------- talking to the server

async function call(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, key }) })
  let j = {}
  try { j = await r.json() } catch { /* nothing to read */ }
  return { status: r.status, body: j }
}

const queue = new Map() // `${recipe}|${field}` -> the value waiting to be saved
const timers = new Map()
let busy = false
let lastProblem = ''
// fields holding something that cannot be saved (test 03, finding 2): while any is left, the bar never says "Saved"
const invalid = new Map() // element -> problem
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
function save(recipeId, field, value, wait = 0) {
  const k = `${recipeId ?? ''}|${field}`
  queue.set(k, structuredClone(value))
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
        r = rid.startsWith('M:')
          ? await call({ action: 'save', field: 'measure', measure: rid.slice(2), value })
          : await call({ action: 'save', recipe: rid || null, field, value })
      } catch {
        r = { status: 0, body: {} }
      }
      if (r.status === 200) { lastProblem = ''; continue }
      if (r.status === 0 || r.status >= 500) {
        if (!queue.has(k)) queue.set(k, value)
        status('bad', 'Not saved yet: no connection. Trying again...')
        busy = false
        setTimeout(flush, 4000)
        return
      }
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

// ---------------------------------------------------------------- the cost, worked out, never typed

const ctx = () => ({ items: S.itemById, recipes: S.byId, measures: S.measures })
const money = (n) => (n < 1 ? `${Math.max(1, Math.round(n * 100))}c` : fmtRand(n))
const fromWords = (c) => (c.from === 'Kitchen items' ? 'kitchen price' : c.from === 'Batch' ? 'from the batch' : `${c.from} price`)
const lineCostHtml = (l) => {
  const c = lineCost(l, ctx())
  if (c.rand !== null && c.rand < 0.005) return `under 1c<small>${esc(fromWords(c))}</small>`
  return c.rand !== null ? `${money(c.rand)}<small>${esc(fromWords(c))}</small>` : '<span class="c-miss">no price</span>'
}
function costHtml(r) {
  const c = recipeCost(r, ctx())
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
  return `<div class="cost-line"><span class="lbl">Cost to make</span>${bits.join(SEP)}${sells}</div>`
    + (miss.length ? `<div class="miss">Not complete. ${miss.map(esc).join('; ')}</div>` : '')
}
function miniCost(r) {
  const c = recipeCost(r, ctx())
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

// ---------------------------------------------------------------- one recipe

const SRC = { loyverse: 'Loyverse', odoo: 'Odoo', both: 'Loyverse and Odoo', new: 'Added here' }
const ro = () => (S.canEdit ? '' : ' disabled')
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

const plural = (n, w) => `${trimN(n)} ${n === 1 ? w : `${w}s`}`
const trimN = (n) => String(Number(Number(n).toFixed(3)))
// How a line that points at a shared measure reads: its slices, or why it cannot yet (never rounded)
function measured(l) {
  if (!l.measure) return null
  const m = S.measures.get(l.measure)
  if (!m) return null
  const p = piecesOf(l, m)
  if (l.unit === 'piece') return { show: l.qty, unit: 'piece', flag: shareOf(m) ? null : `Set what one ${m.unit} is under "How we measure things" at the top.`, m }
  if (!p) return { show: l.qty, unit: l.unit, flag: `Set what one ${m.unit} is under "How we measure things" at the top, and this reads in ${m.unit}s.`, m }
  if (p.clean) return { show: p.n, unit: 'piece', flag: null, m }
  return { show: l.qty, unit: l.unit, flag: `${trimN(l.qty)} of a ${m.pack} is ${trimN(p.n)} ${m.unit}s, which does not come out even. Please type how many ${m.unit}s.`, m }
}

// a suggestion we filled in: a small mark; what it was only on tap or hover
const sugMark = (was) => `<details class="sug" title="${esc(was)}"><summary>Suggested</summary><span>${esc(was)} Change it if it is wrong.</span></details>`

function lineRow(l, path, r) {
  const mm = measured(l)
  const shownUnit = mm ? mm.unit : l.unit
  // "of one" is never offered (Tarryn, 17/11/2026: "0.009 etc. is ridiculous"); only shown on a line still written so
  const units = [...(mm ? [['piece', mm.m.unit]] : []), ...UNITS.filter((u) => u !== 'piece' && (u !== 'part' || l.unit === 'part')).map((u) => [u, UNIT_WORDS[u]])]
    .map(([u, w]) => `<option value="${u}"${u === shownUnit ? ' selected' : ''}>${esc(w)}</option>`).join('')
  const flag = mm ? mm.flag : l.flag
  return `<div class="line" data-path="${esc(path)}" data-id="${esc(l.id)}">
    <input class="l-name" type="text" list="itemList" maxlength="120" value="${esc(l.name)}" aria-label="Ingredient"${ro()}>
    <input class="l-qty" type="text" inputmode="decimal" value="${(mm ? mm.show : l.qty) ?? ''}" aria-label="Amount" placeholder="Amount"${ro()}>
    <select class="l-unit" aria-label="Unit"${ro()}>${units}</select>
    <span class="l-cost">${lineCostHtml(l)}</span>
    ${S.canEdit ? `<button type="button" class="x" data-act="del-line" aria-label="Remove">${X}</button>` : ''}
    ${r && path.startsWith('choices.') ? whenSelect(r, l, path) : ''}
    ${flag ? `<div class="flag">${esc(flag)}</div>` : ''}
    ${l.sug ? sugMark(/^m-(sourdough|health)/.test(l.measure || '') ? 'Bread at 12 slices a loaf, Tarryn\'s figure.' : l.pack ? 'Ticked for you.' : 'Worked out from how Loyverse had it.') : ''}
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
  return `<div class="other"><h4>In Odoo: ${esc(o.name)}${makes}</h4>
    <ul>${o.lines.map((l) => `<li>${esc(fmtQty(l.qty, l.unit))} ${esc(l.name)}</li>`).join('')}</ul>
    ${o.choices && o.choices.length ? `<p class="muted">Choices there: ${o.choices.map(esc).join('; ')}</p>` : ''}
    ${S.canEdit && o.ingredients && o.ingredients.length ? '<button type="button" class="btn ghost" data-act="use-other">Use the Odoo list instead</button>' : ''}</div>`
}

// Take-away as ticks (Tarryn, 17/11/2026: "lets do check boxes ... pre check box the obvious she can edit if wrong").
// A tick is a take-away line pointing at the packaging list; one tap adds or removes it. Ticked ones first, the rest of
// what she stocks one tap away, and "Other packaging" for anything not on the list.
function packChip(r, p, l) {
  return `<div class="pk${l ? ' on' : ''}" data-pack="${esc(p.key)}">
    <label><input type="checkbox" data-act="pack"${l ? ' checked' : ''}${ro()}><span>${esc(p.name)}</span></label>
    ${l ? `<span class="pk-q"><input class="pk-qty" type="text" inputmode="decimal" value="${l.qty ?? ''}" aria-label="How many ${esc(p.name)}"${ro()}></span>` : ''}
    ${l && l.sug ? '<small class="pk-sug">suggested</small>' : ''}
  </div>`
}
function packHtml(r) {
  const ticks = new Map(r.takeaway.filter((l) => l.pack).map((l) => [l.pack, l]))
  const on = S.packaging.filter((p) => ticks.has(p.key))
  const off = S.packaging.filter((p) => !ticks.has(p.key))
  const other = r.takeaway.filter((l) => !l.pack)
  return `<div class="pks">${on.map((p) => packChip(r, p, ticks.get(p.key))).join('')}</div>
    ${on.length ? '' : '<p class="warn">No packaging picked. Tick what it goes out in.</p>'}
    ${off.length ? `<details class="pk-more"><summary>More packaging (${off.length})</summary><div class="pks">${off.map((p) => packChip(r, p, null)).join('')}</div></details>` : ''}
    ${other.length || S.canEdit ? `<p class="pk-other">Other packaging</p>${linesHtml(other, 'takeaway', 'Add other packaging')}` : ''}`
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
      <select class="m-unit" aria-label="Unit"${ro()}>${MAKES_UNITS.map((u) => `<option value="${u}"${r.makes && r.makes.unit === u ? ' selected' : ''}>${u === 'portion' ? 'portions' : u}</option>`).join('')}</select></div>
      ${r.makes ? (isSuggestedSize(r) ? sugMark(`I added up the ingredients: ${r.seed.makes_suggested.how}.`) : '') : '<p class="warn">Please fill this in: dishes that use this batch cannot be costed without it.</p>'}</div>` : ''
  return `${info}
    <div class="field"><label>Name</label><input class="r-name" type="text" maxlength="120" value="${esc(r.name)}"${ro()}></div>
    <div class="field"><label>Type</label><div class="seg">
      <button type="button" class="${r.kind === 'sold' ? 'on' : ''}" data-act="kind" data-v="sold"${ro()}>Sold <small>a meal or drink</small></button>
      <button type="button" class="${r.kind === 'batch' ? 'on' : ''}" data-act="kind" data-v="batch"${ro()}>Batch <small>made here, used in other recipes</small></button></div></div>
    ${makes}
    <h3>Ingredients</h3>${linesHtml(r.ingredients, 'ingredients', 'Add an ingredient')}
    ${r.kind === 'sold' ? `<h3>Take-away packaging <small>only taken off stock for take-away</small></h3>${packHtml(r)}` : ''}
    ${r.kind === 'sold' ? `<h3>Choices <small>the choice decides which ingredient comes off</small></h3>${choicesHtml(r)}` : ''}
    <div class="cost" id="cost-${esc(r.id)}">${costHtml(r)}</div>
    ${otherHtml(r)}
    <div class="field"><label>Notes</label><textarea class="r-notes" rows="3" maxlength="4000" placeholder="Anything about this recipe"${ro()}>${esc(r.notes)}</textarea></div>`
}

function cardHtml(r) {
  const s = r.seed || {}
  const pic = s.picture ? `<img class="pic" src="img/${esc(s.picture)}" alt="" loading="lazy" width="64" height="64">` : '<div class="pic none" aria-hidden="true"></div>'
  const flag = s.fix ? `<span class="pill ${s.fix.level}">${s.fix.level === 'fix' ? 'To fix' : 'Worth a look'}</span>` : ''
  return `<article class="card${r.needed === true ? ' yes' : r.needed === false ? ' no' : ''}" id="r-${esc(r.id)}" data-id="${esc(r.id)}">
    <div class="head">${pic}<div class="h-txt">
      <h3 class="r-title">${esc(r.name)}</h3>
      <p class="meta"><span class="src">${esc(SRC[r.source] || r.source)}</span><span class="kind">${r.kind === 'batch' ? 'Batch' : 'Sold'}</span>${flag}</p>
      <p class="mini" id="mini-${esc(r.id)}">${miniCost(r)}</p></div></div>
    <div class="need"><span>Do we need it?</span>
      <button type="button" class="yn y${r.needed === true ? ' on' : ''}" data-act="need" data-v="true"${ro()}>Yes</button>
      <button type="button" class="yn n${r.needed === false ? ' on' : ''}" data-act="need" data-v="false"${ro()}>No</button></div>
    <details class="more"><summary>Check the ingredients <span class="count">(${usualCount(r)})</span></summary><div class="body" id="body-${esc(r.id)}"></div></details>
  </article>`
}

// ---------------------------------------------------------------- the whole list

function groups() {
  const cats = [...new Set(S.recipes.filter((r) => !r.left_out).map((r) => r.category))]
  return cats.sort((a, b) => ((MENU_ORDER.indexOf(a) + 1) || 99) - ((MENU_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b))
}

// ---------------------------------------------------------------- shared measures and batch sizes, at the top
// Tarryn, 17/11/2026: "if she changes bread from 0.09 in one place it should automatically change it everywhere"

function measureLines(key) {
  const out = []
  for (const r of S.recipes) {
    if (r.left_out) continue
    const ls = [...r.ingredients, ...r.takeaway, ...r.choices.flatMap((g) => g.options.flatMap((o) => o.lines))].filter((l) => l.measure === key)
    if (ls.length) out.push([r, ls])
  }
  return out
}

const isSuggestedSize = (r) => r.seed && r.seed.makes_suggested && r.makes && r.makes.qty === r.seed.makes_suggested.qty && r.makes.unit === r.seed.makes_suggested.unit
const isSuggestedMeasure = (m) => m.suggested && !m.touched_at
const GROUP_ORDER = ['Bread', 'Fruit and veg', 'Dairy', 'Meat', 'Dry goods and spices', 'Sauces', 'Drinks', 'Packaging']
const plur = (n, w) => (n === 1 || /s$/.test(w) || w === 'g' || w === 'ml' ? w : `${w}s`)

// One short row per ingredient, as the kitchen buys it (Tarryn, 17/11/2026: "a loaf of bread is bought - how many slices
// are in that loaf"): 1 loaf (R54.00) = [12] slices. Counted things change with one tap; weight and volume are as
// priced (1 kg = 1000 g) and only show.
function measureCard(m) {
  const users = measureLines(m.key)
  const price = m.price == null ? 'no price yet' : m.of === 'unit' ? `${money(Number(m.price))} each` : money(Number(m.price))
  const counted = m.kind === 'count'
  const amount = counted
    ? `<input class="m-count" type="text" inputmode="numeric" value="${esc(trimN(m.value))}" aria-label="How many ${esc(m.unit)}s in one ${esc(m.pack)}"${ro()}>`
    : `<b>${esc(trimN(m.value))}</b>`
  const reads = users.map(([r, ls]) => `<li><a href="#r-${esc(r.id)}" data-open="${esc(r.id)}">${esc(r.name)}</a>: ${ls.map((l) => (l.unit === 'piece' ? plural(l.qty, m.unit) : esc(fmtQty(l.qty, l.unit)))).join(', ')}</li>`).join('')
  return `<div class="buy" data-key="${esc(m.key)}">
    <div class="b-name">${esc(m.name)}</div>
    <div class="b-eq"><span>1 ${esc(m.pack)} <small>(${esc(price)})</small> =</span>${amount}<span>${esc(plur(Number(m.value), m.unit))}</span>
      ${isSuggestedMeasure(m) ? sugMark(/^m-(sourdough|health)/.test(m.key) ? 'Tarryn\'s figure: 12 slices a loaf.' : 'My best kitchen guess. Change it if your pack is different.') : ''}</div>
    <details class="m-users"><summary>${users.length} recipe${users.length === 1 ? '' : 's'}</summary><ul>${reads}</ul></details>
  </div>`
}

function renderShared() {
  const ms = [...S.measures.values()].filter((m) => m.kind && measureLines(m.key).length)
  const byGroup = GROUP_ORDER.map((g) => [g, ms.filter((m) => (m.grp || 'Dry goods and spices') === g)]).filter(([, l]) => l.length)
  $('#measures').innerHTML = `<h2>How we measure things</h2>
    <p class="small">How we buy each ingredient, and what it is in the kitchen. I have filled these in. Change any that are wrong and every recipe follows.</p>
    ${byGroup.map(([g, l], i) => `<details class="b-group"${i === 0 ? ' open' : ''}><summary>${esc(g)} <span class="n">${l.length}</span></summary>${l.map(measureCard).join('')}</details>`).join('')}`
  const batches = S.recipes.filter((r) => r.seed && r.seed.needs_makes && !r.left_out)
  $('#sizes').innerHTML = batches.length ? `<h2>How much each batch makes</h2>
    <p class="small">Loyverse never recorded this, so I added up each batch's ingredients. Change any that are wrong: it is the same box as on the batch's own card.</p>
    ${batches.map((r) => `<div class="size" data-id="${esc(r.id)}"><a href="#r-${esc(r.id)}" data-open="${esc(r.id)}">${esc(r.name)}</a>
      <div class="row"><input class="s-qty" type="text" inputmode="decimal" value="${r.makes ? r.makes.qty : ''}" placeholder="Amount" aria-label="${esc(r.name)} makes how much"${ro()}>
      <select class="s-unit" aria-label="Unit"${ro()}>${MAKES_UNITS.map((u) => `<option value="${u}"${r.makes && r.makes.unit === u ? ' selected' : ''}>${u === 'portion' ? 'portions' : u}</option>`).join('')}</select></div>
      ${isSuggestedSize(r) ? sugMark(`I added up the ingredients: ${r.seed.makes_suggested.how}.`) : ''}</div>`).join('')}` : ''
}

// after a measure changes: every open recipe using it redraws (amounts and costs), the counts on top too
function afterMeasure(key) {
  for (const [r] of measureLines(key)) {
    const body = document.getElementById(`body-${r.id}`)
    if (body && body.innerHTML) body.innerHTML = bodyHtml(r)
  }
  refreshCosts()
}

// Setting a measure turns every line written as part of the pack that divides evenly into slices (0.09 of a loaf with
// 1 slice = 0.09 is 1 slice), so a later change of what a slice is changes every recipe. Uneven ones stay as written,
// flagged for her. Never rounded.
function convertLines(key) {
  const m = S.measures.get(key)
  if (!shareOf(m)) return
  for (const [r] of measureLines(key)) {
    const touched = new Set()
    const fix = (ls, field) => ls.forEach((l) => {
      if (l.measure !== key || l.unit !== 'part') return
      const p = piecesOf(l, m)
      if (p && p.clean) { l.unit = 'piece'; l.qty = p.n; touched.add(field) }
    })
    fix(r.ingredients, 'ingredients')
    fix(r.takeaway, 'takeaway')
    for (const g of r.choices) for (const o of g.options) fix(o.lines, 'choices')
    for (const f of touched) save(r.id, f, r[f])
  }
}

function onShared(e, final) {
  if (!S.canEdit) return
  const t = e.target
  const box = t.closest('.buy')
  if (box) {
    const m = S.measures.get(box.dataset.key)
    if (!t.classList.contains('m-count')) return
    const raw = t.value.trim().replace(',', '.')
    const q = Number(raw)
    if (!(raw !== '' && Number.isFinite(q) && q >= 1 && q <= 1000000)) { bad(t, `how many ${m.unit}s in one ${m.pack}: a whole number, like 12.`); return }
    good(t)
    m.how = 'count'
    m.value = q
    save(`M:${m.key}`, 'measure', { unit: m.unit, pack: m.pack, how: 'count', value: q, grams: m.grams ?? null }, final ? 0 : 900)
    if (final) {
      m.touched_at = m.touched_at || new Date().toISOString()
      const sug = box.querySelector('.b-eq .sug')
      if (sug) sug.remove()
      box.querySelector('.b-eq > span:last-of-type').textContent = plur(q, m.unit)
    }
    afterMeasure(m.key)
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
    const body = document.getElementById(`body-${r.id}`)
    if (body && body.innerHTML && final) body.innerHTML = bodyHtml(r)
    refreshCosts()
  }
}

function render() {
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

// ---------------------------------------------------------------- editing

function at(r, path) {
  if (path === 'ingredients' || path === 'takeaway') return r[path]
  const [, gi, oi] = path.split('.')
  return r.choices[+gi].options[+oi].lines
}
const fieldOf = (path) => path.split('.')[0]
const similar = (a, b) => {
  const w = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || [])
  const x = w(a)
  return [...w(b)].some((t) => x.has(t))
}

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

function onLineInput(r, lineEl, target, final) {
  const path = lineEl.dataset.path
  const l = at(r, path).find((x) => x.id === lineEl.dataset.id)
  if (!l) return
  if (target.classList.contains('l-name')) {
    const v = target.value.trim()
    if (!v) { bad(target, 'each ingredient needs a name.'); return }
    good(target)
    const batch = S.recipes.find((x) => x.kind === 'batch' && x.id !== r.id && x.name.toLowerCase() === v.toLowerCase())
    const item = S.itemByName.get(v.toLowerCase())
    if (batch) { l.batch = batch.id; l.item = null; l.price = null }
    else if (item) {
      l.item = item.id; l.batch = null
      if (!similar(l.name, v)) l.price = null
      // a new line takes the unit the kitchen counts it in (g, ml, each): one less thing to pick
      if (l.qty == null && UNITS.includes(item.unit)) { l.unit = item.unit; lineEl.querySelector('.l-unit').value = item.unit }
    }
    else if (!similar(l.name, v)) { l.item = null; l.batch = null; l.price = null }
    l.name = v
  } else if (target.classList.contains('l-qty')) {
    const q = target.value.trim().replace(',', '.')
    const unitShown = lineEl.querySelector('.l-unit').value
    if (q === '') l.qty = null
    else if (Number.isFinite(Number(q)) && Number(q) > 0) l.qty = Number(q)
    else { bad(target, 'the amount must be a number above nought, like 150 or 0.5.'); return }
    if (unitShown === 'piece') l.unit = 'piece' // she typed slices: the line now says slices
    delete l.sug; delete l.adj // her own number now, exactly
    good(target)
  } else if (target.classList.contains('l-unit')) {
    if (target.value === 'piece' && l.unit !== 'piece') {
      const p = piecesOf(l, S.measures.get(l.measure))
      const box = lineEl.querySelector('.l-qty')
      if (!p || !p.clean) { bad(box, `type how many ${S.measures.get(l.measure).unit}s.`); return }
      l.qty = p.n
      box.value = p.n
      good(box)
    }
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

// A line "only with" a choice that is removed: with an option gone, its lines go; with a whole group gone, the lines
// for its usual choice stay (as "always") and the rest go. The server refuses a line pointing at nothing.
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

// Ready-made choice groups (17/11/2026, to cut typing): copied from lines already on the page, so they carry prices
function presetNames() { return ['Bread', 'Sauce', 'Other'] }
function presetGroup(name) {
  const find = (pred) => { for (const r of S.recipes) for (const l of [...r.ingredients, ...r.choices.flatMap((g) => g.options.flatMap((o) => o.lines))]) if (pred(l)) return l; return null }
  const copy = (l, qty) => { const { sug, adj, when, ...rest } = l; return { ...rest, id: nid(), qty } }
  const opt = (name, lines, usual) => ({ id: nid(), name, usual, lines })
  if (name === 'Bread') {
    const sour = find((l) => l.measure === 'm-sourdough-loafbread' && l.unit === 'piece')
    const health = find((l) => l.measure === 'm-health-bread-loaf' && l.unit === 'piece')
    return { id: nid(), name: 'Bread', options: [opt('Sourdough', sour ? [copy(sour, 2)] : [], true), opt('Health', health ? [copy(health, 2)] : [], false)] }
  }
  if (name === 'Sauce') {
    const sauces = [['Ranch', /^ranch sauce$/i], ['Chipotle', /^chipotle a(i)?oli$/i], ['Buffalo', /^buffalo sauce$/i]]
    const options = sauces.map(([n, re], i) => {
      const b = S.recipes.find((r) => r.kind === 'batch' && re.test(r.name))
      return opt(n, b ? [{ id: nid(), name: b.name, qty: 30, unit: 'ml', item: null, batch: b.id, price: null, was: null, flag: null }] : [], i === 0)
    })
    return { id: nid(), name: 'Sauce', options }
  }
  return { id: nid(), name: 'New choice', options: [opt('Usual', [], true), opt('Other', [], false)] }
}

function wire() {
  const main = $('#main')
  main.addEventListener('toggle', (e) => {
    const d = e.target
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('more') || !d.open) return
    const r = S.byId.get(d.closest('.card').dataset.id)
    const body = d.querySelector('.body')
    if (r && !body.innerHTML) body.innerHTML = bodyHtml(r)
  }, true)

  main.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (!b || !S.canEdit) return
    const holder = b.closest('.card, .lo')
    const r = holder && S.byId.get(holder.dataset.id)
    const act = b.dataset.act
    if (!r) return
    if (act === 'need') {
      const v = b.dataset.v === 'true'
      r.needed = r.needed === v ? null : v
      for (const x of holder.querySelectorAll(':scope > .need .yn, :scope > .yn')) x.classList.toggle('on', r.needed !== null && x.dataset.v === String(r.needed))
      holder.classList.toggle('yes', r.needed === true)
      holder.classList.toggle('no', r.needed === false)
      updateProgress()
      save(r.id, 'needed', r.needed)
      return
    }
    if (act === 'kind') {
      if (r.kind === b.dataset.v) return
      r.kind = b.dataset.v
      save(r.id, 'kind', r.kind)
      holder.querySelector('.kind').textContent = r.kind === 'batch' ? 'Batch' : 'Sold'
      rerenderBody(r)
      return
    }
    if (act === 'add-line') {
      const path = b.dataset.path
      at(r, path).push({ id: nid(), name: 'New ingredient', qty: null, unit: 'g', item: null, batch: null, price: null, was: null, flag: null })
      rerenderBody(r)
      const rows = document.querySelectorAll(`#body-${CSS.escape(r.id)} .line[data-path="${path}"] .l-name`)
      const last = rows[rows.length - 1]
      if (last) { last.focus(); last.select() }
      save(r.id, fieldOf(path), r[fieldOf(path)])
      return
    }
    if (act === 'del-line') {
      const lineEl = b.closest('.line')
      const arr = at(r, lineEl.dataset.path)
      const i = arr.findIndex((x) => x.id === lineEl.dataset.id)
      if (i >= 0 && !confirm(`Remove ${arr[i].name}?`)) return
      if (i >= 0) arr.splice(i, 1)
      rerenderBody(r)
      save(r.id, fieldOf(lineEl.dataset.path), r[fieldOf(lineEl.dataset.path)])
      return
    }
    if (act === 'use-other') {
      const o = r.seed.other
      const size = r.kind === 'batch' && o.makes ? ` and its size (${fmtQty(o.makes.qty, o.makes.unit)})` : ''
      if (!confirm(`Replace the ingredients with the Odoo list${size}? You can change them after.`)) return
      r.ingredients = o.ingredients.map((l) => ({ ...l, id: nid() }))
      save(r.id, 'ingredients', r.ingredients)
      if (size) { r.makes = { ...o.makes }; save(r.id, 'makes', r.makes) }
      rerenderBody(r)
      return
    }
    const gEl = b.closest('.group')
    const g = gEl ? r.choices[+gEl.dataset.g] : null
    if (act === 'pack') {
      const key = b.closest('.pk').dataset.pack
      const p = S.packaging.find((x) => x.key === key)
      const i = r.takeaway.findIndex((l) => l.pack === key)
      if (i >= 0) r.takeaway.splice(i, 1)
      else r.takeaway.push({ id: nid(), name: p.name, qty: 1, unit: 'each', item: p.item, batch: null, price: p.price, was: null, flag: null, pack: key, ...(p.measure ? { measure: p.measure } : {}) })
      save(r.id, 'takeaway', r.takeaway)
      rerenderBody(r)
      return
    }
    if (act === 'preset') {
      const g = presetGroup(b.dataset.v)
      if (g) r.choices.push(g)
      save(r.id, 'choices', r.choices)
      rerenderBody(r)
      return
    }
    if (act === 'add-group') {
      // the usual ones are one tap: Bread or Sauce come filled in; "Other" is a blank group
      const menu = b.parentElement.querySelector('.presets')
      if (!menu) {
        b.insertAdjacentHTML('afterend', `<div class="presets">${presetNames().map((n) => `<button type="button" class="btn ghost" data-act="preset" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>`)
        return
      }
      menu.remove()
      return
    } else if (act === 'del-group' && g) {
      if (!confirm(`Remove the ${g.name} choices?`)) return
      r.choices.splice(+gEl.dataset.g, 1)
      forgetChoice(r, g, null)
    } else if (act === 'add-opt' && g) {
      g.options.push({ id: nid(), name: 'New choice', usual: false, lines: [] })
    } else if (act === 'del-opt' && g) {
      const oi = +b.closest('.opt').dataset.o
      const wasUsual = g.options[oi].usual
      const gone = g.options.splice(oi, 1)[0]
      forgetChoice(r, g, gone)
      if (wasUsual && g.options[0]) g.options[0].usual = true
    } else if (act === 'usual' && g) {
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
    const card = t.closest('.card')
    if (!card) return
    const r = S.byId.get(card.dataset.id)
    if (t.classList.contains('pk-qty')) {
      const l = r.takeaway.find((x) => x.pack === t.closest('.pk').dataset.pack)
      const q = Number(t.value.trim().replace(',', '.'))
      if (!(Number.isFinite(q) && q > 0)) { bad(t, 'how many must be a number above nought, like 1 or 2.'); return }
      good(t)
      l.qty = q
      delete l.sug
      refreshCosts()
      save(r.id, 'takeaway', r.takeaway, final ? 0 : 800)
      return
    }
    const lineEl = t.closest('.line')
    if (lineEl) return onLineInput(r, lineEl, t, final)
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
      const raw = $('.m-qty', body).value.trim().replace(',', '.')
      const q = Number(raw)
      const box = $('.m-qty', body)
      if (raw === '') r.makes = null
      else if (Number.isFinite(q) && q > 0) r.makes = { qty: q, unit: $('.m-unit', body).value }
      else { bad(box, 'how much it makes must be a number above nought, like 2 or 1.5.'); return }
      good(box)
      const top = document.querySelector(`.size[data-id="${CSS.escape(r.id)}"]`)
      if (top && final) { top.querySelector('.s-qty').value = r.makes ? r.makes.qty : ''; if (r.makes) top.querySelector('.s-unit').value = r.makes.unit }
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
  main.addEventListener('input', (e) => (e.target.closest('#measures, #sizes') ? onShared(e, false) : onEdit(e, false)))
  main.addEventListener('change', (e) => (e.target.closest('#measures, #sizes') ? onShared(e, true) : onEdit(e, true)))
  main.addEventListener('click', (e) => {
    const ch = e.target.closest('[data-act="m-change"]')
    if (ch) {
      const ed = ch.closest('.measure').querySelector('.m-edit')
      ed.hidden = !ed.hidden
      ch.textContent = ed.hidden ? 'Change' : 'Done'
      return
    }
    const a = e.target.closest('#measures [data-open], #sizes [data-open]')
    if (!a) return
    const card = document.getElementById(`r-${a.dataset.open}`)
    if (card) card.querySelector('details').open = true
  })

  $('#anythingElse').addEventListener('input', (e) => { if (S.canEdit) save(null, 'anything_else', e.target.value, 1000) })
  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]')
    if (!b) return
    S.show = b.dataset.show
    for (const x of document.querySelectorAll('#filter .chip')) x.classList.toggle('on', x === b)
    applyFilter()
  })
  $('#addBtn').addEventListener('click', async () => {
    const name = $('#addName').value.trim()
    if (!name) { $('#addName').focus(); return }
    status('saving', 'Adding...')
    let r
    try { r = await call({ action: 'add', name, category: $('#addCat').value }) } catch { r = { status: 0, body: {} } }
    if (r.status !== 200) { status('bad', `Not added: ${r.body.problem || 'please try again.'}`); return }
    const rec = { makes: null, ingredients: [], takeaway: [], choices: [], seed: {}, notes: '', ...r.body.recipe }
    S.recipes.push(rec)
    S.byId.set(rec.id, rec)
    $('#addName').value = ''
    const open = [...document.querySelectorAll('.card details.more[open]')].map((d) => d.closest('.card').dataset.id)
    render()
    for (const id of open) { const d = document.querySelector(`#r-${CSS.escape(id)} details.more`); if (d) d.open = true }
    status('ok', 'Added')
    const card = document.getElementById(`r-${rec.id}`)
    if (card) { card.querySelector('details').open = true; card.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  })
}

// ---------------------------------------------------------------- Tarryn's view: every change

const FIELD_WORDS = { measure: 'how we measure it', name: 'name', category: 'menu group', kind: 'type', makes: 'makes how much', needed: 'do we need it', notes: 'notes', ingredients: 'ingredients', takeaway: 'take-away extras', choices: 'choices', anything_else: 'anything else', added: 'added a recipe' }
function said(field, v) {
  if (v === null || v === undefined || v === '') return '<i>empty</i>'
  if (field === 'measure') {
    const what = v.how === 'share' ? `1 ${v.unit} = ${trimN(v.value)} of a ${v.pack}` : v.how === 'count' ? `1 ${v.pack} = ${trimN(v.value)} ${v.unit}s` : `${v.unit}, ${v.pack}, not set`
    return esc(`${what}${v.grams ? `, ${trimN(v.grams)} g each` : ''}`)
  }
  if (field === 'needed') return v ? 'Yes' : 'No'
  if (field === 'makes') return esc(fmtQty(v.qty, v.unit))
  if (field === 'kind') return v === 'batch' ? 'Batch' : 'Sold'
  return esc(typeof v === 'string' ? v : JSON.stringify(v))
}
const lineWords = (l) => `${l.unit === 'piece' && S.measures.get(l.measure) ? plural(l.qty, S.measures.get(l.measure).unit) : fmtQty(l.qty, l.unit) || 'no amount'} ${l.name}`
function listDiff(before, after) {
  const b = new Map((before || []).map((l) => [l.id, l]))
  const a = new Map((after || []).map((l) => [l.id, l]))
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
  const optName = (w) => { for (const g of cs || []) for (const o of g.options) if (g.id === w.g && o.id === w.o) return `${g.name} ${o.name}`; return 'a removed choice' }
  const lw = (l) => `${lineWords(l)}${l.when ? ` (only with ${optName(l.when)})` : ''}`
  return (cs || []).map((g) => `${g.name}: ${g.options.map((o) => `${o.usual ? '(usual) ' : ''}${o.name}${o.lines.length ? ` = ${o.lines.map(lw).join(', ')}` : ''}`).join(' / ')}`).join('; ')
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
      else what = `<p>${said(c.field, c.before)} <b>to</b> ${said(c.field, c.after)}</p>`
      return `<li><div class="c-top"><b>${esc(c.who)}</b> <span class="muted">${when(c.at)}</span></div>
        <div>${c.recipe ? `<a href="#r-${esc(c.recipe)}" data-open="${esc(c.recipe)}">${esc(c.name || c.recipe)}</a>, ` : c.measure ? `${esc(c.name || c.measure)}, ` : ''}${esc(FIELD_WORDS[c.field] || c.field)}</div>${what}</li>`
    }).join('')}</ol>`
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]')
    if (!a) return
    const card = document.getElementById(`r-${a.dataset.open}`)
    if (card) card.querySelector('details').open = true
  })
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
  S.packaging = d.packaging || []
  S.measures = new Map((d.measures || []).map((m) => [m.key, { ...m, value: m.value == null ? null : Number(m.value), grams: m.grams == null ? null : Number(m.grams) }]))
  const names = new Map()
  for (const i of [...d.items].sort((a, b) => Number(b.live) - Number(a.live) || Number(b.per != null) - Number(a.per != null))) {
    if (!names.has(i.name.toLowerCase())) names.set(i.name.toLowerCase(), i)
  }
  S.itemByName = names
  const batchNames = S.recipes.filter((x) => x.kind === 'batch' && !x.left_out).map((x) => x.name)
  $('#itemList').innerHTML = [...new Set([...batchNames, ...[...names.values()].map((i) => i.name)])].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}"></option>`).join('')
  $('#anythingElse').value = d.notes || ''
  if (!S.canEdit) {
    document.body.classList.add('view')
    $('#whoLine').textContent = 'Tarryn\'s view: every change Lindsay makes, newest first. This link can only look.'
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
