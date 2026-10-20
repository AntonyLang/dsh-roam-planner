/**
 * Marker numbering checks for the map renderer.
 *
 * Stops are numbered by their order within the day; numbering by day made every
 * stop of day one read "1".
 *
 * Run: node server/__tests__/geometry-labels.test.mjs
 */
import assert from 'node:assert/strict'
import { buildGeometry } from '../../client/src/map/maplibre/geometry.js'

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

const view = {
  tripId: 't1',
  crs: 'WGS84',
  days: [
    {
      index: 0,
      stops: [
        { id: 'a', name: 'A', lat: 31.3, lng: 120.6 },
        { id: 'b', name: 'B', lat: 31.31, lng: 120.61 },
        { id: 'c', name: 'C', lat: 31.32, lng: 120.62 },
      ],
      legs: [],
    },
    {
      index: 1,
      stops: [
        { id: 'd', name: 'D', lat: 31.33, lng: 120.63 },
        { id: 'e', name: 'E', lat: 31.34, lng: 120.64 },
      ],
      legs: [],
    },
  ],
}

const geometry = buildGeometry(view, 'WGS84')
const labels = geometry.stops.features.map((feature) => feature.properties.label)
const days = geometry.stops.features.map((feature) => feature.properties.dayIndex)

check('labels count up within each day', () => {
  assert.deepEqual(labels, ['1', '2', '3', '1', '2'])
})
check('the day is still carried separately', () => {
  assert.deepEqual(days, [0, 0, 0, 1, 1])
})
check('the overlay numbers match the point labels', () => {
  assert.deepEqual(
    geometry.overlayPoints.map((point) => point.label),
    labels,
  )
})
check('a stop with no coordinates is skipped, not numbered', () => {
  const withGap = {
    tripId: 't2',
    crs: 'WGS84',
    days: [
      {
        index: 0,
        stops: [
          { id: 'x', name: 'X', lat: 31.3, lng: 120.6 },
          { id: 'y', name: 'Y' },
          { id: 'z', name: 'Z', lat: 31.32, lng: 120.62 },
        ],
        legs: [],
      },
    ],
  }
  const built = buildGeometry(withGap, 'WGS84')
  assert.deepEqual(
    built.stops.features.map((feature) => feature.properties.label),
    ['1', '2'],
  )
})

console.log(failed === 0 ? '\nlabel checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
