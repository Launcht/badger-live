/*
 * Lindsay's stock take entry page (20/11/2026). Plain browser code, no build. The rules (what a count is, what may be
 * saved, the likely units, progress) are in stocktake.js, a copy of shared/stocktake.js made at deploy, so the page and
 * the server cannot disagree. The key is in the link after # (never sent to a web server's log), and goes in the
 * request body. The page holds no items: they all come with the key.
 *
 * Blank is NOT COUNTED. Nothing on this page ever turns a blank into a 0; only "None (0)" or a typed 0 does.
 * A value waiting to be saved is also kept in this browser, so a refresh or a dropped connection loses nothing.
 *
 * Fixes after the independent test (02-test-report.md, 20/11/2026): every save says what this screen last knew (N-1),
 * so an older screen never overwrites a newer value; a top add keeps its place (N-2); a count that could be read two
 * ways is asked about, and what was typed is read back under the box (N-3); open screens pick up other screens'
 * changes every 25 seconds without touching what is being typed (N-4); Tarryn's history is folded (N-7).
 */
import { validate, parseCount, readBack, unitsFor, ALL_UNITS, summary, shelfProgress, OTHER_SHELF, GONE_REASONS, ITEM_FIELDS, SHEET_FIELDS } from './stocktake.js'

const API = 'https://nptyrtjdvqglgwkaepce.supabase.co/functions/v1/badger-stocktake'
const key = new URLSearchParams(location.hash.slice(1)).get('k') || ''
const PENDING = 'badger-stocktake-pending'

const S = { items: [], byId: new Map(), shelves: [], sheet: {}, canEdit: false, who: '', q: '', todo: false, openBefore: null }
const POLL_MS = 25000
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const hhmm = (t = new Date()) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const num = (n) => (n === null || n === undefined ? '' : String(n))
const live = () => S.items.filter((i) => !i.gone)

// ---------------------------------------------------------------- talking to the server

async function call(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, key }) })
  let j = {}
  try { j = await r.json() } catch { /* nothing to read */ }
  return { status: r.status, body: j }
}

