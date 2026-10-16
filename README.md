# opencode-dyn-models

OpenCode v2 plugin. On startup it fetches each provider's model list, hides what you don't want, and fills in names, limits, prices and reasoning-effort levels from [models.dev](https://models.dev).

Model names look like `[CC] DeepSeek V4.1 Flash`: the models.dev name with the prefix in front. Models that models.dev doesn't know get a readable name from their id (`qwen2.5-coder-7b-instruct` → `Qwen2.5 Coder 7B Instruct`). If two models end up with the same name, the upstream id is appended in parentheses. The id sent to the provider stays the upstream id.

## Install

Point `opencode.json(c)` at the Git package; OpenCode installs it on startup. The spec must resolve to a directory (OpenCode loads its `index.ts`), which GitHub, npm, and local paths all do.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:teyd/opencode-dyn-models",
      "options": {
        "providers": {
          "commandcode": {
            "name": "Command Code",
            "prefix": "CC",
            "baseURL": "https://api.commandcode.ai/provider/v1",
            "apiKey": "{env:COMMANDCODE_API_KEY}",
            "hide": ["^claude-", "^google/", "^xai/", "^gpt-"],
            "show": ["luna"],
            "cache": { "enabled": true, "ttlSeconds": 86400 }
          }
        }
      }
    }
  ]
}
```

`cache` is optional but recommended: it skips the `/models` request on start until the TTL passes. Every other option in this README has a default and can stay out.

Append `#<commit>` to pin a reviewed revision: branches and tags still track the remote, so only a full commit hash (or an exact npm version) stays put. Bump it when you mean to pick up a new release.

To run a local checkout instead, use its path: `"package": "/path/to/opencode-dyn-models"`. After changing plugin code, run `opencode service restart`.

Then log in for the provider you configured. Together with the `opencode.json` entry above, this stores the key and lets the plugin discover its models:

```sh
opencode auth login commandcode --method key
```

`show` only brings back a model that `hide` removed. `hide: ["^gpt-"]` and `show: ["luna"]` drops the other GPT models and still lists DeepSeek. `prefix` defaults to the initials of `name` (`Command Code` → `CC`).

## Filtering on raw fields

`includeBy` and `excludeBy` test top-level fields of each entry in the `/models` response, `match` as a regex or `equals` as strict equality. `includeBy` keeps only matching models, `excludeBy` removes matches and wins over `includeBy`. They run before `hide`/`show`.

```jsonc
"includeBy": [{ "field": "id", "match": "^(gpt|deepseek)" }],
"excludeBy": [{ "field": "available", "equals": false }]
```

## Endpoint, timeout and caching

| Option | Meaning |
| --- | --- |
| `endpoint` | Models path relative to `baseURL`. Default `/models`. |
| `timeoutMs` | Timeout of the models request. Default `30000`. |
| `cache` | `{ "enabled": true, "ttlSeconds": 86400 }` reuses the last `/models` response, kept in OpenCode's plugin storage, while it is fresh. Off by default. |

The cache holds the raw response, never keys or headers, and is ignored if `baseURL` or `endpoint` changed. Filters, effort levels and prices are applied on every start, so config edits take effect at once. A stale cache is never used when the request fails.

The models.dev catalog is cached on disk too. Set a mirror or freshness at plugin level, next to `providers`:

```jsonc
"options": { "catalog": { "url": "https://mirror.example/api.json", "ttlSeconds": 21600 }, "providers": { } }
```

## Refreshing

- `/dyn-models-refresh [provider]` re-fetches the model lists, bypassing the cache, and posts the result in the session.
- The `dyn_models_refresh` tool does the same for the agent (optional `provider` input).
- Connecting or switching a credential re-runs discovery by itself, so a provider skipped for a missing key shows up without a restart. This one may use the cache.

## Effort levels

This is worked out dynamically on every discovery run. A model that models.dev flags as reasoning gets one variant per effort level, each adding `reasoning_effort: "<level>"` to the request body; you pick one with the variant cycle key. There is nothing to configure for the common case.

The levels come from models.dev. For example, DeepSeek V4.1 Flash gets `low`, `high` and `max` — no `medium`. Hosts list different levels for the same model, so the plugin uses the most common list and ignores `none` (that switches reasoning off, it is not a level).

When the catalog flags a model as reasoning but lists no levels — hosts split evenly, or the entry only offers a toggle — the model gets `low`, `medium` and `high`. A model with no models.dev entry gets no variants unless the `reasoning` option matches it.

The options below only override that:

| Option | Meaning |
| --- | --- |
| `effort` | Replaces the discovered levels on models already flagged as reasoning (by models.dev or `reasoning`). It does not flag models by itself. `false` turns variants off everywhere. |
| `reasoning` | Regexes of models to treat as reasoning even when models.dev doesn't flag them (matched against upstream id and name). They get the discovered levels, or `low`, `medium` and `high`. |

```jsonc
"commandcode": {
  "baseURL": "https://api.commandcode.ai/provider/v1",
  "effort": ["low", "medium", "high", "xhigh"],
  "reasoning": ["luna"]
}
```

The endpoint has to accept `reasoning_effort`. If it ignores the field, the variants appear but change nothing.

The key comes from `/connect` or `opencode auth login <id> --method key` when that account is active. Otherwise it comes from the env method (`{env:NAME}` in `apiKey`, or `OPENCODE_LOCAL_<ID>_API_KEY`). `apiKey` is only the fallback.

A provider whose key is unset, or whose `/models` call fails, is skipped. A redirect off the provider's origin is refused. models.dev being down only means names still appear, without prices.
