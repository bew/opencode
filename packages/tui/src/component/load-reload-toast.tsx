// Reload notice for the TUI, organized by sources.
//
// A single config reload fans out into independent agent, skill, command,
// plugin, and config services that publish their `*.updated` events at slightly
// different times; this module groups that fan-out into one "Reloaded!" toast
// with per-source change counts.
//
// A "resync" is the client re-fetching a source's list after its event; the
// aggregator diffs that new list against the previous one for its counts.
//
// `createLoadReloadAggregator` holds the framework-free grouping logic, and
// `LoadReloadToast` wires it to the client events and the shared toast queue.

import type { AgentInfo, CommandInfo, ConfigEntry, PluginInfo, SkillInfo } from "@opencode/client"
import { createEffect, onCleanup } from "solid-js"
import path from "path"
import { useClient } from "../context/client"
import { configReloads } from "../config"
import { useData } from "../context/data"
import { usePlugin } from "../plugin/context"
import { useToast } from "../ui/toast"

// Sources a reload notice can report. The first five mirror the server's
// `*.updated` events; `cli-config` comes from the TUI's own config watcher.
type ReloadSource = "agent" | "skill" | "command" | "plugin" | "config" | "cli-config"

// Added/updated/removed counts for one bucket of a source's entries.
type Counts = {
  added: number
  updated: number
  removed: number
}

// A source's changes split into user configuration and opencode's own builtins,
// so a reload notice can report the two separately.
type SourceChanges = {
  user: Counts
  builtin: Counts
}

// Totals for one source at initial load: user configuration and opencode's own
// builtins.
type LoadedTotals = {
  user: number
  builtin: number
}

// Milliseconds a reload notice waits for a fan-out of source events to group
// into one toast.
const GROUPING_WINDOW_MS = 1000

// Milliseconds a pending trigger waits for its matching resync before being
// discarded as unmatched.
const PENDING_EXPIRY_MS = 2000

// Milliseconds the startup sync burst waits before the initial-load notice is
// announced, so lists that sync at slightly different times group into one.
const INITIAL_LOAD_WINDOW_MS = 1000

// Counted category lines, in display order, with their display labels.
const categoryLines = [
  ["agent", "Agents"],
  ["skill", "Skills"],
  ["command", "Commands"],
  ["plugin", "Plugins"],
] as const

