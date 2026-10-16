import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Integration, Model, Plugin, Provider } from "@opencode/plugin"

/**
 * One entry in the plugin's `providers` option.
 *
 * At startup the plugin calls `GET {baseURL}/models` with the API key, drops
 * anything matching `hide`, and registers the rest. Names, limits, price, tool
 * support and effort levels come from models.dev when the model is in that catalog.
 */
export type ProviderOptions = {
  /** Display name. Defaults to the provider id. Also used to build `prefix`. */
  name?: string
  /** Short tag in model names, e.g. `CC` → `[CC] DeepSeek V4.1 Flash`. Defaults to the initials of `name`. */
  prefix?: string
  /** Base URL of the OpenAI-compatible API, without a trailing `/models`. */
  baseURL: string
  /** Credential: a plain value or `{env:VARIABLE}`. Omit on unauthenticated endpoints. */
  apiKey?: string
  /** Runtime package. Defaults to the OpenAI-compatible one. */
  package?: string
  /** Extra headers, sent to both the models request and model requests. */
  headers?: Record<string, string>
  /** Regexes; a model is hidden when any of them matches its upstream id or name. */
  hide?: string | string[]
  /** Regexes that un-hide a model already matched by `hide`. They do not hide anything else. */
  show?: string | string[]
  /**
   * Replaces the models.dev effort levels on models already flagged as reasoning,
   * sent as `reasoning_effort`. It does not flag models by itself; use `reasoning` for that.
   * `false` turns variants off.
   */
  effort?: string[] | false
  /** Regexes of models that get effort levels even when models.dev does not flag them as reasoning models. */
  reasoning?: string | string[]
  /** Path of the models list, relative to `baseURL`. Defaults to `/models`. */
  endpoint?: string
  /** Timeout for the models request in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** Keep only models whose raw field matches one of these rules. Applied before `hide`/`show`. */
  includeBy?: FieldRule[]
  /** Drop models whose raw field matches one of these rules. Wins over `includeBy`. */
  excludeBy?: FieldRule[]
  /** Reuse the last `/models` response on disk instead of requesting it on every start. Off by default. */
  cache?: { enabled?: boolean; ttlSeconds?: number }
}

/** A test on one top-level field of a raw `/models` entry: `match` is a regex, `equals` is strict equality. */
export type FieldRule = { field: string; match?: string; equals?: unknown }

export type Options = {
  providers?: Record<string, ProviderOptions>
  /** The models.dev catalog: a mirror URL and how long the on-disk copy stays fresh. */
  catalog?: { url?: string; ttlSeconds?: number }
}

type Loaded = { info: Provider.Info; models: Model.Info[] }

