/**
 * Lindsay's supplier review page (17/11/2026). The rules in ONE place: what may be saved (phone and email checks
 * included), what counts as checked, and the door (which key may read, which may change). Used by the page
 * (supplier-review/page/, a copy made at deploy), its own Edge Function (supabase/functions/badger-suppliers/, a copy
 * made at deploy) and test/supplierreview.test.js.
 *
 * Brief: clients/wild-mongoo/badger/spec/2026-11-17-suppliers-review/01-brief-supplier-review-page.md
 *
 * One import only, shared/supplierchoices.js (itself import-free), copied beside this file at deploy. No Node or Deno
 * features: it must run in a browser, in Deno and in Node unchanged.
 *
 * Supplier fields on her page (20/11/2026, spec 2026-11-20-supplier-fields/03-build-review-page-fields.md): the same
 * ticks and picks the admin got that day (how they take orders, lead time, order before, delivery days and window, how we
 * pay them, our account number, payment terms), from the same lists, with the same checks.
 */
import { ORDER_WAYS as WAYS, DAYS, LEAD_TIMES, DAY_LEADS, PAY_HOW, ACCOUNT_MAX, TERMS_MAX, timeOf, windowOk, WINDOW_PROBLEM } from './supplierchoices.js'

// ---------------------------------------------------------------- what may be saved

/** The fields added on 20/11/2026, the admin's own (shared/supplierchoices.js). */
export const NEW_FIELDS = ['lead_hours', 'order_cutoff', 'delivery_days', 'delivery_from', 'delivery_to', 'pay_how', 'account_number', 'terms']
export const FIELDS = new Set(['name', 'contact', 'email', 'phone', 'whatsapp', 'wa_same', 'order_by', 'still_used', 'notes', 'confirmed', 'same', 'anything_else', ...NEW_FIELDS])
export const ORDER_WAYS = WAYS.map(([k]) => k)
export const ORDER_WORDS = Object.fromEntries(WAYS)
export { DAYS, LEAD_TIMES, DAY_LEADS, PAY_HOW, timeOf, windowOk, WINDOW_PROBLEM }
const LIMIT = { name: 120, contact: 120, email: 120, notes: 2000, anything_else: 8000, account_number: ACCOUNT_MAX, terms: TERMS_MAX }
export const ID = /^[a-z0-9-]{1,40}$/

const ok = (value) => ({ ok: true, value })
const no = (problem) => ({ ok: false, problem })

/** A South African number: 0 and 9 more digits, or +27 (or 27) and 9 digits. Spaces, dashes and brackets allowed. */
export function phoneOk(v) {
  const d = String(v).replace(/[\s\-().]/g, '')
  return /^0[1-9]\d{8}$/.test(d) || /^\+?27[1-9]\d{8}$/.test(d)
}
/** The ten digits as a person writes them: 082 471 2044, 044 874 3729. Null when it is not a number. */
export function localPhone(v) {
  if (v == null) return null
  const d = String(v).replace(/[\s\-().]/g, '')
  const ten = /^0[1-9]\d{8}$/.test(d) ? d : /^\+?27[1-9]\d{8}$/.test(d) ? `0${d.replace(/^\+?27/, '')}` : null
  return ten && `${ten.slice(0, 3)} ${ten.slice(3, 6)} ${ten.slice(6)}`
}
/** A cell number (06, 07, 08): one that can be on WhatsApp. A landline (01 to 05) usually cannot. */
export function isCell(v) {
  const l = localPhone(v)
  return !!l && /^0[678]/.test(l)
}
/** +27 and nine digits, the one way a number is stored (test 03, finding 4). Null when it is not a number. */
export function canonPhone(v) {
  const l = localPhone(v)
  return l && `+27${l.replace(/\s/g, '').slice(1)}`
}
// Fix after test 04 (N4): every Wild Mongoo domain, the pet one and any subdomain too.
export const OWN_DOMAIN = /@([a-z0-9-]+\.)*wildmongoo(pet)?\.(com|co\.za)$/i
// Addresses of the group (Wild Mongoo's, Badger's, Dotsure's) and of our own companies: never a supplier's email to
// fill in for her (test 03, finding 1). Found in her Odoo 17/11: wildmongoo.com, dotsure.co.za, badgerholdings.co.za,
// badgerins.co.za. Only Wild Mongoo's is refused when typed; the others are hers to decide.
const GROUP = [[OWN_DOMAIN, 'Wild Mongoo'], [/@dotsure\.co\.za$/i, 'Dotsure'], [/@badgerholdings\.co\.za$/i, 'Badger Holdings'],
  [/@badgerins\.co\.za$/i, 'Badger Insurance'], [/@honeyguide\.co\.za$/i, 'Honeyguide'], [/@kamb\.co\.za$/i, 'Kamb'],
  [/@assayhouse\.co\.za$/i, 'Assay House'], [/@parallaxai\.co\.za$/i, 'ParallaxAi'], [/@launcht\.co\.za$/i, 'LAUNCHT']]
