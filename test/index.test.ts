import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Provider } from "@opencode/plugin"
import type { Effort } from "../src/index.js"
import {
  cachePath,
  catalogEfforts,
  credentialEnvNames,
  credentialFor,
  displayId,
  disambiguate,
  displayName,
  prettyName,
  freshList,
  effortVariants,
  indexCatalog,
  keep,
  loadCatalog,
  matchKey,
  nextSameOrigin,
  pinnedFetch,
  prefixOf,
  redact,
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
  expect(displayName("CC", "DeepSeek V4.1 Flash")).toBe("[CC] DeepSeek V4.1 Flash")
  expect(matchKey("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(matchKey("deepseek/deepseek-v4.1-flash"))
})

test("prettyName is the fallback when models.dev has no name", () => {
  expect(prettyName("deepseek/deepseek-v4.1-flash")).toBe("Deepseek V4.1 Flash")
  expect(prettyName("qwen2.5-coder-7b-instruct")).toBe("Qwen2.5 Coder 7B Instruct")
  expect(prettyName("meta/llama-3-8b-q4_k_m")).toBe("Llama 3 8B Q4 K M")
  expect(prettyName("openai/gpt-oss-20b")).toBe("GPT OSS 20B")
  expect(prettyName("google/gemma-3-vl")).toBe("Gemma 3 VL")
})

test("disambiguate suffixes colliding names with the upstream id", () => {
  const models = [{ name: "[CC] Mini", modelID: "a/mini" }, { name: "[CC] Mini", modelID: "b/mini" }, { name: "[CC] Solo", modelID: "c" }]
  disambiguate(models, (model) => model.modelID)
  expect(models.map((model) => model.name)).toEqual(["[CC] Mini (a/mini)", "[CC] Mini (b/mini)", "[CC] Solo"])
})

test("toModel falls back to a formatted name without a catalog entry", () => {
  const model = toModel(Provider.ID.make("commandcode"), { id: "deepseek/deepseek-v4.1-flash" }, "CC")
  expect(model.name).toBe("[CC] Deepseek V4.1 Flash")
})

test("toModel keeps the upstream id and overlays models.dev", () => {
  const providerID = Provider.ID.make("commandcode")
  const model = toModel(
    providerID,
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1000000 },
    "CC",
    {
      name: "DeepSeek V4.1 Flash",
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
  expect(model.name).toBe("[CC] DeepSeek V4.1 Flash")
  expect(model.limit.output).toBe(128000)
  expect(Number(model.cost[0]?.input)).toBe(0.14)
  expect(Number(model.cost[0]?.cache.read)).toBe(0.01)
  expect(Number(model.cost[0]?.cache.write)).toBe(0)
  expect(model.capabilities.tools).toBe(true)
  expect(model.time.released).toBe(Date.parse("2026-06-09"))
})

test("reasoning models get effort variants that set reasoning_effort", () => {
  const providerID = Provider.ID.make("commandcode")
  const effort = { levels: ["low", "high"], force: [/luna/i] }
  const variants = (model: ReturnType<typeof toModel>) => model.variants.map((variant) => [String(variant.id), variant.body])

  const flagged = toModel(providerID, { id: "deepseek/r2" }, "CC", { reasoning: true }, "r2", effort)
  expect(variants(flagged)).toEqual([
    ["low", { reasoning_effort: "low" }],
    ["high", { reasoning_effort: "high" }],
  ])

  const forced = toModel(providerID, { id: "gpt-6-luna" }, "CC", undefined, "gpt-6-luna", effort)
  expect(forced.variants).toHaveLength(2)

  const plain = toModel(providerID, { id: "qwen/plain" }, "CC", { reasoning: false }, "plain", effort)
  expect(plain.variants).toEqual([])

  const off = toModel(providerID, { id: "deepseek/r2" }, "CC", { reasoning: true }, "r2", { disabled: true, force: [] })
  expect(off.variants).toEqual([])

  expect(toModel(providerID, { id: "deepseek/r2" }, "CC", { reasoning: true }).variants).toEqual([])
  expect(effortVariants(["high", " high ", "", "max"]).map((variant) => String(variant.id))).toEqual(["high", "max"])
})

test("effort levels come from models.dev reasoning_options", () => {
  const providerID = Provider.ID.make("commandcode")
  const ids = (model: ReturnType<typeof toModel>) => model.variants.map((variant) => String(variant.id))
  const make = (catalog: Parameters<typeof toModel>[3], effort: Effort = { force: [] }) =>
    toModel(providerID, { id: "deepseek/deepseek-v4.1-flash" }, "CC", catalog, "deepseek-v4.1-flash", effort)

  const deepseek = { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["none", "low", "high", "max"] }] }
  expect(catalogEfforts(deepseek)).toEqual(["low", "high", "max"])
  expect(ids(make(deepseek))).toEqual(["low", "high", "max"])
  expect(make(deepseek).variants.at(-1)?.body).toEqual({ reasoning_effort: "max" })

  expect(ids(make({ reasoning: true, reasoning_options: [] }))).toEqual(["low", "medium", "high"])
  expect(ids(make({ reasoning: true }))).toEqual(["low", "medium", "high"])
  expect(ids(make({ reasoning: true, reasoning_options: [{ type: "toggle" }] }))).toEqual([])
  expect(ids(make({ reasoning: true, reasoning_options: [{ type: "toggle" }] }, { force: [/deepseek/] }))).toEqual(["low", "medium", "high"])
  expect(catalogEfforts({ reasoning_options: [{ type: "effort", values: ["none", "high"] }] })).toEqual([])
  expect(ids(make(deepseek, { levels: ["high", "xhigh"], force: [] }))).toEqual(["high", "xhigh"])
})