/** The bits of a models.dev entry this plugin copies onto a discovered model. */
export type CatalogModel = {
  id?: string
  name?: string
  family?: string
  tool_call?: boolean
  reasoning?: boolean
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; input?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible"
const CATALOG_URL = "https://models.dev/api.json"
/** How long a cached models.dev catalog is reused before a refetch. */
const CATALOG_TTL = 6 * 60 * 60 * 1000
const ENV = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const MAX_REDIRECTS = 5
const DEFAULT_EFFORT = ["low", "medium", "high"]
const asArray = (value?: string | string[]) => (value === undefined ? [] : Array.isArray(value) ? value : [value])

/** Replace `{env:NAME}` with the matching environment variable, or nothing when unset. */
export const resolveEnv = (value?: string, env: NodeJS.ProcessEnv = process.env) =>
  value?.replace(ENV, (_, name: string) => env[name] ?? "")

/** Env variable OpenCode's own connection resolution looks at when the option names none. */
export const envName = (id: string) => `OPENCODE_LOCAL_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`

/** Variables the integration's env method should read. A `{env:NAME}` option wins. */
export function credentialEnvNames(id: string, apiKey?: string): string[] {
  const named = [...(apiKey?.matchAll(ENV) ?? [])].map((match) => match[1]).filter((name): name is string => !!name)
  return [...new Set(named.length ? named : [envName(id)])]
}

type Integration = Plugin.Context["integration"]
/** The key discovery would authenticate with, plus where it came from (never the secret itself). */
export type Credential = { key?: string; identity: string }

/**
 * The credential OpenCode would use to run this provider: its active connection
 * (a stored `/connect` key or the `OPENCODE_LOCAL_<ID>_API_KEY` env method), and
 * only without one the plugin's own `apiKey` option. An OAuth connection is
 * rejected rather than silently falling back to a different credential.
 */
export async function credentialFor(
  integration: Integration,
  id: string,
  options: ProviderOptions,
): Promise<Credential> {
  const fallback: Credential = { key: resolveEnv(options.apiKey) || undefined, identity: "options" }
  let connection
  try {
    connection = await integration.connection.active(id)
  } catch (error) {
    warn(`${id}: could not read the active connection: ${(error as Error).message}`)
    return fallback
  }
  if (!connection) return fallback

  try {
    const value = await integration.connection.resolve(connection)
    if (value?.type === "key") {
      const identity = connection.type === "env" ? `env:${connection.name}` : `credential:${connection.id}`
      return { key: value.key, identity }
    }
    if (value) throw new Error("an OAuth connection is not supported for model discovery")
  } catch (error) {
    // A stored connection is authoritative: never fall back to another credential for it.
    if (connection.type === "credential") throw error
    warn(`${id}: could not resolve the active connection: ${(error as Error).message}`)
  }
  return fallback
}

/** `Command Code` → `CC`. A single word keeps its first two letters. */
export function prefixOf(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const letters = words.length > 1 ? words.map((word) => word[0]).join("") : name.slice(0, 2)
  return letters.toUpperCase().slice(0, 4) || "XX"
}

/** `deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`. The vendor prefix is dropped. */
export function displayId(rawId: string): string {
  const tail = rawId.split("/").pop() ?? rawId
  return tail
    .toLowerCase()
    .replace(/:/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Same id with `.` folded to `-`, so `v4.1` and `v4-1` match in models.dev. */
export const matchKey = (rawId: string) => displayId(rawId).replace(/\./g, "-")

export function displayName(prefix: string, id: string) {
  return `[${prefix}] ${id}`
}

const ACRONYMS = new Set(["gpt", "oss", "api", "gguf", "ggml", "vl", "mlx", "moe", "tts", "stt", "asr", "ocr"])

function titleCase(token: string): string {
  const lower = token.toLowerCase()
  if (ACRONYMS.has(lower) || /^\d+b$/i.test(token) || /^q\d+$/i.test(token)) return token.toUpperCase()
  if (/^\d+\.\d+/.test(token)) return token
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

/** Readable name from a raw id, used when models.dev has none: `deepseek/deepseek-v4.1-flash` → `Deepseek V4.1 Flash`. */
export function prettyName(rawId: string): string {
  const tail = rawId.split("/").pop() ?? rawId
  return tail.split(/[-_]+/).filter(Boolean).map(titleCase).join(" ") || rawId
}

/** Suffix models whose names collide with their upstream id, so the picker never shows two identical rows. */
export function disambiguate<T extends { name: string }>(models: T[], label: (model: T) => string): void {
  const counts = new Map<string, number>()
  for (const model of models) counts.set(model.name, (counts.get(model.name) ?? 0) + 1)
  for (const model of models) {
    if ((counts.get(model.name) ?? 0) > 1) model.name = `${model.name} (${label(model)})`
  }
}

/** Next URL for a redirect, or an error when it leaves the current origin. */
export function nextSameOrigin(current: string, location: string): string {
  const next = new URL(location, current)
  if (next.origin !== new URL(current).origin) throw new Error(`refusing cross-origin redirect to ${next.origin}`)
  return next.href
}

/** `fetch` that follows only same-origin redirects. */
export async function pinnedFetch(url: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get("location")
    if (!location) throw new Error("redirect missing location")
    current = nextSameOrigin(current, location)
  }
  throw new Error("too many redirects")
}

/** Replace bearer tokens and known secrets so a log line cannot carry a key. */
export function redact(message: string, secrets: Iterable<string | undefined> = []): string {
  let out = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue
    out = out.split(secret).join("[redacted]")
  }
  return out
}

function warn(message: string, secrets?: Iterable<string | undefined>) {
  console.warn(`[dyn-models] ${redact(message, secrets)}`)
}

function compile(patterns: string[]): RegExp[] {
  return patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern, "i")]
    } catch (error) {
      warn(`ignoring invalid pattern ${JSON.stringify(pattern)}: ${(error as Error).message}`)
      return []
    }
  })
}

