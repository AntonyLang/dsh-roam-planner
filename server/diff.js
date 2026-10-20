/**
 * Plan diffing.
 *
 * A trip is compared with the last plan the user adopted. Stops are matched by
 * name, because a replanned day usually regenerates ids; the day index carries
 * the move, and `start`/`stayMinutes` carry the retiming.
 *
 * Pure: no I/O, no clock.
 */

function stopMapOf(days) {
  const map = new Map()
  for (const day of Array.isArray(days) ? days : []) {
    if (!day) continue
    const dayIndex = Number.isFinite(day.index) ? day.index : 0
    for (const stop of Array.isArray(day.stops) ? day.stops : []) {
      if (!stop || typeof stop.name !== 'string' || stop.name.trim() === '') continue
      const name = stop.name.trim()
      if (!map.has(name)) map.set(name, { name, day: dayIndex, stop })
    }
  }
  return map
}

function dayMapOf(days) {
  const map = new Map()
  for (const day of Array.isArray(days) ? days : []) {
    if (!day) continue
    const dayIndex = Number.isFinite(day.index) ? day.index : 0
    map.set(dayIndex, { index: dayIndex, date: typeof day.date === 'string' ? day.date : '' })
  }
  return map
}

/**
 * @param {{title?: string, days?: object[]}} before Last adopted plan.
 * @param {{title?: string, days?: object[]}} after Current plan.
 */
export function diffPlans(before, after) {
  const oldStops = stopMapOf(before?.days)
  const newStops = stopMapOf(after?.days)

  const added = []
  const moved = []
  const retimed = []
  for (const [name, next] of newStops) {
    const previous = oldStops.get(name)
    if (!previous) {
      added.push({ name, day: next.day })
      continue
    }
    if (previous.day !== next.day) {
      moved.push({ name, from: previous.day, to: next.day })
    } else if (
      (previous.stop.start || '') !== (next.stop.start || '') ||
      (previous.stop.stayMinutes ?? null) !== (next.stop.stayMinutes ?? null)
    ) {
      retimed.push({
        name,
        day: next.day,
        from: { start: previous.stop.start || null, stayMinutes: previous.stop.stayMinutes ?? null },
        to: { start: next.stop.start || null, stayMinutes: next.stop.stayMinutes ?? null },
      })
    }
  }

  const removed = []
  for (const [name, previous] of oldStops) {
    if (!newStops.has(name)) removed.push({ name, day: previous.day })
  }

  // Day-level changes: a date moved, or a day appeared/disappeared.
  const oldDays = dayMapOf(before?.days)
  const newDays = dayMapOf(after?.days)
  const daysAdded = []
  const daysRemoved = []
  const datesChanged = []
  for (const [index, day] of newDays) {
    if (!oldDays.has(index)) daysAdded.push({ index, date: day.date })
    else if (oldDays.get(index).date !== day.date) {
      datesChanged.push({ index, from: oldDays.get(index).date, to: day.date })
    }
  }
  for (const [index, day] of oldDays) {
    if (!newDays.has(index)) daysRemoved.push({ index, date: day.date })
  }

  const titleChanged =
    typeof before?.title === 'string' &&
    typeof after?.title === 'string' &&
    before.title !== after.title

  const changes = added.length + removed.length + moved.length + retimed.length +
    daysAdded.length + daysRemoved.length + datesChanged.length + (titleChanged ? 1 : 0)

  return {
    hasBaseline: true,
    unchanged: changes === 0,
    counts: {
      added: added.length,
      removed: removed.length,
      moved: moved.length,
      retimed: retimed.length,
      daysAdded: daysAdded.length,
      daysRemoved: daysRemoved.length,
      datesChanged: datesChanged.length,
      titleChanged: titleChanged ? 1 : 0,
    },
    titleChange: titleChanged ? { from: before.title, to: after.title } : null,
    added,
    removed,
    moved,
    retimed,
    daysAdded,
    daysRemoved,
    datesChanged,
  }
}
