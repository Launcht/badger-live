/**
 * The supplier choices and checks in ONE place (20/11/2026): the ticks and picks for how a supplier takes orders, the
 * lead time, the delivery days and window, and how we pay them, with the time-of-day and window checks.
 *
 * Moved out of shared/supplierfields.js (which re-exports every one of them unchanged) so that Lindsay's supplier review
 * page and its function can use the SAME lists as the admin without the working-days calendar: this file has no imports
 * and runs in a browser, in Deno and in Node as it is. Spec: clients/wild-mongoo/badger/spec/2026-11-20-supplier-fields
 * (01-build.md for the admin, 03-build-review-page-fields.md for her page).
 */

/**
 * How a supplier takes orders. The first three are Tarryn's (17/11); Online and In person come from Lindsay's own notes
 * on her supplier page ("On Line Order so non of the 3 options"; "you can phone but you need to go in and buy").
 */
export const ORDER_WAYS = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['phone', 'Phone call'], ['online', 'Online'], ['in_person', 'In person']]

/** The days of the week, Monday first. */
export const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]

/**
 * Lead time, in hours, as one pick. A whole number of days may also carry an "order before" time of day. Fix after test
 * (N2, 20/11/2026): the days are WORKING days (Monday to Friday), so a Monday delivery with 1 working day is ordered on
 * Friday, never on a Sunday the supplier does not read. Hours stay hours; weeks stay weeks (the same weekday).
 */
export const LEAD_TIMES = [['0', 'Same day'], ['4', '4 hours'], ['12', '12 hours'], ['24', '1 working day'], ['48', '2 working days'], ['72', '3 working days'],
  ['96', '4 working days'], ['120', '5 working days'], ['168', '1 week'], ['336', '2 weeks']]
/** The lead times that are whole days: the ones an "order before" time belongs to. */
export const DAY_LEADS = LEAD_TIMES.map(([v]) => v).filter((v) => Number(v) % 24 === 0)

/** How we pay them. The detail ("30 days from statement") is the Payment terms text. */
export const PAY_HOW = [['account', 'On account'], ['before', 'Pay before delivery (EFT)'], ['on_delivery', 'Pay on delivery or collection'], ['card', 'Pay online by card']]

/** The longest our account number and the payment terms may be (the admin's form and table use the same). */
export const ACCOUNT_MAX = 60
export const TERMS_MAX = 200

/** "08:00:00", "8:00", "08:00" -> "08:00". Null when it is not a time of day. */
export function timeOf(v) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

/** The one delivery window rule: "until" must be later than "from" when both are set. */
export const WINDOW_PROBLEM = 'Delivers until must be later than delivers from.'
export function windowOk(from, to) {
  const f = timeOf(from)
  const t = timeOf(to)
  return !f || !t || t > f
}
