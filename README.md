# opencode-dyn-models

OpenCode v2 plugin. On startup it fetches each provider's model list, hides what you don't want, and fills in limits and prices from [models.dev](https://models.dev).

Model names look like `[CC] deepseek-v4.1-flash`. The id sent to the provider stays the upstream id.

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
            "show": ["luna"]
          }
        }
      }
    }
  ]
}
```

Append `#<commit>` to pin a reviewed revision: branches and tags still track the remote, so only a full commit hash (or an exact npm version) stays put. Bump it when you mean to pick up a new release.

Then log in for the provider you configured. Together with the `opencode.json` entry above, this stores the key and lets the plugin discover its models:

```sh
opencode auth login commandcode --method key
```

`show` only brings back a model that `hide` removed. `hide: ["^gpt-"]` and `show: ["luna"]` drops the other GPT models and still lists DeepSeek. `prefix` defaults to the initials of `name` (`Command Code` → `CC`).

## Effort levels

Models that models.dev marks as reasoning models get one variant per effort level. Each variant adds `reasoning_effort: "<level>"` to the request body, and you pick it with the variant cycle key in OpenCode.

The levels come from models.dev, so DeepSeek V4.1 Flash gets `low`, `high` and `max`, the levels DeepSeek documents. Hosts list different levels for the same model, so the plugin uses the most common list and ignores `none`. Where hosts split evenly, or the catalog has nothing, the model gets `low`, `medium` and `high`.

| Option | Meaning |
| --- | --- |
| `effort` | Levels to offer on every reasoning model of the provider, replacing the models.dev lists. `false` turns variants off. |
| `reasoning` | Regexes of models that get the levels even when models.dev doesn't flag them (matched against upstream id and name). |

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
