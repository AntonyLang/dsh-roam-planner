/**
 * Plugin settings the user can change without a restart.
 *
 * The Amap Web-service key is a secret, so it lives in the host credential
 * service under a fixed reference name rather than in this plugin's JSON store.
 * `config.amapKey` stays supported as a deployment fallback (cordis.patch.yml);
 * a value stored through the settings page wins over it.
 *
 * Nothing here returns the key itself to a client — only whether it is set and
 * where it came from.
 */

const AMAP_KEY_REF = 'ROAM_PLANNER_AMAP_KEY'

/**
 * @param {any} [options]
 */
export function createSettings(options) {
  const { ctx, config, logger } = options || {}
  function credentialsService() {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
    } catch {
      return undefined
    }
  }

  /** Resolve the key for one operation; never cache across operations. */
  async function amapKey() {
    const store = credentialsService()
    if (store && typeof store.resolve === 'function') {
      try {
        const resolved = await store.resolve(AMAP_KEY_REF)
        if (resolved && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      } catch (error) {
        logger?.warn?.(`dsh-roam-planner: amap key lookup failed: ${error?.message || error}`)
      }
    }
    return config?.amapKey || null
  }

  async function describeAmapKey() {
    const store = credentialsService()
    let configured = Boolean(config?.amapKey)
    let source = configured ? 'config' : undefined
    let writable = false
    if (store && typeof store.describe === 'function') {
      try {
        const info = await store.describe(AMAP_KEY_REF)
        if (info?.configured) {
          configured = true
          source = info.source || 'credentials'
        }
        writable = Boolean(info?.writable)
      } catch (error) {
        logger?.warn?.(`dsh-roam-planner: amap key describe failed: ${error?.message || error}`)
      }
    }
    return { configured, source, writable }
  }

  async function setAmapKey(value) {
    const store = credentialsService()
    if (!store || typeof store.set !== 'function') {
      throw new Error('the host credential service is unavailable in this profile')
    }
    const trimmed = String(value || '').trim()
    if (trimmed === '') throw new Error('the key is empty')
    await store.set(AMAP_KEY_REF, trimmed)
  }

  async function clearAmapKey() {
    const store = credentialsService()
    if (!store || typeof store.unset !== 'function') return
    await store.unset(AMAP_KEY_REF)
  }

  return { amapKey, describeAmapKey, setAmapKey, clearAmapKey, ref: AMAP_KEY_REF }
}