/** Hide matches are dropped, unless `show` matches that same model. Anything else stays. */
export function keep(model: { id: string; name: string }, filter: { hide: RegExp[]; show: RegExp[] }) {
  const hit = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(model.id) || pattern.test(model.name))
  return !hit(filter.hide) || hit(filter.show)
}

/** Whether a raw entry satisfies a field rule. A rule with neither `match` nor `equals` never hits. */
export function ruleHits(entry: Record<string, unknown>, rule: FieldRule): boolean {
  const value = entry[rule.field]
  if ("equals" in rule && rule.equals !== undefined) return value === rule.equals
  if (rule.match === undefined || typeof value !== "string") return false
  try {
    return new RegExp(rule.match, "i").test(value)
  } catch (error) {
    warn(`ignoring invalid pattern ${JSON.stringify(rule.match)}: ${(error as Error).message}`)
    return false
  }
}

/** `includeBy` (when set) must match, then `excludeBy` must not. */
export function passesRules(entry: Record<string, unknown>, options: Pick<ProviderOptions, "includeBy" | "excludeBy">): boolean {
  const { includeBy, excludeBy } = options
  if (includeBy?.length && !includeBy.some((rule) => ruleHits(entry, rule))) return false
  return !excludeBy?.some((rule) => ruleHits(entry, rule))
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)

/** Effort variants for a reasoning model, in the order given. Blank and repeated levels are dropped. */
export function effortVariants(levels: readonly string[]): Model.Info["variants"] {
  return [...new Set(levels.map((level) => level.trim()).filter(Boolean))].map((level) => ({
    id: Model.VariantID.make(level),
    body: { reasoning_effort: level },
  })) as unknown as Model.Info["variants"]
}

/**
 * Effort levels models.dev lists for a model, without `none` (that switches reasoning off, it is not a level).
 * `undefined` when the entry says nothing; an empty list when it only offers a toggle or a token budget.
 */
export function catalogEfforts(catalog?: CatalogModel): string[] | undefined {
  const options = catalog?.reasoning_options
  if (!options?.length) return undefined
  const values = options.flatMap((option) => (option.type === "effort" ? (option.values ?? []) : []))
  const levels = [...new Set(values.filter((value) => value !== "none"))]
  // A single level is not a choice.
  return levels.length > 1 ? levels : []
}

/** Per-provider effort settings. `levels` is the explicit override; `disabled` turns variants off. */
export type Effort = { levels?: readonly string[]; disabled?: boolean; force: RegExp[] }

/** Map one discovered model onto an OpenCode model, overlaying a models.dev entry when there is one. */
export function toModel(
  providerID: Provider.ID,
  raw: Record<string, unknown>,
  prefix: string,
  catalog?: CatalogModel,
  id = displayId(String(raw.id)),
  effort?: Effort,
): Model.Info {
  const upstream = String(raw.id)
  const forced = !!effort?.force.some((pattern) => pattern.test(upstream) || pattern.test(String(raw.name ?? upstream)))
  const listed = catalogEfforts(catalog)
  // models.dev wins over the default list; a toggle-only entry gets no levels unless the user forced it.
  const fallback = listed?.length ? listed : listed && !forced ? [] : DEFAULT_EFFORT
  const levels = !effort || effort.disabled ? [] : (effort.levels ?? fallback)
  const reasoning = levels.length > 0 && (catalog?.reasoning === true || forced)
  const base = Model.Info.default(providerID, Model.ID.make(id))
  const context = catalog?.limit?.context ?? count(raw.context_length ?? raw.context_window ?? raw.max_context_tokens)
  const output = catalog?.limit?.output ?? count(raw.max_output_tokens ?? raw.max_completion_tokens)
  const released = catalog?.release_date ? Date.parse(catalog.release_date) : base.time.released
  const price = catalog?.cost
  return {
    ...base,
    id: Model.ID.make(id),
    modelID: Model.ID.make(upstream),
    name: displayName(prefix, catalog?.name?.trim() || prettyName(upstream)),
    family: catalog?.family as Model.Info["family"],
    capabilities: {
      tools: catalog?.tool_call ?? base.capabilities.tools,
      input: catalog?.modalities?.input?.length ? catalog.modalities.input : base.capabilities.input,
      output: catalog?.modalities?.output?.length ? catalog.modalities.output : base.capabilities.output,
    },
    limit: {
      context: context ?? base.limit.context,
      output: output ?? base.limit.output,
      ...(catalog?.limit?.input ? { input: catalog.limit.input } : {}),
    },
    ...(reasoning ? { variants: effortVariants(levels) } : {}),
    time: { released: Number.isFinite(released) ? released : base.time.released },
    cost: priced(price) ?? base.cost,
  }
}

