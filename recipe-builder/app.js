/*
 * Lindsay's recipe and menu page (21/11/2026). Plain browser code, no build. The rules (names, units, To pick, To check
 * and Done, the counts, the extras, what may be saved) are in recipebuilder.js, a copy of shared/recipebuilder.js made
 * at deploy, so the page and the server cannot disagree. The key is in the link after # (never sent to a web server's
 * log) and goes in the request body. The page holds no data: it all comes with the key.
 *
 * Spec: clients/wild-mongoo/badger/spec/2026-11-21-recipe-builder/02-spec.md (section 20 wins).
 * A pre-fill is To check until she confirms it. Blank is "not entered", never zero. Every change can be undone, and an
 * undo is a new change (history kept). A change waiting to save is kept in this browser until it does.
 */
import {
  SECTIONS, HEADINGS, MOVE_TO, sectionOf, sectionOfCat, normName, wordsOf, toItemQty, unitWord, parseAmount, readBack,
  lineState, cardStatus, progress, extrasFor, allCorrect, layout, strays, loopReason, fieldValue, setField,
} from './recipebuilder.js'

const API = 'https://nptyrtjdvqglgwkaepce.supabase.co/functions/v1/badger-recipebuilder'
const key = new URLSearchParams(location.hash.slice(1)).get('k') || ''
const PENDING = 'badger-recipebuilder-pending'
const LATELY = 'badger-recipebuilder-lately'
const POLL_MS = 25000

let D = null
const S = { canEdit: false, who: '', open: new Set(), q: '', need: false, P: null, undo: null, undoTimer: 0, ask: new Map() }
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const hhmm = (t = new Date()) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
const num = (n) => (n === null || n === undefined ? '' : String(Number(n)))
const ro = () => (S.canEdit ? '' : ' disabled')
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const TBL = { recipes: 'recipes', lines: 'lines', cards: 'cards', rules: 'rules', extras: 'extras' }
let IX = {}
function reindex() {
  IX = {
    recipes: new Map(D.recipes.map((r) => [r.id, r])), lines: new Map(D.lines.map((r) => [r.id, r])), cards: new Map(D.cards.map((r) => [r.id, r])),
    rules: new Map(D.rules.map((r) => [r.id, r])), extras: new Map(D.extras.map((r) => [r.id, r])), stock: new Map(D.stock.map((k) => [k.id, k])),
  }
}
const rowOf = (tbl, id) => IX[tbl] && IX[tbl].get(id)
const itemName = (id) => (IX.stock.get(id) || {}).name || 'an item no longer in stock'
const cardName = (c) => c.name || c.menu_name
const targetOf = (l) => (l.batch_id ? { ...(IX.recipes.get(l.batch_id) || {}), kind: 'batch' } : l.item_id ? IX.stock.get(l.item_id) : null)

// ---------------------------------------------------------------- talking to the server

async function call(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, key }) })
  let j = {}
  try { j = await r.json() } catch { /* nothing to read */ }
  return { status: r.status, body: j }
}
const queue = new Map() // `${tbl}|${id}|${field}` -> { tbl, id, field, v, base }
let busy = false
function lsWrite() { try { if (queue.size) localStorage.setItem(PENDING, JSON.stringify([...queue.values()])); else localStorage.removeItem(PENDING) } catch { /* private browsing */ } }
function status(kind, text) { const el = $('#status'); el.className = `status ${kind}`; el.textContent = text }

/** One action she takes: every field it changes, saved together, undone together. */
function act(changes, { undoable = true, label = '' } = {}) {
  if (!S.canEdit || !changes.length) return
  const before = progress(D).cards
  const back = []
  for (const c of changes) {
    const row = rowOf(TBL[c.tbl], c.id)
    if (!row) continue
    const old = fieldValue(c.tbl, row, c.field)
    if (same(old, c.value)) continue
    back.unshift({ tbl: c.tbl, id: c.id, field: c.field, value: old })
    setField(c.tbl, row, c.field, c.value)
    const k = `${c.tbl}|${c.id}|${c.field}`
    const q = queue.get(k)
    const base = q ? q.base : old
    if (same(base, c.value)) queue.delete(k)
    else queue.set(k, { tbl: c.tbl, id: c.id, field: c.field, v: c.value, base })
  }
  if (!back.length) return
  lsWrite()
  if (undoable) showUndo(back, label)
  status('saving', 'Saving...')
  redraw(before)
  setTimeout(flush, 300)
}
async function flush() {
  if (busy || !queue.size) return
  busy = true
  const batch = [...queue.values()].slice(0, 250)
  try {
    let r
    try { r = await call({ action: 'many', saves: batch.map((e) => ({ tbl: e.tbl, id: e.id, field: e.field, value: e.v, base: e.base })) }) } catch { r = { status: 0, body: {} } }
    if (r.status === 0 || r.status >= 500) {
      status('bad', 'Not saved: no connection. We will try again.')
      busy = false
      setTimeout(flush, 4000)
      return
    }
    if (r.status !== 200) { status('bad', `Not saved: ${r.body.problem || 'please refresh the page.'}`); for (const e of batch) queue.delete(`${e.tbl}|${e.id}|${e.field}`); lsWrite(); return }
    let note = ''
    for (const res of r.body.results || []) {
      const k = `${res.tbl}|${res.id}|${res.field}`
      const sent = batch.find((e) => `${e.tbl}|${e.id}|${e.field}` === k)
      const now = queue.get(k)
      if (now && sent && same(now.v, sent.v)) queue.delete(k)
      else if (now && res.ok) now.base = sent.v
      if (res.ok) continue
      if (res.stale) {
        const row = rowOf(TBL[res.tbl], res.id)
        if (row) setField(res.tbl, row, res.field, res.current)
        queue.delete(k)
        note = 'Changed on another screen. It shows what was saved there.'
      } else note = `Not saved: ${res.problem || 'please try again.'}`
    }
    lsWrite()
    if (note) { status(/^Not/.test(note) ? 'bad' : 'note', note); redraw() } else if (!queue.size) status('ok', `Saved ${hhmm()}`)
  } finally { busy = false }
  if (queue.size) setTimeout(flush, 50)
}
addEventListener('beforeunload', (e) => { if (queue.size || busy) { e.preventDefault(); e.returnValue = '' } })
addEventListener('online', () => flush())

async function addRow(tbl, row, extraUndo = []) {
  if (!S.canEdit) return null
  status('saving', 'Saving...')
  let r
  try { r = await call({ action: 'add', tbl, row }) } catch { r = { status: 0, body: {} } }
  if (r.status !== 200) { status('bad', `Not saved: ${r.body.problem || 'no connection. Please try again.'}`); return null }
  const saved = r.body.row
  D[tbl === 'rules' ? 'rules' : tbl].push(saved)
  reindex()
  status('ok', `Saved ${hhmm()}`)
  return saved
}

function showUndo(back, label) {
  S.undo = back
  const b = $('#undoBtn')
  b.hidden = false
  b.textContent = label ? `Undo ${label}` : 'Undo'
  clearTimeout(S.undoTimer)
  S.undoTimer = setTimeout(() => { b.hidden = true; S.undo = null }, 8000)
}

// ---------------------------------------------------------------- words

const SOURCE = { mine: 'Your recipe, as you checked it', sue: 'Sue\'s recipe (19/11)', revised: 'Sue\'s revised recipe (20/11)', new: 'New from Sue (19/11)' }
const SERVE = { both: 'Eat in and take-away', eat_in: 'Eat in only', take_away: 'Take-away only' }
const UNIT_SAY = { piece: 'piece', slice: 'slice', portion: 'portion', each: '', part: 'part of', g: 'g', kg: 'kg', ml: 'ml', L: 'L' }
const srcText = (l) => (l.added && !l.src_name ? 'Your own line' : [num(l.src_qty), l.src_unit ? UNIT_SAY[l.src_unit] ?? l.src_unit : '', l.src_name].filter(Boolean).join(' '))
const MAKES = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], L: ['ml', 1000], each: ['each', 1], portions: ['each', 1] }
const showBase = (base, word) => (base === null || base === undefined ? '' : String(Math.round((Number(base) / (MAKES[word] || ['', 1])[1]) * 1000) / 1000))
function pickText(l) {
  if (l.not_counted) return 'Not from stock (like tap water)'
  if (l.not_in_stock) return 'Not in our stock yet'
  if (l.batch_id) return `${(IX.recipes.get(l.batch_id) || {}).name || 'a batch'} (batch)`
  if (l.item_id) return itemName(l.item_id)
  return ''
}
const sectionWord = (k) => SECTIONS.find((s) => s.key === k)

// ---------------------------------------------------------------- one line

