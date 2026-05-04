---
name: schema-per-cancer
description: Schema reference for the 5-table family that exists per TCGA cohort (_meta, _signature, _fullsig, _fulldegene, _splice). Load this skill whenever a question is scoped to a specific cancer (luad, brca, kirc, etc.) or when writing SQL that touches a {cancer}_* table.
---

# Per-Cancer 5-Table Family

Every one of the 24 TCGA cohorts (plus `gtex`) has exactly **five** tables
following the pattern `{cancer}_{type}`. Schemas are identical across
cohorts — only the `{cancer}` prefix changes.

Available cancer codes (use lowercase in SQL):

    blca brca cesc coad esca gbm hnsc kich kirc lgg lihc
    luad lusc ov paad pcpg prad read sarc skcm stad tgct
    thca ucec   + gtex

> `kirp` appears in cross-cancer tables (`survival`, `cluster_annotation`)
> but has NO per-cohort tables. Never use `cancer='kirp'` in operator tools.

---

## 1. `{cancer}_meta` — patient rows

One row per patient sample. Clinical + molecular metadata.

`uid` = TCGA sample barcode (e.g. `TCGA-XX-XXXX-01`). This is a
**patient** identifier; joinable to `_signature.uid` and to the dynamic
sample-name columns of `_splice`.

| Column | Type | Notes |
|---|---|---|
| `uid` | text (PK) | TCGA barcode |
| `histological_type` | text | Primary pathological classification |
| `gender`, `race`, `tumor_stage`, `consensus_ancestry` | text | Demographics / stage |
| `coca`, `copy_number`, `dna_methylation`, `mutations` | text | Molecular subtype fields |
| `subtype_integrative`, `subtype_dnameth`, `immune_subtype` | text | Named subtypes |
| `leukocyte_fraction`, `nonsilent_mutation_rate`, `fraction_altered` | text | **CAST to DOUBLE PRECISION** |
| CIBERSORT / pathway columns (`macrophages_m1`, `ifn_gamma_response`, ...) | text | **CAST to DOUBLE PRECISION** |
| Cohort-specific fields (e.g. `tobacco_smoking_history` in luad) | text | |

`gtex_meta` is simplified: `uid`, `histological_type`, `body_site`, `sex` only.

There is no `vital_status` here. Survival lives in the cross-cancer
`survival` table (see `schema-global` skill).

---

## 2. `{cancer}_signature` — sample × signature PSI matrix

One row per patient. Columns are per-signature PSI scores.

`uid` = TCGA sample barcode (same entity as `_meta.uid`).

| Column | Type | Notes |
|---|---|---|
| `uid` | text (PK) | TCGA barcode |
| `psi_{cancer}_{type}_{run}_{version}` | text | Per-signature PSI — **CAST to DOUBLE PRECISION** |

Signature column names exactly match `signature_name` values in
`_fullsig` and the `original` column of `cluster_annotation`.

`gtex_signature` uses names like `psi_lung_vs_others` instead.

---

## 3. `{cancer}_fullsig` — significant events per signature

One row per (signature, splicing event) pair.

`uid` here is a **splicing EVENT ID**, NOT a patient barcode. Do not
join `_fullsig.uid` to `_meta.uid`.

| Column | Type | Notes |
|---|---|---|
| `signature_name` | text | Matches a `psi_` column of `_signature` |
| `uid` | text | Event ID — format `SYMBOL:ENSG...:coord` |
| `gene` | text | HGNC symbol |
| `event_direction` | text | `inclusion` / `exclusion` |
| `eventannotation` | text | e.g. `cassette-exon`, `alt-3prime`, `intron-retention` |
| `dpsi`, `rawp`, `adjp`, `avg_others` | text | **CAST to DOUBLE PRECISION** |
| `proteinpredictions`, `coordinates`, `clusterid` | text | |

---

## 4. `{cancer}_fulldegene` — DEGs per signature

One row per (signature, gene).

| Column | Type | Notes |
|---|---|---|
| `signature_name` | text | Matches `_fullsig.signature_name` |
| `symbol` | text | HGNC symbol |
| `geneid`, `systemcode` | text | Ensembl ID, source code |
| `logfold`, `rawp`, `adjp`, `avg_self`, `avg_others` | text | **CAST to DOUBLE PRECISION** |

Exception: `gtex_fulldegene` stores `logfold` as `double precision` (no CAST).

---

## 5. `{cancer}_splice` — raw PSI matrix (WIDE)

One row per splicing event; **one column per patient** (hundreds to
thousands of sample columns).

| Column | Type | Notes |
|---|---|---|
| `uid` | text | Event ID |
| `symbol`, `description`, `eventannotation` | text | |
| `examined_junction`, `background_major_junction`, `altexons` | text | |
| `dpsi`, `proteinpredictions`, `clusterid`, `pancanceruid` | text | `dpsi` is CAST'd |
| `chromosome`, `coord1`..`coord4` | text | |
| `<TCGA-XX-XXXX-01>` (hundreds) | text | Per-sample PSI (0–1) |

> **NEVER `SELECT *` from a `_splice` table.** Always enumerate columns,
> or unpivot with `jsonb_each_text(to_jsonb(t))` filtering out the known
> metadata keys.

---

## Safe join patterns

```sql
-- Patient metadata + signature PSI (both uids = patient)
SELECT m.uid, m.histological_type, s.psi_luad_dt_r1_v8
FROM luad_meta m
JOIN luad_signature s USING (uid);

-- Signature events + human-readable cluster label
SELECT f.gene, f.uid, f.eventannotation, ca.annotation
FROM luad_fullsig f
JOIN cluster_annotation ca
  ON ca.cancer = 'LUAD'
 AND ca.original = f.signature_name;

-- UNSAFE: NEVER join _meta.uid ↔ _fullsig.uid (different entity types).
```