// Groups the independent resync notifs a single reload fans out into one toast.
// A source is only reported after its matching `*.updated` event, so an
// unrelated resync cannot be misattributed.
export function createLoadReloadAggregator(show: (toast: { variant: "info"; title: string; message: string }) => void) {
  const baselines = new Map<ReloadSource, readonly unknown[]>()
  const pending = new Set<ReloadSource>()
  const staged = new Map<ReloadSource, SourceChanges | undefined>()
  // Totals recorded on each source's first observation, for the one-time
  // initial-load notice.
  const loaded = new Map<ReloadSource, LoadedTotals>()
  let loadedEmitted = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // Marks a source as expecting a resync, so its next observed change is reported.
  const trigger = (source: ReloadSource) => {
    pending.add(source)
    // Drop the trigger if the matching resync never lands (an event for a
    // different location, say) so a later change is not misattributed.
    setTimeout(() => pending.delete(source), PENDING_EXPIRY_MS).unref()
  }

  // Emits one toast for everything staged so far and resets the staging map.
  const flush = () => {
    timer = undefined
    if (!staged.size) {
      return
    }
    const entries = new Map(staged)
    staged.clear()
    const lines: string[] = []
    // Both config sources collapse into one line, CLI first, with no counts.
    const configLabels = [
      entries.has("cli-config") ? "CLI" : undefined,
      entries.has("config") ? "Server" : undefined,
    ].filter((name) => name !== undefined)
    if (configLabels.length) {
      // Show either `Config: CLI`, `Config: Server` or `Configs: CLI, Server` (plural)
      lines.push(`${configLabels.length > 1 ? "Configs" : "Config"}: ${configLabels.join(", ")}`)
    }
    for (const [source, label] of categoryLines) {
      const changes = entries.get(source)
      if (changes) {
        lines.push(formatSourceChanges(label, changes))
      }
    }
    show({ variant: "info", title: "Reloaded!", message: lines.join("\n") })
  }

  // Records a source's changes and (re)arms the grouping window.
  const stage = (source: ReloadSource, changes?: SourceChanges) => {
    if (changes && !formatCounts(changes.user) && !formatCounts(changes.builtin)) {
      return
    }
    staged.set(source, changes)
    if (timer) {
      clearTimeout(timer)
    }
    // A single reload fans out into several independent plugins (skill, command, ...)
    // that publish their events at slightly different times, so keep the window
    // long enough to group them into one toast.
    timer = setTimeout(flush, GROUPING_WINDOW_MS).unref()
  }

  // Diffs a source's new list against its baseline. Only reports while the source
  // is pending, so an unrelated resync cannot be misattributed.
  const observe = <T,>(
    source: ReloadSource,
    list: readonly T[] | undefined,
    key: (item: T) => string,
    signature: (item: T) => string,
    isBuiltin?: (item: T) => boolean,
  ) => {
    if (list === undefined) {
      return
    }
    const before = baselines.get(source) as readonly T[] | undefined
    baselines.set(source, list)
    if (before === undefined) {
      // First sight is the initial load: record totals, not a diff.
      if (!loadedEmitted) {
        const checkBuiltin = isBuiltin ?? (() => false)
        const builtinCount = list.filter((item) => checkBuiltin(item)).length
        loaded.set(source, { user: list.length - builtinCount, builtin: builtinCount })
      }
      return
    }
    if (before === list) {
      return
    }
    if (!pending.has(source)) {
      return
    }
    pending.delete(source)
    stage(source, splitChanges(before, list, key, signature, isBuiltin))
  }

  // Emits the one-time "Loaded!" notice from the totals recorded on each
  // source's first observation. The component calls this once the startup sync
  // burst settles; later calls are ignored.
  const announceLoad = (config: { cli: boolean; server: boolean }) => {
    if (loadedEmitted) {
      return
    }
    loadedEmitted = true
    const configLabels = [
      config.cli ? "CLI" : undefined,
      config.server ? "Server" : undefined,
    ].filter((name) => name !== undefined)
    const lines: string[] = []
    if (configLabels.length) {
      lines.push(`${configLabels.length > 1 ? "Configs" : "Config"}: ${configLabels.join(", ")}`)
    }
    for (const [source, label] of categoryLines) {
      const totals = loaded.get(source)
      if (!totals) {
        continue
      }
      const line = formatLoadedLine(label, totals)
      if (line) {
        lines.push(line)
      }
    }
    loaded.clear()
    if (lines.length) {
      show({ variant: "info", title: "Loaded!", message: lines.join("\n") })
    }
  }

  // Cancels the pending grouping timer.
  const dispose = () => {
    if (timer) {
      clearTimeout(timer)
    }
  }

  return {
    trigger,
    observe,
    // Signals a source that has no diff, e.g. the CLI config watcher.
    signal: (source: ReloadSource) => stage(source),
    announceLoad,
    dispose,
  }
}

// Headless component that bridges reload events to the toast queue. It renders
// nothing; the actual notice is drawn by the shared Toast component.
export function LoadReloadToast() {
  const client = useClient()
  const data = useData()
  const plugins = usePlugin()
  const toast = useToast()
  const aggregator = createLoadReloadAggregator(toast.show)

  // Tracks the one-time initial-load notice. Each startup sync re-arms the
  // window, so the notice fires once the burst settles rather than mid-load.
  let loadAnnounced = false
  let loadTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    // Agents have no provenance marker, so they are always counted as user changes,
    // like commands below.
    aggregator.observe("agent", data.location.agent.list(), (agent) => agent.id, agentSignature)
    aggregator.observe("skill", data.location.skill.list(), (skill) => skill.id, skillSignature, isBuiltinSkill)
    // Commands have no provenance marker, so they are always counted as user changes;
    // opencode's own commands (init, review) cannot be distinguished from discovered ones.
    aggregator.observe("command", data.location.command.list(), (command) => command.name, commandSignature)
    aggregator.observe("plugin", plugins.server(), pluginKey, pluginSignature, isBuiltinPlugin)
    aggregator.observe("config", data.location.config.list(), configKey, configSignature)

    if (loadAnnounced) {
      return
    }
    if (loadTimer) {
      clearTimeout(loadTimer)
    }
    loadTimer = setTimeout(() => {
      loadAnnounced = true
      aggregator.announceLoad({ cli: true, server: data.location.config.list() !== undefined })
    }, INITIAL_LOAD_WINDOW_MS)
  })

  onCleanup(client.event.on("agent.updated", () => aggregator.trigger("agent")))
  onCleanup(client.event.on("skill.updated", () => aggregator.trigger("skill")))
  onCleanup(client.event.on("command.updated", () => aggregator.trigger("command")))
  onCleanup(client.event.on("plugin.updated", () => aggregator.trigger("plugin")))
  onCleanup(client.event.on("config.updated", () => aggregator.trigger("config")))
  // The TUI watches the CLI config directory directly; it has no server event, so
  // signal the source without a diff.
  onCleanup(configReloads.onReload(() => aggregator.signal("cli-config")))
  onCleanup(aggregator.dispose)
  onCleanup(() => {
    if (loadTimer) {
      clearTimeout(loadTimer)
    }
  })

  return null
}