function tagHtml(state, l, act1) {
  if (state === 'check') return `<span class="tag">We picked this${S.canEdit ? ` <button type="button" class="lnk" data-act="${act1}">Yes, that's right</button>` : ''}</span>`
  if (l.prefill_rule && l.confirmed) return '<span class="tag ok">Checked</span>'
  return ''
}
function lineHtml(l, rec) {
  const st = lineState(l)
  if (l.removed) {
    return `<div class="ln gone" id="ln-${esc(l.id)}" data-line="${esc(l.id)}"><div class="l-src">${esc(srcText(l))}</div>
      <div class="l-pick"><span class="grey">Removed</span>${S.canEdit ? '<button type="button" class="lnk" data-act="line-back">Put it back</button>' : ''}</div></div>`
  }
  const t = targetOf(l)
  const pt = pickText(l)
  const who = rec && ['sue', 'revised', 'new'].includes(rec.source_tag) ? 'Sue wrote' : 'Was'
  const was = l.src_was && normName(l.src_was) !== normName(`${num(l.src_qty)}${l.src_unit || ''}`) ? `<small class="l-was">${who}: ${esc(l.src_was)}</small>` : ''
  const needQty = (l.item_id || l.batch_id) && (l.qty === null || l.qty === undefined)
  const q = S.ask.get(`lines|${l.id}`)
  return `<div class="ln" id="ln-${esc(l.id)}" data-line="${esc(l.id)}">
    <div class="l-src">${esc(srcText(l))}${was}</div>
    <div class="l-pick">
      <button type="button" class="pk${pt ? '' : ' blank'}" data-act="pick-line" aria-label="From our stock for ${esc(srcText(l))}"${ro()}>${esc(pt || 'Type to find...')}</button>
      ${l.item_id || l.batch_id ? `<span class="qx">x</span><input class="qty" type="text" inputmode="decimal" enterkeyhint="next" data-qty="lines" value="${esc(q ? q.text : num(l.qty))}" aria-label="Amount" autocomplete="off"${ro()}><span class="uw">${esc(unitWord(t, Number(l.qty ?? 2)))}</span>` : ''}
      ${tagHtml(st, l, 'ok-line')}
      ${S.canEdit ? '<button type="button" class="lnk" data-act="line-remove" aria-label="Remove this line">Remove</button>' : ''}
      <div class="rb" aria-live="polite">${q ? '' : ''}</div>
      ${q ? askHtml(q) : ''}
      ${needQty ? `<span class="amt">Amount? <span class="grey">Recipe says ${esc(srcText(l))}${t ? `: enter the ${esc(unitWord(t, 2))}` : ''}</span></span>` : ''}
    </div></div>`
}
const askHtml = (q) => `<div class="ask">Did you mean ${q.ask.map((n) => `<button type="button" class="btn sm ghost" data-act="ask" data-v="${n}">${n}</button>`).join(' or ')}?</div>`

function recipeBody(rid, { cardId = null } = {}) {
  const r = IX.recipes.get(rid)
  if (!r) return ''
  const ls = D.lines.filter((l) => l.recipe_id === rid).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const plain = ls.filter((l) => l.place !== 'option')
  const gs = D.groups.filter((g) => g.recipe_id === rid).sort((a, b) => a.sort - b.sort)
  const also = D.cards.filter((c) => !c.removed && c.recipe_id === rid && c.id !== cardId).map((c) => cardName(c.parent_id ? IX.cards.get(c.parent_id) || c : c))
  let h = `<p class="src">${esc(SOURCE[r.source_tag] || 'Written here')}${also.length ? `. Also on: ${esc([...new Set(also)].join(', '))}` : ''}</p>`
  h += `<div class="lines" data-recipe="${esc(rid)}">${plain.map((l) => lineHtml(l, r)).join('')}`
  for (const g of gs) {
    for (const o of D.options.filter((x) => x.group_id === g.id).sort((a, b) => a.sort - b.sort)) {
      h += `<p class="opt">${esc(g.name)}: ${esc(o.name)}${o.usual ? ' (usual)' : ''}</p>`
      h += ls.filter((l) => l.option_id === o.id).map((l) => lineHtml(l, r)).join('') || '<p class="grey">Nothing extra for this one.</p>'
    }
  }
  h += '</div>'
  if (S.canEdit) h += `<button type="button" class="lnk" data-act="line-add" data-recipe="${esc(rid)}">+ Add a line</button>`
  return h
}

// ---------------------------------------------------------------- a card

function headHtml(x, st) {
  if (x.id.startsWith('r-')) {
    const r = IX.recipes.get(x.id)
    const sub = r.kind === 'batch' ? (r.makes_qty ? `Makes ${showBase(r.makes_qty, r.makes_word)} ${r.makes_word || r.makes_unit}` : 'Batch') : 'Not on the menu yet'
    return headWrap(x.id, r.name, sub, st)
  }
  const c = IX.cards.get(x.id)
  const kids = D.cards.filter((k) => k.parent_id === c.id && !k.removed)
  const made = c.combo ? 'A combo' : c.made_from === 'recipe' ? (c.recipe_id ? `Recipe: ${(IX.recipes.get(c.recipe_id) || {}).name || ''}` : kids.length ? 'Its recipes, by flavour' : 'Recipe not chosen') :
    c.made_from === 'as_is' ? 'Sold as it is' : 'Not chosen yet'
  const sub = `${HEADINGS[c.heading_id] || 'No category yet'}. ${made}`
  return headWrap(c.id, cardName(c), sub, st) + quickHtml(c, st)
}
function headWrap(id, name, sub, st) {
  const cls = st.done ? (st.off ? 'st grey' : 'st ok') : 'st'
  return `<button type="button" class="c-head" data-act="toggle" aria-expanded="${S.open.has(id)}" aria-controls="b-${esc(id)}">
    <span class="c-title"><span class="c-name">${esc(name)}</span><span class="c-sub">${esc(sub)}</span></span>
    <span class="${cls}">${esc(st.label)}</span></button>`
}
/** Quick rows (spec 20.13): a sold-as-it-is card whose only open items are its picks, confirmed without opening it. */
function quickHtml(c, st) {
  if (S.open.has(c.id) || st.done || c.made_from !== 'as_is' || c.on_menu === false) return ''
  const kids = D.cards.filter((k) => k.parent_id === c.id && !k.removed && k.on_menu !== false)
  const ex = extrasFor(c, D).filter((e) => !e.skipped && e.state !== 'done')
  if (ex.length) return ''
  const rows = kids.length ? kids : [c]
  if (rows.some((k) => k.item_id && (k.item_qty === null || k.item_qty === undefined))) return ''
  return rows.map((k) => {
    const check = k.prefill_rule && !k.confirmed && k.item_id === k.prefill_item_id && k.item_id
    const isDone = k.item_id && !check
    return `<div class="quick" data-card="${esc(k.id)}"><span class="q-pick">${k.flavour ? `${esc(k.flavour)} . ` : ''}${k.item_id ? `${esc(itemName(k.item_id))} x ${num(k.item_qty ?? 1)}` : '<span class="grey">not picked</span>'}
      ${check ? ' . <span class="tag">We picked this</span>' : isDone ? ' . <span class="tag ok">Done</span>' : ''}</span>
      ${S.canEdit && check ? '<button type="button" class="btn sm pink" data-act="q-ok">Correct</button>' : ''}
      ${S.canEdit ? `<button type="button" class="btn sm ghost" data-act="pick-asis">${k.item_id ? 'Change' : 'Pick'}</button>` : ''}</div>`
  }).join('')
}

