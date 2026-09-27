# Workspace path-search scale suite

The normal `pnpm test` run skips the generated million-path workloads. From the repository root, enable the scale suite to stream every catalog size/profile and print generation time plus sampled RSS/heap:

```sh
ORCA_RUN_PATH_SEARCH_SCALE=1 pnpm exec vitest run --config config/vitest.config.ts src/shared/workspace-path-search-scale.test.ts
```

To also replay the complete query battery against both 1M-path profiles (intentionally much slower), set the second gate:

```sh
ORCA_RUN_PATH_SEARCH_SCALE=1 ORCA_RUN_PATH_SEARCH_SCALE_BATTERY=1 pnpm exec vitest run --config config/vitest.config.ts src/shared/workspace-path-search-scale.test.ts
```

On PowerShell, set `$env:ORCA_RUN_PATH_SEARCH_SCALE = '1'` (and `$env:ORCA_RUN_PATH_SEARCH_SCALE_BATTERY = '1'` for the full battery) before running the same `pnpm exec` command. The catalog stream is regenerated for each query rather than retained as a million-string array. Scale output contains fixture shape, count, elapsed generation time, and peak process samples; it does not log paths or query text.
