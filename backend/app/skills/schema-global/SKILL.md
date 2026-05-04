---
name: schema-global
description: Schema reference for all cross-cancer and genome-reference tables (survival, cluster_annotation, supersig, sigtranslate, cluster_synonym, neo_cluster_synonym, gtex, hs_exon, hs_junc, hs_transcript_annot, legacygtex_*). Load this skill whenever the question spans multiple cohorts, involves survival / prognosis, maps signature IDs, or needs genomic reference annotations.
---

# Global / Cross-Cancer & Reference Tables

These tables are not prefixed with a cancer code — they contain
pan-cancer results, lookup tables, and genomic references.

---

## `survival` — Cox + log-rank per event per cohort

One row per `(cancer, splicing event)` pair.

| Column | Type | Notes |
|---|---|---|
| `cancer` | text | **UPPERCASE** code (e.g. `LUAD`) |
| `uid` | text | Splicing EVENT ID (not a patient) |
| `eventannotation` | text | Event type |
| `lrtpvalue` | numeric | Log-rank test p-value |
| `mlog10lrtp` | numeric | −log10(p) |
| `loghr` | numeric | Log hazard ratio |
| `zscore` | numeric | Hazard z-score |

> All numeric columns here are real `numeric` — **no CAST needed**.

Prognosis interpretation (only when `lrtpvalue < 0.05`):

    loghr > 0 → POOR prognosis (higher PSI = worse survival)
    loghr < 0 → GOOD prognosis (higher PSI = better survival)

---

## `cluster_annotation` — human labels for signature clusters

| Column | Type | Notes |
|---|---|---|
| `cancer` | text | **UPPERCASE** |
| `original` | text | Internal cluster name (matches `_fullsig.signature_name`) |
| `datagroup` | text | Display-friendly cluster label |
| `annotation` | text | Biological / clinical annotation |
| `ases`, `degs`, `samples` | **integer** | Counts (no CAST) |

---

## `cluster_synonym` / `neo_cluster_synonym` — free-text lookup

Flexible synonym tables used by the web UI to resolve user search terms
to canonical signature IDs.

`cluster_synonym` columns: `metadata`, `synonym`, `standard` (pipe-
delimited lists).

`neo_cluster_synonym` columns: `oncobrowserlookup` (internal signature
key), `clusterid`, `top10_metadata_sig`, `top10_mut_sig`, `synonym`.

---

## `sigtranslate` — internal → display name map

| Column | Type |
|---|---|
| `cancer` | text |
| `clusters` | text |
| `psi_event_signatures` | text |
| `simple_name` | text |

---

## `supersig` — cross-cancer super-signatures

One row per representative event defining a signature cluster across
cancers / tissues.

| Column | Type |
|---|---|
| `cancer_name` | text |
| `signature_name` | text |
| `firstjunc` | text |
| `uid` | text (event ID) |
| `event_direction` | text |
| `clusterid` | text |
| `eventannotation` | text |

---

## `gtex` — tissue PSI reference

One row per splicing event, one column per GTEx tissue (~54 tissue
columns). Each tissue column stores a **pipe-delimited** string of
per-sample PSIs — parse it, do not CAST.

Key column: `uid` (unique event ID). Tissue columns include
`whole_blood`, `lung`, `liver`, `brain_cortex`, `heart_left_ventricle`,
`adipose_subcutaneous`, etc.

---

## `hs_exon` (1.2M) / `hs_junc` (1.1M) — genome reference

Identical schema:

| Column | Type |
|---|---|
| `gene` | text — **Ensembl gene ID** (ENSG...) |
| `exon_id` / `junction_id` | text |
| `chromosome`, `strand` | text |
| `exon_region_start_s_`, `exon_region_stop_s_` | text (numeric stored as text — CAST if comparing) |
| `constitutive_call` | text (`yes`/`no`) |
| `ens_ids`, `splice_events`, `splice_junctions` | text |

> `gene` here is Ensembl ID, not HGNC symbol. To resolve an HGNC symbol,
> look it up via `{cancer}_fullsig`: `split_part(uid, ':', 2)` gives the
> Ensembl ID.

---

## `hs_transcript_annot` — Ensembl transcript → exon map

| Column | Type |
|---|---|
| `ensembl_gene_id`, `ensembl_transcript_id`, `ensembl_exon_id` | text |
| `chromosome`, `strand` (`1`/`-1`) | text |
| `exon_start__bp_`, `exon_end__bp_` | text |
| `constitutive_exon` | text (`1`/`0`) |

---

## `legacygtex_fullsig` / `legacygtex_fulldegene`

Back-compat copies of `gtex_fullsig` / `gtex_fulldegene`. Same columns
but `logfold` is stored as **text** (CAST needed) unlike the current
`gtex_fulldegene`.

---

## Cross-table linkage cheat sheet

Event ID (`uid`) is shared across:

    {cancer}_splice.uid  ⇄  {cancer}_fullsig.uid  ⇄
    survival.(cancer,uid) ⇄ supersig.uid ⇄ gtex.uid

Signature name is shared across:

    {cancer}_fullsig.signature_name  ⇄  _fulldegene.signature_name
      ⇄ column-names of {cancer}_signature
      ⇄ cluster_annotation.(cancer,original)
      ⇄ neo_cluster_synonym.oncobrowserlookup

Common cross-cancer queries:

```sql
-- Gene across all cohorts
SELECT cancer, uid, eventannotation, lrtpvalue, loghr,
       CASE WHEN loghr > 0 THEN 'POOR' ELSE 'GOOD' END AS prognosis
FROM survival
WHERE uid LIKE '%TP53%' AND lrtpvalue < 0.05
ORDER BY ABS(loghr) DESC;

-- Available cohorts
SELECT DISTINCT cancer FROM cluster_annotation ORDER BY cancer;

-- Rank cohorts by prognostic event count for one gene
SELECT cancer, COUNT(*) AS n
FROM survival
WHERE uid LIKE '%EGFR%' AND lrtpvalue < 0.05
GROUP BY cancer ORDER BY n DESC;
```