function factsHtml(c) {
  const moved = !c.added && c.heading_id !== c.live_heading_id
  return `<div class="facts">
    <div class="fact"><span class="lbl">Name</span><b>${esc(cardName(c))}</b>${S.canEdit ? '<button type="button" class="lnk" data-act="rename">Rename</button>' : ''}
      ${c.name && !c.added ? `<span class="grey">On the menu now as: ${esc(c.menu_name)}</span>` : ''}</div>
    <div class="rn panel" hidden></div>
    <div class="fact"><span class="lbl">Category</span>${esc(HEADINGS[c.heading_id] || 'No category yet')}${S.canEdit ? '<button type="button" class="lnk" data-act="move">Move</button>' : ''}
      ${moved ? `<span class="grey">Moved from ${esc(HEADINGS[c.live_heading_id] || 'No category yet')}</span>` : ''}</div>
    <label class="switch"><input type="checkbox" data-act="onmenu"${c.on_menu !== false ? ' checked' : ''}${ro()}> On the menu</label>
  </div>`
}
function madeHtml(c) {
  return `<div class="made" role="group" aria-label="What it is made from">
    <button type="button" class="mf${c.made_from === 'recipe' ? ' on' : ''}" data-act="made-recipe" aria-pressed="${c.made_from === 'recipe'}"${ro()}>Made from a recipe</button>
    <button type="button" class="mf${c.made_from === 'as_is' ? ' on' : ''}" data-act="made-asis" aria-pressed="${c.made_from === 'as_is'}"${ro()}>Sold as it is<small>Like a can of Coke: one stock item.</small></button>
  </div>`
}
function recipeSelect(c, kid = null) {
  const cur = (kid || c).recipe_id || ''
  const sold = D.recipes.filter((r) => r.kind === 'sold' && !r.removed).sort((a, b) => a.name.localeCompare(b.name))
  return `<select data-act="choose-recipe" data-card="${esc((kid || c).id)}" aria-label="Which recipe"${ro()}>
    <option value=""${cur ? '' : ' selected'}>Choose the recipe...</option>
    ${sold.map((r) => `<option value="${esc(r.id)}"${r.id === cur ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
    <option value="__new">Write a new recipe for it</option></select>`
}
function asIsLine(c, k) {
  const check = k.prefill_rule && !k.confirmed && k.item_id && k.item_id === k.prefill_item_id
  const t = k.item_id ? IX.stock.get(k.item_id) : null
  return `<div class="ln" data-card="${esc(k.id)}"><div class="l-src">${esc(k.flavour ? `${cardName(c)} (${k.flavour})` : cardName(c))}</div>
    <div class="l-pick"><button type="button" class="pk${k.item_id ? '' : ' blank'}" data-act="pick-asis"${ro()}>${esc(k.item_id ? itemName(k.item_id) : 'Type to find...')}</button>
      ${k.item_id ? `<span class="qx">x</span><input class="qty" type="text" inputmode="decimal" data-qty="cards" value="${esc(num(k.item_qty))}" aria-label="How many" autocomplete="off"${ro()}><span class="uw">${esc(unitWord(t, Number(k.item_qty ?? 1)))}</span>` : ''}
      ${check ? `<span class="tag">We picked this${S.canEdit ? ' <button type="button" class="lnk" data-act="q-ok">Yes, that\'s right</button>' : ''}</span>` : ''}</div></div>`
}
function flavourBlock(c, k) {
  if (k.on_menu === false) {
    return `<div class="ln gone" data-card="${esc(k.id)}"><div class="l-src">${esc(cardName(c))} (${esc(k.flavour)})</div><div class="l-pick"><span class="grey">Not sold any more</span>
      ${S.canEdit ? '<button type="button" class="lnk" data-act="flavour-back">Undo</button>' : ''}</div></div>`
  }
  if (c.made_from === 'as_is') return asIsLine(c, k)
  const check = k.prefill_rule && !k.confirmed && k.recipe_id && k.recipe_id === k.prefill_recipe_id
  return `<div class="flav" data-card="${esc(k.id)}"><p class="h3">${esc(k.flavour)}</p>
    <div class="row">${recipeSelect(c, k)}${check ? `<span class="tag">We picked this${S.canEdit ? ' <button type="button" class="lnk" data-act="q-ok">Yes, that\'s right</button>' : ''}</span>` : ''}
    ${S.canEdit ? '<button type="button" class="lnk" data-act="flavour-drop">We don\'t sell this one</button>' : ''}</div>
    ${k.recipe_id ? recipeBody(k.recipe_id, { cardId: k.id }) : ''}</div>`
}
function extrasHtml(c) {
  const xs = extrasFor(c, D)
  const rows = xs.map((e) => {
    const lbl = e.label ? `<span class="grey">for ${esc(e.label)}</span>` : ''
    if (e.skipped) return `<div class="ex"><span class="ex-t grey">Left off: ${esc(e.slot ? 'Packaging' : itemName(e.item_id))} ${lbl}</span>${S.canEdit ? `<button type="button" class="lnk" data-act="unskip" data-rule="${esc(e.rule_id)}">Put back</button>` : ''}</div>`
    if (e.from === 'rule' && !e.slot) return `<div class="ex"><span class="ex-t">${num(e.qty)} ${esc(itemName(e.item_id))}. ${esc(SERVE[e.serve])} ${lbl}</span>${S.canEdit ? `<button type="button" class="lnk" data-act="skip" data-rule="${esc(e.rule_id)}">Leave off</button>` : ''}</div>`
    if (e.from === 'rule' && e.slot) {
      return `<div class="ex"><span class="ex-t">Packaging. ${esc(SERVE[e.serve])} ${lbl}</span>
        <button type="button" class="pk blank" data-act="pick-slot" data-rule="${esc(e.rule_id)}"${ro()}>Pick the packaging...</button>
        ${S.canEdit ? `<button type="button" class="lnk" data-act="skip" data-rule="${esc(e.rule_id)}">Leave off</button>` : ''}</div>`
    }
    const x = IX.extras.get(e.extra_id)
    const check = e.state === 'check'
    return `<div class="ex" data-extra="${esc(e.extra_id)}"><span class="ex-t">${e.slot ? '<b>Packaging</b> ' : ''}</span>
      <button type="button" class="pk${e.item_id ? '' : ' blank'}" data-act="pick-extra"${ro()}>${esc(e.item_id ? itemName(e.item_id) : 'Type to find...')}</button>
      <span class="qx">x</span><input class="qty" type="text" inputmode="decimal" data-qty="extras" value="${esc(num(e.qty))}" aria-label="How many" autocomplete="off"${ro()}>
      <select class="serve" data-act="serve" aria-label="When"${ro()}>${Object.entries(SERVE).map(([k, w]) => `<option value="${k}"${x && x.serve === k ? ' selected' : ''}>${w}</option>`).join('')}</select>
      ${check ? `<span class="tag">We picked this${S.canEdit ? ' <button type="button" class="lnk" data-act="ok-extra">Yes, that\'s right</button>' : ''}</span>` : ''}
      ${S.canEdit ? '<button type="button" class="lnk" data-act="extra-remove">Remove</button>' : ''}</div>`
  }).join('')
  return `<p class="h3">Goes out with it</p><div class="extras">${rows || '<p class="grey">Nothing yet.</p>'}</div>
    ${S.canEdit ? '<button type="button" class="lnk" data-act="extra-add">+ Add an extra</button>' : ''}`
}
function footHtml(id) {
  const n = S.canEdit ? allCorrect(id, D).length : 0
  return `<div class="foot-acts">${n ? `<button type="button" class="btn pink" data-act="all-correct">All correct: ${n} we picked</button>` : ''}
    <button type="button" class="btn ghost" data-act="next">Next that needs you</button></div>`
}
function bodyHtml(id) {
  if (id.startsWith('r-')) {
    const r = IX.recipes.get(id)
    if (r.kind === 'batch') {
      const word = r.makes_word || r.makes_unit || 'g'
      return `<div class="facts"><div class="fact"><span class="lbl">Name</span><b>${esc(r.name)}</b>${S.canEdit ? '<button type="button" class="lnk" data-act="rename">Rename</button>' : ''}</div><div class="rn panel" hidden></div></div>
        ${r.not_made_yet && !r.we_make_this ? `<div class="ask">Sue says this is not made yet.${S.canEdit ? ' <button type="button" class="btn sm" data-act="we-make">We make this</button>' : ''}</div>` : ''}
        <div class="batchf">
          <div class="row"><label for="mk-${esc(id)}">One batch makes</label><input id="mk-${esc(id)}" class="qty" type="text" inputmode="decimal" data-batch="makes" value="${esc(showBase(r.makes_qty, word))}" autocomplete="off"${ro()}>
            <select data-act="makes-word" aria-label="Unit"${ro()}>${Object.keys(MAKES).map((w) => `<option${w === word ? ' selected' : ''}>${w}</option>`).join('')}</select>
            ${r.makes_qty ? '' : '<span class="need">How much does one batch make?</span>'}</div>
          <div class="row"><label for="ma-${esc(id)}">Make more when it gets to</label><input id="ma-${esc(id)}" class="qty" type="text" inputmode="decimal" data-batch="make_at" value="${esc(showBase(r.make_at_base, word))}" autocomplete="off"${ro()}>
            <span class="uw">${esc(word)}</span><span class="grey">(you can fill this in later)</span></div>
        </div>
        ${recipeBody(id)}
        <p class="h3">Notes</p><textarea data-act="notes" maxlength="2000" aria-label="Notes"${ro()}>${esc(r.notes)}</textarea>
        ${footHtml(id)}`
    }
    const acts = S.canEdit && !r.left_out ? `<div class="row">
      <button type="button" class="btn sm ghost" data-act="stray-menuas">It is on the menu as...</button>
      <button type="button" class="btn sm ghost" data-act="stray-add">Add it to the menu</button>
      <button type="button" class="btn sm ghost" data-act="stray-batch">It is a batch</button>
      <button type="button" class="btn sm ghost" data-act="stray-drop">We don't make this</button></div>` : r.left_out ? `<div class="row"><span class="grey">We don't make this.</span>${S.canEdit ? '<button type="button" class="lnk" data-act="stray-back">Undo</button>' : ''}</div>` : ''
    return `${r.not_made_yet && !r.we_make_this ? `<div class="ask">Sue says this is not made yet.${S.canEdit ? ' <button type="button" class="btn sm" data-act="we-make">We make this</button>' : ''}</div>` : ''}
      <p class="h3">Where does this go?</p>${acts}${recipeBody(id)}${footHtml(id)}`
  }
  const c = IX.cards.get(id)
  if (c.combo) return `${factsHtml(c)}<p>A combo: made of its parts. Nothing to link.</p>${footHtml(id)}`
  if (c.on_menu === false) return `${factsHtml(c)}<p class="grey">Not on the menu. Switch it back on to link it.</p>`
  const kids = D.cards.filter((k) => k.parent_id === c.id && !k.removed)
  let h = factsHtml(c) + '<p class="h3">What is it made from?</p>' + madeHtml(c)
  const madeCheck = c.prefill_rule && !c.confirmed && c.made_from && c.prefill_made_from === c.made_from && !kids.length && (c.recipe_id ?? null) === (c.prefill_recipe_id ?? null) && (c.item_id ?? null) === (c.prefill_item_id ?? null)
  if (c.made_from === 'recipe') {
    if (kids.length) h += kids.map((k) => flavourBlock(c, k)).join('')
    else {
      h += `<div class="row">${recipeSelect(c)}${madeCheck ? `<span class="tag">We picked this${S.canEdit ? ' <button type="button" class="lnk" data-act="ok-card">Yes, that\'s right</button>' : ''}</span>` : ''}</div>`
      if (c.recipe_id) h += recipeBody(c.recipe_id, { cardId: c.id })
    }
  } else if (c.made_from === 'as_is') {
    h += kids.length ? kids.map((k) => flavourBlock(c, k)).join('') : asIsLine(c, c)
  }
  if (c.made_from) h += extrasHtml(c)
  return h + footHtml(id)
}

// ---------------------------------------------------------------- the page

let P = null // progress, recomputed after every change
function sectionHtml(s) {
  const lay = layout(D).filter((x) => x.section === s.key)
  const sp = P.sections[s.key]
  const groupsOrder = s.key === 'batches' ? ['Bakes', 'Made ahead'] : [...s.headings.map(String), ...(s.key === 'meals' ? ['none'] : []), 'stray']
  const name = (g) => (g === 'none' ? 'No category yet' : g === 'stray' ? 'Not on the menu yet?' : HEADINGS[g] || g)
  let h = `<section class="sec" id="s-${s.key}" data-sec="${s.key}"><div class="sec-head"><h2>${esc(s.title)}</h2><p class="sec-prog" id="sp-${s.key}"></p></div>${rulesHtml(s)}`
  for (const g of groupsOrder) {
    const xs = lay.filter((x) => x.group === g)
    if (!xs.length) continue
    h += `<details class="grp" data-grp="${esc(`${s.key}|${g}`)}" open><summary><span class="g-name">${esc(name(g))}</span><span class="g-prog"></span></summary>
      ${s.key === 'meals' && HEADINGS[g] && S.canEdit ? '' : ''}
      ${xs.map((x) => `<article class="card" id="card-${esc(x.id)}" data-id="${esc(x.id)}"></article>`).join('')}
      ${s.key !== 'batches' && g !== 'stray' && g !== 'none' && S.canEdit ? `<button type="button" class="lnk" data-act="menu-add" data-heading="${esc(g)}">+ Add a menu item</button>` : ''}</details>`
  }
  const nm = lay.filter((x) => x.group === 'notmade')
  if (nm.length) {
    h += `<details class="grp" data-grp="${esc(`${s.key}|notmade`)}"><summary><span class="g-name">Sue says these are not made yet</span><span class="g-prog">${nm.length}</span></summary>
      ${nm.map((x) => `<article class="card" id="card-${esc(x.id)}" data-id="${esc(x.id)}"></article>`).join('')}</details>`
  }
  return `${h}</section>`
}
function rulesHtml(s) {
  if (s.key === 'batches') return ''
  const rs = D.rules.filter((r) => r.section === s.key || (s.key === 'cold' && r.section === 'shakes')).sort((a, b) => a.sort - b.sort)
  if (!rs.length) return ''
  const by = new Map()
  for (const r of rs) { const k = r.section + '|' + r.label; if (!by.has(k)) by.set(k, []); by.get(k).push(r) }
  const n = layout(D).filter((x) => x.section === s.key && x.kind === 'card' && !(IX.cards.get(x.id) || {}).combo).length
  const rows = [...by.values()].map((g) => {
    const on = g.filter((r) => r.active)
    const what = g.map((r) => (r.slot ? 'a packaging type (take-away)' : `${num(r.qty)} ${itemName(r.item_id)}`)).join(', ')
    const ids = g.map((r) => r.id).join(',')
    const word = g[0].section === 'shakes' ? 'shake, wherever it sits on the menu,' : `${(sectionWord(s.key) || {}).word}`
    if (!on.length) return `<div class="rule"><span class="off">Left off for every ${esc(word)}: ${esc(what)}.</span>${S.canEdit ? `<button type="button" class="lnk" data-act="rule-on" data-rules="${esc(ids)}">Put back</button>` : ''}</div>`
    const plural = g[0].section === 'shakes' ? 'shakes' : `${n} ${(sectionWord(s.key) || {}).word}s`
    return `<div class="rule"><span>Every ${esc(word)} gets: <b>${esc(what)}</b>.</span>${S.canEdit ? `<button type="button" class="lnk" data-act="rule-ask" data-rules="${esc(ids)}" data-n="${esc(plural)}">Leave off for all</button>` : ''}</div>`
  }).join('')
  return `<div class="rules">${rows}</div>`
}

function drawCard(id) {
  const el = document.getElementById(`card-${id}`)
  if (!el) return
  const st = P.cards[id] || cardStatus(id, D)
  const open = S.open.has(id)
  const r = id.startsWith('r-') ? IX.recipes.get(id) : null
  const c = !r ? IX.cards.get(id) : null
  el.className = `card${st.done ? ' done' : ''}${(c && c.on_menu === false) || (r && r.left_out) ? ' off' : ''}`
  el.innerHTML = headHtml({ id }, st) + (open ? `<div class="c-body" id="b-${esc(id)}">${bodyHtml(id)}</div>` : '')
}
function drawCounts() {
  const t = P.total
  $('#totalText').textContent = `${t.done} of ${t.total} done`
  $('#fill').style.width = `${t.total ? Math.round((t.done / t.total) * 100) : 0}%`
  $('#total').hidden = false
  $('#chips').innerHTML = SECTIONS.map((s) => `<button type="button" class="chip" data-jump="${s.key}">${esc(s.title)} <span class="n">${P.sections[s.key].done}/${P.sections[s.key].total}</span></button>`).join('')
  markChip()
  for (const s of SECTIONS) {
    const sp = P.sections[s.key]
    const parts = [`${sp.done} of ${sp.total} done.`]
    const w = []
    if (sp.pick) w.push(`${sp.pick} to pick`)
    if (sp.check) w.push(`${sp.check} to check`)
    if (w.length) parts.push(`${w.join(', ')}.`)
    if (sp.notInStock) parts.push(`${sp.notInStock} not in our stock yet.`)
    if (s.key === 'batches') parts.push(`Make-more set on ${sp.makeAtSet} of ${sp.batches}.`)
    const el = $(`#sp-${s.key}`)
    if (el) el.textContent = parts.join(' ')
    for (const [g, v] of Object.entries(sp.groups)) {
      const d = $(`[data-grp="${CSS.escape(`${s.key}|${g}`)}"] .g-prog`)
      if (d && g !== 'notmade') d.textContent = `${v.done} of ${v.total} done`
    }
  }
}
function markChip() {
  const top = $('#bar').getBoundingClientRect().height + 20
  let cur = SECTIONS[0].key
  for (const s of SECTIONS) { const el = $(`#s-${s.key}`); if (el && el.getBoundingClientRect().top <= top) cur = s.key }
  for (const b of $$('#chips .chip')) b.classList.toggle('on', b.dataset.jump === cur)
}
/** After any change: counts, every card's head, the open cards' bodies; then the loop (spec 20.3). */
let shape = ''
/** The page's structure: which card sits in which group, and the section rules. When it changes, the list is drawn again. */
const shapeOf = () => JSON.stringify([layout(D).map((x) => `${x.id}:${x.group}`), D.rules.map((r) => r.active)])
function redraw(before = null) {
  reindex()
  P = progress(D)
  if (shapeOf() !== shape) { const y = scrollY; renderAll(); scrollTo(0, y); afterDone(before); return }
  const focusId = document.activeElement && document.activeElement.closest && document.activeElement.closest('.card') && document.activeElement.closest('.card').dataset.id
  for (const el of $$('.card')) {
    if (!(el.dataset.id in P.cards)) { renderAll(); return }
    if (el.dataset.id === focusId && document.activeElement.matches('input, textarea, select')) { refreshHead(el.dataset.id); continue }
    drawCard(el.dataset.id)
  }
  drawCounts()
  applyFilter()
  afterDone(before)
}
function afterDone(before) {
  if (before && S.canEdit) {
    const justDone = [...S.open].find((id) => before[id] && !before[id].done && P.cards[id] && P.cards[id].done)
    if (justDone) setTimeout(() => goNext(justDone), 1000)
  }
}
function refreshHead(id) {
  const el = document.getElementById(`card-${id}`)
  const head = el && el.querySelector(':scope > .c-head')
  if (!head) return
  const tmp = document.createElement('div')
  tmp.innerHTML = headHtml({ id }, P.cards[id])
  head.replaceWith(tmp.firstElementChild)
}
function renderAll() {
  reindex()
  P = progress(D)
  shape = shapeOf()
  $('#list').innerHTML = SECTIONS.map(sectionHtml).join('')
  for (const el of $$('.card')) drawCard(el.dataset.id)
  drawCounts()
  applyFilter()
}
const needsOrder = () => layout(D).filter((x) => x.group !== 'notmade' && P.cards[x.id] && !P.cards[x.id].done).map((x) => x.id)
function openCard(id, scroll = true) {
  S.open.add(id)
  const el = document.getElementById(`card-${id}`)
  if (!el) return
  for (let d = el.closest('details'); d; d = d.parentElement.closest('details')) d.open = true
  el.hidden = false
  drawCard(id)
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function goNext(fromId) {
  const order = layout(D).filter((x) => x.group !== 'notmade').map((x) => x.id)
  const at = order.indexOf(fromId)
  const todo = new Set(needsOrder())
  const next = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].find((id) => todo.has(id))
  if (fromId) { S.open.delete(fromId); drawCard(fromId) }
  if (!next) { status('ok', `Everything is done. Thank you. ${P.total.done} of ${P.total.total} done.`); return }
  openCard(next)
}

