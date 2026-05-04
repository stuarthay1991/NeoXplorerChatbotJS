const { CANCER_CODES } = require("../constants.js");

const _SAFE_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const _SAFE_GENE = /^[A-Za-z0-9\-_.]+$/;
const _SAFE_EVENT_UID = /^[A-Za-z0-9:|._\-]+$/;
const _SAFE_SEARCH = /^[A-Za-z0-9 _.\-\/+()]+$/;
const _SAFE_SAMPLE_UID = /^[A-Za-z0-9\-_.]+$/;

const _PROGNOSIS_ALLOWED = new Set(["poor", "good", "both"]);
const _SORT_BY_ALLOWED = new Set(["hazard", "cancer", "pvalue"]);

class UnsafeInputError extends Error {
    constructor(message) {
      super(message);
      this.name = "UnsafeInputError";
    }
  }

function _validateCancer(cancer) {
  const normalized = String(cancer).trim().toLowerCase();
  if (!CANCER_CODES.has(normalized)) {
    const valid = [...CANCER_CODES].sort().join(", ");
    throw new UnsafeInputError(
      `Unknown cancer code: '${normalized}'. Valid: ${valid}`,
    );
  }
  return normalized;
}

function _validateGene(gene) {
  const normalized = String(gene).trim().toUpperCase();
  if (!_SAFE_GENE.test(normalized)) {
    throw new UnsafeInputError(`Invalid gene symbol: '${normalized}'`);
  }
  return normalized;
}

function _validateEventUid(uid) {
  const normalized = String(uid).trim();
  if (!_SAFE_EVENT_UID.test(normalized)) {
    throw new UnsafeInputError(`Invalid event UID: '${normalized}'`);
  }
  return normalized;
}

function _validateSampleUid(uid) {
  const normalized = String(uid).trim();
  if (!_SAFE_SAMPLE_UID.test(normalized)) {
    throw new UnsafeInputError(`Invalid sample UID: '${normalized}'`);
  }
  return normalized;
}

function _validateSearch(term) {
  const normalized = String(term).trim();
  if (
    !normalized ||
    !_SAFE_SEARCH.test(normalized)
  ) {
    throw new UnsafeInputError(
      `Invalid search term: '${normalized}'. Allowed chars: alnum, space, ._-/+()`,
    );
  }
  return normalized;
}

function _validateIdentifier(value, label) {
  const normalized = String(value).trim();
  if (!_SAFE_IDENTIFIER.test(normalized)) {
    throw new UnsafeInputError(`Invalid ${label}: '${normalized}'`);
  }
  return normalized;
}

function _validateSubtypeField(value) {
  return _validateIdentifier(value, "subtype_field");
}

function _buildPrognosisFilter(prognosis) {
  if (prognosis === "poor") {
    return "AND loghr > 0";
  }
  if (prognosis === "good") {
    return "AND loghr < 0";
  }
  return "";
}

/**
 * WHERE-fragment for matching a gene against `survival.uid`.
 *
 * `survival.uid` stores splicing-event IDs like `GENE:ENSG...:COORDS`.
 * exact=false → substring match (also matches TP53I3, TP53BP2, ...).
 * exact=true  → anchored match on `(^|:)GENE:` — TP53 does NOT match TP53I3.
 */
function _buildGeneMatch(gene, exact) {
  if (exact) {
    return `uid ~ '(^|:)${gene}:'`;
  }
  return `uid LIKE '%${gene}%'`;
}

