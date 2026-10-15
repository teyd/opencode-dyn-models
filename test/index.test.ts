import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Provider } from "@opencode/plugin"
import {
  cachePath,
  credentialEnvNames,
  credentialFor,
  displayId,
  displayName,
  indexCatalog,
  keep,
  loadCatalog,
  matchKey,
  prefixOf,
  readCache,
  resolveEnv,
  toModel,
  writeCache,
} from "../src/index.js"

const filter = (hide: string[] = [], show: string[] = []) => ({
  hide: hide.map((pattern) => new RegExp(pattern, "i")),
  show: show.map((pattern) => new RegExp(pattern, "i")),
})

test("resolveEnv substitutes set variables and blanks unset ones", () => {
  const env = { COMMANDCODE_API_KEY: "sk-test" }
  expect(resolveEnv("{env:COMMANDCODE_API_KEY}", env)).toBe("sk-test")
  expect(resolveEnv("{env:MISSING}", env)).toBe("")
  expect(resolveEnv("plain-key", env)).toBe("plain-key")
  expect(resolveEnv(undefined, env)).toBeUndefined()
})

test("hide patterns drop matching ids and names", () => {
  const luna = { id: "gpt-6-luna", name: "GPT-6 Luna" }
  const claude = { id: "claude-sonnet-5", name: "Claude Sonnet 5" }
  const grok = { id: "xai/grok-4.7", name: "Grok 4.7" }

  expect(keep(luna, filter(["^claude-", "^xai/", "^google/"]))).toBe(true)
  expect(keep(claude, filter(["^claude-"]))).toBe(false)
  expect(keep(grok, filter(["grok"]))).toBe(false)
  expect(keep(grok, filter(["^Grok"]))).toBe(false)
})

test("show only un-hides a hidden model", () => {
  const luna = { id: "gpt-6-luna", name: "GPT-6 Luna" }
  const sol = { id: "gpt-6-sol", name: "GPT-6 Sol" }
  const deepseek = { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }
  const hidden = filter(["^gpt-"], ["luna"])

  expect(keep(luna, hidden)).toBe(true)
  expect(keep(sol, hidden)).toBe(false)
  expect(keep(deepseek, hidden)).toBe(true)
  expect(keep(sol, filter())).toBe(true)
})