// ---------------------------------------------------------------- Find and Needs you (spec 20.12)

function cardText(x) {
  if (x.id.startsWith('r-')) {
    const r = IX.recipes.get(x.id)
    return [r.name, ...D.lines.filter((l) => l.recipe_id === r.id).flatMap((l) => [l.src_name, pickText(l)])].join(' ')
  }
  const c = IX.cards.get(x.id)
  const kids = D.cards.filter((k) => k.parent_id === c.id)
  const rids = [c.recipe_id, ...kids.map((k) => k.recipe_id)].filter(Boolean)
  return [c.name, c.menu_name, ...kids.map((k) => k.flavour), ...[c, ...kids].map((k) => k.item_id && itemName(k.item_id)),
    ...rids.flatMap((rid) => [(IX.recipes.get(rid) || {}).name, ...D.lines.filter((l) => l.recipe_id === rid).flatMap((l) => [l.src_name, pickText(l)])])].filter(Boolean).join(' ')
}
function applyFilter() {
  const q = normName(S.q)
  const on = q.length >= 2 || S.need
  let hits = 0
  const words = q ? q.split(' ') : []
  for (const x of layout(D)) {
    const el = document.getElementById(`card-${x.id}`)
    if (!el) continue
    let show = true
    if (q.length >= 2) { const t = normName(cardText(x)); show = words.every((w) => t.includes(w)) }
    if (show && S.need) show = !(P.cards[x.id] || {}).done
    el.hidden = !show
    if (show) hits++
  }
  for (const g of $$('.grp')) {
    const any = $$('.card', g).some((c) => !c.hidden)
    g.hidden = on && !any
    if (on && any) g.open = true
  }
  for (const s of $$('.sec')) s.hidden = on && !$$('.card', s).some((c) => !c.hidden)
  $('#nohit').hidden = !on || hits > 0
  $('#nohit').textContent = q.length >= 2 ? `Nothing found for '${S.q.trim()}'.` : 'Everything is done. Thank you.'
  $('#needBtn').classList.toggle('on', S.need)
  $('#needBtn').setAttribute('aria-pressed', String(S.need))
}