function _validate(params = {}) {
  const out = { ...params };
  if (out.cancer != null) {
    out.cancer = _validateCancer(out.cancer);
    out.cancer_upper = out.cancer.toUpperCase();
  }
  if (out.gene != null) {
    out.gene = _validateGene(out.gene);
  }
  if (out.event_uid != null) {
    out.event_uid = _validateEventUid(out.event_uid);
  }
  if (out.sample_uid != null) {
    out.sample_uid = _validateSampleUid(out.sample_uid);
  }
  if (out.search != null) {
    out.search = _validateSearch(out.search);
  }
  // Back-compat: older callers used subtype_field; newer call-site uses
  // sample_field for clinical sample typing fields in `{cancer}_meta`.
  if (out.sample_field != null && out.subtype_field != null) {
    throw new UnsafeInputError(
      "Pass only one of sample_field or subtype_field.",
    );
  }
  if (out.sample_field != null) {
    out.sample_field = _validateSubtypeField(out.sample_field);
  }
  if (out.subtype_field != null) {
    out.subtype_field = _validateSubtypeField(out.subtype_field);
  }
  if (out.signature_name != null) {
    out.signature_name = _validateIdentifier(out.signature_name, "signature_name");
  }
  if (out.signature_col != null) {
    out.signature_col = _validateIdentifier(out.signature_col, "signature_col");
  }
  if (out.prognosis != null) {
    out.prognosis = String(out.prognosis).trim().toLowerCase();
    if (!_PROGNOSIS_ALLOWED.has(out.prognosis)) {
      throw new UnsafeInputError(
        `Invalid prognosis: '${out.prognosis}'. Must be 'poor', 'good', or 'both'.`,
      );
    }
  }
  if (out.sort_by != null) {
    out.sort_by = String(out.sort_by).trim().toLowerCase();
    if (!_SORT_BY_ALLOWED.has(out.sort_by)) {
      throw new UnsafeInputError(
        `Invalid sort_by: '${out.sort_by}'. Must be 'hazard', 'cancer', or 'pvalue'.`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "pvalue_threshold")) {
    if (out.pvalue_threshold == null) {
      throw new UnsafeInputError(
        `Invalid pvalue_threshold: '${out.pvalue_threshold}'.`,
      );
    }
    const v = Number(out.pvalue_threshold);
    if (!Number.isFinite(v)) {
      throw new UnsafeInputError(
        `Invalid pvalue_threshold: '${out.pvalue_threshold}'.`,
      );
    }
    out.pvalue_threshold = v;
  }
  if (Object.prototype.hasOwnProperty.call(out, "limit")) {
    if (out.limit == null) {
      throw new UnsafeInputError(`Invalid limit: '${out.limit}'.`);
    }
    const v = Number(out.limit);
    if (!Number.isFinite(v)) {
      throw new UnsafeInputError(`Invalid limit: '${out.limit}'.`);
    }
    out.limit = Math.trunc(v);
  }
  if (Object.prototype.hasOwnProperty.call(out, "exact")) {
    out.exact = Boolean(out.exact);
  }
  return out;
}

// ── counts ──
const _TEMPLATES = Object.freeze({
  count_splicing_events:
    "SELECT COUNT(*) AS total_events FROM {cancer}_splice",
  count_junctions: "SELECT COUNT(*) AS total_junctions FROM hs_junc",
  count_exons: "SELECT COUNT(*) AS total_exons FROM hs_exon",
  count_samples: "SELECT COUNT(*) AS total_samples FROM {cancer}_meta",
  count_genes_in_cohort: `
        SELECT COUNT(DISTINCT gene) AS distinct_genes
        FROM {cancer}_fullsig
    `,
  count_degs_in_cohort: `
        SELECT COUNT(DISTINCT symbol) AS distinct_degs
        FROM {cancer}_fulldegene
    `,
  count_signatures: `
        SELECT COUNT(*) AS num_signatures
        FROM cluster_annotation
        WHERE cancer = '{cancer_upper}'
    `,

  // ── listings ──
  list_cancers: `
        SELECT cancer, COUNT(*) AS num_clusters,
               SUM(samples) AS total_samples
        FROM cluster_annotation
        GROUP BY cancer ORDER BY cancer
    `,
  list_sample_types: `
        SELECT {sample_field}, COUNT(*) AS n
        FROM {cancer}_meta
        GROUP BY {sample_field}
        ORDER BY n DESC
    `,
  list_signatures: `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = '{cancer}_signature'
          AND column_name LIKE 'psi_%%'
        ORDER BY column_name
    `,
  list_genes_in_signature: `
        SELECT DISTINCT gene
        FROM {cancer}_fullsig
        WHERE signature_name = '{signature_name}'
        ORDER BY gene
    `,
  list_event_types: `
        SELECT eventannotation, COUNT(*) AS n
        FROM {cancer}_splice
        WHERE eventannotation IS NOT NULL
        GROUP BY eventannotation
        ORDER BY n DESC
    `,
  list_samples: `
        SELECT uid AS sample_id, histological_type
        FROM {cancer}_meta
        ORDER BY uid
        LIMIT {limit}
    `,
  list_tables: `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
    `,
  cluster_annotations: `
        SELECT original, datagroup, annotation, ases, degs, samples
        FROM cluster_annotation
        WHERE cancer = '{cancer_upper}'
        ORDER BY samples DESC
    `,

  // ── gene-centric ──
  gene_events: `
        SELECT gene, uid, eventannotation,
               CAST(dpsi AS DOUBLE PRECISION) AS delta_psi,
               CAST(adjp AS DOUBLE PRECISION) AS adj_pvalue,
               proteinpredictions
        FROM {cancer}_fullsig
        WHERE gene = '{gene}'
          AND CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
        ORDER BY adj_pvalue
        LIMIT {limit}
    `,
  gene_deg: `
        SELECT symbol, signature_name,
               CAST(logfold AS DOUBLE PRECISION) AS log_fold_change,
               CAST(adjp AS DOUBLE PRECISION) AS adj_pvalue
        FROM {cancer}_fulldegene
        WHERE symbol = '{gene}'
          AND CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
        ORDER BY adj_pvalue
        LIMIT {limit}
    `,
  gene_events_by_signature: `
        SELECT f.signature_name,
               ca.annotation,
               COUNT(DISTINCT f.uid) AS event_count
        FROM {cancer}_fullsig f
        LEFT JOIN cluster_annotation ca
          ON ca.cancer = '{cancer_upper}'
         AND ca.original = f.signature_name
        WHERE f.gene = '{gene}'
          AND CAST(f.adjp AS DOUBLE PRECISION) < {pvalue_threshold}
        GROUP BY f.signature_name, ca.annotation
        ORDER BY event_count DESC
    `,
  gene_survival: `
        SELECT cancer, uid, eventannotation,
               lrtpvalue, loghr, zscore,
               CASE WHEN loghr > 0 THEN 'POOR' ELSE 'GOOD' END AS prognosis
        FROM survival
        WHERE {gene_match}
          AND lrtpvalue < {pvalue_threshold}
          {prognosis_filter}
        ORDER BY {sort_expr}
        LIMIT {limit}
    `,

  gene_exons: `
        SELECT gene AS ensembl_gene_id,
               exon_id, chromosome, strand,
               exon_region_start_s_ AS region_start,
               exon_region_stop_s_  AS region_stop,
               constitutive_call
        FROM hs_exon
        WHERE gene = '{gene}'
           OR gene = (
                SELECT split_part(uid, ':', 2)
                FROM luad_fullsig WHERE gene = '{gene}'
                UNION ALL
                SELECT split_part(uid, ':', 2)
                FROM brca_fullsig WHERE gene = '{gene}'
                LIMIT 1
           )
        ORDER BY exon_region_start_s_::double precision NULLS LAST
        LIMIT {limit}
    `,
  gene_junctions: `
        SELECT gene AS ensembl_gene_id,
               junction_id, chromosome, strand,
               exon_region_start_s_ AS region_start,
               exon_region_stop_s_  AS region_stop
        FROM hs_junc
        WHERE gene = '{gene}'
           OR gene = (
                SELECT split_part(uid, ':', 2)
                FROM luad_fullsig WHERE gene = '{gene}'
                UNION ALL
                SELECT split_part(uid, ':', 2)
                FROM brca_fullsig WHERE gene = '{gene}'
                LIMIT 1
           )
        ORDER BY exon_region_start_s_::double precision NULLS LAST
        LIMIT {limit}
    `,
  gene_transcripts: `
        SELECT ensembl_gene_id, ensembl_transcript_id, ensembl_exon_id,
               chromosome, strand,
               exon_start__bp_ AS exon_start,
               exon_end__bp_   AS exon_end,
               constitutive_exon
        FROM hs_transcript_annot
        WHERE ensembl_gene_id = '{gene}'
           OR ensembl_gene_id = (
                SELECT split_part(uid, ':', 2)
                FROM luad_fullsig WHERE gene = '{gene}'
                UNION ALL
                SELECT split_part(uid, ':', 2)
                FROM brca_fullsig WHERE gene = '{gene}'
                LIMIT 1
           )
        ORDER BY ensembl_transcript_id, exon_start__bp_::double precision NULLS LAST
        LIMIT {limit}
    `,

  // ── signature-centric ──
  signature_events: `
        SELECT gene, uid, eventannotation,
               CAST(dpsi AS DOUBLE PRECISION) AS delta_psi,
               CAST(adjp AS DOUBLE PRECISION) AS adj_pvalue
        FROM {cancer}_fullsig
        WHERE signature_name = '{signature_name}'
          AND CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
        ORDER BY adj_pvalue
        LIMIT {limit}
    `,
  signature_degs: `
        SELECT symbol,
               CAST(logfold AS DOUBLE PRECISION) AS log_fold_change,
               CAST(adjp AS DOUBLE PRECISION) AS adj_pvalue
        FROM {cancer}_fulldegene
        WHERE signature_name = '{signature_name}'
          AND CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
        ORDER BY adj_pvalue
        LIMIT {limit}
    `,
  signature_annotation: `
        SELECT cancer, original, datagroup, annotation,
               ases, degs, samples
        FROM cluster_annotation
        WHERE cancer = '{cancer_upper}'
          AND original = '{signature_name}'
    `,
  signature_top_samples: `
        SELECT uid AS sample_id,
               CAST({signature_col} AS DOUBLE PRECISION) AS psi
        FROM {cancer}_signature
        WHERE {signature_col} IS NOT NULL AND {signature_col} <> ''
        ORDER BY psi DESC
        LIMIT {limit}
    `,
  signature_mean_psi: `
        SELECT AVG(CAST({signature_col} AS DOUBLE PRECISION)) AS mean_psi,
               STDDEV(CAST({signature_col} AS DOUBLE PRECISION)) AS stddev_psi,
               COUNT(*) FILTER (WHERE {signature_col} IS NOT NULL AND {signature_col} <> '') AS n_samples
        FROM {cancer}_signature
    `,

  // ── event-centric ──
  event_psi: `
        SELECT key AS sample_id, value AS psi
        FROM {cancer}_splice t, jsonb_each_text(to_jsonb(t))
        WHERE t.uid = '{event_uid}'
          AND key NOT IN ('symbol','description','examined_junction',
                          'background_major_junction','altexons',
                          'proteinpredictions','dpsi','clusterid','uid',
                          'pancanceruid','chromosome','coord1','coord2',
                          'coord3','coord4','eventannotation')
          AND value IS NOT NULL AND value <> ''
        ORDER BY sample_id
        LIMIT {limit}
    `,
  event_details: `
        SELECT uid, symbol, description, eventannotation,
               examined_junction, background_major_junction, altexons,
               proteinpredictions, pancanceruid,
               chromosome, coord1, coord2, coord3, coord4,
               CAST(dpsi AS DOUBLE PRECISION) AS overall_dpsi
        FROM {cancer}_splice
        WHERE uid = '{event_uid}'
        LIMIT 1
    `,
  event_survival: `
        SELECT cancer, eventannotation, lrtpvalue, loghr, zscore,
               CASE WHEN loghr > 0 THEN 'POOR' ELSE 'GOOD' END AS prognosis
        FROM survival
        WHERE uid = '{event_uid}'
        ORDER BY lrtpvalue
        LIMIT {limit}
    `,
  event_pancancer: `
        SELECT cancer_name, signature_name, event_direction,
               firstjunc, clusterid, eventannotation
        FROM supersig
        WHERE uid = '{event_uid}'
        LIMIT {limit}
    `,
  event_gtex: `
        SELECT key AS tissue, value AS psi_values
        FROM gtex t, jsonb_each_text(to_jsonb(t))
        WHERE t.uid = '{event_uid}'
          AND key <> 'uid'
          AND value IS NOT NULL AND value <> ''
        ORDER BY tissue
        LIMIT {limit}
    `,

  // ── sample-centric ──
  sample_metadata: `
        SELECT *
        FROM {cancer}_meta
        WHERE uid = '{sample_uid}'
        LIMIT 1
    `,
  sample_signature_profile: `
        SELECT key AS signature_name, value AS psi
        FROM {cancer}_signature t, jsonb_each_text(to_jsonb(t))
        WHERE t.uid = '{sample_uid}'
          AND key <> 'uid'
          AND value IS NOT NULL AND value <> ''
        ORDER BY CAST(value AS DOUBLE PRECISION) DESC
        LIMIT {limit}
    `,

  // ── search ──
  search_annotations: `
        SELECT cancer, original, datagroup, annotation,
               ases, degs, samples
        FROM cluster_annotation
        WHERE annotation ILIKE '%%{search}%%'
           OR datagroup  ILIKE '%%{search}%%'
        ORDER BY samples DESC
        LIMIT {limit}
    `,

  // ── ranking ──
  rank_cohorts_by_gene_events: `
        SELECT cancer, COUNT(*) AS event_count
        FROM survival
        WHERE {gene_match}
          AND lrtpvalue < {pvalue_threshold}
          {prognosis_filter}
        GROUP BY cancer
        ORDER BY event_count DESC
        LIMIT {limit}
    `,
  rank_cohorts_by_mean_hazard: `
        SELECT cancer,
               AVG(loghr) AS mean_loghr,
               COUNT(*) AS n_events
        FROM survival
        WHERE {gene_match}
          AND lrtpvalue < {pvalue_threshold}
          {prognosis_filter}
        GROUP BY cancer
        HAVING COUNT(*) >= 3
        ORDER BY mean_loghr DESC
        LIMIT {limit}
    `,
  rank_genes_by_events_in_cohort: `
        SELECT gene, COUNT(DISTINCT uid) AS event_count
        FROM {cancer}_fullsig
        WHERE CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
        GROUP BY gene
        ORDER BY event_count DESC
        LIMIT {limit}
    `,
  rank_events_by_hazard_in_cohort: `
        SELECT uid, eventannotation, lrtpvalue, loghr, zscore,
               CASE WHEN loghr > 0 THEN 'POOR' ELSE 'GOOD' END AS prognosis
        FROM survival
        WHERE cancer = '{cancer_upper}'
          AND lrtpvalue < {pvalue_threshold}
          {prognosis_filter}
        ORDER BY ABS(loghr) DESC
        LIMIT {limit}
    `,
  rank_events_by_pvalue_in_cohort: `
        SELECT uid, eventannotation, lrtpvalue, loghr, zscore
        FROM survival
        WHERE cancer = '{cancer_upper}'
        ORDER BY lrtpvalue ASC
        LIMIT {limit}
    `,
  rank_signatures_by_samples: `
        SELECT original, datagroup, annotation, ases, degs, samples
        FROM cluster_annotation
        WHERE cancer = '{cancer_upper}'
        ORDER BY samples DESC
        LIMIT {limit}
    `,
    rank_samples_by_event_psi: `
        SELECT key AS sample_id,
               CAST(value AS DOUBLE PRECISION) AS psi
        FROM {cancer}_splice t, jsonb_each_text(to_jsonb(t))
        WHERE t.uid = '{event_uid}'
          AND key NOT IN ('symbol','description','examined_junction',
                          'background_major_junction','altexons',
                          'proteinpredictions','dpsi','clusterid','uid',
                          'pancanceruid','chromosome','coord1','coord2',
                          'coord3','coord4','eventannotation')
          AND value ~ '^-?[0-9.]+$'
        ORDER BY psi DESC
        LIMIT {limit}
    `,
});

const _PAN_COHORTS = [...CANCER_CODES].filter((c) => c !== "gtex");

const _PAN_EVENT_PART = `
        SELECT '{cancer}' AS cancer, gene, uid, eventannotation,
               CAST(dpsi AS DOUBLE PRECISION) AS delta_psi,
               CAST(adjp AS DOUBLE PRECISION) AS adj_pvalue
        FROM {cancer}_fullsig
        WHERE gene = '{gene}'
          AND CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
    `;

const _PAN_DEG_PART = `
        SELECT '{cancer}' AS cancer, symbol, signature_name,
               CAST(logfold AS DOUBLE PRECISION) AS log_fold_change,
               CAST(adjp AS DOUBLE PRECISION) AS adj_pvalue
        FROM {cancer}_fulldegene
        WHERE symbol = '{gene}'
          AND CAST(adjp AS DOUBLE PRECISION) < {pvalue_threshold}
    `;

function _buildPanUnion(partTemplate, p) {
  const gene = String(p.gene).replace(/'/g, "''");
  const pt = Number(p.pvalue_threshold);
  const lim = Number(p.limit);
  const pieces = _PAN_COHORTS.map((c) =>
    partTemplate
      .replace(/\{cancer\}/g, c)
      .replace(/\{gene\}/g, gene)
      .replace(/\{pvalue_threshold\}/g, String(pt)),
  );
  return `${pieces.join("\nUNION ALL\n")}\nORDER BY cancer, adj_pvalue\nLIMIT ${lim}`;
}

const _SORT_EXPR = {
  hazard: "ABS(loghr) DESC",
  cancer: "cancer",
  pvalue: "lrtpvalue ASC",
};

function _interpolatePlaceholders(sql, flat) {
  let out = sql;
  for (const [key, val] of Object.entries(flat)) {
    if (val == null) {
      continue;
    }
    const token = `{${key}}`;
    if (!out.includes(token)) {
      continue;
    }
    const str = String(val).replace(/\\/g, "\\\\").replace(/'/g, "''");
    out = out.split(token).join(str);
  }
  return out;
}

function buildSql(operation, rawParams = {}) {
  if (operation === "pan_events") {
    const p = _validate(rawParams);
    return _buildPanUnion(_PAN_EVENT_PART, p);
  }
  if (operation === "pan_deg") {
    const p = _validate(rawParams);
    return _buildPanUnion(_PAN_DEG_PART, p);
  }

  const template = _TEMPLATES[operation];
  if (template == null) {
    throw new Error(`Unknown SQL operator: ${operation}`);
  }

  const p = _validate(rawParams);
  let sql = template;

  if (sql.includes("{gene_match}")) {
    sql = sql.replace(/\{gene_match\}/g, _buildGeneMatch(p.gene, p.exact));
  }
  if (sql.includes("{prognosis_filter}")) {
    sql = sql.replace(/\{prognosis_filter\}/g, _buildPrognosisFilter(p.prognosis));
  }
  if (sql.includes("{sort_expr}")) {
    const sb = p.sort_by ?? "hazard";
    sql = sql.replace(/\{sort_expr\}/g, _SORT_EXPR[sb] ?? _SORT_EXPR.hazard);
  }

  return _interpolatePlaceholders(sql, p).trim();
}

async function executeOperator(db, operation, rawParams = {}) {
  const sql = buildSql(operation, rawParams);
  let rows;
  if (typeof db.run === "function") {
    rows = await db.run(sql);
  } else if (typeof db.query === "function") {
    const res = await db.query(sql);
    rows = res.rows;
  } else {
    throw new Error("db must provide run(sql) or query(sql) (pg Pool)");
  }
  return { sql_executed: sql, raw_result: rows };
}

module.exports = {
  UnsafeInputError,
  buildSql,
  executeOperator,
};