# dsh-roam-planner

Trip planning inside [DeepSeek Harness](https://github.com/deepseek-ai): talk a plan
into existence, watch it land on a map, and adopt it when it looks right.

The agent edits a **draft**. A candidate is frozen for review, and only an explicit
**Adopt** commits it — so a hallucinated revision can never overwrite a plan you
already accepted.

## Requirements

- DeepSeek Harness `^0.2.1-rc.2` (`engines.dsh`)
- No extra services: no Docker, no database, no API key required

## Install

```text
plugin_manager install_bundle <this package or directory>
```

Then **restart DSH**: the host half loads its tools and `/roam/api` routes at
startup. After the restart the sidebar shows a **Roam Planner** icon, and the
agent gains the `roam_*` tools.

## First run

1. Click the sidebar icon — an empty panel says to ask the agent for a plan.
2. In any conversation:

   > Plan two relaxed days in Suzhou for me and my parents

3. The agent calls `roam_get_snapshot`, `roam_prepare_draft` (place **names**
   only — the host geocodes them) and `roam_fill_routes`. The panel polls every
   few seconds and follows along.
4. `roam_save_candidate` freezes the plan; a green **Adopt plan** button appears.
5. Adopt it. Editing afterwards reopens a draft, and the panel shows what
   changed against the adopted version.

## Optional: Amap key

Place lookup and routing work without a key (OpenStreetMap + OSRM), but Chinese
addresses resolve far better through Amap.

**Settings → Roam Planner → Amap Web-service key** (not a JS API key). The key is
written to the host credential store under `ROAM_PLANNER_AMAP_KEY`, is never sent
back to the page, and takes effect on the next lookup — no restart.

## Configuration

Everything below lives in the plugin row's `config` in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `basemapId` | `osm` | Basemap selected on first use |
| `basemaps` | `null` | Replacement provider catalogue (array of `{id, label, url, attribution, maxZoom, crs}`); `null` uses the built-ins |
| `geocoder` | `nominatim` | `nominatim`, `amap`, or `off` |
| `amapKey` | `null` | Deployment-level key; a key saved in Settings wins |
| `defaultCity` | `null` | City appended to place names, e.g. `苏州` |
| `dataDir` | `null` | Directory for the JSON fallback store |

## External MCP sidecars (optional)

Railway tickets and Xiaohongshu notes are not built in. The plugin speaks MCP
itself — `stdio` and `streamable http` — so any sidecar can be attached through
config, and servers start on the first call rather than at activation.

The agent reaches them through `roam_mcp_servers`, `roam_mcp_tools` and
`roam_mcp_call`.

### Railway: use the bundled proxy

`server/railway-mcp.js` is our own MCP server in front of the third-party 12306
sidecar. It owns the railway business API, so the caller gets a time window, a
station filter and a row cap instead of an entire day of trains:

| Parameter | Meaning |
|---|---|
| `from_station`, `to_station`, `date` | The query itself (`date` = YYYY-MM-DD) |
| `time_from`, `time_to` | Departure window, `HH:MM` |
| `station` | Keep trains serving this station (a city has many) |
| `limit` | Maximum trains returned, default 10, max 50 |

```yaml
- id: roam-planner
  config:
    mcpServers:
      - name: railway
        command: node
        args: ['<plugin>/server/railway-mcp.js']
        env:
          RAILWAY_PYTHON: 'C:\...\python.exe'        # has mcp-server-12306 installed
          RAILWAY_PYTHONPATH: 'C:\...\site-packages'
```

A raw `streamable http` sidecar is configured with `transport: http` and
`url`. Add `command` (plus optional `args`/`env`) and the bridge starts
the process on first use, waits for the port and then speaks HTTP — nothing has
to be launched by hand.

| Sidecar | Source | Notes |
|---|---|---|
| 12306 tickets | [drfccv/mcp-server-12306](https://github.com/drfccv/mcp-server-12306) | The project states non-commercial use only |
| Xiaohongshu notes | [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | Needs a one-time login; serves HTTP on `:18060` |

## Tools

| Tool | Effect |
|---|---|
| `roam_get_snapshot` | Read the session trip (creates an empty draft if none) |
| `roam_prepare_draft` | Apply a title/days change; stops need only a name |
| `roam_save_candidate` | Freeze the draft for review |
| `roam_adopt` | Commit the candidate |
| `roam_fill_routes` | Fill missing leg geometry and durations (Amap or OSRM) |
| `roam_forecast` | Daily weather at each day's first stop (read-only) |
| `roam_search_places` | Keyword search for real places (needs an Amap key) |
| `roam_mcp_servers` / `roam_mcp_tools` / `roam_mcp_call` | Reach an attached MCP sidecar |

## Data

- Trips live in the DSH storage domain (`$DSH_HOME/storages/roam_planner.json`),
  falling back to `<dataDir>/.roam/store.json` when the domain is unavailable.
- The Amap key lives in the credential store, never in the trip data.
- The page remembers the chosen basemap locally; that is a viewing preference,
  not trip data.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Panel says the host routes are unavailable | The host half failed to activate — restart DSH |
| Map is blank but the day list renders | Basemap tiles could not load (network or provider policy) |
| Routes are straight dashed lines | No route source answered; fill them with `roam_fill_routes` |
| Weather chips missing | The forecast has no data for those dates yet |

## License

MIT — see [LICENSE](LICENSE). This is an independent implementation; see
[PROVENANCE.md](PROVENANCE.md) for the boundary against the upstream project it
was inspired by.