// ---------------------------------------------------------------- the picker (spec 5.2, 20.5)

function lately() { try { return JSON.parse(localStorage.getItem(LATELY) || '[]') } catch { return [] } }
function remember(id) { try { localStorage.setItem(LATELY, JSON.stringify([id, ...lately().filter((x) => x !== id)].slice(0, 5))) } catch { /* fine */ } }
const SHELF_ORDER = ['Bakery', 'Dairy and eggs', 'Meat and poultry', 'Fruit and veg', 'Pantry', 'Sauces', 'Frozen foods', 'Packaging', 'Drinks', 'Snacks', 'Sweets and chocolates']
function optHtml(o, i) {
  return `<button type="button" class="pk-o" role="option" data-i="${i}" aria-selected="false"${o.why ? ' disabled' : ''}>${esc(o.name)}<small>${esc(o.sub)}</small></button>`
}
function pickerOptions() {
  const P_ = S.P
  const all = []
  if (P_.batches) {
    for (const r of D.recipes.filter((x) => x.kind === 'batch' && !x.removed).sort((a, b) => a.name.localeCompare(b.name))) {
      const why = P_.recipeId ? loopReason(P_.recipeId, r.id, D) : null
      all.push({ kind: 'batch', id: r.id, name: r.name, sub: why === 'loop' ? 'This would put the batch inside itself' : why ? 'Batches can sit at most three deep' : `Batch . by the ${r.makes_unit === 'each' ? 'piece' : r.makes_unit || 'g'}`, group: 'Our batches', why })
    }
  }
  for (const k of D.stock) all.push({ kind: 'item', id: k.id, name: k.name, sub: `${k.shelf} . by the ${k.use_unit === 'each' ? (k.piece_name && k.piece_name !== 'each' ? k.piece_name : 'piece') : k.use_unit}`, group: k.shelf })
  return all
}
function drawPicker() {
  const q = $('#pkSearch').value.trim()
  const all = pickerOptions()
  let list = []
  let html = ''
  if (q.length >= 2) {
    const qw = [...wordsOf(q)]
    list = all.filter((o) => { const w = [...wordsOf(o.name)]; return qw.every((x) => w.some((y) => y.startsWith(x))) })
    html = list.length ? list.map(optHtml).join('') : `<p class="pk-none">Nothing called '${esc(q)}' in our stock.</p>`
  } else {
    const groups = []
    const fw = new Set([...wordsOf(S.P.for || '')].filter((w) => w.length > 2))
    // Maybe: at most three sharing the most words with the recipe's own words; never selected for her
    const score = (o) => [...wordsOf(o.name)].filter((w) => fw.has(w)).length
    const maybe = fw.size ? all.filter((o) => !o.why && score(o) > 0).map((o) => [score(o), o])
      .sort((x, y) => y[0] - x[0] || (x[1].kind === 'batch') - (y[1].kind === 'batch')).slice(0, 3).map(([, o]) => o) : []
    if (maybe.length) groups.push(['Maybe', maybe])
    const lat = lately().map((id) => all.find((o) => o.id === id)).filter(Boolean)
    if (lat.length) groups.push(['Used lately', lat])
    if (S.P.batches) groups.push(['Our batches', all.filter((o) => o.kind === 'batch')])
    const shelves = [...new Set(all.filter((o) => o.kind === 'item').map((o) => o.group))]
    shelves.sort((a, b) => (S.P.packFirst ? (b === 'Packaging') - (a === 'Packaging') : 0) || ((SHELF_ORDER.indexOf(a) + 99) % 99) - ((SHELF_ORDER.indexOf(b) + 99) % 99) || a.localeCompare(b))
    for (const sh of shelves) groups.push([sh, all.filter((o) => o.kind === 'item' && o.group === sh)])
    for (const [g, os] of groups) { html += `<p class="pk-g">${esc(g)}</p>`; for (const o of os) { html += optHtml(o, list.length); list.push(o) } }
  }
  S.P.list = list
  S.P.at = -1
  $('#pkList').innerHTML = html
  const f = []
  if (S.P.mode === 'line') f.push('<button type="button" class="btn ghost" data-pk="notin">Not in our stock yet</button>', '<button type="button" class="btn ghost" data-pk="notfrom">Not from stock (like tap water)</button>')
  if (S.P.flavour) f.push('<button type="button" class="btn ghost" data-pk="nosell">We don\'t sell this one</button>')
  $('#pkFoot').innerHTML = f.join('')
  $('#pkFoot').hidden = !f.length
}
function openPicker(opts, anchor) {
  if (!S.canEdit) return
  S.P = { ...opts, anchor }
  const pk = $('#picker')
  $('#pkFor').textContent = `For: ${opts.for || ''}`
  $('#pkSearch').value = ''
  pk.hidden = false
  $('#scrim').hidden = false
  if (innerWidth >= 700 && anchor) {
    const r = anchor.getBoundingClientRect()
    const w = Math.min(520, innerWidth * 0.92)
    pk.style.left = `${Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - w - 8))}px`
    pk.style.top = `${r.bottom + scrollY + 4}px`
  } else { pk.style.left = ''; pk.style.top = '' }
  drawPicker()
  $('#pkSearch').focus()
}
function closePicker() {
  const a = S.P && S.P.anchor
  $('#picker').hidden = true
  $('#scrim').hidden = true
  S.P = null
  if (a && a.isConnected) a.focus({ preventScroll: true })
}
function choose(o) {
  const P_ = S.P
  closePicker()
  if (o.kind === 'item' || o.kind === 'batch') remember(o.id)
  if (P_.mode === 'line') {
    const l = IX.lines.get(P_.id)
    const pick = { item_id: o.kind === 'item' ? o.id : null, batch_id: o.kind === 'batch' ? o.id : null, not_counted: o.kind === 'notfrom', not_in_stock: o.kind === 'notin' }
    const ch = [{ tbl: 'lines', id: l.id, field: 'pick', value: pick }]
    const t = o.kind === 'item' ? IX.stock.get(o.id) : o.kind === 'batch' ? { ...IX.recipes.get(o.id), kind: 'batch' } : null
    const q = t ? toItemQty(l.src_qty, l.src_unit, t) : null
    if (t && q !== null && (l.qty === null || l.qty === undefined || pick.item_id !== l.item_id || pick.batch_id !== l.batch_id)) ch.push({ tbl: 'lines', id: l.id, field: 'qty', value: q })
    else if (t && (pick.item_id !== l.item_id || pick.batch_id !== l.batch_id) && l.qty !== null) ch.push({ tbl: 'lines', id: l.id, field: 'qty', value: null })
    act(ch)
    const after = IX.lines.get(l.id)
    if (t && (after.qty === null || after.qty === undefined)) { const inp = $(`#ln-${CSS.escape(l.id)} .qty`); if (inp) inp.focus() }
  } else if (P_.mode === 'asis') {
    if (o.kind === 'nosell') return act([{ tbl: 'cards', id: P_.id, field: 'on_menu', value: false }])
    const k = IX.cards.get(P_.id)
    act([{ tbl: 'cards', id: k.id, field: 'made', value: { made_from: k.parent_id ? null : 'as_is', recipe_id: null, item_id: o.id } }])
  } else if (P_.mode === 'extra') {
    act([{ tbl: 'extras', id: P_.id, field: 'item_id', value: o.id }])
  } else if (P_.mode === 'slot' || P_.mode === 'newextra') {
    const slot = P_.mode === 'slot'
    addRow('extras', { card_id: P_.card, action: 'add', item_id: o.id, slot: slot ? 'packaging' : null, rule_id: slot ? P_.rule : null, qty: 1, serve: slot ? 'take_away' : 'both' })
      .then((row) => { if (row) { showUndo([{ tbl: 'extras', id: row.id, field: 'removed', value: true }]); redraw() } })
  } else if (P_.mode === 'move') {
    act([{ tbl: 'cards', id: P_.id, field: 'heading_id', value: Number(o.id) }])
    openCard(P_.id)
  } else if (P_.mode === 'addmenu') {
    const r = P_.recipe ? IX.recipes.get(P_.recipe) : null
    const name = P_.name || (r && r.name)
    addRow('cards', { name, heading_id: Number(o.id), recipe_id: r ? r.id : null }).then((row) => {
      if (!row) return
      showUndo([{ tbl: 'cards', id: row.id, field: 'removed', value: true }])
      redraw()
      openCard(row.id)
    })
  } else if (P_.mode === 'menuas') {
    const c = IX.cards.get(o.id)
    const doit = () => { act([{ tbl: 'cards', id: c.id, field: 'made', value: { made_from: 'recipe', recipe_id: P_.recipe, item_id: null } }]); openCard(c.id) }
    if (c.made_from === 'recipe' && c.recipe_id && c.recipe_id !== P_.recipe) {
      const el = document.getElementById(`card-${P_.recipe}`)
      const box = el && el.querySelector('.c-body')
      if (box) {
        box.insertAdjacentHTML('afterbegin', `<div class="ask">Replace ${esc((IX.recipes.get(c.recipe_id) || {}).name)} on ${esc(cardName(c))}? <button type="button" class="btn sm" data-act="yes">Yes</button> <button type="button" class="btn sm ghost" data-act="no">No</button></div>`)
        S.pendingYes = doit
        return
      }
    }
    doit()
  }
}
function categoryOptions() {
  return SECTIONS.slice(1).flatMap((s) => s.headings.map((h) => ({ kind: 'cat', id: String(h), name: HEADINGS[h], sub: s.title, group: s.title })))
}
function openList(opts, anchor, options) {
  openPicker(opts, anchor)
  S.P.fixed = options
  const draw = () => {
    const q = normName($('#pkSearch').value)
    const list = options.filter((o) => !q || normName(o.name).includes(q))
    S.P.list = list
    S.P.at = -1
    let html = ''
    let g = null
    list.forEach((o, i) => { if (o.group !== g) { g = o.group; html += `<p class="pk-g">${esc(g)}</p>` } html += optHtml(o, i) })
    $('#pkList').innerHTML = html || '<p class="pk-none">Nothing by that name.</p>'
    $('#pkFoot').hidden = true
  }
  S.P.draw = draw
  draw()
}

