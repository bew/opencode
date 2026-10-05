import { afterEach, expect, jest, test } from "bun:test"
import type { ConfigEntry } from "@opencode/client"
import { configKey, configSignature, createLoadReloadAggregator } from "../../src/component/load-reload-toast"

// Minimal keyed entry used to exercise the aggregator's diffing.
type Item = { id: string; value: string }

// Shape of the toast payload the aggregator hands to its `show` callback.
type Shown = { variant: "info"; title: string; message: string }

// Milliseconds the aggregator waits to group a reload fan-out into one toast.
const GROUPING_WINDOW_MS = 1000

// Milliseconds a pending trigger waits for its matching resync.
const PENDING_EXPIRY_MS = 2000

// Extracts an item's identity for keyed diffing.
const key = (item: Item) => item.id

// Extracts an item's comparable value, so a changed value counts as an update.
const signature = (item: Item) => item.value

// Builds an Item list from `[id, value]` pairs.
const list = (entries: Array<[string, string]>): Item[] => entries.map(([id, value]) => ({ id, value }))

// Creates an aggregator and captures the toasts it emits.
function harness() {
  const shown: Shown[] = []
  const aggregator = createLoadReloadAggregator((toast) => shown.push(toast))
  return { shown, aggregator }
}

afterEach(() => jest.useRealTimers())