test("indexCatalog takes the most common effort list across hosts", () => {
  const host = (...values: string[]) => ({ models: { "deepseek/v4": { reasoning: true, reasoning_options: [{ type: "effort", values }] } } })
  const pick = (api: Parameters<typeof indexCatalog>[0]) => catalogEfforts(indexCatalog(api).get("v4"))
  expect(pick({ a: host("none", "low", "high", "max"), b: host("low", "high", "max"), c: host("low", "high", "xhigh") })).toEqual(["low", "high", "max"])
  expect(pick({ a: host("low", "high", "max"), b: host("low", "medium", "high") })).toBeUndefined()
  expect(pick({ a: host("low", "high", "max") })).toEqual(["low", "high", "max"])
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

test("redirects stay on the base origin", () => {
  expect(nextSameOrigin("https://api.commandcode.ai/provider/v1/models", "/provider/v1/models")).toBe(
    "https://api.commandcode.ai/provider/v1/models",
  )
  expect(() => nextSameOrigin("https://api.commandcode.ai/provider/v1/models", "https://evil.example/models")).toThrow(
    "evil.example",
  )
})

test("pinnedFetch follows a same-origin redirect and refuses another origin", async () => {
  const calls: string[] = []
  const fake = (async (url: string) => {
    calls.push(String(url))
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/v1/models" } })
    return new Response("[]", { status: 200 })
  }) as unknown as typeof fetch
  const ok = await pinnedFetch("https://api.commandcode.ai/provider/models", {}, fake)
  expect(ok.status).toBe(200)
  expect(calls[1]).toBe("https://api.commandcode.ai/v1/models")

  const cross = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })) as unknown as typeof fetch
  await expect(pinnedFetch("https://api.commandcode.ai/models", {}, cross)).rejects.toThrow("evil.example")
})

test("redact strips bearer tokens and known secrets", () => {
  expect(redact("Authorization: Bearer sk-live-secret failed sk-live-secret", ["sk-live-secret"])).toBe(
    "Authorization: Bearer [redacted] failed [redacted]",
  )
  expect(redact("short", ["ab"])).toBe("short")
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

test("includeBy and excludeBy filter on raw fields, exclude winning", async () => {
  const { passesRules } = await import("../src/index.js")
  const rules = {
    includeBy: [{ field: "id", match: "^(gpt|deepseek)" }],
    excludeBy: [{ field: "available", equals: false }, { field: "id", match: "image" }],
  }
  expect(passesRules({ id: "deepseek-v4" }, rules)).toBe(true)
  expect(passesRules({ id: "llama" }, rules)).toBe(false)
  expect(passesRules({ id: "gpt-5", available: false }, rules)).toBe(false)
  expect(passesRules({ id: "gpt-image-1" }, rules)).toBe(false)
  expect(passesRules({ id: "anything" }, {})).toBe(true)
})

test("models cache is reused while fresh and only for the same endpoint", () => {
  const entry = { timestamp: 1000, baseURL: "https://a/models", list: [{ id: "m" }] }
  expect(freshList(entry, "https://a/models", 60, 1000 + 59_000)).toEqual([{ id: "m" }])
  expect(freshList(entry, "https://a/models", 60, 1000 + 61_000)).toBeUndefined()
  expect(freshList(entry, "https://b/models", 60, 1000)).toBeUndefined()
  expect(freshList(undefined, "x", 60)).toBeUndefined()
  expect(freshList({ list: "no" }, "x", 60)).toBeUndefined()
})

test("loadCatalog honours a custom ttl and url", async () => {
  const file = tempCache()
  writeCache(file, { a: { models: { old: { name: "old" } } } }, 0)
  const original = globalThis.fetch
  let url = ""
  globalThis.fetch = (async (input: unknown) => {
    url = String(input)
    return new Response(JSON.stringify({ a: { models: { fresh: { name: "fresh" } } } }))
  }) as unknown as typeof fetch
  try {
    const known = await loadCatalog(file, 5_000, { url: "https://mirror.example/api.json", ttlSeconds: 1 })
    expect(url).toBe("https://mirror.example/api.json")
    expect(known.get("fresh")?.name).toBe("fresh")
  } finally {
    globalThis.fetch = original
  }
})
