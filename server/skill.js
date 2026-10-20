/**
 * Registers the skills that ship inside this package.
 *
 * The host does not scan `skills/` on its own: a plugin has to push each skill
 * into `ctx.skills` while applying. The shape mirrors what dsh-remotion does —
 * parsed frontmatter, the body as content, and the containing directory as the
 * resource base so relative links resolve.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function parseSkill(text) {
  const match = FRONTMATTER.exec(text)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) fields[key] = value
  }
  const content = text.slice(match[0].length).trim()
  if (!fields.name || !fields.description || !content) return null
  return { name: fields.name, description: fields.description, content }
}

/**
 * @param {object} ctx Host context; `ctx.skills.register` returns a disposer.
 * @param {string} directory Absolute path to the package `skills/` directory.
 * @returns {Array<{name: string, ok: boolean, detail: string}>} what was registered
 */
export function registerBundledSkills(ctx, directory) {
  const report = []
  if (!ctx?.skills || typeof ctx.skills.register !== 'function') {
    report.push({ name: '', ok: false, detail: 'the host exposes no ctx.skills' })
    return { report, dispose() {} }
  }

  let entries
  try {
    entries = readdirSync(directory)
  } catch (error) {
    report.push({ name: '', ok: false, detail: `skills directory is unreadable: ${error.message}` })
    return { report, dispose() {} }
  }

  const disposers = []
  for (const entry of entries) {
    const base = join(directory, entry)
    try {
      if (!statSync(base).isDirectory()) continue
    } catch (_error) {
      continue
    }
    let text
    try {
      text = readFileSync(join(base, 'SKILL.md'), 'utf8')
    } catch (_error) {
      continue
    }
    const parsed = parseSkill(text)
    if (!parsed) {
      report.push({ name: entry, ok: false, detail: 'SKILL.md has no usable frontmatter' })
      continue
    }
    if (parsed.name !== entry) {
      report.push({ name: entry, ok: false, detail: `frontmatter name "${parsed.name}" does not match the directory` })
      continue
    }
    try {
      const remove = ctx.skills.register({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        resourceBase: { kind: 'directory', path: base },
        source: 'runtime',
      })
      if (typeof remove === 'function') disposers.push(remove)
      report.push({ name: parsed.name, ok: true, detail: base })
    } catch (error) {
      report.push({ name: entry, ok: false, detail: `registration failed: ${error.message}` })
    }
  }

  const dispose = () => {
    for (const remove of disposers.splice(0)) {
      try {
        remove()
      } catch (_error) {
        /* a failed unregister must not break the plugin teardown */
      }
    }
  }
  return { report, dispose }
}