// ---------------------------------------------------------------- what she does

function onClick(e) {
  if (e.target.closest('#picker')) return pickerClick(e)
  const j = e.target.closest('[data-jump]')
  if (j) { const s = $(`#s-${j.dataset.jump}`); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
  const b = e.target.closest('[data-act]')
  if (!b) return
  const a = b.dataset.act
  const cardEl = b.closest('.card')
  const id = cardEl && cardEl.dataset.id
  if (a === 'toggle') {
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id)
    drawCard(id)
    return
  }
  if (a === 'next') return goNext(id)
  if (a === 'yes') { const f = S.pendingYes; S.pendingYes = null; b.closest('.ask').remove(); if (f) f(); return }
  if (a === 'no') { S.pendingYes = null; b.closest('.ask').remove(); return }
  if (!S.canEdit) return
  const lineEl = b.closest('[data-line]')
  const l = lineEl && IX.lines.get(lineEl.dataset.line)
  const kidEl = b.closest('[data-card]')
  const kid = kidEl && IX.cards.get(kidEl.dataset.card)
  const exEl = b.closest('[data-extra]')
  const ex = exEl && IX.extras.get(exEl.dataset.extra)
  const c = id && IX.cards.get(id)
  const r = id && IX.recipes.get(id)
  switch (a) {
    case 'pick-line': {
      return openPicker({ mode: 'line', id: l.id, for: srcText(l), batches: true, recipeId: l.recipe_id }, b)
    }
    case 'ok-line': return act([{ tbl: 'lines', id: l.id, field: 'confirmed', value: true }])
    case 'line-remove': return act([{ tbl: 'lines', id: l.id, field: 'removed', value: true }], { label: 'remove' })
    case 'line-back': return act([{ tbl: 'lines', id: l.id, field: 'removed', value: false }])
    case 'line-add': {
      addRow('lines', { recipe_id: b.dataset.recipe }).then((row) => {
        if (!row) return
        showUndo([{ tbl: 'lines', id: row.id, field: 'removed', value: true }])
        redraw()
        const btn = $(`#ln-${CSS.escape(row.id)} .pk`)
        if (btn) openPicker({ mode: 'line', id: row.id, for: 'your new line', batches: true, recipeId: row.recipe_id }, btn)
      })
      return
    }
    case 'ask': {
      const k = S.ask.get(`lines|${l.id}`)
      S.ask.delete(`lines|${l.id}`)
      return act([{ tbl: 'lines', id: l.id, field: 'qty', value: Number(b.dataset.v) }])
    }
    case 'pick-asis': {
      const k = kid || c
      const parent = k.parent_id ? IX.cards.get(k.parent_id) : k
      return openPicker({ mode: 'asis', id: k.id, for: k.flavour ? `${cardName(parent)} (${k.flavour})` : cardName(parent), flavour: !!k.parent_id }, b)
    }
    case 'q-ok': {
      const k = kid || c
      const ch = [{ tbl: 'cards', id: k.id, field: 'confirmed', value: true }]
      const parent = k.parent_id ? IX.cards.get(k.parent_id) : null
      if (parent && parent.prefill_rule && !parent.confirmed && parent.prefill_made_from === parent.made_from) ch.push({ tbl: 'cards', id: parent.id, field: 'confirmed', value: true })
      return act(ch)
    }
    case 'ok-card': return act([{ tbl: 'cards', id: c.id, field: 'confirmed', value: true }])
    case 'flavour-drop': return act([{ tbl: 'cards', id: kid.id, field: 'on_menu', value: false }], { label: '' })
    case 'flavour-back': return act([{ tbl: 'cards', id: kid.id, field: 'on_menu', value: true }])
    case 'made-recipe': {
      if (c.made_from === 'recipe') return
      const kids = D.cards.some((k) => k.parent_id === c.id)
      const rid = kids ? null : c.recipe_id || (c.prefill_made_from === 'recipe' ? c.prefill_recipe_id : null)
      return act([{ tbl: 'cards', id: c.id, field: 'made', value: { made_from: 'recipe', recipe_id: rid, item_id: null } }])
    }
    case 'made-asis': {
      if (c.made_from === 'as_is') return
      const kids = D.cards.some((k) => k.parent_id === c.id)
      const it = kids ? null : c.prefill_made_from === 'as_is' ? c.prefill_item_id : null
      return act([{ tbl: 'cards', id: c.id, field: 'made', value: { made_from: 'as_is', recipe_id: null, item_id: it } }])
    }
    case 'rename': {
      const p = cardEl.querySelector('.rn')
      if (!p.hidden) { p.hidden = true; return }
      const cur = r ? r.name : cardName(c)
      p.innerHTML = `<label class="grey" for="rn-${esc(id)}">The name you use</label><div class="row"><input id="rn-${esc(id)}" type="text" maxlength="120" value="${esc(cur)}" autocomplete="off">
        <button type="button" class="btn sm" data-act="rename-done">Save name</button>${c && c.name && !c.added ? '<button type="button" class="btn sm ghost" data-act="rename-back">Use the menu\'s name</button>' : ''}
        <button type="button" class="lnk" data-act="rename-close">Cancel</button></div>`
      p.hidden = false
      p.querySelector('input').focus()
      return
    }
    case 'rename-close': cardEl.querySelector('.rn').hidden = true; return
    case 'rename-done': {
      const v = cardEl.querySelector('.rn input').value.trim().replace(/\s+/g, ' ')
      if (!v) return
      if (r) return act([{ tbl: 'recipes', id: r.id, field: 'name', value: v }])
      return act([{ tbl: 'cards', id: c.id, field: 'name', value: v === c.menu_name && !c.added ? null : v }])
    }
    case 'rename-back': return act([{ tbl: 'cards', id: c.id, field: 'name', value: null }])
    case 'move': return openList({ mode: 'move', id: c.id, for: `Move ${cardName(c)} to` }, b, categoryOptions())
    case 'menu-add': {
      const name = prompt('The new menu item\'s name')
      if (!name || !name.trim()) return
      addRow('cards', { name: name.trim(), heading_id: Number(b.dataset.heading) }).then((row) => {
        if (!row) return
        showUndo([{ tbl: 'cards', id: row.id, field: 'removed', value: true }])
        redraw()
        openCard(row.id)
      })
      return
    }
    case 'skip': {
      const rule = IX.rules.get(b.dataset.rule)
      const fill = rule.slot ? D.extras.find((x) => x.card_id === c.id && x.action === 'add' && x.slot === 'packaging' && !x.removed) : null
      addRow('extras', { card_id: c.id, action: 'skip', rule_id: rule.id }).then((row) => {
        if (!row) return
        showUndo([{ tbl: 'extras', id: row.id, field: 'removed', value: true }])
        redraw()
      })
      if (fill) act([{ tbl: 'extras', id: fill.id, field: 'removed', value: true }], { undoable: false })
      return
    }
    case 'unskip': {
      const s = D.extras.find((x) => x.card_id === c.id && x.action === 'skip' && x.rule_id === b.dataset.rule && !x.removed)
      if (s) act([{ tbl: 'extras', id: s.id, field: 'removed', value: true }])
      return
    }
    case 'pick-slot': return openPicker({ mode: 'slot', card: c.id, rule: b.dataset.rule, for: `Packaging for ${cardName(c)} (take-away)`, packFirst: true }, b)
    case 'pick-extra': return openPicker({ mode: 'extra', id: ex.id, for: `Goes out with ${cardName(c)}`, packFirst: true }, b)
    case 'ok-extra': return act([{ tbl: 'extras', id: ex.id, field: 'confirmed', value: true }])
    case 'extra-remove': return act([{ tbl: 'extras', id: ex.id, field: 'removed', value: true }], { label: 'remove' })
    case 'extra-add': return openPicker({ mode: 'newextra', card: c.id, for: `Goes out with ${cardName(c)}`, packFirst: true }, b)
    case 'all-correct': {
      const saves = allCorrect(id, D)
      return act(saves.map((s) => ({ tbl: s.tbl, id: s.id, field: s.field, value: true })), { label: `(${saves.length})` })
    }
    case 'rule-ask': {
      const row = b.closest('.rule')
      if (row.querySelector('.ask')) return
      row.insertAdjacentHTML('beforeend', `<div class="ask">Take it off all ${esc(b.dataset.n)}? <button type="button" class="btn sm" data-act="rule-off" data-rules="${esc(b.dataset.rules)}">Yes</button> <button type="button" class="btn sm ghost" data-act="rule-keep">Keep it</button></div>`)
      return
    }
    case 'rule-keep': b.closest('.ask').remove(); return
    case 'rule-off': return act(b.dataset.rules.split(',').map((rid) => ({ tbl: 'rules', id: rid, field: 'active', value: false })))
    case 'rule-on': return act(b.dataset.rules.split(',').map((rid) => ({ tbl: 'rules', id: rid, field: 'active', value: true })))
    case 'we-make': return act([{ tbl: 'recipes', id: r.id, field: 'we_make_this', value: true }])
    case 'stray-drop': return act([{ tbl: 'recipes', id: r.id, field: 'left_out', value: true }])
    case 'stray-back': return act([{ tbl: 'recipes', id: r.id, field: 'left_out', value: false }])
    case 'stray-batch': {
      act([{ tbl: 'recipes', id: r.id, field: 'kind', value: 'batch' }, { tbl: 'recipes', id: r.id, field: 'grp', value: 'Made ahead' }])
      openCard(r.id)
      return
    }
    case 'stray-add': return openList({ mode: 'addmenu', recipe: r.id, for: `Add ${r.name} to` }, b, categoryOptions())
    case 'stray-menuas': {
      const sec = sectionOfCat(r.cat)
      const opts = D.cards.filter((x) => !x.parent_id && !x.removed && !x.combo && sectionOf(x.heading_id) === sec && !D.cards.some((k) => k.parent_id === x.id))
        .sort((a, b2) => cardName(a).localeCompare(cardName(b2))).map((x) => ({ kind: 'card', id: x.id, name: cardName(x), sub: HEADINGS[x.heading_id] || 'No category yet', group: (sectionWord(sec) || {}).title }))
      return openList({ mode: 'menuas', recipe: r.id, for: `${r.name} is on the menu as` }, b, opts)
    }
    default:
  }
}
function pickerClick(e) {
  const f = e.target.closest('[data-pk]')
  if (f) return choose({ kind: { notin: 'notin', notfrom: 'notfrom', nosell: 'nosell' }[f.dataset.pk] })
  const o = e.target.closest('.pk-o')
  if (o && !o.disabled) return choose(S.P.list[Number(o.dataset.i)])
  if (e.target.closest('#pkClose')) closePicker()
}
function onChange(e) {
  const el = e.target
  if (!S.canEdit || el.closest('#picker')) return
  const cardEl = el.closest('.card')
  const id = cardEl && cardEl.dataset.id
  if (el.dataset.act === 'onmenu') return act([{ tbl: 'cards', id, field: 'on_menu', value: el.checked }])
  if (el.dataset.act === 'choose-recipe') {
    const k = IX.cards.get(el.dataset.card)
    const parent = k.parent_id ? IX.cards.get(k.parent_id) : null
    if (el.value === '__new') {
      const name = k.flavour ? `${cardName(parent)} (${k.flavour})` : cardName(k)
      const sec = sectionOf((parent || k).heading_id)
      addRow('recipes', { name, cat: sec === 'drinks' ? 'Hot Drinks' : sec === 'cold' ? 'Cold Drinks' : HEADINGS[(parent || k).heading_id] || 'Midday Munch' }).then(async (rec) => {
        if (!rec) return redraw()
        await addRow('lines', { recipe_id: rec.id })
        act([{ tbl: 'cards', id: k.id, field: 'made', value: { made_from: parent ? null : 'recipe', recipe_id: rec.id, item_id: null } }], { label: '' })
        S.undo = [...(S.undo || []), { tbl: 'recipes', id: rec.id, field: 'removed', value: true }]
      })
      return
    }
    return act([{ tbl: 'cards', id: k.id, field: 'made', value: { made_from: parent ? null : 'recipe', recipe_id: el.value || null, item_id: null } }])
  }
  if (el.dataset.act === 'serve') { const ex = IX.extras.get(el.closest('[data-extra]').dataset.extra); return act([{ tbl: 'extras', id: ex.id, field: 'serve', value: el.value }]) }
  if (el.dataset.act === 'notes') return act([{ tbl: 'recipes', id, field: 'notes', value: el.value }])
  if (el.dataset.act === 'makes-word') {
    const r = IX.recipes.get(id)
    const [unit, f] = MAKES[el.value]
    const shown = r.makes_qty === null ? null : Number(showBase(r.makes_qty, r.makes_word || r.makes_unit))
    const ch = [{ tbl: 'recipes', id, field: 'makes', value: { qty: shown === null ? null : Math.round(shown * f * 1000) / 1000, unit: shown === null ? null : unit, word: shown === null ? null : el.value } }]
    if (shown === null) { r.makes_word = el.value; return drawCard(id) }
    if (r.make_at_base !== null && r.make_at_base !== undefined) ch.push({ tbl: 'recipes', id, field: 'make_at_base', value: Math.round(Number(showBase(r.make_at_base, r.makes_word || r.makes_unit)) * f * 1000) / 1000 })
    return act(ch)
  }
  if (el.dataset.qty || el.dataset.batch) return amount(el, true)
}
/** An amount box: read the South African way, asked about when it could be read two ways, saved when it is plain. */
function amount(el, final) {
  const v = parseAmount(el.value)
  const box = el.closest('.l-pick, .row, .ex') || el.parentElement
  const rb = box.querySelector('.rb')
  if (rb) rb.textContent = v.ok ? readBack(el.value) : ''
  const err = box.querySelector('.err')
  if (err) err.remove()
  el.classList.remove('bad')
  if (!v.ok) { el.classList.add('bad'); el.insertAdjacentHTML('afterend', `<span class="err">Not saved: ${esc(v.problem)}</span>`); return }
  const cardEl = el.closest('.card')
  const id = cardEl.dataset.id
  if (v.ask) {
    const l = el.dataset.qty === 'lines' && IX.lines.get(el.closest('[data-line]').dataset.line)
    if (l) { S.ask.set(`lines|${l.id}`, { ask: v.ask, text: el.value }); if (final) drawCard(id) }
    else { el.classList.add('bad'); el.insertAdjacentHTML('afterend', `<span class="err">Type ${v.ask[0]} or ${v.ask[1]}, so it cannot be read the wrong way.</span>`) }
    return
  }
  if (!final) return
  if (el.dataset.qty === 'lines') { const l = IX.lines.get(el.closest('[data-line]').dataset.line); S.ask.delete(`lines|${l.id}`); return act([{ tbl: 'lines', id: l.id, field: 'qty', value: v.value }]) }
  if (el.dataset.qty === 'cards') { const k = IX.cards.get(el.closest('[data-card]').dataset.card); return act([{ tbl: 'cards', id: k.id, field: 'item_qty', value: v.value }]) }
  if (el.dataset.qty === 'extras') { const x = IX.extras.get(el.closest('[data-extra]').dataset.extra); return act([{ tbl: 'extras', id: x.id, field: 'qty', value: v.value }]) }
  const r = IX.recipes.get(id)
  const word = cardEl.querySelector('[data-act="makes-word"]').value
  const [unit, f] = MAKES[word]
  const base = v.value === null ? null : Math.round(v.value * f * 1000) / 1000
  if (base !== null && base > 100000) { el.classList.add('bad'); el.insertAdjacentHTML('afterend', '<span class="err">Not saved: that is more than 100,000.</span>'); return }
  if (el.dataset.batch === 'makes') return act([{ tbl: 'recipes', id, field: 'makes', value: { qty: base, unit: base === null ? null : unit, word: base === null ? null : word } }])
  return act([{ tbl: 'recipes', id, field: 'make_at_base', value: base }])
}

