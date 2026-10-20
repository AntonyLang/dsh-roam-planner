/**
 * DSH client entry for dsh-roam-planner.
 *
 * The build emits an IIFE and wraps it inside
 * `window.__ModuleLoader__.load({ id, factory(require) { ... } })`, so every
 * React lookup emitted by the component modules runs inside the factory with
 * the loader's own `require`.
 */
import { Panel } from './page/Panel.jsx'
import { PanelIcon } from './page/PanelIcon.jsx'
import { SettingsPanel } from './page/SettingsPanel.jsx'
import { MapDock } from './page/MapDock.jsx'
import { TripBadge } from './page/TripBadge.jsx'
import { STRINGS } from './page/strings.js'

/** Must equal `package.json` `name`. */
export const PACKAGE_ID = '@antony/dsh-roam-planner'

/** Shared key: the `main` slot key and the sidebar panellist id. */
export const PANEL_KEY = 'roam-planner'

export const inject = ['slots', 'locale']

export function apply(ctx) {
  let locale
  try {
    locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) || ctx.locale
  } catch (_error) {
    locale = undefined
  }

  // Selecting the sidebar icon makes `main` render the entry whose key matches
  // the panellist id, so both registrations below must share PANEL_KEY.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_KEY,
        inject: () => ({ locale }),
      },
      Panel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_KEY,
        order: 20,
        label: () => STRINGS.panelTitle,
        inject: () => ({ locale }),
      },
      PanelIcon,
    ),
  )

  // Settings → Roam Planner: where the user stores the Amap key.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: PANEL_KEY,
        order: 70,
        label: () => STRINGS.panelTitle,
        inject: () => ({ locale }),
      },
      SettingsPanel,
    ),
  )

  // "Current trip" above the composer: the trip this conversation edits, which
  // the panel cannot show when it is looking at a different one.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'roam-trip',
        order: 5,
        label: () => STRINGS.panelTitle,
        inject: () => ({ locale }),
      },
      TripBadge,
    ),
  )

  // A floating map dock, so the map is visible while chatting instead of
  // replacing the conversation.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'roam-planner-dock',
        order: 40,
        label: () => STRINGS.panelTitle,
      },
      MapDock,
    ),
  )
}

