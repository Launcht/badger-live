/*
 * Lindsay's supplier review page (17/11/2026). Plain browser code, no build. The rules (what may be saved, the phone
 * and email checks, what counts as checked) are in supplierreview.js, a copy of shared/supplierreview.js made at
 * deploy, so the page and the server cannot disagree. The key is in the link after # (never sent to a web server's
 * log), and goes in the request body. The page holds no supplier details and no notes: all of it comes with the key.
 */
import { validate, progress, isChecked, stillSuggested, ORDER_WAYS, ORDER_WORDS, localPhone, confirmProblem, carryAcross,
  DAYS, LEAD_TIMES, DAY_LEADS, PAY_HOW, windowOk, WINDOW_PROBLEM } from './supplierreview.js'

const API = 'https://nptyrtjdvqglgwkaepce.supabase.co/functions/v1/badger-suppliers'
const key = new URLSearchParams(location.hash.slice(1)).get('k') || ''
const GROUPS = [['use', 'Suppliers you use now'], ['other', 'Other suppliers in Odoo'], ['new', 'Added by you']]

const S = { suppliers: [], byId: new Map(), canEdit: false, who: '', show: 'all' }
const $ = (s, el = document) => el.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
let seq = 0
const nid = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`
const hhmm = (t = new Date()) => `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`

// ---------------------------------------------------------------- talking to the server

async function call(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, key }) })
  let j = {}
  try { j = await r.json() } catch { /* nothing to read */ }
  return { status: r.status, body: j }
}

const queue = new Map() // `${supplier}|${field}` -> the value waiting to be saved
const timers = new Map()
let busy = false
let lastProblem = ''
// fields holding something that cannot be saved: while any is left, the bar never says "Saved"
const invalid = new Map() // element -> problem
function bad(el, problem, quiet = false) {
  invalid.set(el, problem)
  if (!quiet) {
    if (!el.dataset.errid) el.dataset.errid = nid()
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
  }
  showProblems()
}
function good(el) {
  const had = invalid.has(el) || el.classList.contains('bad')
  invalid.delete(el)
  el.classList.remove('bad')
  el.removeAttribute('aria-invalid')
  const msg = el.dataset.errid && document.querySelector(`.err[data-for="${el.dataset.errid}"]`)
  if (msg) msg.remove()
  if (had) showProblems()
}
function showProblems() {
  for (const el of [...invalid.keys()]) if (!el.isConnected) invalid.delete(el)
  if (invalid.size) status('bad', `Not saved: ${[...invalid.values()][0]}`)
  else if (!queue.size && !busy && !lastProblem) status('ok', `Saved ${hhmm()}`)
}
function status(kind, text) {
  const el = $('#status')
  el.className = `status ${kind}`
  el.textContent = text
}
function forget(id, field) {
  const k = `${id ?? ''}|${field}`
  queue.delete(k)
  clearTimeout(timers.get(k))
}
function save(id, field, value, wait = 0) {
  const k = `${id ?? ''}|${field}`
  queue.set(k, structuredClone(value))
  clearTimeout(timers.get(k))
  if (!invalid.size) status('saving', 'Saving...')
  timers.set(k, setTimeout(flush, wait))
}
async function flush() {
  if (busy) return
  busy = true
  try {
    while (queue.size) {
      const [k, value] = queue.entries().next().value
      queue.delete(k)
      const [sid, field] = k.split('|')
      let r
      try {
        r = await call({ action: 'save', supplier: sid || null, field, value })
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
    else if (!lastProblem) status('ok', `Saved ${hhmm()}`)
  } finally {
    busy = false
  }
  if (queue.size) flush()
}
addEventListener('beforeunload', (e) => {
  if (queue.size || busy || invalid.size) { e.preventDefault(); e.returnValue = '' }
})

// ---------------------------------------------------------------- one supplier

const SRC = { odoo: 'Odoo', loyverse: 'Loyverse', both: 'Odoo and Loyverse', new: 'Added by you' }
const ro = () => (S.canEdit ? '' : ' disabled')
// what a "Yes, same" carried onto this card from the other one (test 03, finding 3): Suggested until she checks it
const CARRY = ['contact', 'email', 'phone', 'whatsapp', 'wa_same', 'order_by']
const EMPTY = { contact: '', email: '', phone: '', whatsapp: '', wa_same: false, order_by: [] }
function carriedFrom(s, f) {
  if (s.confirmed) return null
  for (const x of S.suppliers) {
    if (x.same !== true || !x.seed.ask || x.seed.ask.id !== s.id) continue
    const want = carryAcross(x, { ...s, [f]: EMPTY[f] })[f]
    if (want !== undefined && JSON.stringify(want) === JSON.stringify(s[f]) && JSON.stringify(s[f]) !== JSON.stringify(EMPTY[f])) return x
  }
  return null
}
const showPhone = (v) => localPhone(v) || v || ''
const sugTag = (s, f) => {
  const from = CARRY.includes(f) && carriedFrom(s, f)
  if (from) return `<span class="tag was" title="${esc(`From ${from.name}`)}">Suggested</span>`
  if (!stillSuggested(s, f)) return ''
  // a name is only our suggestion where I tidied Odoo's capitals; otherwise it is simply her own name for them
  if (f === 'name' && !(s.seed && s.seed.name_was)) return ''
  const was = f === 'name' && s.seed.name_was ? ` title="${esc(`Odoo says: ${s.seed.name_was}`)}"` : ''
  return `<span class="tag${was ? ' was' : ''}"${was}>Suggested</span>`
}
const fid = (s, f) => `f-${s.id}-${f}`

function suppliesHtml(s) {
  const all = (s.seed && s.seed.supplies) || []
  const note = s.seed && s.seed.odoo_note ? `<p class="supplies">Odoo note: ${esc(s.seed.odoo_note)}</p>` : ''
  if (!all.length) return `${note}${note ? '' : '<p class="supplies">No items on record for them.</p>'}`
  const first = all.slice(0, 4).map(esc).join(', ')
  const rest = all.slice(4)
  return `<p class="supplies">Supplies: ${first}${rest.length ? `<span class="rest" hidden>, ${rest.map(esc).join(', ')}</span> <button type="button" class="more-items" data-more>and ${rest.length} more</button>` : ''}</p>${note}`
}
function sourceWords(s) {
  const loy = (s.seed && s.seed.loyverse) || []
  if (s.source === 'both') {
    const sameName = loy.every((n) => n.toLowerCase() === String(s.seed.odoo_name || '').toLowerCase())
    return sameName ? 'Odoo and Loyverse' : `Odoo, and Loyverse as ${loy.join(', ')}`
  }
  return SRC[s.source] || s.source
}
function orderHints(s) {
  const out = []
  const wa = s.wa_same ? s.phone : s.whatsapp
  const where = isChecked(s) ? ': tap Change below to add it.' : ' above.'
  const ways = shownWays(s)
  if (ways.includes('email') && !s.email) out.push(`No email yet${where}`)
  if (ways.includes('whatsapp') && !wa) out.push(`No WhatsApp number yet${where}`)
  if (ways.includes('phone') && !s.phone) out.push(`No phone number yet${where}`)
  if (s.still_used === true && !ways.length) out.push('Tick at least one, if you know.')
  return out.length ? `<p class="hint">${out.map(esc).join(' ')}</p>` : ''
}
function summaryHtml(s) {
  if (s.still_used === false) return '<div class="sum"><p>Not used any more.</p></div>'
  const wa = s.wa_same ? s.phone : s.whatsapp
  const bits = [s.contact, s.email, s.phone && `Phone ${showPhone(s.phone)}`, wa && `WhatsApp ${showPhone(wa)}`].filter(Boolean)
  return `<div class="sum"><p>Still used: Yes</p>${bits.length ? `<p>${bits.map(esc).join(' / ')}</p>` : '<p>No contact details.</p>'}</div>`
}
function askHtml(s) {
  const a = s.seed && s.seed.ask
  if (!a) return ''
  if (s.same === true) {
    return `<div class="merged"><span>Same supplier as <b>${esc(a.name)}</b>. I will treat them as one.</span>
      ${S.canEdit ? '<button type="button" class="btn ghost" data-act="unmerge">Undo</button>' : ''}</div>`
  }
  return `<div class="ask ask-live"><p>Is this the same supplier as <b>${esc(a.name)}</b>? <span class="why">${esc(a.why)}</span></p>
    <div class="seg"><button type="button" data-act="same" data-v="true"${ro()}>Yes, same</button><button type="button" class="${s.same === false ? 'on' : ''}" data-act="same" data-v="false"${ro()}>No, different</button></div></div>`
}
function fieldsHtml(s) {
  const input = (f, label, type, extra = '') => `<div class="field">
      <div class="lbl-row"><label for="${fid(s, f)}">${label}</label>${sugTag(s, f)}</div>
      <input id="${fid(s, f)}" data-f="${f}" type="${type}" value="${esc(f === 'phone' ? showPhone(s[f]) : s[f])}" maxlength="${f === 'phone' || f === 'whatsapp' ? 30 : 120}"${extra}${ro()}>
    </div>`
  return `<div class="fields">
    <div class="keep">${input('name', 'Supplier name', 'text', ' autocomplete="off"')}</div>
    ${input('contact', 'Contact person', 'text', ' autocomplete="off" placeholder="Their name"')}
    ${input('email', 'Email', 'email', ' inputmode="email" autocomplete="off" placeholder="name@business.co.za"')}
    <div class="two">
      ${input('phone', 'Phone', 'tel', ' inputmode="tel" autocomplete="off" placeholder="082 123 4567"')}
      <div class="field">
        <div class="lbl-row"><span class="lab">WhatsApp</span>${sugTag(s, 'wa_same')}</div>
        <label class="tick"><input type="checkbox" data-f="wa_same"${s.wa_same ? ' checked' : ''}${ro()}> Same as phone</label>
        <div class="wa-own"${s.wa_same ? ' hidden' : ''}><input id="${fid(s, 'whatsapp')}" data-f="whatsapp" type="tel" inputmode="tel" autocomplete="off" maxlength="30" placeholder="WhatsApp number" aria-label="WhatsApp number" value="${esc(showPhone(s.whatsapp))}"${ro()}></div>
      </div>
    </div>
    <div class="field keep">
      <div class="lbl-row"><label for="${fid(s, 'notes')}">Notes</label></div>
      <textarea id="${fid(s, 'notes')}" data-f="notes" rows="2" maxlength="2000" placeholder="Anything else about them"${ro()}>${esc(s.notes)}</textarea>
    </div>
  </div>`
}
// ---------------------------------------------------------------- ordering, deliveries and paying (20/11/2026)
// The admin's own fields and choices (shared/supplierchoices.js). Open on every card she still uses, checked or not, so
// she never has to tap Change to fill them in. What the suppliers list already holds shows as Suggested (`held`, read
// only); nothing is stored for her until she taps or types.
const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
const heldOf = (s, f) => (s.held && !isEmpty(s.held[f]) ? s.held[f] : null)
/** What the box shows: her own value, else what the suppliers list holds. */
const cur = (s, f) => (!isEmpty(s[f]) ? s[f] : heldOf(s, f))
/** Her ticks, with any way the suppliers list already holds (Online from her own note, say) ticked too. */
function shownWays(s) {
  const held = heldOf(s, 'order_by') || []
  return ORDER_WAYS.filter((w) => s.order_by.includes(w) || held.includes(w))
}
const heldTag = '<span class="tag was" title="Already in the Badger system">Suggested</span>'
const heldShown = (s, f) => (f === 'order_by' ? shownWays(s).length > s.order_by.length : isEmpty(s[f]) && heldOf(s, f) !== null)
const tagFor = (s, f) => (heldShown(s, f) ? heldTag : f === 'order_by' ? sugTag(s, f) : '')
const isDayLead = (v) => v !== null && v !== undefined && DAY_LEADS.includes(String(v))

function extraHtml(s) {
  const ways = shownWays(s)
  const lead = cur(s, 'lead_hours')
  const days = cur(s, 'delivery_days') || []
  const pay = cur(s, 'pay_how')
  const pick = (f, list, now) => `<div class="picks" role="group">${list.map(([v, w]) => `<button type="button" class="pick${String(now ?? '') === v ? ' on' : ''}" data-act="pick" data-pf="${f}" data-v="${v}" aria-pressed="${String(now ?? '') === v}"${ro()}>${esc(w)}</button>`).join('')}</div>`
  const time = (f, label) => `<div class="field">
      <div class="lbl-row"><label for="${fid(s, f)}">${label}</label>${tagFor(s, f)}</div>
      <input id="${fid(s, f)}" data-f="${f}" type="time" step="900" value="${esc(cur(s, f) || '')}"${ro()}>
    </div>`
  const text = (f, label, max, ph) => `<div class="field">
      <div class="lbl-row"><label for="${fid(s, f)}">${label}</label>${tagFor(s, f)}</div>
      <input id="${fid(s, f)}" data-f="${f}" type="text" maxlength="${max}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(cur(s, f) || '')}"${ro()}>
    </div>`
  return `<div class="extra">
    <p class="x-title">Ordering, deliveries and paying</p>
    <p class="x-head">Ordering</p>
    <div class="field">
      <div class="lbl-row"><span class="lab">How do they take orders?</span>${tagFor(s, 'order_by')}</div>
      <div class="ways">${ORDER_WAYS.map((w) => `<label class="way${ways.includes(w) ? ' on' : ''}"><input type="checkbox" data-f="order_by" value="${w}"${ways.includes(w) ? ' checked' : ''}${ro()}>${ORDER_WORDS[w]}</label>`).join('')}</div>
      <div class="hints">${orderHints(s)}</div>
    </div>
    <div class="field">
      <div class="lbl-row"><span class="lab">Order lead time</span>${tagFor(s, 'lead_hours')}</div>
      ${pick('lead_hours', LEAD_TIMES, lead)}
      <p class="x-hint">How long before a delivery the order must be in. Days are working days, Monday to Friday.</p>
    </div>
    <div class="cut"${isDayLead(lead) ? '' : ' hidden'}>${time('order_cutoff', 'Order before (time of day)')}</div>
    <p class="x-head">Deliveries</p>
    <div class="field">
      <div class="lbl-row"><span class="lab">Delivery days</span>${tagFor(s, 'delivery_days')}</div>
      <div class="days">${DAYS.map(([d, w]) => `<label class="day${days.includes(d) ? ' on' : ''}"><input type="checkbox" data-f="delivery_days" value="${d}"${days.includes(d) ? ' checked' : ''}${ro()}>${w}</label>`).join('')}</div>
    </div>
    <div class="pair">${time('delivery_from', 'Delivers from')}${time('delivery_to', 'Delivers until')}</div>
    <p class="x-head">Paying</p>
    <div class="field">
      <div class="lbl-row"><span class="lab">How we pay them</span>${tagFor(s, 'pay_how')}</div>
      ${pick('pay_how', PAY_HOW, pay)}
    </div>
    ${text('account_number', 'Our account number with them', 60, 'If you have one')}
    ${text('terms', 'Payment terms', 200, '30 days from statement')}
  </div>`
}

function cardClass(s) {
  return ['card', 'sup', isChecked(s) && s.same !== true ? 'done' : '', s.still_used === false ? 'unused' : '', s.same === true ? 'merged-card' : ''].filter(Boolean).join(' ')
}
function cardHtml(s) {
  const seed = s.seed || {}
  const flags = (seed.flags || []).map((f) => `<div class="fix ${f.level === 'fix' ? 'fix' : 'check'}">${esc(f.text)}</div>`).join('')
  return `<article class="${cardClass(s)}" id="s-${esc(s.id)}" data-id="${esc(s.id)}">
    <div class="head">
      <h3 class="r-title"><span class="nm">${esc(s.name)}</span>${isChecked(s) ? '<span class="tag ok">Checked</span>' : ''}</h3>
      <p class="meta"><span>${esc(sourceWords(s))}</span>${flags ? '<span class="pill check">Worth a look</span>' : ''}</p>
      ${suppliesHtml(s)}
    </div>
    ${flags}
    ${askHtml(s)}
    <div class="need sup-need"><span>Still used?${sugTag(s, 'still_used') ? ` ${sugTag(s, 'still_used')}` : ''}</span>
      <button type="button" class="yn y${s.still_used === true ? ' on' : ''}" data-act="used" data-v="true"${ro()}>Yes</button>
      <button type="button" class="yn n${s.still_used === false ? ' on' : ''}" data-act="used" data-v="false"${ro()}>No</button>
      <p class="need-msg" hidden></p></div>
    ${summaryHtml(s)}
    ${fieldsHtml(s)}
    ${extraHtml(s)}
    <div class="foot-row">${S.canEdit ? (isChecked(s)
      ? '<span class="done-line">Checked.</span><button type="button" class="btn ghost" data-act="edit">Change</button>'
      : '<button type="button" class="btn good" data-act="confirm">Looks right</button>') : ''}</div>
  </article>`
}

// redraw one card in place, keeping whether it was open for changing
function redraw(s) {
  const old = document.getElementById(`s-${s.id}`)
  if (!old) return
  const editing = old.classList.contains('editing')
  for (const el of old.querySelectorAll('[data-f]')) invalid.delete(el)
  old.outerHTML = cardHtml(s)
  const now = document.getElementById(`s-${s.id}`)
  if (editing && isChecked(s)) now.classList.add('editing')
  applyFilter()
  updateProgress()
}

// ---------------------------------------------------------------- the whole list

function render() {
  const present = GROUPS.filter(([g]) => S.suppliers.some((s) => (s.grp || 'other') === g))
  $('#jump').innerHTML = present.map(([g, label]) => `<a href="#g-${g}" class="chip">${esc(label)}</a>`).join('')
  $('#list').innerHTML = present.map(([g, label]) => {
    const ss = S.suppliers.filter((s) => (s.grp || 'other') === g)
    return `<section class="cat grp" id="g-${g}"><h2>${esc(label)} <span class="n">${ss.length}</span></h2>${ss.map(cardHtml).join('')}</section>`
  }).join('')
  applyFilter()
  updateProgress()
}
function updateProgress() {
  const p = progress(S.suppliers)
  $('#prog').textContent = `${p.checked} of ${p.total} checked`
  $('#fill').style.width = `${p.total ? Math.round((p.checked / p.total) * 100) : 0}%`
}
function applyFilter() {
  for (const el of document.querySelectorAll('.card')) {
    const s = S.byId.get(el.dataset.id)
    el.hidden = S.show === 'todo' && s && isChecked(s)
  }
}

// ---------------------------------------------------------------- editing

function onField(e, final) {
  const el = e.target
  const f = el.dataset && el.dataset.f
  if (!f || !S.canEdit) return
  const holder = el.closest('.card')
  const s = holder && S.byId.get(holder.dataset.id)
  if (!s) return
  if (f === 'order_by') {
    if (!final) return
    const v = [...holder.querySelectorAll('input[data-f="order_by"]')].filter((x) => x.checked).map((x) => x.value)
    s.order_by = validate('order_by', v).value
    for (const w of holder.querySelectorAll('.way')) w.classList.toggle('on', w.querySelector('input').checked)
    holder.querySelector('.hints').innerHTML = orderHints(s)
    dropTag(el)
    save(s.id, 'order_by', s.order_by)
    return
  }
  if (f === 'delivery_days') {
    if (!final) return
    const v = [...holder.querySelectorAll('input[data-f="delivery_days"]')].filter((x) => x.checked).map((x) => x.value)
    s.delivery_days = validate('delivery_days', v).value
    for (const d of holder.querySelectorAll('.day')) d.classList.toggle('on', d.querySelector('input').checked)
    dropTag(el)
    save(s.id, 'delivery_days', s.delivery_days)
    return
  }
  if (f === 'wa_same') {
    if (!final) return
    s.wa_same = el.checked
    const own = holder.querySelector('.wa-own')
    own.hidden = s.wa_same
    const wa = own.querySelector('input')
    if (s.wa_same) { good(wa); forget(s.id, 'whatsapp') }
    holder.querySelector('.hints').innerHTML = orderHints(s)
    save(s.id, 'wa_same', s.wa_same)
    return
  }
  const v = validate(f, el.value)
  if (!v.ok) {
    // never sent; while typing only the bar says so, the box goes red when she leaves it
    forget(s.id, f)
    bad(el, v.problem, !final && !el.classList.contains('bad'))
    return
  }
  // the one window rule, against the other time as shown (shared/supplierchoices.js)
  if ((f === 'delivery_from' && !windowOk(v.value, cur(s, 'delivery_to'))) || (f === 'delivery_to' && !windowOk(cur(s, 'delivery_from'), v.value))) {
    forget(s.id, f)
    bad(el, WINDOW_PROBLEM, !final && !el.classList.contains('bad'))
    return
  }
  good(el)
  // Fix after test (N1, 20/11/2026): a time this change makes valid in the OTHER box was never sent while it was refused.
  // Check it on its own and save it now, after this one; if it still cannot be saved, it stays marked "Not saved".
  let other = null
  if (f === 'delivery_from' || f === 'delivery_to') {
    const of = f === 'delivery_from' ? 'delivery_to' : 'delivery_from'
    const o = holder.querySelector(`input[data-f="${of}"]`)
    if (o && (invalid.has(o) || o.classList.contains('bad'))) {
      const ov = validate(of, o.value)
      const win = of === 'delivery_to' ? windowOk(v.value, ov.value) : windowOk(ov.value, v.value)
      if (ov.ok && win) other = () => { good(o); s[of] = ov.value; dropTag(o); save(s.id, of, ov.value, final ? 0 : 900) }
      else if (ov.ok) bad(o, WINDOW_PROBLEM)
    }
  }
  if (f === 'name') holder.querySelector('.nm').textContent = v.value || s.name
  if (final && ['order_cutoff', 'delivery_from', 'delivery_to', 'account_number', 'terms'].includes(f)) dropTag(el)
  s[f] = v.value
  if (final) {
    // tidy what she typed (an email in small letters), and drop the Suggested mark if it no longer is
    if (f === 'email' && el.value.trim() !== v.value) el.value = v.value
    const tag = el.closest('.field') && el.closest('.field').querySelector('.tag')
    if (tag && !stillSuggested(s, f)) tag.remove()
  }
  if (['email', 'phone', 'whatsapp'].includes(f)) holder.querySelector('.hints').innerHTML = orderHints(s)
  save(s.id, f, v.value, final ? 0 : 900)
  if (other) other()
}

// her own value now: the Suggested mark for a value from the suppliers list goes
function dropTag(el) {
  const tag = el.closest('.field') && el.closest('.field').querySelector('.tag.was[title="Already in the Badger system"]')
  if (tag) tag.remove()
}
// a lead time or a way of paying: one tap picks it, a tap on her own pick clears it
function onPick(holder, s, b) {
  const f = b.dataset.pf
  const tapped = f === 'lead_hours' ? Number(b.dataset.v) : b.dataset.v
  const v = s[f] === tapped ? null : tapped
  s[f] = v
  const now = cur(s, f)
  for (const x of holder.querySelectorAll(`.pick[data-pf="${f}"]`)) {
    const on = String(now ?? '') === x.dataset.v
    x.classList.toggle('on', on)
    x.setAttribute('aria-pressed', String(on))
  }
  dropTag(b)
  save(s.id, f, v)
  if (f === 'lead_hours') {
    const cut = holder.querySelector('.cut')
    cut.hidden = !isDayLead(now)
    // an "order before" time only belongs to a lead time in whole days (the admin clears it the same way)
    if (cut.hidden && !isEmpty(s.order_cutoff)) {
      s.order_cutoff = null
      cut.querySelector('input').value = cur(s, 'order_cutoff') || ''
      save(s.id, 'order_cutoff', null)
    }
  }
}

function wire() {
  const main = $('#main')
  main.addEventListener('input', (e) => { if (e.target.id === 'anythingElse') return onAnything(false); onField(e, false) })
  main.addEventListener('change', (e) => { if (e.target.id === 'anythingElse') return onAnything(true); onField(e, true) })
  main.addEventListener('click', (e) => {
    // the full list of what they supply: reading, so it works on both links
    const more = e.target.closest('[data-more]')
    if (more) { more.previousElementSibling.hidden = false; more.remove(); return }
    const b = e.target.closest('[data-act]')
    if (!b || !S.canEdit) return
    const holder = b.closest('.card')
    const s = holder && S.byId.get(holder.dataset.id)
    if (!s) return
    const act = b.dataset.act
    if (act === 'pick') {
      onPick(holder, s, b)
    } else if (act === 'used') {
      const v = b.dataset.v === 'true'
      if (s.confirmed && s.still_used === v) return // a checked supplier keeps a Yes or No
      s.still_used = s.still_used === v ? null : v
      save(s.id, 'still_used', s.still_used)
      redraw(s)
    } else if (act === 'confirm') {
      const wrong = [...holder.querySelectorAll('[data-f]')].find((x) => invalid.has(x))
      if (wrong) { bad(wrong, invalid.get(wrong)); wrong.focus(); return }
      // never a quiet Yes (test 03, finding 2): she answers Still used herself, the card stays open until she does
      if (confirmProblem(s)) {
        const need = holder.querySelector('.sup-need')
        need.classList.add('ask-used')
        const msg = need.querySelector('.need-msg')
        msg.hidden = false
        msg.textContent = 'Do you still use them? Tap Yes or No, then Looks right.'
        need.scrollIntoView({ behavior: 'smooth', block: 'center' })
        need.querySelector('.yn').focus({ preventScroll: true })
        return
      }
      s.confirmed = true
      save(s.id, 'confirmed', true)
      redraw(s)
    } else if (act === 'edit') {
      holder.classList.add('editing')
    } else if (act === 'same') {
      const v = b.dataset.v === 'true'
      s.same = s.same === v ? null : v
      save(s.id, 'same', s.same)
      // Yes, same: what the other card is missing comes across from this one, marked Suggested (test 03, finding 3)
      const to = s.same === true && S.byId.get(s.seed.ask.id)
      if (to && !to.confirmed) {
        for (const [f, val] of Object.entries(carryAcross(s, to))) { to[f] = val; save(to.id, f, val) }
        redraw(to)
      }
      redraw(s)
    } else if (act === 'unmerge') {
      const to = S.byId.get(s.seed.ask.id)
      const back = to ? CARRY.filter((f) => carriedFrom(to, f)) : []
      if (!confirm(`Undo: keep ${s.name} as its own supplier?${back.length ? ` What I copied to ${to.name} comes off again.` : ''}`)) return
      for (const f of back) { to[f] = structuredClone(EMPTY[f]); save(to.id, f, to[f]) }
      s.same = null
      save(s.id, 'same', null)
      if (back.length) redraw(to)
      redraw(s)
    }
  })
  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]')
    if (!b) return
    S.show = b.dataset.show
    for (const x of document.querySelectorAll('#filter .chip')) x.classList.toggle('on', x === b)
    applyFilter()
  })
  $('#addBtn').addEventListener('click', addSupplier)
  $('#addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSupplier() })
}

function onAnything(final) {
  if (!S.canEdit) return
  const v = validate('anything_else', $('#anythingElse').value)
  if (!v.ok) { bad($('#anythingElse'), v.problem); return }
  good($('#anythingElse'))
  save(null, 'anything_else', v.value, final ? 0 : 900)
}

async function addSupplier() {
  const name = $('#addName').value.trim()
  if (!name) { $('#addName').focus(); return }
  status('saving', 'Adding...')
  let r
  try { r = await call({ action: 'add', name }) } catch { r = { status: 0, body: {} } }
  if (r.status !== 200) { status('bad', `Not added: ${r.body.problem || 'please try again.'}`); return }
  const s = { contact: '', email: '', phone: '', whatsapp: '', wa_same: false, order_by: [], still_used: true, notes: '', confirmed: false, same: null, seed: {},
    lead_hours: null, order_cutoff: null, delivery_days: [], delivery_from: null, delivery_to: null, pay_how: null, account_number: '', terms: '', held: null,
    ...r.body.supplier, grp: 'new' }
  S.suppliers.push(s)
  S.byId.set(s.id, s)
  $('#addName').value = ''
  // add the card without redrawing the others, so whatever she has open stays open
  let sec = document.getElementById('g-new')
  if (!sec) {
    sec = document.createElement('section')
    sec.className = 'cat grp'
    sec.id = 'g-new'
    sec.innerHTML = '<h2>Added by you <span class="n">0</span></h2>'
    $('#list').appendChild(sec)
    $('#jump').insertAdjacentHTML('beforeend', '<a href="#g-new" class="chip">Added by you</a>')
  }
  sec.insertAdjacentHTML('beforeend', cardHtml(s))
  sec.querySelector('h2 .n').textContent = String(sec.querySelectorAll('.card').length)
  updateProgress()
  status('ok', `Added ${hhmm()}`)
  const card = document.getElementById(`s-${s.id}`)
  card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const c = card.querySelector('[data-f="contact"]')
  if (c) c.focus({ preventScroll: true })
}

// ---------------------------------------------------------------- Tarryn's view: every change

const FIELD_WORDS = { name: 'name', contact: 'contact person', email: 'email', phone: 'phone', whatsapp: 'WhatsApp', wa_same: 'WhatsApp same as phone', order_by: 'how they take orders', still_used: 'still used', notes: 'notes', confirmed: 'Looks right', same: 'same supplier as', anything_else: 'anything else', added: 'added a supplier',
  lead_hours: 'order lead time', order_cutoff: 'order before', delivery_days: 'delivery days', delivery_from: 'delivers from', delivery_to: 'delivers until', pay_how: 'how we pay them', account_number: 'our account number', terms: 'payment terms' }
const words = (list, v) => (list.find(([k]) => k === String(v)) || [null, String(v)])[1]
function said(c, v) {
  if (v === null || v === undefined || v === '') return '<i>empty</i>'
  if (c.field === 'order_by') return v.length ? esc(v.map((w) => ORDER_WORDS[w] || w).join(', ')) : '<i>none ticked</i>'
  if (c.field === 'wa_same') return v ? 'ticked' : 'not ticked'
  if (c.field === 'lead_hours') return esc(words(LEAD_TIMES, v))
  if (c.field === 'pay_how') return esc(words(PAY_HOW, v))
  if (c.field === 'delivery_days') return v.length ? esc(v.map((d) => words(DAYS, d)).join(', ')) : '<i>none ticked</i>'
  if (c.field === 'phone' || c.field === 'whatsapp') return esc(showPhone(v))
  if (c.field === 'confirmed') return v ? 'checked' : 'not checked'
  if (c.field === 'still_used') return v ? 'Yes' : 'No'
  if (c.field === 'same') {
    const s = S.byId.get(c.supplier)
    const to = s && s.seed && s.seed.ask ? s.seed.ask.name : 'the other'
    return v ? esc(`Yes, same as ${to}`) : 'No, different'
  }
  return esc(typeof v === 'string' ? v : JSON.stringify(v))
}
function renderChanges(changes) {
  const el = $('#changes')
  el.hidden = false
  const when = (t) => new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  el.innerHTML = `<h2>Every change <span class="n">${changes.length}</span></h2>
    ${changes.length ? '' : '<p class="small">No changes yet.</p>'}
    <ol class="clist">${changes.map((c) => `<li><div class="c-top"><b>${esc(c.who)}</b> <span class="muted">${when(c.at)}</span></div>
        <div>${c.supplier ? `<a href="#s-${esc(c.supplier)}">${esc(c.name || c.supplier)}</a>, ` : ''}${esc(FIELD_WORDS[c.field] || c.field)}</div>
        <p>${c.field === 'added' ? said(c, c.after) : `${said(c, c.before)} <b>to</b> ${said(c, c.after)}`}</p></li>`).join('')}</ol>`
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
    $('#list').innerHTML = `<p class="loading">${esc(r.body.problem || 'The suppliers could not be loaded. Check your connection and refresh.')}</p>`
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
  S.suppliers = d.suppliers.map((s) => ({ ...s, order_by: Array.isArray(s.order_by) ? s.order_by : [], seed: s.seed || {},
    delivery_days: Array.isArray(s.delivery_days) ? s.delivery_days : [], account_number: s.account_number || '', terms: s.terms || '' }))
  S.byId = new Map(S.suppliers.map((x) => [x.id, x]))
  $('#anythingElse').value = d.notes || ''
  $('#anything').hidden = false
  $('#filter').hidden = false
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