// Counts entries added, updated, and removed between two keyed lists. An entry
// that changes key or signature is counted once, by its new bucket.
function diffCounts<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  signature: (item: T) => string,
): Counts {
  const previous = new Map(before.map((item) => [key(item), signature(item)]))
  const current = new Map(after.map((item) => [key(item), signature(item)]))
  const counts: Counts = { added: 0, updated: 0, removed: 0 }
  for (const [id, currentSignature] of current) {
    const prior = previous.get(id)
    if (prior === undefined) {
      counts.added++
    } else if (prior !== currentSignature) {
      counts.updated++
    }
  }
  for (const id of previous.keys()) {
    if (!current.has(id)) {
      counts.removed++
    }
  }
  return counts
}

// Splits a list resync into user and builtin counts, so a reload notice can report
// the two separately on one line.
function splitChanges<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  signature: (item: T) => string,
  isBuiltin?: (item: T) => boolean,
): SourceChanges {
  const builtin = isBuiltin ?? (() => false)
  return {
    user: diffCounts(
      before.filter((item) => !builtin(item)),
      after.filter((item) => !builtin(item)),
      key,
      signature,
    ),
    builtin: diffCounts(before.filter(builtin), after.filter(builtin), key, signature),
  }
}

// Renders counts as `+A ~U -R`, space-separated, omitting zero-valued types.
function formatCounts(counts: Counts) {
  return [
    counts.added ? `+${counts.added}` : undefined,
    counts.updated ? `~${counts.updated}` : undefined,
    counts.removed ? `-${counts.removed}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

// Renders one category line, appending the builtin counts in parentheses only
// when there are any.
function formatSourceChanges(label: string, changes: SourceChanges) {
  const userCounts = formatCounts(changes.user)
  const builtinCounts = formatCounts(changes.builtin)
  if (!builtinCounts) {
    return `${label}: ${userCounts}`
  }
  const builtinSuffix = `(${builtinCounts} builtins)`
  return userCounts ? `${label}: ${userCounts} ${builtinSuffix}` : `${label}: ${builtinSuffix}`
}

// Renders one initial-load line as a total, with builtins in parentheses only
// when there are any. Returns undefined for a source with nothing loaded.
function formatLoadedLine(label: string, totals: LoadedTotals) {
  const total = totals.user + totals.builtin
  if (!total) {
    return undefined
  }
  if (!totals.builtin) {
    return `${label}: ${totals.user}`
  }
  return totals.user
    ? `${label}: ${totals.user} (+${totals.builtin} builtins)`
    : `${label}: (+${totals.builtin} builtins)`
}

// True for skills provided by opencode itself, detected by the synthetic
// `/builtin/` path their internal plugin registers them under.
function isBuiltinSkill(skill: SkillInfo) {
  return skill.path.startsWith("/builtin/")
}

// True for plugins loaded from opencode's own bundled sources.
function isBuiltinPlugin(plugin: PluginInfo) {
  return plugin.source.type === "builtin"
}

// Comparable signature of an agent change; the whole entry is significant, like config.
function agentSignature(agent: AgentInfo) {
  return JSON.stringify(agent)
}

// Comparable signature of the fields that make a skill change meaningful.
function skillSignature(skill: SkillInfo) {
  return JSON.stringify([skill.name, skill.description, skill.content, skill.autoinvoke])
}

// Comparable signature of the fields that make a command change meaningful.
function commandSignature(command: CommandInfo) {
  return JSON.stringify([command.name, command.description])
}

// Comparable signature of the fields that make a plugin change meaningful.
function pluginSignature(plugin: PluginInfo) {
  return JSON.stringify([plugin.source, plugin.features, plugin.state])
}

// Stable identity of a plugin entry, used to match entries across resyncs.
function pluginKey(plugin: PluginInfo) {
  return plugin.id ?? pluginLabel(plugin.source)
}

// Human label for a plugin's source, used when the plugin has no id.
function pluginLabel(source: PluginInfo["source"]) {
  if (source.type === "package") {
    return source.target
  }
  if (source.type === "local") {
    return path.basename(source.path)
  }
  return source.type
}

// Stable identity of a config entry, used to match entries across resyncs.
// The full path is required: basenames collide (a global and a project
// `opencode.jsonc` both reduce to `opencode.jsonc`), which would hide changes.
export function configKey(entry: ConfigEntry) {
  return entry.path ?? entry.type
}

// Comparable signature of a config entry; the whole entry is significant.
export function configSignature(entry: ConfigEntry) {
  return JSON.stringify(entry)
}