function priced(cost: CatalogModel["cost"]): Model.Info["cost"] | undefined {
  if (!cost || count(cost.input) === undefined || count(cost.output) === undefined) return
  return [{ input: cost.input!, output: cost.output!, cache: { read: cost.cache_read ?? 0, write: cost.cache_write ?? 0 } }] as unknown as Model.Info["cost"]
}

/** Index models.dev by normalized id. A priced entry beats an unpriced one for the same id. */
export function indexCatalog(api: Record<string, { models?: Record<string, CatalogModel> }>): Map<string, CatalogModel> {
  const index = new Map<string, CatalogModel>()
  const votes = new Map<string, Map<string, { count: number; levels: string[] }>>()
  for (const provider of Object.values(api)) {
    for (const [id, model] of Object.entries(provider.models ?? {})) {
      const key = matchKey(model.id ?? id)
      const previous = index.get(key)
      if (!previous || score(model) > score(previous)) index.set(key, model)
      if (model.reasoning_options?.some((option) => option.type === "effort")) {
        const levels = catalogEfforts(model) ?? []
        const ballot = votes.get(key) ?? new Map()
        const entry = ballot.get(levels.join(",")) ?? { count: 0, levels }
        ballot.set(levels.join(","), { ...entry, count: entry.count + 1 })
        votes.set(key, ballot)
      }
    }
  }
  // Hosts disagree on a model's effort levels, so use the most common list. A tie says nothing.
  for (const [key, ballot] of votes) {
    const ranked = [...ballot.values()].sort((a, b) => b.count - a.count)
    const winner = ranked[0]!.count > (ranked[1]?.count ?? 0) ? ranked[0]!.levels : undefined
    index.set(key, { ...index.get(key)!, reasoning_options: winner ? [{ type: "effort", values: winner }] : undefined })
  }
  return index
}

const score = (model: CatalogModel) => (model.cost ? 2 : 0) + (model.limit?.context ? 1 : 0)

type CatalogApi = Record<string, { models?: Record<string, CatalogModel> }>

/** Path of the on-disk models.dev cache, under `$XDG_CACHE_HOME` (default `~/.cache`). */
export function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.XDG_CACHE_HOME || path.join(os.homedir() || os.tmpdir(), ".cache")
  return path.join(root, "opencode-dyn-models", "models-dev.json")
}

type CacheEntry = { timestamp: number; data: CatalogApi }

/** Reads the cached catalog, ignoring a missing, unreadable, or malformed file. */
export function readCache(file: string): CacheEntry | undefined {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8")) as CacheEntry
    return entry && typeof entry.timestamp === "number" && entry.data ? entry : undefined
  } catch {
    return undefined
  }
}

export function writeCache(file: string, data: CatalogApi, now = Date.now()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ timestamp: now, data }), { mode: 0o600 })
  } catch {
    // The cache is best-effort; a failure only costs a network fetch next time.
  }
}

let catalogPromise: Promise<Map<string, CatalogModel>> | undefined

/** models.dev metadata; one fetch per process, served from disk while it is fresh. */
export function catalog(settings: CatalogSettings = {}): Promise<Map<string, CatalogModel>> {
  catalogPromise ??= loadCatalog(cachePath(), Date.now(), settings)
  return catalogPromise
}

export type CatalogSettings = { url?: string; ttlSeconds?: number }

export type ModelsCache = { timestamp: number; baseURL: string; list: unknown[] }

/** Plugin-scoped durable storage, as `ctx.storage` provides it. */
export type Store = {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<void>
}

