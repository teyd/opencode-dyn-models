import { expect, test } from "bun:test"
import { Provider } from "@opencode/plugin"
import { displayId, displayName, indexCatalog, keep, matchKey, prefixOf, resolveEnv, toModel } from "../src/index.js"

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