function wire() {
  document.addEventListener('click', onClick)
  document.addEventListener('change', onChange)
  document.addEventListener('input', (e) => { if (e.target.dataset && (e.target.dataset.qty || e.target.dataset.batch)) amount(e.target, false) })
  document.addEventListener('keydown', (e) => {
    const el = e.target
    if ((el.dataset && (el.dataset.qty || el.dataset.batch)) && e.key === 'Enter') {
      e.preventDefault()
      amount(el, true)
      const pks = $$('.c-body .pk:not([disabled])')
      const at = pks.findIndex((p) => el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING)
      if (at >= 0) pks[at].focus()
    }
    if (el.closest && el.closest('.rn') && e.key === 'Enter') { e.preventDefault(); el.closest('.rn').querySelector('[data-act="rename-done"]').click() }
  })
  $('#pkSearch').addEventListener('input', () => (S.P && S.P.draw ? S.P.draw() : drawPicker()))
  $('#pkSearch').addEventListener('keydown', (e) => {
    if (!S.P) return
    const os = $$('#pkList .pk-o:not([disabled])')
    if (e.key === 'Escape') { e.preventDefault(); return closePicker() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = os.findIndex((o) => o.getAttribute('aria-selected') === 'true')
      const n = Math.max(0, Math.min(os.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      os.forEach((o, i) => o.setAttribute('aria-selected', String(i === n)))
      if (os[n]) os[n].scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const sel = os.find((o) => o.getAttribute('aria-selected') === 'true') || (os.length === 1 ? os[0] : null) || ($('#pkSearch').value.trim().length >= 2 ? os[0] : null)
      if (sel) choose(S.P.list[Number(sel.dataset.i)])
    }
  })
  $('#scrim').addEventListener('click', closePicker)
  $('#undoBtn').addEventListener('click', () => {
    const u = S.undo
    if (!u) return
    S.undo = null
    $('#undoBtn').hidden = true
    act(u, { undoable: false })
    status('ok', 'Undone. Saving...')
  })
  $('#search').addEventListener('input', () => { S.q = $('#search').value; applyFilter() })
  $('#needBtn').addEventListener('click', () => { S.need = !S.need; applyFilter() })
  addEventListener('scroll', () => requestAnimationFrame(markChip), { passive: true })
}

// ---------------------------------------------------------------- Tarryn's view: History

const FIELD_SAY = { pick: 'picked', qty: 'amount', confirmed: 'checked', removed: 'removed', name: 'renamed', heading_id: 'moved', on_menu: 'on the menu', made: 'made from',
  item_qty: 'how many', makes: 'one batch makes', make_at_base: 'make more when it gets to', notes: 'notes', kind: 'kind', grp: 'group', left_out: 'we don\'t make this',
  we_make_this: 'we make this', active: 'for every card', item_id: 'picked', serve: 'when', added: 'added' }
function said(c, v) {
  if (v === null || v === undefined || v === '') return '<i>blank</i>'
  if (c.field === 'pick') return esc(v.not_counted ? 'Not from stock' : v.not_in_stock ? 'Not in our stock yet' : v.batch_id ? `${(IX.recipes.get(v.batch_id) || {}).name} (batch)` : v.item_id ? itemName(v.item_id) : 'nothing')
  if (c.field === 'made') return esc(v.made_from === 'as_is' ? `Sold as it is${v.item_id ? `: ${itemName(v.item_id)}` : ''}` : v.made_from === 'recipe' || v.recipe_id ? `Recipe${v.recipe_id ? `: ${(IX.recipes.get(v.recipe_id) || {}).name}` : ''}` : v.item_id ? itemName(v.item_id) : 'not chosen')
  if (c.field === 'item_id') return esc(itemName(v))
  if (c.field === 'heading_id') return esc(HEADINGS[v] || 'No category yet')
  if (c.field === 'makes') return esc(v.qty === null ? 'blank' : `${showBase(v.qty, v.word)} ${v.word}`)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'object') return esc(v.name || v.menu_name || v.src_name || 'a new row')
  return esc(String(v))
}
function whereOf(c) {
  if (c.tbl === 'lines') { const l = IX.lines.get(c.row_id); const r = l && IX.recipes.get(l.recipe_id); return l ? `'${srcText(l)}' on ${r ? r.name : ''}` : c.row_id }
  if (c.tbl === 'cards') { const k = IX.cards.get(c.row_id); if (!k) return c.row_id; const p = k.parent_id ? IX.cards.get(k.parent_id) : null; return p ? `${cardName(p)} (${k.flavour})` : cardName(k) }
  if (c.tbl === 'recipes') return (IX.recipes.get(c.row_id) || {}).name || c.row_id
  if (c.tbl === 'extras') { const x = IX.extras.get(c.row_id); const k = x && IX.cards.get(x.card_id); return `an extra on ${k ? cardName(k) : ''}` }
  const r = IX.rules.get(c.row_id)
  return r ? `the rule for ${r.label}` : c.row_id
}
function renderChanges(changes) {
  const el = $('#changes')
  el.hidden = false
  const when = (t) => new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  const was = el.querySelector('details')
  el.innerHTML = `<details class="hist"${was && was.open ? ' open' : ''}><summary><span class="cz">History</span>&nbsp;<span class="grey">${changes.length}</span></summary>
    ${changes.length ? '' : '<p class="small">No changes yet.</p>'}
    <ol class="clist">${changes.map((c) => `<li><b>${esc(c.who)}</b> <span class="grey">${when(c.at)}</span><br>${esc(whereOf(c))}: ${esc(FIELD_SAY[c.field] || c.field)}
      ${c.field === 'added' ? '' : `<br>${said(c, c.before)} <b>to</b> ${said(c, c.after)}`}</li>`).join('')}</ol></details>`
}

// ---------------------------------------------------------------- start

function useData(d) {
  D = { recipes: d.recipes, groups: d.groups, options: d.options, lines: d.lines, cards: d.cards, rules: d.rules, extras: d.extras, stock: d.stock }
  for (const l of D.lines) { if (l.qty !== null) l.qty = Number(l.qty); if (l.src_qty !== null) l.src_qty = Number(l.src_qty) }
  for (const c of D.cards) if (c.item_qty !== null) c.item_qty = Number(c.item_qty)
  for (const r of D.recipes) { if (r.makes_qty !== null) r.makes_qty = Number(r.makes_qty); if (r.make_at_base !== null) r.make_at_base = Number(r.make_at_base) }
  for (const e of D.extras) if (e.qty !== null) e.qty = Number(e.qty)
  // what this screen typed and had not saved yet goes back on, with the base it was typed against
  for (const e of queue.values()) { const row = (D[TBL[e.tbl]] || []).find((x) => x.id === e.id); if (row) setField(e.tbl, row, e.field, e.v) }
  reindex()
}
async function look() {
  if (document.hidden || busy || queue.size || S.P) return
  const a = document.activeElement
  if (a && a.matches && a.matches('input, textarea, select') && a.id !== 'search') return
  let r
  try { r = await call({ action: 'open' }) } catch { return }
  if (r.status !== 200 || busy || queue.size || S.P) return
  useData(r.body.data)
  if (!S.canEdit) renderChanges(r.body.changes || [])
  redraw()
}

async function start() {
  if (!key) { $('#list').innerHTML = '<p class="loading">This link is missing its key. Please use the link Tarryn sent.</p>'; return }
  let r
  try { r = await call({ action: 'open' }) } catch { r = { status: 0, body: {} } }
  if (r.status !== 200) {
    $('#list').innerHTML = `<p class="loading">${esc(r.status === 404 ? 'This link does not work. Ask Tarryn for it again.' : r.body.problem || 'The page could not be loaded. Check your connection and refresh.')}</p>`
    return
  }
  const d = r.body
  S.canEdit = d.canEdit
  S.who = d.who
  if (d.intro) {
    $('#title').textContent = d.intro.title
    $('#whoLine').textContent = d.intro.sub
    $('#foot').textContent = d.intro.foot
    let seen = false
    try { seen = localStorage.getItem('badger-recipebuilder-howto') === '1'; localStorage.setItem('badger-recipebuilder-howto', '1') } catch { /* fine */ }
    $('#notes').innerHTML = `<details class="note"${seen ? '' : ' open'}><summary>How to use this page</summary><ol>${d.intro.howto.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></details>`
  }
  if (S.canEdit) {
    try { for (const e of JSON.parse(localStorage.getItem(PENDING) || '[]')) if (e && e.tbl && e.id && e.field && 'base' in e) queue.set(`${e.tbl}|${e.id}|${e.field}`, e) } catch { /* fine */ }
  }
  useData(d.data)
  if (!S.canEdit) {
    document.body.classList.add('view')
    $('#whoLine').textContent = 'Tarryn\'s view: what Lindsay has done, and every change, newest first. It updates by itself. This link can only look.'
    renderChanges(d.changes || [])
  }
  $('#find').hidden = false
  P = progress(D)
  // open where she left off (spec 20.3); a deep link wins
  const deep = new URLSearchParams(location.hash.slice(1)).get('card')
  const first = deep && (IX.cards.has(deep) || IX.recipes.has(deep)) ? deep : S.canEdit ? needsOrder()[0] : null
  if (first) S.open.add(first)
  renderAll()
  document.documentElement.style.setProperty('--barH', `${Math.ceil($('#bar').getBoundingClientRect().height)}px`)
  wire()
  status('ok', S.canEdit ? 'Changes save as you go' : 'Read only')
  if (first) requestAnimationFrame(() => { const el = document.getElementById(`card-${first}`); if (el) el.scrollIntoView({ block: 'start' }) })
  if (queue.size) { status('saving', 'Saving...'); flush() }
  setInterval(look, POLL_MS)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look() })
}
start()