// N-1: `known` is each field's value as the server last told this screen. Every save sends it as `base`; the server
// refuses (409) when the field holds something newer, and says what. Waiting values carry their own base.
const known = new Map() // `${item}|${field}` -> the server's value, as this screen last knew it
const queue = new Map() // `${item}|${field}` -> { v, base, t }: waiting to be saved
const timers = new Map()
let busy = false
let lastProblem = ''
const invalid = new Map() // element -> problem: while any is left, the bar never says "Saved"
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// The browser's copy of what is waiting, shared by every tab of this page: each tab adds and takes off only its own
// lines (test N-1: one tab used to replace another's list).
function lsRead() {
  try { const o = JSON.parse(localStorage.getItem(PENDING) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch { return {} }
}
function lsWrite(o) {
  try { if (Object.keys(o).length) localStorage.setItem(PENDING, JSON.stringify(o)); else localStorage.removeItem(PENDING) } catch { /* private browsing: the server copy counts */ }
}
function lsPut(k, e) { const o = lsRead(); o[k] = e; lsWrite(o) }
function lsDone(k, v) { const o = lsRead(); if (o[k] && same(o[k].v, v)) { delete o[k]; lsWrite(o) } }

function status(kind, text) {
  const el = $('#status')
  el.className = `status ${kind}`
  el.textContent = text
}
function showProblems() {
  for (const el of [...invalid.keys()]) if (!el.isConnected) invalid.delete(el)
  if (invalid.size) status('bad', `Not saved: ${[...invalid.values()][0]}`)
  else if (!queue.size && !busy && !lastProblem) status('ok', `Saved ${hhmm()}`)
}
function bad(el, problem) {
  invalid.set(el, problem)
  el.classList.add('bad')
  el.setAttribute('aria-invalid', 'true')
  let msg = el.parentElement.querySelector(':scope > .err')
  if (!msg) {
    msg = document.createElement('div')
    msg.className = 'err'
    el.parentElement.appendChild(msg)
  }
  msg.textContent = `Not saved: ${problem}`
  showProblems()
}
function good(el) {
  const had = invalid.has(el)
  invalid.delete(el)
  el.classList.remove('bad')
  el.removeAttribute('aria-invalid')
  const msg = el.parentElement && el.parentElement.querySelector(':scope > .err')
  if (msg) msg.remove()
  if (had) showProblems()
}
function save(id, field, value, wait = 0) {
  const k = `${id ?? ''}|${field}`
  const q = queue.get(k)
  const base = q ? q.base : (known.has(k) ? known.get(k) : null)
  clearTimeout(timers.get(k))
  // N-1: nothing new (leaving a box that was not changed, or changed back) sends nothing
  if (same(value, base)) {
    if (q) { queue.delete(k); lsDone(k, q.v) }
    showProblems()
    return
  }
  const e = { v: value, base, t: Date.now() }
  queue.set(k, e)
  lsPut(k, e)
  const row = id && document.getElementById(`i-${id}`)
  const upd = row && row.querySelector('.upd')
  if (upd) upd.remove()
  if (!invalid.size) status('saving', 'Saving...')
  timers.set(k, setTimeout(flush, wait))
}
async function flush() {
  if (busy) return
  busy = true
  try {
    while (queue.size) {
      const [k, e] = queue.entries().next().value
      queue.delete(k)
      const [id, field] = k.split('|')
      let r
      try {
        r = await call({ action: 'save', item: id || null, field, value: e.v, base: e.base })
      } catch {
        r = { status: 0, body: {} }
      }
      if (r.status === 0 || r.status >= 500) {
        if (!queue.has(k)) queue.set(k, e)
        status('bad', 'Not saved yet: no connection. Trying again...')
        busy = false
        setTimeout(flush, 4000)
        return
      }
      lsDone(k, e.v)
      if (r.status === 200) {
        lastProblem = ''
        const now = 'value' in r.body ? r.body.value : e.v
        known.set(k, now)
        // typed again while this was on its way: that next save starts from what was just saved
        const next = queue.get(k)
        if (next) { next.base = now; lsPut(k, next) }
        continue
      }
      if (r.status === 409 && r.body.stale) {
        // N-1: another screen saved something newer; show it, say so, and drop what this screen had for that field
        known.set(k, r.body.current ?? null)
        const next = queue.get(k)
        if (next) { queue.delete(k); lsDone(k, next.v) }
        applyField(id || null, field, r.body.current ?? null, true)
        const it = id && S.byId.get(id)
        lastProblem = ''
        status('note', `Updated on another screen${it ? `: ${it.name}` : ''}`)
        continue
      }
      lastProblem = r.body.problem || 'That could not be saved.'
      status('bad', `Not saved: ${lastProblem}`)
    }
    if (invalid.size) showProblems()
    else if (!lastProblem && !/^Updated/.test($('#status').textContent)) status('ok', `Saved ${hhmm()}`)
  } finally {
    busy = false
  }
  if (queue.size) flush()
}
addEventListener('beforeunload', (e) => {
  if (queue.size || busy) { e.preventDefault(); e.returnValue = '' }
})

// ---------------------------------------------------------------- one item

const ro = () => (S.canEdit ? '' : ' disabled')
const REASON = Object.fromEntries(GONE_REASONS)
const stateOf = (it) => (it.count === null || it.count === undefined ? 's-blank' : it.count === 0 ? 's-zero' : 's-counted')

function unitsHtml(it) {
  const likely = unitsFor(it)
  const rest = ALL_UNITS.filter((u) => !likely.includes(u))
  const chip = (u) => `<button type="button" class="u${it.unit === u ? ' on' : ''}" data-act="unit" data-u="${esc(u)}"${ro()}>${esc(u)}</button>`
  const other = it.unit && !ALL_UNITS.includes(it.unit) ? it.unit : ''
  const restOn = rest.includes(it.unit)
  return `<div class="units" role="group" aria-label="Unit">${likely.map(chip).join('')}
      <span class="rest"${restOn ? '' : ' hidden'}>${rest.map(chip).join('')}</span>
      ${restOn || !S.canEdit ? '' : '<button type="button" class="u more" data-act="more">More</button>'}
      ${other || !S.canEdit ? '' : '<button type="button" class="u more" data-act="other">Other</button>'}
      <input class="uo" type="text" maxlength="30" data-f="unit" value="${esc(other)}" placeholder="Type the unit" aria-label="Other unit for ${esc(it.name)}" autocomplete="off"${ro()}${other ? '' : ' hidden'}></div>`
}
/** The unit beside the reorder level: the one she picked for the count, or a word saying it follows that one. */
const rlUnit = (it) => (it.unit ? it.unit : 'same unit as the count')
function nameHtml(it) {
  const renamed = !it.added && it.sheet_name && it.name !== it.sheet_name
  const tag = it.ours ? ' <span class="tag check">Added by us - check</span>' : it.added ? ' <span class="tag">Added</span>' : ''
  return `<div class="it-name"><span class="nm">${esc(it.name)}</span>${tag}
      ${renamed ? `<small class="was">On the sheet: ${esc(it.sheet_name)}</small>` : ''}
      ${it.comes_as ? `<small class="ca">Comes as ${esc(it.comes_as)}</small>` : ''}</div>`
}
function itemHtml(it) {
  if (it.gone) return removedHtml(it)
  return `<div class="it ${stateOf(it)}" id="i-${esc(it.id)}" data-id="${esc(it.id)}">
    ${nameHtml(it)}
    <div class="it-count">
      <div class="cbox"><input class="cnt" type="text" inputmode="decimal" enterkeyhint="next" data-f="count" value="${esc(num(it.count))}" placeholder="Count" aria-label="Count for ${esc(it.name)}" autocomplete="off"${ro()}>
        <div class="rb" aria-live="polite"></div><div class="askc" hidden></div></div>
      <button type="button" class="zero${it.count === 0 ? ' on' : ''}" data-act="zero" aria-pressed="${it.count === 0}"${ro()}>None (0)</button>
      <div class="rl"><label for="rl-${esc(it.id)}">Reorder when it gets to</label>
        <div class="rl-row"><input id="rl-${esc(it.id)}" class="rl-in" type="text" inputmode="decimal" data-f="reorder" value="${esc(num(it.reorder))}" placeholder="-" autocomplete="off"${ro()}>
        <span class="rl-u">${esc(rlUnit(it))}</span></div></div>
    </div>
    ${unitsHtml(it)}
    <div class="it-foot">
      <div class="nbox"><input class="nt" type="text" maxlength="300" data-f="note" value="${esc(it.note)}" placeholder="Note" aria-label="Note for ${esc(it.name)}" autocomplete="off"${ro()}></div>
      ${S.canEdit ? '<button type="button" class="lnk" data-act="rename">Rename</button><button type="button" class="lnk" data-act="remove">Remove</button>' : ''}
    </div>
    <div class="panel rn" hidden></div>
    <div class="panel rm" hidden></div>
  </div>`
}
function removedHtml(it) {
  const same = it.same_as && S.byId.get(it.same_as)
  const why = [it.gone_reason && REASON[it.gone_reason], same && `same as ${same.name}`].filter(Boolean).join(', ')
  return `<div class="it gone" id="i-${esc(it.id)}" data-id="${esc(it.id)}">
    <div class="g-row"><div><span class="nm">${esc(it.name)}</span>${why ? `<small class="ca">${esc(why)}</small>` : ''}
      ${!it.added && it.name !== it.sheet_name ? `<small class="was">On the sheet: ${esc(it.sheet_name)}</small>` : ''}
      ${it.note ? `<small class="ca">Note: ${esc(it.note)}</small>` : ''}</div>
      ${S.canEdit ? '<button type="button" class="btn ghost sm" data-act="undo">Undo</button>' : ''}</div></div>`
}

// ---------------------------------------------------------------- one shelf

const itemsOf = (shelf) => S.items.filter((i) => i.shelf === shelf)
function shelfHtml(shelf, n, open) {
  const its = itemsOf(shelf)
  const liveIts = its.filter((i) => !i.gone)
  const gone = its.filter((i) => i.gone)
  const other = shelf === OTHER_SHELF
  return `<details class="shelf" id="sh-${n}" data-shelf="${esc(shelf)}"${open ? ' open' : ''}>
    <summary><span class="sh-name">${esc(shelf)}</span><span class="sh-prog"></span></summary>
    ${other ? '<p class="small pad">Anything on the shelf that is not on the sheet, like the space at the end of your paper.</p>' : ''}
    ${S.canEdit && !other ? addHtml('top') : ''}
    <div class="items">${liveIts.map(itemHtml).join('')}</div>
    <details class="removed"${gone.length ? '' : ' hidden'}><summary>Removed <span class="n">${gone.length}</span></summary><div class="ritems">${gone.map(removedHtml).join('')}</div></details>
    ${S.canEdit ? addHtml('bottom', other) : ''}
  </details>`
}
/** "+ Add an item": at the top and the bottom of every shelf (Tarryn 20/11), name, count, unit and note. */
function addHtml(where, open = false) {
  return `<div class="add" data-where="${where}">
    <button type="button" class="addbtn" data-act="add-open"${open ? ' hidden' : ''}>+ Add an item</button>
    <div class="add-form"${open ? '' : ' hidden'}>
      <p class="add-h">An item you counted that isn't on the list</p>
      <div class="add-row"><input class="a-name" type="text" maxlength="120" placeholder="Item name" aria-label="New item name" autocomplete="off">
        <input class="a-cnt" type="text" inputmode="decimal" placeholder="Count" aria-label="New item count" autocomplete="off">
        <input class="a-unit" type="text" maxlength="30" list="unitList" placeholder="Unit" aria-label="New item unit" autocomplete="off"></div>
      <input class="a-note" type="text" maxlength="300" placeholder="Note (if you want)" aria-label="New item note" autocomplete="off">
      <div class="p-acts"><button type="button" class="btn" data-act="add">Add</button>${open ? '' : '<button type="button" class="lnk" data-act="add-close">Cancel</button>'}</div>
    </div></div>`
}
function updShelf(shelf) {
  const el = $$('.shelf').find((x) => x.dataset.shelf === shelf)
  if (!el) return
  const p = shelfProgress(S.items, shelf)
  el.querySelector('.sh-prog').textContent = shelf === OTHER_SHELF && !p.total ? 'nothing added' : `${p.entered} of ${p.total} entered`
  el.classList.toggle('done', p.total > 0 && p.entered === p.total)
  const gone = itemsOf(shelf).filter((i) => i.gone).length
  const rem = el.querySelector(':scope > .removed')
  rem.hidden = !gone
  rem.querySelector('.n').textContent = String(gone)
}
function updBar() {
  const s = summary(S.items)
  const entered = s.counted + s.zero
  $('#prog').textContent = `${entered} of ${s.total} entered`
  $('#fill').style.width = `${s.total ? Math.round((entered / s.total) * 100) : 0}%`
  const noUnit = live().filter((i) => typeof i.count === 'number' && i.count > 0 && !i.unit).length
  $('#summary').innerHTML = `<h2>Summary</h2>
    <dl class="sum">
      <div><dt>Counted</dt><dd>${s.counted}</dd></div>
      <div><dt>None in stock (0)</dt><dd>${s.zero}</dd></div>
      <div><dt>Not counted yet</dt><dd>${s.blank}</dd></div>
      <div><dt>Added by you</dt><dd>${s.added}</dd></div>
      <div><dt>Removed</dt><dd>${s.removed}</dd></div>
    </dl>
    ${noUnit ? `<p class="hint">${noUnit} counted ${noUnit === 1 ? 'item has' : 'items have'} no unit yet.</p>` : ''}
    ${s.blank ? `<button type="button" class="btn ghost" data-act="todo">${S.todo ? 'Show everything' : 'Show what is not counted yet'}</button>` : '<p class="small">Every item has a count.</p>'}`
}
const refresh = (it) => { updShelf(it.shelf); updBar() }

// ---------------------------------------------------------------- finding and filtering

function applyFilter() {
  const q = fold(S.q)
  const filtering = !!q || S.todo
  if (filtering && !S.openBefore) S.openBefore = new Map($$('.shelf').map((d) => [d, d.open]))
  let hits = 0
  for (const sh of $$('.shelf')) {
    let n = 0
    for (const row of $$(':scope > .items > .it', sh)) {
      const it = S.byId.get(row.dataset.id)
      const show = (!q || fold(it.name).includes(q) || fold(it.sheet_name).includes(q)) && (!S.todo || it.count === null || it.count === undefined)
      row.hidden = !show
      if (show) n++
    }
    hits += n
    sh.hidden = filtering && !n
    if (filtering) sh.open = n > 0
  }
  if (!filtering && S.openBefore) {
    for (const [d, o] of S.openBefore) d.open = o
    S.openBefore = null
  }
  $('#nohit').hidden = !filtering || hits > 0
  $('#nohit').textContent = q ? 'Nothing on the list by that name. If you counted it, tap + Add an item on its shelf.' : 'Every item has a count.'
  $('#todoBtn').classList.toggle('on', S.todo)
  $('#todoBtn').setAttribute('aria-pressed', String(S.todo))
  updBar()
}

/** The next item's Count box, opening its shelf: Enter and Tab go down the sheet line by line. */
function nextCount(from) {
  const all = $$('.shelf:not([hidden]) > .items > .it:not([hidden]) .cnt')
  const at = all.indexOf(from)
  const next = all[at + 1]
  if (!next) { from.blur(); $('#summary').scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
  const sh = next.closest('.shelf')
  if (!sh.open) sh.open = true
  next.focus({ preventScroll: true })
  next.scrollIntoView({ behavior: 'smooth', block: 'center' })
  next.select()
}

// ---------------------------------------------------------------- what she does

function setCount(it, row, value, wait) {
  it.count = value
  row.classList.remove('s-blank', 's-zero', 's-counted')
  row.classList.add(stateOf(it))
  const z = row.querySelector('.zero')
  z.classList.toggle('on', value === 0)
  z.setAttribute('aria-pressed', String(value === 0))
  save(it.id, 'count', value, wait)
  refresh(it)
}
function setUnit(it, row, u) {
  it.unit = u
  for (const b of $$('.u[data-u]', row)) b.classList.toggle('on', b.dataset.u === u)
  row.querySelector('.rl-u').textContent = rlUnit(it)
  save(it.id, 'unit', u)
  refresh(it)
}
function moveRow(it) {
  const old = document.getElementById(`i-${it.id}`)
  const sh = $$('.shelf').find((x) => x.dataset.shelf === it.shelf)
  if (old) old.remove()
  const into = it.gone ? sh.querySelector('.ritems') : sh.querySelector(':scope > .items')
  // keep the sheet's order when an item comes back
  const after = [...into.children].find((r) => (S.byId.get(r.dataset.id) || {}).sort > it.sort)
  const html = itemHtml(it)
  if (after) after.insertAdjacentHTML('beforebegin', html)
  else into.insertAdjacentHTML('beforeend', html)
  refresh(it)
}

// ---------------------------------------------------------------- what other screens changed (N-1, N-4)

/** Remember what the server holds for every field of a line. */
function learn(it) {
  for (const f of ITEM_FIELDS) known.set(`${it.id}|${f}`, it[f] ?? null)
}
const focusedField = (row) => (row && row.contains(document.activeElement) ? document.activeElement.dataset.f || '' : '')

/** One field changed by another screen: shown, without touching a box that is being typed in (unless `force`). */
function applyField(id, field, value, force = false) {
  if (!id) {
    S.sheet[field] = value
    const el = $(`[data-sheet="${field}"]`)
    if (el && (force || el !== document.activeElement)) { el.value = value ?? ''; good(el) }
    return
  }
  const it = S.byId.get(id)
  if (!it) return
  it[field] = value
  if (field === 'gone') { moveRow(it); applyFilter(); return }
  const row = document.getElementById(`i-${id}`)
  if (!row) return
  if (it.gone) { row.outerHTML = removedHtml(it); refresh(it); return }
  const busyF = force ? '' : focusedField(row)
  if (field === 'count' && busyF !== 'count') {
    const inp = row.querySelector('.cnt')
    inp.value = num(value)
    good(inp)
    row.querySelector('.rb').textContent = ''
    row.querySelector('.askc').hidden = true
    row.classList.remove('s-blank', 's-zero', 's-counted')
    row.classList.add(stateOf(it))
    const z = row.querySelector('.zero')
    z.classList.toggle('on', value === 0)
    z.setAttribute('aria-pressed', String(value === 0))
  } else if (field === 'unit' && busyF !== 'unit') {
    row.querySelector('.units').outerHTML = unitsHtml(it)
    row.querySelector('.rl-u').textContent = rlUnit(it)
  } else if (field === 'reorder' && busyF !== 'reorder') {
    const rl = row.querySelector('.rl-in')
    rl.value = num(value)
    good(rl)
  } else if (field === 'note' && busyF !== 'note') {
    const nt = row.querySelector('.nt')
    nt.value = value || ''
    good(nt)
  } else if (field === 'name' && busyF !== 'name') {
    row.querySelector('.it-name').outerHTML = nameHtml(it)
  }
  if (force && !row.querySelector('.upd')) row.insertAdjacentHTML('beforeend', '<p class="upd">Updated on another screen</p>')
  refresh(it)
}

/** N-4: every 25 seconds, what other screens saved. A field waiting to save here, or being typed in, is left alone. */
async function look() {
  if (document.hidden || busy || queue.size) return
  let r
  try { r = await call({ action: 'open' }) } catch { return }
  if (r.status !== 200 || busy || queue.size) return
  for (const raw of r.body.items) {
    const s = { ...raw, count: raw.count === null || raw.count === undefined ? null : Number(raw.count),
      reorder: raw.reorder === null || raw.reorder === undefined ? null : Number(raw.reorder), unit: raw.unit || '', note: raw.note || '' }
    const it = S.byId.get(s.id)
    if (!it) {
      // a line added on another screen
      S.items.push(s)
      S.byId.set(s.id, s)
      learn(s)
      moveRow(s)
      continue
    }
    const row = document.getElementById(`i-${s.id}`)
    for (const f of ITEM_FIELDS) {
      const k = `${s.id}|${f}`
      if (queue.has(k) || same(s[f], known.get(k))) continue
      if (focusedField(row) === f) continue // she is typing here: her save will be checked against the server
      known.set(k, s[f] ?? null)
      if (!same(it[f], s[f])) applyField(s.id, f, s[f] ?? null)
    }
  }
  for (const f of SHEET_FIELDS) {
    const k = `|${f}`
    const v = (r.body.sheet || {})[f] ?? null
    if (queue.has(k) || same(v, known.get(k)) || $(`[data-sheet="${f}"]`) === document.activeElement) continue
    known.set(k, v)
    applyField(null, f, v)
  }
  if (!S.canEdit) renderChanges(r.body.changes || [])
  applyFilter()
}

function onInput(e, final) {
  if (!S.canEdit) return
  const el = e.target
  if (el.dataset.sheet) {
    const v = validate(el.dataset.sheet, el.value)
    if (!v.ok) return bad(el, v.problem)
    good(el)
    return save(null, el.dataset.sheet, v.value, final ? 0 : 900)
  }
  const row = el.closest('.it')
  const it = row && S.byId.get(row.dataset.id)
  if (!it) return
  const f = el.dataset.f
  if (f === 'count') {
    const v = parseCount(el.value)
    row.querySelector('.rb').textContent = v.ok ? readBack(el.value) : ''
    const askc = row.querySelector('.askc')
    if (!v.ok) { askc.hidden = true; return bad(el, v.problem) }
    if (v.ask) {
      // N-3: 1,500 could be 1.5 or 1500. Nothing is saved until she picks.
      bad(el, `did you mean ${v.ask[0]} or ${v.ask[1]}?`)
      // drawn once per question: leaving the box to tap an answer must not swap the buttons under her finger
      if (askc.hidden || askc.dataset.ask !== String(v.ask)) {
        askc.innerHTML = `<span>Did you mean</span>${v.ask.map((n) => `<button type="button" class="u" data-act="pick" data-v="${n}">${n}</button>`).join('<span>or</span>')}`
        askc.dataset.ask = String(v.ask)
        askc.hidden = false
      }
      return
    }
    askc.hidden = true
    good(el)
    if (v.value !== it.count) setCount(it, row, v.value, final ? 0 : 700)
    else if (final) save(it.id, 'count', v.value, 0)
  } else if (f === 'reorder') {
    const v = parseCount(el.value)
    if (!v.ok) return bad(el, v.problem)
    if (v.ask) return bad(el, `type ${v.ask[0]} or ${v.ask[1]}, so it cannot be read the wrong way.`)
    good(el)
    it.reorder = v.value
    save(it.id, 'reorder', v.value, final ? 0 : 700)
  } else if (f === 'unit') {
    const v = validate('unit', el.value)
    if (!v.ok) return bad(el, v.problem)
    good(el)
    it.unit = v.value
    for (const b of $$('.u[data-u]', row)) b.classList.toggle('on', b.dataset.u === v.value)
    row.querySelector('.rl-u').textContent = rlUnit(it)
    save(it.id, 'unit', v.value, final ? 0 : 900)
    refresh(it)
  } else if (f === 'note') {
    const v = validate('note', el.value)
    if (!v.ok) return bad(el, v.problem)
    good(el)
    it.note = v.value
    save(it.id, 'note', v.value, final ? 0 : 900)
  } else if (f === 'name' && final) {
    const v = validate('name', el.value)
    if (!v.ok) return bad(el, v.problem)
    good(el)
    renameTo(it, v.value)
  }
}

function renameTo(it, name) {
  if (name !== it.name) { it.name = name; save(it.id, 'name', name) }
  const row = document.getElementById(`i-${it.id}`)
  row.querySelector('.it-name').outerHTML = nameHtml(it)
  row.querySelector('.rn').hidden = true
  row.querySelector('.cnt').setAttribute('aria-label', `Count for ${name}`)
}
function openRename(it, row) {
  const p = row.querySelector('.rn')
  if (!p.hidden) { p.hidden = true; return }
  row.querySelector('.rm').hidden = true
  p.innerHTML = `<label class="pl" for="rn-${esc(it.id)}">The name you use</label>
    <div class="nbox"><input id="rn-${esc(it.id)}" type="text" maxlength="120" data-f="name" value="${esc(it.name)}" autocomplete="off"></div>
    <div class="p-acts"><button type="button" class="btn sm" data-act="rename-done">Save name</button>
    ${!it.added && it.name !== it.sheet_name ? '<button type="button" class="btn ghost sm" data-act="rename-back">Use the sheet\'s name</button>' : ''}
    <button type="button" class="lnk" data-act="close">Cancel</button></div>`
  p.hidden = false
  const inp = p.querySelector('input')
  inp.focus()
  inp.select()
}
function openRemove(it, row) {
  const p = row.querySelector('.rm')
  if (!p.hidden) { p.hidden = true; return }
  row.querySelector('.rn').hidden = true
  const here = S.items.filter((x) => !x.gone && x.id !== it.id && x.shelf === it.shelf)
  const there = S.items.filter((x) => !x.gone && x.id !== it.id && x.shelf !== it.shelf)
  const opt = (x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`
  p.innerHTML = `<p class="pl">Why? (if you want to say)</p>
    <div class="reasons">${GONE_REASONS.map(([k, w]) => `<button type="button" class="u" data-act="reason" data-r="${k}">${esc(w)}</button>`).join('')}</div>
    <div class="same" hidden><label class="pl" for="sa-${esc(it.id)}">Same as</label>
      <select id="sa-${esc(it.id)}"><option value="">Choose the item it duplicates</option>
        <optgroup label="${esc(it.shelf)}">${here.map(opt).join('')}</optgroup><optgroup label="Other shelves">${there.map(opt).join('')}</optgroup></select></div>
    <div class="p-acts"><button type="button" class="btn sm warn" data-act="remove-do">Remove it</button><button type="button" class="lnk" data-act="close">Cancel</button></div>`
  p.hidden = false
}

async function addItem(box) {
  const shelf = box.closest('.shelf').dataset.shelf
  const nameEl = box.querySelector('.a-name')
  const cntEl = box.querySelector('.a-cnt')
  const unitEl = box.querySelector('.a-unit')
  const noteEl = box.querySelector('.a-note')
  const name = validate('name', nameEl.value)
  if (!name.ok) { bad(nameEl, 'type the item\'s name first.'); nameEl.focus(); return }
  good(nameEl)
  const count = parseCount(cntEl.value)
  if (!count.ok) { bad(cntEl, count.problem); cntEl.focus(); return }
  if (count.ask) { bad(cntEl, `type ${count.ask[0]} or ${count.ask[1]}, so it cannot be read the wrong way.`); cntEl.focus(); return }
  good(cntEl)
  const unit = validate('unit', unitEl.value)
  if (!unit.ok) { bad(unitEl, unit.problem); return }
  const note = validate('note', noteEl.value)
  if (!note.ok) { bad(noteEl, note.problem); return }
  status('saving', 'Adding...')
  let r
  try { r = await call({ action: 'add', shelf, where: box.dataset.where, name: name.value, count: count.value, unit: unit.value, note: note.value }) } catch { r = { status: 0, body: {} } }
  if (r.status !== 200) { status('bad', `Not added: ${r.body.problem || 'no connection. Please try again.'}`); return }
  const it = { note: '', gone: false, gone_reason: null, same_as: null, sheet_name: '', comes_as: '', ...r.body.item }
  S.items.push(it)
  S.byId.set(it.id, it)
  learn(it)
  // added from the top of a shelf, it shows at the top, where she is; from the bottom, at the bottom
  box.closest('.shelf').querySelector(':scope > .items').insertAdjacentHTML(box.dataset.where === 'top' ? 'afterbegin' : 'beforeend', itemHtml(it))
  nameEl.value = ''
  cntEl.value = ''
  unitEl.value = ''
  noteEl.value = ''
  refresh(it)
  status('ok', `Added ${hhmm()}`)
  nameEl.focus()
}

function wire() {
  const main = $('#main')
  main.addEventListener('input', (e) => onInput(e, false))
  main.addEventListener('change', (e) => onInput(e, true))
  main.addEventListener('keydown', (e) => {
    const el = e.target
    if (el.classList.contains('cnt') && (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey))) {
      e.preventDefault()
      onInput({ target: el }, true)
      if (!el.closest('.it').querySelector('.askc').hidden) return
      nextCount(el)
    } else if ((el.classList.contains('nt') || el.classList.contains('rl-in')) && e.key === 'Enter') {
      e.preventDefault()
      onInput({ target: el }, true)
      nextCount(el.closest('.it').querySelector('.cnt'))
    } else if (el.dataset.f === 'name' && e.key === 'Enter') {
      e.preventDefault()
      onInput({ target: el }, true)
    } else if (el.closest('.add') && e.key === 'Enter') {
      e.preventDefault()
      addItem(el.closest('.add'))
    }
  })
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]')
    if (go) {
      const row = document.getElementById(`i-${go.dataset.go}`)
      if (row) { for (let d = row.closest('details'); d; d = d.parentElement.closest('details')) d.open = true; row.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
      return
    }
    const b = e.target.closest('[data-act]')
    if (!b) return
    const act = b.dataset.act
    if (act === 'todo') { S.todo = !S.todo; applyFilter(); if (S.todo) $('#list').scrollIntoView({ behavior: 'smooth' }); return }
    if (!S.canEdit) return
    if (act === 'add') return addItem(b.closest('.add'))
    if (act === 'add-open') {
      const box = b.closest('.add')
      b.hidden = true
      box.querySelector('.add-form').hidden = false
      box.querySelector('.a-name').focus()
      return
    }
    if (act === 'add-close') {
      const box = b.closest('.add')
      box.querySelector('.add-form').hidden = true
      box.querySelector('.addbtn').hidden = false
      return
    }
    const row = b.closest('.it')
    const it = row && S.byId.get(row.dataset.id)
    if (!it) return
    if (act === 'pick') {
      const inp = row.querySelector('.cnt')
      const v = Number(b.dataset.v)
      inp.value = String(v)
      row.querySelector('.askc').hidden = true
      row.querySelector('.rb').textContent = ''
      good(inp)
      setCount(it, row, v, 0)
      inp.focus()
    } else if (act === 'zero') {
      const v = it.count === 0 ? null : 0
      const inp = row.querySelector('.cnt')
      inp.value = num(v)
      row.querySelector('.askc').hidden = true
      row.querySelector('.rb').textContent = ''
      good(inp)
      setCount(it, row, v, 0)
    } else if (act === 'unit') {
      setUnit(it, row, it.unit === b.dataset.u ? '' : b.dataset.u)
      row.querySelector('.uo').value = ''
      good(row.querySelector('.uo'))
    } else if (act === 'other') {
      const uo = row.querySelector('.uo')
      uo.hidden = false
      b.remove()
      uo.focus()
    } else if (act === 'more') {
      row.querySelector('.rest').hidden = false
      b.remove()
    } else if (act === 'rename') {
      openRename(it, row)
    } else if (act === 'rename-done') {
      const inp = row.querySelector('[data-f="name"]')
      const v = validate('name', inp.value)
      if (!v.ok) { bad(inp, v.problem); return }
      good(inp)
      renameTo(it, v.value)
    } else if (act === 'rename-back') {
      renameTo(it, it.sheet_name)
    } else if (act === 'remove') {
      openRemove(it, row)
    } else if (act === 'reason') {
      const on = !b.classList.contains('on')
      for (const x of $$('[data-act="reason"]', row)) x.classList.toggle('on', on && x === b)
      row.querySelector('.same').hidden = !(on && b.dataset.r === 'duplicate')
    } else if (act === 'remove-do') {
      const r = row.querySelector('[data-act="reason"].on')
      const reason = r ? r.dataset.r : null
      const sameAs = reason === 'duplicate' ? row.querySelector('.same select').value || null : null
      if (reason !== it.gone_reason) { it.gone_reason = reason; save(it.id, 'gone_reason', reason) }
      if (sameAs !== it.same_as) { it.same_as = sameAs; save(it.id, 'same_as', sameAs) }
      it.gone = true
      save(it.id, 'gone', true)
      for (const el of $$('input', row)) invalid.delete(el)
      moveRow(it)
      showProblems()
    } else if (act === 'undo') {
      it.gone = false
      save(it.id, 'gone', false)
      if (it.gone_reason) { it.gone_reason = null; save(it.id, 'gone_reason', null) }
      if (it.same_as) { it.same_as = null; save(it.id, 'same_as', null) }
      moveRow(it)
      applyFilter()
    } else if (act === 'close') {
      b.closest('.panel').hidden = true
    }
  })
  $('#search').addEventListener('input', () => { S.q = $('#search').value; applyFilter() })
  $('#search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const first = $('.shelf:not([hidden]) > .items > .it:not([hidden]) .cnt')
    if (first && !first.disabled) { first.closest('.shelf').open = true; first.focus({ preventScroll: true }); first.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
  })
  $('#todoBtn').addEventListener('click', () => { S.todo = !S.todo; applyFilter() })
}

// ---------------------------------------------------------------- Tarryn's view: every change

const FIELD_WORDS = { count: 'count', reorder: 'reorder when it gets to', unit: 'unit', note: 'note', name: 'renamed', gone: 'Remove', gone_reason: 'why removed', same_as: 'same as',
  date: 'date', counted_by: 'counted by', checked_by: 'checked by', added: 'added an item' }
function said(c, v) {
  if (c.field === 'gone') return v ? 'Removed from the list' : 'Undo: back on the list'
  if (v === null || v === undefined || v === '') return c.field === 'count' ? '<i>not counted</i>' : c.field === 'reorder' ? '<i>no level</i>' : '<i>empty</i>'
  if (c.field === 'gone_reason') return esc(REASON[v] || v)
  if (c.field === 'same_as') return esc((S.byId.get(v) || {}).name || v)
  if (c.field === 'date') return esc(String(v).split('-').reverse().join('/'))
  if (c.field === 'added') return esc(`${v.name}${v.count !== null && v.count !== undefined ? `: ${v.count}${v.unit ? ` ${v.unit}` : ''}` : ''}`)
  return esc(String(v))
}
function renderChanges(changes) {
  const el = $('#changes')
  el.hidden = false
  const when = (t) => new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  const was = el.querySelector('details')
  const open = was ? was.open : false
  const scroll = was ? (was.querySelector('.clist') || {}).scrollTop || 0 : 0
  el.innerHTML = `<details class="hist"${open ? ' open' : ''}><summary><span class="h2">Every change</span> <span class="n">${changes.length}</span></summary>
    ${changes.length ? '' : '<p class="small">No changes yet.</p>'}
    <ol class="clist">${changes.map((c) => `<li><div class="c-top"><b>${esc(c.who)}</b> <span class="muted">${when(c.at)}</span></div>
        <div>${c.item ? `<button type="button" class="lnk" data-go="${esc(c.item)}">${esc(c.name || c.item)}</button> <span class="muted">${esc(c.shelf || '')}</span>, ` : 'Top of the sheet, '}${esc(FIELD_WORDS[c.field] || c.field)}</div>
        <p>${c.field === 'added' || c.field === 'gone' ? said(c, c.after) : `${said(c, c.before)} <b>to</b> ${said(c, c.after)}`}</p></li>`).join('')}</ol></details>`
  const list = el.querySelector('.clist')
  if (list) list.scrollTop = scroll
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
    $('#list').innerHTML = `<p class="loading">${esc(r.body.problem || 'The list could not be loaded. Check your connection and refresh.')}</p>`
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
  S.items = d.items.map((i) => ({ ...i, count: i.count === null || i.count === undefined ? null : Number(i.count),
    reorder: i.reorder === null || i.reorder === undefined ? null : Number(i.reorder), unit: i.unit || '', note: i.note || '' }))
  S.byId = new Map(S.items.map((x) => [x.id, x]))
  for (const it of S.items) if (!it.added && !S.shelves.includes(it.shelf)) S.shelves.push(it.shelf)
  const sheet = { ...(d.sheet || {}) }
  for (const it of S.items) learn(it)
  for (const f of SHEET_FIELDS) known.set(`|${f}`, sheet[f] ?? null)

  // Anything typed here that had not reached the server (a refresh, a dropped connection) goes again with the base it
  // was typed against, so the server refuses it if another screen changed that field since (N-1). Lines in the old
  // shape (no base) are dropped: they cannot be checked.
  const waiting = {}
  if (S.canEdit) {
    const o = lsRead()
    for (const [k, e] of Object.entries(o)) {
      if (!(e && typeof e === 'object' && 'v' in e && 'base' in e)) { delete o[k]; continue }
      const [id, field] = k.split('|')
      if (!(id ? ITEM_FIELDS : SHEET_FIELDS).includes(field) || (id && !S.byId.has(id))) { delete o[k]; continue }
      waiting[k] = e
      if (!id) sheet[field] = e.v
      else S.byId.get(id)[field] = e.v
    }
    lsWrite(o)
  }
  S.sheet = sheet

  $('#sDate').value = sheet.date || ''
  $('#sCounted').value = sheet.counted_by || ''
  $('#sChecked').value = sheet.checked_by || ''
  $('#sheet').hidden = false
  $('#find').hidden = false
  $('#summary').hidden = false
  if (!S.canEdit) {
    document.body.classList.add('view')
    $('#whoLine').textContent = 'Tarryn\'s view: what Lindsay has entered, and every change, newest first. It updates by itself. This link can only look.'
    for (const el of $$('#sheet input')) el.disabled = true
    renderChanges(d.changes || [])
  }
  // open where she left off: the first shelf with a line not yet counted
  const firstTodo = S.canEdit ? S.shelves.find((sh) => itemsOf(sh).some((i) => !i.gone && i.count === null)) : null
  const shelves = [...S.shelves, OTHER_SHELF]
  $('#list').innerHTML = shelves.map((sh, n) => shelfHtml(sh, n, sh === firstTodo)).join('')
  if (!$('#unitList')) document.body.insertAdjacentHTML('beforeend', `<datalist id="unitList">${ALL_UNITS.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>`)
  for (const sh of shelves) updShelf(sh)
  updBar()
  wire()
  status('ok', S.canEdit ? 'Changes save as you go' : 'Read only')
  for (const [k, e] of Object.entries(waiting)) {
    queue.set(k, e)
    timers.set(k, setTimeout(flush, 0))
  }
  if (queue.size) status('saving', 'Saving...')
  setInterval(look, POLL_MS)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) look() })
}
start()