export function groupOf(email) {
  const e = String(email || '').trim()
  const g = e && GROUP.find(([re]) => re.test(e))
  return g ? g[1] : null
}
export function emailOk(v) {
  const t = String(v).trim()
  return t.length <= LIMIT.email && /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/.test(t)
}

const freeText = (v, max) => {
  if (v === null || v === undefined) return ok('')
  if (typeof v !== 'string') return no('That could not be read as words.')
  if (v.length > max) return no(`Keep it to ${max} letters or fewer.`)
  return ok(v)
}
const yesNo = (v) => (v === null || v === true || v === false ? ok(v) : no('Pick Yes or No.'))

/** One field, cleaned, or the reason it cannot be saved. The reason never repeats what was typed (it may be personal). */
export function validate(field, value) {
  switch (field) {
    case 'name': {
      if (typeof value !== 'string' || !value.trim()) return no('Every supplier needs a name.')
      if (value.trim().length > LIMIT.name) return no(`Keep it to ${LIMIT.name} letters or fewer.`)
      return ok(value.trim())
    }
    case 'contact': {
      const t = freeText(value, LIMIT.contact)
      return t.ok ? ok(t.value.trim()) : t
    }
    case 'email': {
      const t = freeText(value, LIMIT.email)
      if (!t.ok) return t
      const e = t.value.trim()
      if (!e) return ok('')
      if (!emailOk(e)) return no('that email address is not complete. It looks like name@business.co.za.')
      if (OWN_DOMAIN.test(e)) return no('that is a Wild Mongoo address. Please give the supplier\'s own.')
      return ok(e.toLowerCase())
    }
    case 'phone':
    case 'whatsapp': {
      const t = freeText(value, 30)
      if (!t.ok) return t
      const p = t.value.trim()
      if (!p) return ok('')
      if (!phoneOk(p)) return no(`that ${field === 'phone' ? 'phone' : 'WhatsApp'} number is not right. Use 10 digits starting with 0, or +27 and 9 digits.`)
      return ok(canonPhone(p))
    }
    case 'wa_same':
    case 'confirmed':
      return typeof value === 'boolean' ? ok(value) : no('Tick or untick it.')
    case 'still_used':
    case 'same':
      return yesNo(value)
    case 'order_by': {
      if (!Array.isArray(value) || value.some((x) => !ORDER_WAYS.includes(x))) return no('tick from the list: Email, WhatsApp, Phone call, Online or In person.')
      return ok(ORDER_WAYS.filter((w) => value.includes(w)))
    }
    // the fields added on 20/11/2026: the admin's lists and checks (shared/supplierchoices.js); empty is always allowed
    case 'lead_hours': {
      if (value === null || value === undefined || value === '') return ok(null)
      const v = String(value).trim()
      if (!LEAD_TIMES.some(([k]) => k === v)) return no('choose the order lead time from the list.')
      return ok(Number(v))
    }
    case 'order_cutoff':
    case 'delivery_from':
    case 'delivery_to': {
      if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return ok(null)
      const t = typeof value === 'string' ? timeOf(value) : null
      if (!t) return no('enter a time of day, such as 08:00.')
      return ok(t)
    }
    case 'delivery_days': {
      if (!Array.isArray(value) || value.some((x) => !DAYS.some(([k]) => k === x))) return no('tick the days from the list.')
      return ok(DAYS.map(([k]) => k).filter((k) => value.includes(k)))
    }
    case 'pay_how': {
      if (value === null || value === undefined || value === '') return ok(null)
      if (!PAY_HOW.some(([k]) => k === value)) return no('choose how you pay them from the list.')
      return ok(value)
    }
    case 'account_number':
    case 'terms': {
      const t = freeText(value, LIMIT[field])
      return t.ok ? ok(t.value.trim().replace(/\s+/g, ' ')) : t
    }
    case 'notes': return freeText(value, LIMIT.notes)
    case 'anything_else': return freeText(value, LIMIT.anything_else)
    default: return no('That cannot be changed here.')
  }
}

/** Why Looks right cannot be tapped yet, or null (test 03, finding 2: never a quiet Yes on Still used). */
export function confirmProblem(s) {
  if (s.still_used !== true && s.still_used !== false) return 'tap Yes or No on Still used first.'
  return null
}

/**
 * Yes, the same supplier (test 03, finding 3): what this card carries across to the other one, only where the other
 * is empty. A person's card (seed.person) brings its name as the contact. A group address is never carried.
 */
export function carryAcross(from, to) {
  const out = {}
  const contact = from.contact || (from.seed && from.seed.person ? from.name : '')
  if (contact && !to.contact) out.contact = contact
  const email = from.email && !groupOf(from.email) ? from.email : ''
  if (email && !to.email) out.email = email
  if (from.phone && !to.phone) {
    out.phone = from.phone
    if (from.wa_same && !to.whatsapp) out.wa_same = true
  }
  if (!from.wa_same && from.whatsapp && !to.whatsapp && !(to.wa_same && to.phone)) out.whatsapp = from.whatsapp
  const ways = (from.order_by || []).filter((w) => w !== 'email' || email || to.email)
  if (ways.length && !(to.order_by || []).length) out.order_by = ways
  return out
}

