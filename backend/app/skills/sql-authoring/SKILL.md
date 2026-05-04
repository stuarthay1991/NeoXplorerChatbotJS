---
name: sql-authoring
description: How to author raw SQL against the OncoSplice Agent PostgreSQL database — data-type casting rules, uid polysemy, LIKE escaping with SQLAlchemy, LIMIT discipline, and a decision checklist to apply BEFORE calling execute_sql. Load this skill whenever you are about to call execute_sql or hand-write SQL.
---

# SQL Authoring Guide

Before writing raw SQL, ask: **"Can one of the operator tools answer
this?"** The operator surface (`query_gene`, `query_signature`,
`query_event`, `query_sample`, `count`, `list_entities`, `rank`,
`search_annotations`) already covers ~95% of questions with validated,
parameterised queries. Use `execute_sql` only for the long tail:

- arbitrary boolean combinations of thresholds across tables,
- multi-cohort joins that don't match a built-in `pan_*` aspect,
- rare columns not surfaced by any operator.

---

## Rule 1 — CAST everywhere stringly-numeric

The vast majority of numeric-looking columns in this database are
actually stored as `text`. String comparison (`'0.049' < '0.05'` =
false!) silently returns the wrong answer.

CAST **always** when comparing or aggregating these:

    dpsi, adjp, rawp, logfold, avg_self, avg_others
    leukocyte_fraction, nonsilent_mutation_rate, fraction_altered
    psi_<cancer>_<...>   (signature-level PSI)
    <TCGA-XX-XXXX-01>    (per-sample PSI in _splice)
    all CIBERSORT / pathway columns in _meta
    exon_region_start_s_, exon_region_stop_s_ (hs_exon / hs_junc)

```sql
-- Correct
WHERE CAST(adjp AS DOUBLE PRECISION) < 0.05
ORDER BY CAST(dpsi AS DOUBLE PRECISION) DESC
-- Wrong (string comparison)
WHERE adjp < 0.05
```

Exceptions (genuine numeric types — do NOT cast):

| Table | Already-numeric columns |
|---|---|
| `survival` | `lrtpvalue`, `mlog10lrtp`, `loghr`, `zscore` |
| `cluster_annotation` | `ases`, `degs`, `samples` (integers) |
| `gtex_fulldegene` | `logfold`, `rawp` (double precision) |

---

## Rule 2 — `uid` is polysemous

| Table | `uid` means |
|---|---|
| `_meta`, `_signature` | TCGA sample barcode (**patient** identifier) |
| `_splice`, `_fullsig`, `survival`, `supersig`, `gtex` | Splicing **event** ID |

Never join `_meta.uid` to `_fullsig.uid` or `survival.uid` — you'll join
patients to events and get a cartesian catastrophe.

Safe joins:

    _meta.uid       ⇄ _signature.uid         (both = patient)
    _splice.uid     ⇄ _fullsig.uid           (both = event)
    survival.uid    ⇄ _splice.uid            (both = event)

---

## Rule 3 — `_splice` tables are wide — never `SELECT *`

Each `{cancer}_splice` table has hundreds to thousands of patient
columns (one per sample). `SELECT *` materialises a massive row.

Always either enumerate the columns you need, or unpivot:

```sql
SELECT key AS sample_id, value AS psi
FROM luad_splice t, jsonb_each_text(to_jsonb(t))
WHERE t.uid = 'TP53:ENSG00000141510:E4.4-E5.3|E3.5-E5.3'
  AND key NOT IN ('symbol','description','examined_junction',
                  'background_major_junction','altexons',
                  'proteinpredictions','dpsi','clusterid','uid',
                  'pancanceruid','chromosome','coord1','coord2',
                  'coord3','coord4','eventannotation')
  AND value IS NOT NULL AND value <> '';
```

---

## Rule 4 — Escape `%` when using SQLAlchemy + LIKE

The database connection uses SQLAlchemy's `text()` which treats `%` as
a parameter-substitution marker. To use a literal `%` in a LIKE
pattern, double it:

```sql
-- Correct with SQLAlchemy
WHERE uid LIKE '%%TP53%%'
-- Incorrect (will raise "argument formats can't be mixed")
WHERE uid LIKE '%TP53%'
```

All operator templates already use `%%` internally — you only need to
remember this when writing raw SQL through `execute_sql`.

---

## Rule 5 — Always cap results

Every query must end with `LIMIT N` (default 25 unless the user asked
for more). This database has tables with millions of rows and wide
pivots with thousands of columns; an un-LIMIT-ed query can blow up the
context window or the network pipe.

Prefer:

    ORDER BY <rank_column> DESC LIMIT 25

over

    LIMIT 25               -- unsorted → non-deterministic sample

---

## Rule 6 — Cohort codes are lowercase; `cancer` column values are UPPERCASE

- Per-cohort **table prefixes** are lowercase: `luad_meta`, `brca_fullsig`.
- The cross-cancer `cancer` **column** in `survival`, `cluster_annotation`,
  `supersig`, `sigtranslate` stores codes in **UPPERCASE**: `LUAD`, `BRCA`.

```sql
SELECT * FROM luad_fullsig ...              -- lowercase table prefix
WHERE cancer = 'LUAD'                        -- uppercase column value
```

---

## Rule 7 — No DML

Never emit `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`,
`ALTER`, `GRANT`, `CREATE`. `execute_sql` is read-only and will reject
anything that isn't a `SELECT` / `WITH` / `EXPLAIN`.

---

## Decision checklist before calling `execute_sql`

1. Does an existing operator tool cover this? (Re-read the tool list.)
2. If yes → use it. If no → proceed.
3. Load `schema-per-cancer` if touching a `{cancer}_*` table.
4. Load `schema-global` if touching `survival`, `cluster_annotation`,
   `supersig`, `hs_*`, `gtex`, etc.
5. Apply rules 1–7 above while drafting.
6. Always include `LIMIT`.
7. Single-statement only — no semicolon-separated batches.