/** A cached list, only when it is fresh and was fetched from the same endpoint. */
export function freshList(entry: unknown, key: string, ttlSeconds: number, now = Date.now()): unknown[] | undefined {
  const cached = entry as Partial<ModelsCache> | undefined
  if (!cached || cached.baseURL !== key || !Array.isArray(cached.list) || typeof cached.timestamp !== "number") return undefined
  return now - cached.timestamp <= ttlSeconds * 1000 ? cached.list : undefined
}

export const modelsKey = (id: string) => `models/${id}`

export async function loadCatalog(file: string, now = Date.now(), settings: CatalogSettings = {}): Promise<Map<string, CatalogModel>> {
  const cached = readCache(file)
  const ttl = settings.ttlSeconds !== undefined ? settings.ttlSeconds * 1000 : CATALOG_TTL
  if (cached && now - cached.timestamp <= ttl) return indexCatalog(cached.data)
  try {
    const response = await pinnedFetch(settings.url ?? CATALOG_URL, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = (await response.json()) as CatalogApi
    writeCache(file, data, now)
    return indexCatalog(data)
  } catch (error) {
    warn(`models.dev unavailable, using ${cached ? "cached" : "no"} metadata: ${(error as Error).message}`)
    return cached ? indexCatalog(cached.data) : new Map()
  }
}

async function load(
  integration: Integration,
  id: string,
  options: ProviderOptions,
  known: Map<string, CatalogModel>,
  signal?: AbortSignal,
  store?: Store,
  force = false,
): Promise<Loaded | undefined> {
  const credential = await credentialFor(integration, id, options)
  const apiKey = credential.key
  if (!apiKey && options.apiKey) {
    warn(`${id}: ${options.apiKey} is not set and no connection is active, skipping`)
    return undefined
  }

  const providerID = Provider.ID.make(id)
  const prefix = options.prefix ?? prefixOf(options.name ?? id)
  const filter = { hide: compile(asArray(options.hide)), show: compile(asArray(options.show)) }
  const effort: Effort = {
    levels: options.effort === false ? undefined : options.effort,
    disabled: options.effort === false,
    force: compile(asArray(options.reasoning)),
  }
  const endpoint = `${options.baseURL.replace(/\/+$/, "")}/${(options.endpoint ?? "/models").replace(/^\/+/, "")}`
  const cacheOn = options.cache?.enabled === true && !!store
  const ttl = options.cache?.ttlSeconds ?? 86_400
  let list = cacheOn && !force ? freshList(await store!.get(modelsKey(id)).catch(() => undefined), endpoint, ttl) : undefined
  if (!list) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
    const secrets = [apiKey, ...Object.values(options.headers ?? {})]
    let response: Response
    try {
      response = await pinnedFetch(endpoint, {
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...options.headers,
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      throw new Error(redact((error as Error).message, secrets))
    }
    if (!response.ok) throw new Error(`models request failed: ${response.status} ${response.statusText}`)

    const body = (await response.json()) as { data?: unknown[] } | unknown[]
    list = Array.isArray(body) ? body : (body.data ?? [])
    if (cacheOn) await store!.set(modelsKey(id), { timestamp: Date.now(), baseURL: endpoint, list } as never).catch(() => undefined)
  }
  const used = new Set<string>()
  const models = list
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string")
    .filter((entry) => passesRules(entry, options))
    .filter((entry) => keep({ id: String(entry.id), name: String(entry.name ?? entry.id) }, filter))
    .map((entry) => {
      let slug = displayId(String(entry.id))
      if (used.has(slug)) slug = `${slug}-${used.size}`
      used.add(slug)
      return toModel(providerID, entry, prefix, known.get(matchKey(String(entry.id))), slug, effort)
    })
  if (!models.length) throw new Error("no models left, check your hide/show patterns")
  disambiguate(models, (model) => String(model.modelID))

  return {
    info: {
      ...Provider.Info.empty(providerID),
      name: options.name ?? id,
      activation: "enabled",
      package: options.package ?? DEFAULT_PACKAGE,
      integrationID: Integration.ID.make(id),
      // A stored connection authenticates requests itself. Only the options fallback has no account to point at.
      settings: { baseURL: options.baseURL, ...(credential.identity === "options" && apiKey ? { apiKey } : {}) },
      ...(options.headers ? { headers: options.headers } : {}),
    },
    models,
  }
}

/** Summary line for a discovery run, e.g. `commandcode: 12 models`. */
export const summary = (loaded: Loaded[]) => loaded.map(({ info, models }) => `${info.id}: ${models.length} models`).join(", ")

export default Plugin.define({
  id: "opencode-dyn-models",
  async setup(ctx) {
    const entries = Object.entries((ctx.options.providers ?? {}) as Record<string, ProviderOptions>)
    if (!entries.length) {
      warn("no providers configured, add options.providers to the plugin entry")
      return
    }

    // Discovery runs off the startup path so a slow endpoint or models.dev never delays boot.
    // The transform replays whatever has loaded so far; a reload after discovery makes the models visible.
    await ctx.integration.transform((editor) => {
      for (const [id, options] of entries) {
        editor.update(id, (integration) => {
          integration.name = options.name ?? id
        })
        editor.method.update({
          integrationID: id,
          method: { type: "key", label: "API key" },
        })
        editor.method.update({
          integrationID: id,
          method: { type: "env", names: credentialEnvNames(id, options.apiKey) },
        })
      }
    })

    let loaded: Loaded[] = []
    await ctx.provider.transform((editor) => {
      for (const { info, models } of loaded) editor.add({ info, models })
    })

    const abort = new AbortController()
    const store = ctx.storage as unknown as Store
    let running: Promise<string> = Promise.resolve("")

    /** One discovery pass over `only` (or every provider). Runs are serialized; `force` skips the models cache. */
    const discover = (force: boolean, only?: string, signal: AbortSignal = abort.signal): Promise<string> => {
      running = running.then(async () => {
        if (signal.aborted) return "cancelled"
        const known = await catalog((ctx.options.catalog ?? {}) as CatalogSettings)
        const wanted = entries.filter(([id]) => !only || id === only)
        const results = await Promise.all(
          wanted.map(([id, options]) =>
            load(ctx.integration, id, options, known, signal, store, force).catch((error: Error) => {
              warn(`${id}: ${error.message}`)
              return undefined
            }),
          ),
        )
        const fresh = results.filter((entry): entry is Loaded => entry !== undefined)
        if (signal.aborted) return "cancelled"
        // Providers outside this run keep their previous models.
        const kept = loaded.filter(({ info }) => !wanted.some(([id]) => id === info.id))
        loaded = [...kept, ...fresh]
        if (fresh.length) await ctx.provider.reload()
        const text = fresh.length ? summary(fresh) : "no models loaded, see the log"
        console.log(`[dyn-models] ${text}`)
        return text
      })
      running = running.catch((error: Error) => {
        warn(`discovery failed: ${error.message}`)
        return `discovery failed: ${error.message}`
      })
      return running
    }

    void discover(false)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "refresh",
        description: "Re-fetch the model list of the dyn-models providers, bypassing the models cache.",
        input: {
          type: "object",
          properties: { provider: { type: "string", description: "Provider id. Omit to refresh all." } },
          additionalProperties: false,
        },
        options: { namespace: "dyn_models" },
        execute: async (input, context) => {
          const only = (input as { provider?: string }).provider
          if (only && !entries.some(([id]) => id === only)) return { content: `unknown provider ${only}` }
          return { content: await discover(true, only, AbortSignal.any([abort.signal, context.signal])) }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "dyn-models-refresh",
        description: "Re-fetch dyn-models provider model lists",
        execute: async ({ sessionID, prompt }) => {
          const text = await discover(true, prompt.text.trim() || undefined)
          await ctx.session.synthetic({ sessionID, text: `dyn-models: ${text}` })
        },
      })
    })

    // A new or switched credential can unblock a skipped provider; the models cache keeps this cheap.
    const events = new AbortController()
    let pending: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type !== "credential.updated" && event.type !== "credential.switched") continue
          clearTimeout(pending)
          pending = setTimeout(() => void discover(false), 500)
        }
      } catch (error) {
        if (!events.signal.aborted) warn(`event stream stopped: ${(error as Error).message}`)
      }
    })()

    return () => {
      clearTimeout(pending)
      events.abort()
      abort.abort()
    }
  },
})
