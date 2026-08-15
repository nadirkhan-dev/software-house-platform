/**
 * Calendar arithmetic, in UTC from end to end.
 *
 * A `worked_on` is a calendar day, not an instant. The database stores it as
 * DATE and src/db.js hands it back as 'YYYY-MM-DD', so everything that has to
 * agree with it must reason in the same calendar. Doing that in UTC — rather
 * than the server's local zone — means two instances in different regions
 * bucket the same timesheet into the same week.
 *
 * Lives outside server.js so it can be tested without binding a port or
 * reaching a database.
 */

const DAY = 86_400_000;

/**
 * The Monday of the week containing `d`, as 'YYYY-MM-DD'.
 *
 * `d` may be a Date or a 'YYYY-MM-DD' string; the latter is parsed by
 * Date.parse as UTC midnight, which is what we want.
 *
 * The previous version mixed local getters with a UTC formatter:
 *
 *     x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
 *     return x.toISOString().slice(0, 10);
 *
 * getDay/setDate walk back in local time and toISOString() then converts to
 * UTC, so west of UTC the result fell into the previous week — silently, on a
 * date the user never sees.
 */
export function mondayOf(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) throw new TypeError(`mondayOf: not a date: ${d}`);

  // Collapse the instant to its UTC calendar day, then step back to Monday.
  const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const weekday = new Date(midnight).getUTCDay();     // 0 = Sunday
  return new Date(midnight - ((weekday + 6) % 7) * DAY).toISOString().slice(0, 10);
}
