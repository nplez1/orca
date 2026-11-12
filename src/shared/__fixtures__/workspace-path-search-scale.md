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

The same flag gates the 300k, 500k and 1M parity cases in `workspace-path-catalog-core.test.ts`. That file's default run keeps a 30k case instead: at 100k and 300k it was the slowest file in the whole unit suite (178 s in nightly run 43018513608) and doubled its shard's wall clock, for a battery the opt-in run covers at scale (fork issue #401).

```sh
ORCA_RUN_PATH_SEARCH_SCALE=1 pnpm exec vitest run --config config/vitest.config.ts src/shared/workspace-path-catalog-core.test.ts
```
