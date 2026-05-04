# OncoSplice Agent — Invariants

This file is memory: it is injected into every turn. Keep it short —
only rules that are **always** relevant, regardless of the current
question, belong here. Detailed schema and SQL-authoring guidance live
in the progressive-disclosure skills under `skills/`.

## Skills — load on demand

- `schema-per-cancer` — the 5-table family (`_meta`, `_signature`,
  `_fullsig`, `_fulldegene`, `_splice`). Read when a question mentions a
  specific cohort or when writing SQL against a `{cancer}_*` table.
- `schema-global` — cross-cancer and reference tables (`survival`,
  `cluster_annotation`, `supersig`, `sigtranslate`, `cluster_synonym`,
  `neo_cluster_synonym`, `gtex`, `hs_exon`, `hs_junc`,
  `hs_transcript_annot`, `legacygtex_*`). Read for multi-cohort,
  survival, or genome-reference questions.
- `sql-authoring` — required reading before every call to
  `execute_sql`. Covers CAST rules, `uid` polysemy, `%%` escaping,
  `LIMIT` discipline, and the "do I really need raw SQL?" checklist.

## Tool-use policy

1. **Prefer operator tools.** `query_gene`, `query_signature`,
   `query_event`, `query_sample`, `count`, `list_entities`, `rank`,
   and `search_annotations` cover the vast majority of questions
   with validated, parameterised SQL. Use them first.
2. **Use `execute_sql` only as a last resort.** Load the
   `sql-authoring` skill first; it exists so you apply the critical
   rules (CAST, `%%`, LIMIT, uid polysemy) that the operator tools
   enforce automatically.
3. **One cohort at a time** for per-cancer operators. For pan-cancer
   questions use the dedicated `aspect='pan_*'` on `query_gene`, or
   use `rank(scope='cohorts', ...)`.

## Cross-cancer-only cohort

`kirp` (Kidney Renal Papillary Cell Carcinoma) appears in the
cross-cancer tables (`survival`, `cluster_annotation`) but has **no**
per-cohort tables (`kirp_meta`, `kirp_signature`, `kirp_fullsig`,
`kirp_fulldegene`, `kirp_splice`). Never call per-cohort operators with
`cancer='kirp'` — they will fail validation. It is still valid to
surface `kirp` results returned by pan-cancer tools.

## Safety

- Read-only: never emit `INSERT`, `UPDATE`, `DELETE`, `DROP`,
  `TRUNCATE`, `ALTER`, `GRANT`, or `CREATE`.
- Every query is capped with `LIMIT` (operator tools do this for you;
  `execute_sql` requires you to add it explicitly).
- Never `SELECT *` from a `{cancer}_splice` table — they are wide
  pivots with thousands of patient columns.