test("a resync without a matching event is not reported", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.observe("skill", list([["a", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([])
})

test("a triggered resync reports counts", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe(
    "skill",
    list([
      ["a", "1"],
      ["b", "1"],
    ]),
    key,
    signature,
  )
  aggregator.trigger("skill")
  aggregator.observe(
    "skill",
    list([
      ["a", "2"],
      ["c", "1"],
    ]),
    key,
    signature,
  )

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Skills: +1 ~1 -1" }])
})

test("a triggered resync that changes nothing shows no toast", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.trigger("skill")
  aggregator.observe("skill", list([["a", "1"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([])
})

test("resyncs for several sources group into one toast in category order", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("command", list([["c", "1"]]), key, signature)
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.trigger("command")
  aggregator.trigger("skill")
  aggregator.observe("command", list([["c", "2"]]), key, signature)
  aggregator.observe("skill", list([["a", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Skills: ~1\nCommands: ~1" }])
})

test("agent changes are reported like other categories", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("agent", list([["build", "1"]]), key, signature)
  aggregator.trigger("agent")
  aggregator.observe("agent", list([["build", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Agents: ~1" }])
})

test("the Agents line precedes the other category lines", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("agent", list([["build", "1"]]), key, signature)
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.trigger("agent")
  aggregator.trigger("skill")
  aggregator.observe("agent", list([["build", "2"]]), key, signature)
  aggregator.observe("skill", list([["a", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Agents: ~1\nSkills: ~1" }])
})

test("builtins are counted separately from user changes", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  const isBuiltin = (item: Item) => item.id.startsWith("builtin-")
  aggregator.observe(
    "skill",
    list([
      ["user-a", "1"],
      ["builtin-a", "1"],
    ]),
    key,
    signature,
    isBuiltin,
  )
  aggregator.trigger("skill")
  aggregator.observe(
    "skill",
    list([
      ["user-a", "2"],
      ["builtin-a", "2"],
      ["builtin-b", "1"],
    ]),
    key,
    signature,
    isBuiltin,
  )

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Skills: ~1 (+1 ~1 builtins)" }])
})

test("a builtin-only change still shows a toast", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  const isBuiltin = () => true
  aggregator.observe("skill", list([["x", "1"]]), key, signature, isBuiltin)
  aggregator.trigger("skill")
  aggregator.observe(
    "skill",
    list([
      ["x", "1"],
      ["y", "1"],
    ]),
    key,
    signature,
    isBuiltin,
  )

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Skills: (+1 builtins)" }])
})

test("a matching event that never sees a resync expires", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.trigger("skill")
  jest.advanceTimersByTime(PENDING_EXPIRY_MS)
  aggregator.observe("skill", list([["a", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([])
})

test("disposing before the window elapses drops the pending toast", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.trigger("skill")
  aggregator.observe("skill", list([["a", "2"]]), key, signature)
  aggregator.dispose()

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([])
})

test("a signal-only CLI config change shows only the config line", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.signal("cli-config")

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Config: CLI" }])
})

test("two CLI config signals collapse into one entry", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.signal("cli-config")
  aggregator.signal("cli-config")

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Config: CLI" }])
})

test("CLI and server config collapse into one config line, CLI first", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("config", list([["x", "1"]]), key, signature)
  aggregator.signal("cli-config")
  aggregator.trigger("config")
  aggregator.observe("config", list([["x", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Configs: CLI, Server" }])
})

test("the config line precedes the category lines", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("config", list([["x", "1"]]), key, signature)
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.trigger("config")
  aggregator.trigger("skill")
  aggregator.observe("config", list([["x", "2"]]), key, signature)
  aggregator.observe("skill", list([["a", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Config: Server\nSkills: ~1" }])
})

// A directory config entry, mirroring the shape the client returns from
// `config.get` for a scanned config directory.
function configDir(path: string): ConfigEntry {
  return { type: "directory", path }
}

test("a project config change is reported while a global entry exists", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  const globalDoc = configDoc("/cfg/opencode.jsonc", "global")
  const project = (username: string) => configDoc("/work/.opencode/opencode.jsonc", username)

  aggregator.observe("config", [globalDoc, project("one")], configKey, configSignature)
  expect(shown).toEqual([])

  aggregator.trigger("config")
  aggregator.observe("config", [globalDoc, project("two")], configKey, configSignature)
  jest.advanceTimersByTime(GROUPING_WINDOW_MS)

  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Config: Server" }])
})

test("a reload touching every source groups into one toast in line order", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()

  aggregator.observe("config", [configDoc("/cfg/opencode.jsonc", "one")], configKey, configSignature)
  aggregator.observe("agent", list([["build", "1"]]), key, signature)
  aggregator.observe("skill", list([["format", "1"]]), key, signature)
  aggregator.observe("command", list([["review", "1"]]), key, signature)
  aggregator.observe("plugin", list([["fmt", "1"]]), key, signature)

  for (const source of ["config", "agent", "skill", "command", "plugin"] as const) {
    aggregator.trigger(source)
  }
  aggregator.observe("config", [configDoc("/cfg/opencode.jsonc", "two")], configKey, configSignature)
  aggregator.observe("agent", list([["build", "1"], ["plan", "1"]]), key, signature)
  aggregator.observe("skill", list([["format", "2"]]), key, signature)
  aggregator.observe("command", list([]), key, signature)
  aggregator.observe("plugin", list([["fmt", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([
    {
      variant: "info",
      title: "Reloaded!",
      message: "Config: Server\nAgents: +1\nSkills: ~1\nCommands: -1\nPlugins: ~1",
    },
  ])
})

test("config additions and removals still render a bare Config line", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  const keep = configDoc("/cfg/opencode.json", "keep")
  const project = configDoc("/work/.opencode/opencode.jsonc", "project")

  aggregator.observe("config", [keep, configDoc("/cfg/opencode.jsonc", "gone"), project], configKey, configSignature)
  aggregator.trigger("config")
  aggregator.observe("config", [keep, configDoc("/cfg/extra.jsonc", "new"), project], configKey, configSignature)
  jest.advanceTimersByTime(GROUPING_WINDOW_MS)

  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Config: Server" }])
})

test("a triggered source that resyncs unchanged does not suppress or pollute the toast", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("command", list([["review", "1"]]), key, signature)
  aggregator.observe("skill", list([["format", "1"]]), key, signature)

  aggregator.trigger("command")
  aggregator.trigger("skill")
  aggregator.observe("command", list([["review", "1"]]), key, signature)
  aggregator.observe("skill", list([["format", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Skills: ~1" }])
})

test("config directories with distinct paths do not hide each other", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("config", [configDir("/cfg/a"), configDir("/cfg/b")], configKey, configSignature)
  aggregator.trigger("config")
  aggregator.observe("config", [configDir("/cfg/a2"), configDir("/cfg/b")], configKey, configSignature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([{ variant: "info", title: "Reloaded!", message: "Config: Server" }])
})

test("a reload staged during the startup window still follows the initial load", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("skill", list([["format", "1"]]), key, signature)
  aggregator.trigger("skill")
  aggregator.observe("skill", list([["format", "2"]]), key, signature)
  aggregator.announceLoad({ cli: false, server: false })

  expect(shown).toEqual([{ variant: "info", title: "Loaded!", message: "Skills: 1" }])

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([
    { variant: "info", title: "Loaded!", message: "Skills: 1" },
    { variant: "info", title: "Reloaded!", message: "Skills: ~1" },
  ])
})

test("an initial load reports per-category totals", () => {
  const { shown, aggregator } = harness()
  aggregator.observe(
    "agent",
    list([
      ["build", "1"],
      ["plan", "1"],
    ]),
    key,
    signature,
  )
  aggregator.observe("skill", list([["a", "1"]]), key, signature)
  aggregator.announceLoad({ cli: true, server: true })

  expect(shown).toEqual([
    { variant: "info", title: "Loaded!", message: "Configs: CLI, Server\nAgents: 2\nSkills: 1" },
  ])
})

test("an initial load shows builtins separately", () => {
  const { shown, aggregator } = harness()
  const isBuiltin = (item: Item) => item.id.startsWith("builtin-")
  aggregator.observe(
    "skill",
    list([
      ["user-a", "1"],
      ["builtin-a", "1"],
      ["builtin-b", "1"],
    ]),
    key,
    signature,
    isBuiltin,
  )
  aggregator.announceLoad({ cli: false, server: false })

  expect(shown).toEqual([{ variant: "info", title: "Loaded!", message: "Skills: 1 (+2 builtins)" }])
})

test("an initial load of only builtins still reports the source", () => {
  const { shown, aggregator } = harness()
  const isBuiltin = () => true
  aggregator.observe(
    "skill",
    list([
      ["x", "1"],
      ["y", "1"],
    ]),
    key,
    signature,
    isBuiltin,
  )
  aggregator.announceLoad({ cli: false, server: false })

  expect(shown).toEqual([{ variant: "info", title: "Loaded!", message: "Skills: (+2 builtins)" }])
})

test("an initial load with nothing loaded shows no toast", () => {
  const { shown, aggregator } = harness()
  aggregator.observe("agent", list([]), key, signature)
  aggregator.announceLoad({ cli: false, server: false })

  expect(shown).toEqual([])
})

test("the initial load is announced only once", () => {
  const { shown, aggregator } = harness()
  aggregator.observe("agent", list([["build", "1"]]), key, signature)
  aggregator.announceLoad({ cli: false, server: false })
  aggregator.announceLoad({ cli: false, server: false })

  expect(shown).toEqual([{ variant: "info", title: "Loaded!", message: "Agents: 1" }])
})

test("a reload after the initial load is reported normally", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  aggregator.observe("agent", list([["build", "1"]]), key, signature)
  aggregator.announceLoad({ cli: false, server: false })
  aggregator.trigger("agent")
  aggregator.observe("agent", list([["build", "2"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([
    { variant: "info", title: "Loaded!", message: "Agents: 1" },
    { variant: "info", title: "Reloaded!", message: "Agents: ~1" },
  ])
})

// A document config entry at an absolute path, mirroring the shape the client
// returns from `config.get`.
function configDoc(path: string, username: string): ConfigEntry {
  return { type: "document", path, info: { username } }
}

test("a server config reload is reported when a project entry shares its basename", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  const globalDoc = (username: string) => configDoc("/cfg/opencode.jsonc", username)
  const projectDoc = configDoc("/work/.opencode/opencode.jsonc", "project")

  // Startup: every source is observed once, seeding the baseline a reload diffs
  // against. Nothing is reported yet.
  aggregator.observe("config", [globalDoc("one"), projectDoc], configKey, configSignature)
  aggregator.observe("agent", list([["build", "1"]]), key, signature)
  aggregator.observe("skill", list([["format", "1"]]), key, signature)
  expect(shown).toEqual([])

  // A reload: the server config and a skill change land together. The global
  // and project documents both reduce to the basename `opencode.jsonc`, so
  // keying on it would let the unchanged project entry hide the global change.
  aggregator.trigger("config")
  aggregator.trigger("skill")
  aggregator.observe("config", [globalDoc("two"), projectDoc], configKey, configSignature)
  aggregator.observe("skill", list([["format", "2"]]), key, signature)

  // Grouping holds the notice until the window closes.
  expect(shown).toEqual([])

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([
    {
      variant: "info",
      title: "Reloaded!",
      message: "Config: Server\nSkills: ~1",
    },
  ])
})

// A skill's reference files are not part of its `SkillInfo`, so adding or
// removing one leaves the skill list unchanged. The reload reports nothing for
// it rather than inventing a change. Making reference-file edits visible is a
// follow-up: the server would need to fold the skill directory into the entry.
test("a skill reference-file change reports nothing while the skill list is unchanged", () => {
  jest.useFakeTimers()
  const { shown, aggregator } = harness()
  const skills = list([["demo-skill", "demo-skill|body|false"]])

  aggregator.observe("skill", skills, key, signature)
  // The watcher fires for the nested reference file, but the resync returns the
  // same skill with the same signature.
  aggregator.trigger("skill")
  aggregator.observe("skill", list([["demo-skill", "demo-skill|body|false"]]), key, signature)

  jest.advanceTimersByTime(GROUPING_WINDOW_MS)
  expect(shown).toEqual([])
})