/** Checked: she tapped Looks right, or said Yes, it is the same as another supplier (merged into it). */
export const isChecked = (s) => s.confirmed === true || s.same === true
export function progress(suppliers) {
  return { checked: suppliers.filter(isChecked).length, total: suppliers.length }
}

/** What a field reads now against what we filled in: still our suggestion (not yet confirmed or changed)? */
export function stillSuggested(s, field) {
  const sug = s.seed && s.seed.suggested
  if (!sug || !(field in sug) || s.confirmed) return false
  // an empty box, an untick or an empty list is not something we filled in; "No" on Still used is (Badger Kitchen)
  if (sug[field] === '' || sug[field] === null || (Array.isArray(sug[field]) && !sug[field].length)) return false
  if (sug[field] === false && field !== 'still_used') return false
  return JSON.stringify(s[field] ?? null) === JSON.stringify(sug[field])
}

// ---------------------------------------------------------------- the door

const KEY = /^[A-Za-z0-9_-]{32,128}$/
const reply = (status, body) => ({ status, body })
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const NOT_RIGHT = 'This link is not right. Ask Tarryn for it again.'

/**
 * One request from the page. store: { who(keyHashInput), list(), save(id|null, field, value, who), add(row, who),
 * history() } (memoryStore below, or the Supabase one in the function). A wrong key is a plain 404 whatever was asked.
 */
export async function handle(req, store) {
  const key = req && typeof req.key === 'string' ? req.key : ''
  if (!KEY.test(key)) return reply(404, { problem: NOT_RIGHT })
  const me = await store.who(key)
  if (!me) return reply(404, { problem: NOT_RIGHT })
  if (req.action === 'open') {
    const all = await store.list()
    const body = { who: me.who, canEdit: me.edit, suppliers: all.suppliers, notes: all.notes }
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
    if (field !== 'anything_else' && !(typeof req.supplier === 'string' && ID.test(req.supplier))) return reply(404, { problem: 'That supplier could not be found.' })
    const r = await store.save(field === 'anything_else' ? null : req.supplier, field, v.value, me.who)
    if (r.missing) return reply(404, { problem: 'That supplier could not be found.' })
    if (r.noAsk) return reply(400, { problem: 'There is nothing to merge this supplier with.' })
    if (r.needsUsed) return reply(400, { problem: 'tap Yes or No on Still used first.' })
    if (r.badWindow) return reply(400, { problem: WINDOW_PROBLEM })
    return reply(200, { at: r.at, changed: r.changed, value: v.value })
  }
  if (req.action === 'add') {
    const name = validate('name', req.name)
    if (!name.ok) return reply(400, { problem: name.problem })
    const row = {
      id: `new-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 40), sort: 9000,
      name: name.value, contact: '', email: '', phone: '', whatsapp: '', wa_same: false, order_by: [], still_used: true,
      notes: '', confirmed: false, same: null, source: 'new', seed: {},
      lead_hours: null, order_cutoff: null, delivery_days: [], delivery_from: null, delivery_to: null, pay_how: null, account_number: '', terms: '',
    }
    const saved = await store.add(row, me.who)
    return reply(200, { supplier: saved })
  }
  return reply(400, { problem: 'That could not be done.' })
}

/** The store, in memory, answering as the database does (a save and its change line together). For tests. */
export function memoryStore({ keys, suppliers, notes = '' }) {
  const s = {
    suppliers: new Map(suppliers.map((x) => [x.id, structuredClone(x)])),
    notes,
    changes: [],
    async who(key) { return keys[key] || null },
    async list() { return { suppliers: [...s.suppliers.values()], notes: s.notes } },
    async save(id, field, value, who) {
      const at = new Date().toISOString()
      if (id === null) {
        if (same(s.notes, value)) return { at, changed: false }
        s.changes.push({ at, who, supplier: null, name: null, field, before: s.notes, after: value })
        s.notes = value
        return { at, changed: true }
      }
      const r = s.suppliers.get(id)
      if (!r) return { missing: true }
      if (field === 'same' && value !== null && !(r.seed && r.seed.ask)) return { noAsk: true }
      if (field === 'confirmed' && value === true && confirmProblem(r)) return { needsUsed: true }
      if (field === 'still_used' && value === null && r.confirmed) return { needsUsed: true }
      if (field === 'delivery_from' && !windowOk(value, r.delivery_to)) return { badWindow: true }
      if (field === 'delivery_to' && !windowOk(r.delivery_from, value)) return { badWindow: true }
      if (same(r[field], value)) return { at, changed: false }
      s.changes.push({ at, who, supplier: id, name: r.name, field, before: r[field] ?? null, after: value })
      r[field] = value
      r.touched_at = at
      return { at, changed: true }
    },
    async add(row, who) {
      s.suppliers.set(row.id, row)
      s.changes.push({ at: new Date().toISOString(), who, supplier: row.id, name: row.name, field: 'added', before: null, after: row.name })
      return row
    },
    async history() { return [...s.changes].reverse() },
  }
  return s
}