test("names drop the vendor prefix and share one tag", () => {
  expect(displayId("deepseek/deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash")
  expect(displayId("Qwen/Qwen3.8-Flash")).toBe("qwen3.8-flash")
  expect(displayId("stealth/glyph-cluster:free")).toBe("glyph-cluster-free")
  expect(prefixOf("Command Code")).toBe("CC")
  expect(displayName("CC", "deepseek-v4.1-flash")).toBe("[CC] deepseek-v4.1-flash")
  expect(matchKey("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(matchKey("deepseek/deepseek-v4.1-flash"))
})

test("toModel keeps the upstream id and overlays models.dev", () => {
  const providerID = Provider.ID.make("commandcode")
  const model = toModel(
    providerID,
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1000000 },
    "CC",
    {
      family: "deepseek",
      tool_call: true,
      release_date: "2026-06-09",
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1000000, output: 128000 },
      cost: { input: 0.14, output: 0.28, cache_read: 0.01 },
    },
  )

  expect(String(model.id)).toBe("deepseek-v4.1-flash")
  expect(String(model.modelID)).toBe("deepseek/deepseek-v4.1-flash")
  expect(model.name).toBe("[CC] deepseek-v4.1-flash")
  expect(model.limit.output).toBe(128000)
  expect(Number(model.cost[0]?.input)).toBe(0.14)
  expect(Number(model.cost[0]?.cache.read)).toBe(0.01)
  expect(Number(model.cost[0]?.cache.write)).toBe(0)
  expect(model.capabilities.tools).toBe(true)
  expect(model.time.released).toBe(Date.parse("2026-06-09"))
})

test("indexCatalog prefers the priced entry for one normalized id", () => {
  const index = indexCatalog({
    a: { models: { "deepseek-ai/DeepSeek-V4.1-Flash": { name: "bare" } } },
    b: { models: { "deepseek-v4.1-flash": { name: "priced", cost: { input: 1, output: 2 }, limit: { context: 10 } } } },
  })
  expect(index.get("deepseek-v4-1-flash")?.name).toBe("priced")
})

const tempCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dyn-models-")), "models-dev.json")

test("credentialEnvNames prefers the option template", () => {
  expect(credentialEnvNames("commandcode", "{env:COMMANDCODE_API_KEY}")).toEqual(["COMMANDCODE_API_KEY"])
  expect(credentialEnvNames("command-code")).toEqual(["OPENCODE_LOCAL_COMMAND_CODE_API_KEY"])
})

const reader = (active: unknown, value?: unknown) =>
  ({
    connection: {
      active: async () => active,
      resolve: async () => value,
    },
  }) as unknown as Parameters<typeof credentialFor>[0]

test("credentialFor prefers a stored key and otherwise uses the option", async () => {
  const options = { baseURL: "http://127.0.0.1", apiKey: "{env:COMMANDCODE_API_KEY}" }
  const stored = await credentialFor(
    reader({ type: "credential", id: "cred_1" }, { type: "key", key: "stored" }),
    "commandcode",
    options,
  )
  expect(stored).toEqual({ key: "stored", identity: "credential:cred_1" })

  const env = await credentialFor(
    reader({ type: "env", name: "COMMANDCODE_API_KEY" }, { type: "key", key: "from-env" }),
    "commandcode",
    options,
  )
  expect(env.identity).toBe("env:COMMANDCODE_API_KEY")

  const fallback = await credentialFor(reader(undefined), "commandcode", options)
  expect(fallback.identity).toBe("options")
  expect(fallback.key).toBeUndefined()
})

test("credentialFor does not replace a stored OAuth connection with the option", async () => {
  await expect(
    credentialFor(
      reader({ type: "credential", id: "cred_1" }, { type: "oauth", access: "token" }),
      "commandcode",
      { baseURL: "http://127.0.0.1", apiKey: "plain" },
    ),
  ).rejects.toThrow("OAuth")
})

test("cachePath honours XDG_CACHE_HOME", () => {
  expect(cachePath({ XDG_CACHE_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/opencode-dyn-models/models-dev.json")
})

test("writeCache then readCache round-trips, and a bad file reads as empty", () => {
  const file = tempCache()
  writeCache(file, { a: { models: { m: { name: "M" } } } }, 123)
  expect(readCache(file)).toEqual({ timestamp: 123, data: { a: { models: { m: { name: "M" } } } } })

  fs.writeFileSync(file, "not json")
  expect(readCache(file)).toBeUndefined()
  expect(readCache(path.join(os.tmpdir(), "dyn-models-missing.json"))).toBeUndefined()
})

test("loadCatalog serves a fresh cache without touching the network", async () => {
  const file = tempCache()
  writeCache(file, { a: { models: { "deepseek-v4.1-flash": { name: "fresh", cost: { input: 1, output: 2 } } } } }, 1000)

  const original = globalThis.fetch
  let called = false
  globalThis.fetch = (async () => {
    called = true
    throw new Error("network should not be hit")
  }) as unknown as typeof fetch
  try {
    const known = await loadCatalog(file, 1000 + 60_000)
    expect(called).toBe(false)
    expect(known.get("deepseek-v4-1-flash")?.name).toBe("fresh")
  } finally {
    globalThis.fetch = original
  }
})

test("loadCatalog refetches a stale cache and persists the result", async () => {
  const file = tempCache()
  writeCache(file, { a: { models: { old: { name: "old" } } } }, 0)

  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ a: { models: { fresh: { name: "fresh" } } } }), { status: 200 })) as unknown as typeof fetch
  try {
    const known = await loadCatalog(file, 10 * 60 * 60 * 1000)
    expect(known.get("fresh")?.name).toBe("fresh")
    expect(readCache(file)?.data).toEqual({ a: { models: { fresh: { name: "fresh" } } } })
  } finally {
    globalThis.fetch = original
  }
})

test("loadCatalog falls back to a stale cache when the network fails", async () => {
  const file = tempCache()
  writeCache(file, { a: { models: { stale: { name: "stale" } } } }, 0)

  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch
  try {
    const known = await loadCatalog(file, 10 * 60 * 60 * 1000)
    expect(known.get("stale")?.name).toBe("stale")
  } finally {
    globalThis.fetch = original
  }
})
