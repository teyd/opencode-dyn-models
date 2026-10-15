# opencode-dyn-models

OpenCode v2 plugin. On startup it fetches each provider's model list, hides what you don't want, and fills in limits and prices from [models.dev](https://models.dev).

Model names look like `[CC] deepseek-v4.1-flash`. The id sent to the provider stays the upstream id.

The plugin path must be a directory (OpenCode loads its `index.ts`).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/opencode-dyn-models",
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

`show` only brings back a model that `hide` removed. `hide: ["^gpt-"]` and `show: ["luna"]` drops the other GPT models and still lists DeepSeek. Omit `apiKey` for an endpoint that does not need one. `prefix` defaults to the initials of `name` (`Command Code` → `CC`).

A provider whose key is unset, or whose `/models` call fails, is skipped. models.dev being down only means names still appear, without prices.
