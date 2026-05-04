const fs = require("fs/promises");
const path = require("path");
const { dbCredentials } = require("../config/neoxdb.config.js");
const { executeOperator } = require("./operators.js");
const { tool, zodSchema } = require("ai");
const { z } = require("zod");

const MAX_SKILL_FILE_BYTES = 600_000;

/** Same `name` as operators.js so catches match validation errors from either module. */
class SkillPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeInputError";
  }
}

function isUnsafeInputError(err) {
  return err != null && err.name === "UnsafeInputError";
}

let _db;

/**
 * Returns the same DB handle tools use: `{ run(sql) }` backed by the shared
 * `pg` pool from `neoxdb.config.js` (same pool conceptually as `experimental_context.db`).
 */
function _getDb() {
  if (_db == null) {
    _db = {
      run(sql) {
        return dbCredentials.query(sql).then((res) => res.rows);
      },
    };
  }
  return _db;
}

function _fmt(r) {
  const result =
    typeof r.raw_result === "string"
      ? r.raw_result
      : JSON.stringify(r.raw_result);
  return `SQL: ${r.sql_executed}\nResult: ${result}`;
}

function _err(msg) {
  return `ERROR: ${msg}`;
}

function _dbError(source, exc, { sql: sqlArg } = {}) {
  const orig = exc?.orig ?? exc?.cause ?? exc;
  const raw = String(orig ?? "").trim();
  const msg = raw ? raw.split("\n")[0] : String(exc);
  const name = exc?.constructor?.name ?? "Error";
  const parts = [`ERROR (${source}): ${name}: ${msg}`];
  if (sqlArg) {
    let compactSql = sqlArg.split(/\s+/).join(" ");
    if (compactSql.length > 400) {
      compactSql = `${compactSql.slice(0, 400)}…`;
    }
    parts.push(`Failed SQL: ${compactSql}`);
  }
  parts.push(
    "Reflect on the error and try again: verify table/column names against " +
      "the schema skills, prefer an operator tool, and re-check CAST / uid " +
      "/ LIKE-escape rules before retrying.",
  );
  return parts.join("\n");
}

async function _run(operation, params = {}) {
  try {
    return _fmt(await executeOperator(_getDb(), operation, params));
  } catch (exc) {
    if (isUnsafeInputError(exc)) {
      return _err(`${operation}: ${exc.message}`);
    }
    return _dbError(`operator ${operation}`, exc);
  }
}

/** Gene-centric tool `aspect` values (Python `Literal[...]` → frozen tuple). */
const GENE_ASPECT = Object.freeze([
  "events",
  "deg",
  "survival",
  "by_signature",
  "pan_events",
  "pan_deg",
  "exons",
  "junctions",
  "transcripts",
]);

const _QUERY_GENE_NEEDS_CANCER = new Set(["events", "deg", "by_signature"]);

const queryGeneDescription = [
  "Everything you can ask about a single gene. Dispatch with `aspect`:",
  "`events` / `deg` / `by_signature` require lowercase `cancer` (e.g. luad).",
  "`survival` — cross-cohort survival (prognosis: poor|good|both; exact; sort_by: hazard|cancer|pvalue).",
  "`pan_events` / `pan_deg` — pan-cancer UNIONs across TCGA cohorts.",
  "`exons` / `junctions` / `transcripts` — reference tables (HGNC symbol or Ensembl ID).",
].join(" ");

const queryGeneInputSchema = z.object({
  gene: z
    .string()
    .describe("Gene symbol (e.g. TP53) or Ensembl ID for reference aspects."),
  aspect: z
    .enum(GENE_ASPECT)
    .describe("Which slice to return; see tool description."),
  cancer: z
    .string()
    .optional()
    .describe(
      "Cancer code (lowercase, e.g. luad). Required for events, deg, by_signature.",
    ),
  prognosis: z
    .enum(["poor", "good", "both"])
    .optional()
    .default("both")
    .describe("For survival: poor (loghr>0), good (loghr<0), or both."),
  exact: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "For survival: if true, match only UIDs whose gene token is exactly this gene.",
    ),
  sort_by: z
    .enum(["hazard", "cancer", "pvalue"])
    .optional()
    .default("hazard")
    .describe("For survival: sort order."),
  pvalue_threshold: z
    .number()
    .optional()
    .default(0.05)
    .describe("adjp / lrtpvalue cutoff."),
  limit: z
    .number()
    .int()
    .optional()
    .default(25)
    .describe("Max rows to return."),
});

async function queryGeneExecute(input) {
  const gene = input.gene;
  const aspect = input.aspect;
  const cancer = input.cancer;
  const prognosis = input.prognosis ?? "both";
  const exact = input.exact ?? false;
  const sortBy = input.sort_by ?? "hazard";
  const pvalueThreshold = input.pvalue_threshold ?? 0.05;
  const limit = input.limit ?? 25;

  const cancerNorm =
    cancer != null && String(cancer).trim() !== ""
      ? String(cancer).trim()
      : undefined;

  if (_QUERY_GENE_NEEDS_CANCER.has(aspect) && cancerNorm == null) {
    return _err(`\`cancer\` is required for aspect='${aspect}'.`);
  }

  const dispatch = {
    events: () => ({
      op: "gene_events",
      params: {
        cancer: cancerNorm,
        gene,
        pvalue_threshold: pvalueThreshold,
        limit,
      },
    }),
    deg: () => ({
      op: "gene_deg",
      params: {
        cancer: cancerNorm,
        gene,
        pvalue_threshold: pvalueThreshold,
        limit,
      },
    }),
    survival: () => ({
      op: "gene_survival",
      params: {
        gene,
        prognosis,
        exact,
        sort_by: sortBy,
        pvalue_threshold: pvalueThreshold,
        limit,
      },
    }),
    by_signature: () => ({
      op: "gene_events_by_signature",
      params: {
        cancer: cancerNorm,
        gene,
        pvalue_threshold: pvalueThreshold,
      },
    }),
    pan_events: () => ({
      op: "pan_events",
      params: {
        gene,
        pvalue_threshold: pvalueThreshold,
        limit,
      },
    }),
    pan_deg: () => ({
      op: "pan_deg",
      params: {
        gene,
        pvalue_threshold: pvalueThreshold,
        limit,
      },
    }),
    exons: () => ({ op: "gene_exons", params: { gene, limit } }),
    junctions: () => ({ op: "gene_junctions", params: { gene, limit } }),
    transcripts: () => ({ op: "gene_transcripts", params: { gene, limit } }),
  };

  const branch = dispatch[aspect];
  if (branch == null) {
    return _err(`Unknown aspect '${aspect}' for query_gene.`);
  }
  const { op, params } = branch();
  return _run(op, params);
}

const queryGene = tool({
  description: queryGeneDescription,
  inputSchema: zodSchema(queryGeneInputSchema),
  execute: queryGeneExecute,
});

const SIGNATURE_ASPECT = Object.freeze([
  "events",
  "degs",
  "genes",
  "annotation",
  "top_samples",
  "mean_psi",
]);

/** `query_event` aspects (was Python `EventAspect`). */
const EVENT_ASPECT = Object.freeze([
  "psi",
  "details",
  "survival",
  "pancancer",
  "gtex",
]);

const querySignatureInputSchema = z.object({
  cancer: z.string(),
  signature_name: z.string(),
  aspect: z.enum(SIGNATURE_ASPECT),
  pvalue_threshold: z.number().optional().default(0.05),
  limit: z.number().int().optional().default(25),
});

const querySignature = tool({
  description: [
    "One NMF splicing signature in one cohort (cancer + signature_name + aspect).",
    "events|degs|genes: signature_name is the cluster id; pvalue_threshold applies to events/degs.",
    "annotation: cluster_annotation row.",
    "top_samples|mean_psi: signature_name must be the real `{cancer}_signature` column (e.g. psi_luad_dt_r1_v8).",
  ].join(" "),
  inputSchema: zodSchema(querySignatureInputSchema),
  execute: async (input) => {
    const {
      cancer,
      signature_name: sn,
      aspect,
      pvalue_threshold: pt = 0.05,
      limit = 25,
    } = input;
    if (aspect === "events" || aspect === "degs" || aspect === "genes") {
      const op =
        aspect === "events"
          ? "signature_events"
          : aspect === "degs"
            ? "signature_degs"
            : "list_genes_in_signature";
      return _run(op, {
        cancer,
        signature_name: sn,
        pvalue_threshold: pt,
        limit,
      });
    }
    if (aspect === "annotation") {
      return _run("signature_annotation", { cancer, signature_name: sn });
    }
    if (aspect === "top_samples") {
      return _run("signature_top_samples", {
        cancer,
        signature_col: sn,
        limit,
      });
    }
    if (aspect === "mean_psi") {
      return _run("signature_mean_psi", { cancer, signature_col: sn });
    }
    return _err(`Unknown aspect '${aspect}' for query_signature.`);
  },
});

const SAMPLE_ASPECT = Object.freeze(["metadata", "signature_profile"]);

const queryEventInputSchema = z.object({
  event_uid: z.string(),
  aspect: z.enum(EVENT_ASPECT),
  cancer: z.string().optional(),
  limit: z.number().int().optional().default(1000),
});

const queryEvent = tool({
  description: [
    "One splicing event by UID + aspect.",
    "psi|details need cancer (lowercase). survival|pancancer|gtex are cross-cohort / GTEx; limit defaults 1000 (many samples for psi).",
  ].join(" "),
  inputSchema: zodSchema(queryEventInputSchema),
  execute: async (input) => {
    const {
      event_uid: uid,
      aspect,
      cancer,
      limit = 1000,
    } = input;
    const c =
      cancer != null && String(cancer).trim() !== ""
        ? String(cancer).trim()
        : undefined;
    if ((aspect === "psi" || aspect === "details") && c == null) {
      return _err(`\`cancer\` is required for aspect='${aspect}'.`);
    }
    const dispatch = {
      psi: ["event_psi", { cancer: c, event_uid: uid, limit }],
      details: ["event_details", { cancer: c, event_uid: uid }],
      survival: ["event_survival", { event_uid: uid, limit }],
      pancancer: ["event_pancancer", { event_uid: uid, limit }],
      gtex: ["event_gtex", { event_uid: uid, limit }],
    };
    const row = dispatch[aspect];
    if (row == null) {
      return _err(`Unknown aspect '${aspect}' for query_event.`);
    }
    return _run(row[0], row[1]);
  },
});

const querySampleInputSchema = z.object({
  cancer: z.string(),
  sample_uid: z.string(),
  aspect: z.enum(SAMPLE_ASPECT),
  limit: z.number().int().optional().default(50),
});

const querySample = tool({
  description: [
    "One TCGA sample: cancer + sample_uid + aspect.",
    "metadata — full {cancer}_meta row. signature_profile — PSIs across signatures (limit, default 50).",
  ].join(" "),
  inputSchema: zodSchema(querySampleInputSchema),
  execute: async (input) => {
    const { cancer, sample_uid: uid, aspect, limit = 50 } = input;
    if (aspect === "metadata") {
      return _run("sample_metadata", { cancer, sample_uid: uid });
    }
    if (aspect === "signature_profile") {
      return _run("sample_signature_profile", {
        cancer,
        sample_uid: uid,
        limit,
      });
    }
    return _err(`Unknown aspect '${aspect}' for query_sample.`);
  },
});

const COUNT_KIND = Object.freeze([
  "events",
  "samples",
  "junctions",
  "exons",
  "genes",
  "degs",
  "signatures",
]);

const LIST_KIND = Object.freeze([
  "cancers",
  "sample_types",
  "signatures",
  "clusters",
  "event_types",
  "samples",
  "tables",
]);

const RANK_SCOPE = Object.freeze([
  "cohorts",
  "genes",
  "events",
  "signatures",
  "samples",
]);

const RANK_METRIC = Object.freeze([
  "event_count",
  "mean_hazard",
  "hazard",
  "pvalue",
  "sample_count",
  "psi",
]);

const countInputSchema = z.object({
  kind: z.enum(COUNT_KIND),
  cancer: z.string().optional(),
});

const count = tool({
  description:
    "Fast row counts. kind junctions|exons is global; events|samples|genes|degs|signatures need cancer.",
  inputSchema: zodSchema(countInputSchema),
  execute: async (input) => {
    const { kind, cancer } = input;
    const c =
      cancer != null && String(cancer).trim() !== ""
        ? String(cancer).trim()
        : undefined;
    if (kind === "junctions" || kind === "exons") {
      return _run(kind === "junctions" ? "count_junctions" : "count_exons", {});
    }
    if (c == null) {
      return _err(`\`cancer\` is required for count(kind='${kind}').`);
    }
    const op = {
      events: "count_splicing_events",
      samples: "count_samples",
      genes: "count_genes_in_cohort",
      degs: "count_degs_in_cohort",
      signatures: "count_signatures",
    }[kind];
    if (op == null) {
      return _err(`Unknown count kind '${kind}'.`);
    }
    return _run(op, { cancer: c });
  },
});

const listEntitiesInputSchema = z.object({
  kind: z.enum(LIST_KIND),
  cancer: z.string().optional(),
  sample_field: z.string().optional().default("histological_type"),
  limit: z.number().int().optional().default(100),
});

const listEntities = tool({
  description:
    "Enumerate: cancers|tables (global); sample_types|signatures|clusters|event_types|samples need cancer. sample_types uses sample_field (default histological_type). limit only for samples.",
  inputSchema: zodSchema(listEntitiesInputSchema),
  execute: async (input) => {
    const {
      kind,
      cancer,
      sample_field: sf = "histological_type",
      limit = 100,
    } = input;
    const c =
      cancer != null && String(cancer).trim() !== ""
        ? String(cancer).trim()
        : undefined;
    if (kind === "cancers") {
      return _run("list_cancers", {});
    }
    if (kind === "tables") {
      return _run("list_tables", {});
    }
    if (c == null) {
      return _err(`\`cancer\` is required for list_entities(kind='${kind}').`);
    }
    if (kind === "sample_types") {
      return _run("list_sample_types", { cancer: c, sample_field: sf });
    }
    if (kind === "signatures") {
      return _run("list_signatures", { cancer: c });
    }
    if (kind === "clusters") {
      return _run("cluster_annotations", { cancer: c });
    }
    if (kind === "event_types") {
      return _run("list_event_types", { cancer: c });
    }
    if (kind === "samples") {
      return _run("list_samples", { cancer: c, limit });
    }
    return _err(`Unknown list kind '${kind}'.`);
  },
});

const rankInputSchema = z.object({
  scope: z.enum(RANK_SCOPE),
  metric: z.enum(RANK_METRIC),
  gene: z.string().optional(),
  cancer: z.string().optional(),
  event_uid: z.string().optional(),
  prognosis: z.enum(["poor", "good", "both"]).optional().default("both"),
  exact: z.boolean().optional().default(false),
  pvalue_threshold: z.number().optional().default(0.05),
  limit: z.number().int().optional().default(10),
});

const rank = tool({
  description:
    "Top-N rankings. Supported: (cohorts,event_count|mean_hazard)+gene; (genes,event_count)+cancer; (events,hazard|pvalue)+cancer; (signatures,sample_count)+cancer; (samples,psi)+cancer+event_uid. prognosis/exact/pt apply where SQL templates use them.",
  inputSchema: zodSchema(rankInputSchema),
  execute: async (input) => {
    const {
      scope,
      metric,
      gene,
      cancer,
      event_uid,
      prognosis = "both",
      exact = false,
      pvalue_threshold: pt = 0.05,
      limit = 10,
    } = input;
    const c =
      cancer != null && String(cancer).trim() !== ""
        ? String(cancer).trim()
        : undefined;
    const g =
      gene != null && String(gene).trim() !== ""
        ? String(gene).trim()
        : undefined;

    if (scope === "cohorts" && metric === "event_count") {
      if (!g) {
        return _err("`gene` is required for scope='cohorts'.");
      }
      return _run("rank_cohorts_by_gene_events", {
        gene: g,
        prognosis,
        exact,
        pvalue_threshold: pt,
        limit,
      });
    }
    if (scope === "cohorts" && metric === "mean_hazard") {
      if (!g) {
        return _err("`gene` is required for scope='cohorts'.");
      }
      return _run("rank_cohorts_by_mean_hazard", {
        gene: g,
        prognosis,
        exact,
        pvalue_threshold: pt,
        limit,
      });
    }
    if (scope === "genes" && metric === "event_count") {
      if (!c) {
        return _err("`cancer` is required for scope='genes'.");
      }
      return _run("rank_genes_by_events_in_cohort", {
        cancer: c,
        pvalue_threshold: pt,
        limit,
      });
    }
    if (scope === "events" && metric === "hazard") {
      if (!c) {
        return _err("`cancer` is required for scope='events'.");
      }
      return _run("rank_events_by_hazard_in_cohort", {
        cancer: c,
        prognosis,
        pvalue_threshold: pt,
        limit,
      });
    }
    if (scope === "events" && metric === "pvalue") {
      if (!c) {
        return _err("`cancer` is required for scope='events'.");
      }
      return _run("rank_events_by_pvalue_in_cohort", { cancer: c, limit });
    }
    if (scope === "signatures" && metric === "sample_count") {
      if (!c) {
        return _err("`cancer` is required for scope='signatures'.");
      }
      return _run("rank_signatures_by_samples", { cancer: c, limit });
    }
    if (scope === "samples" && metric === "psi") {
      if (!c || !event_uid) {
        return _err(
          "`cancer` and `event_uid` are required for scope='samples', metric='psi'.",
        );
      }
      return _run("rank_samples_by_event_psi", {
        cancer: c,
        event_uid,
        limit,
      });
    }
    return _err(`Unsupported (scope, metric): (${scope}, ${metric}).`);
  },
});

const searchAnnotationsInputSchema = z.object({
  search: z.string(),
  limit: z.number().int().optional().default(25),
});

const searchAnnotations = tool({
  description:
    "Free-text search over cluster_annotation (phenotype-style queries).",
  inputSchema: zodSchema(searchAnnotationsInputSchema),
  execute: async ({ search, limit = 25 }) =>
    _run("search_annotations", { search, limit }),
});

const executeSqlDescription = [
  "LAST-RESORT raw SQL against the OncoSplice Agent PostgreSQL database.",
  "Confirm none of query_gene, query_signature, query_event, query_sample, count, list_entities, rank, search_annotations can answer first.",
  "Load the sql-authoring skill first.",
  "HARD RULES: single SELECT / WITH / EXPLAIN only; never DML.",
  "CAST(col AS DOUBLE PRECISION) for text-stored numerics (dpsi, adjp, logfold, rawp, psi_*, sample PSIs, CIBERSORT, _meta pathway scores).",
  "Do NOT CAST survival.* or gtex_fulldegene.logfold / .rawp — those are real numeric.",
  "SELECT * from {cancer}_splice is FORBIDDEN; enumerate columns or use jsonb_each_text(to_jsonb(t)).",
  "Always end with LIMIT N.",
  "On failure the error is returned as a string (not raised) so you can correct the next query.",
].join(" ");

const executeSqlInputSchema = z.object({
  query: z
    .string()
    .describe(
      "One PostgreSQL SELECT, WITH, or EXPLAIN statement; obey HARD RULES in the tool description.",
    ),
});

async function executeSqlExecute({ query: sql }) {
  try {
    const raw = await _getDb().run(sql);
    if (typeof raw === "string") {
      return raw;
    }
    return JSON.stringify(raw, null, 2);
  } catch (exc) {
    return _dbError("execute_sql", exc, { sql });
  }
}

const executeSql = tool({
  description: executeSqlDescription,
  inputSchema: zodSchema(executeSqlInputSchema),
  execute: executeSqlExecute,
});

function _skillsRootFromContext(experimentalContext) {
  const skills = experimentalContext?.skills;
  if (!Array.isArray(skills)) {
    return null;
  }
  const first = skills.find((s) => typeof s === "string" && s.length > 0);
  return first ?? null;
}

function _defaultSkillsRoot() {
  return path.join(__dirname, "..", "skills");
}

function _resolveSkillPath(skillsRootAbs, relativePath) {
  const raw = String(relativePath ?? "").trim();
  if (!raw) {
    throw new SkillPathError("relative_path is required.");
  }
  if (raw.includes("\0")) {
    throw new SkillPathError("Invalid path.");
  }
  const root = path.resolve(skillsRootAbs);
  const joined = path.resolve(root, raw);
  const rel = path.relative(root, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SkillPathError("Path must stay under the skills directory.");
  }
  return joined;
}

const readSkillDescription = [
  "Read ONE file under the agent skills directory (markdown SKILL files and helpers).",
  "Pass relative_path like \"schema-per-cancer/SKILL.md\" or \"sql-authoring/SKILL.md\".",
  "Paths cannot escape the skills folder (no '..'). Large files are rejected.",
  "Repeated reads of the same file in one chat request are served from an in-memory cache (readSkillCache on experimental_context).",
].join(" ");

const readSkillInputSchema = z.object({
  relative_path: z
    .string()
    .describe(
      'File path under skills/, e.g. "schema-per-cancer/SKILL.md".',
    ),
});

async function readSkillExecute(input, options) {
  const { relative_path: relativePath } = input;
  const ctx = options.experimental_context ?? {};
  const skillsRoot =
    _skillsRootFromContext(ctx) ?? _defaultSkillsRoot();

  let resolved;
  try {
    resolved = _resolveSkillPath(skillsRoot, relativePath);
  } catch (e) {
    if (isUnsafeInputError(e)) {
      return _err(e.message);
    }
    throw e;
  }

  const cache = ctx.readSkillCache;
  const cacheKey = resolved;
  if (cache instanceof Map && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    return `path: ${resolved}\nsource: cache\n\n${cached}`;
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return _err(`Not a file: ${relativePath}`);
    }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      return _err(
        `File too large (${stat.size} bytes); max ${MAX_SKILL_FILE_BYTES}.`,
      );
    }
    const content = await fs.readFile(resolved, "utf8");
    if (cache instanceof Map) {
      cache.set(cacheKey, content);
    }
    return `path: ${resolved}\nsource: disk\n\n${content}`;
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return _err(`No such file: ${relativePath}`);
    }
    return _err(`read_skill: ${e?.message ?? e}`);
  }
}

const readSkill = tool({
  description: readSkillDescription,
  inputSchema: zodSchema(readSkillInputSchema),
  execute: readSkillExecute,
});

const { tool: langchainTool } = require("@langchain/core/tools");

/**
 * LangChain / OpenAI expect StructuredTool instances (with JSON schema + type).
 * Vercel AI `tool()` objects are not compatible — wrap the same execute + Zod here.
 */
/** LangChain tools for `createDeepAgent` (DB operators only; skills come from deepagents `skills:`). */
function createLangChainOncoTools() {
  const emptyExec = {};

  return [
    langchainTool((input) => queryGene.execute(input, emptyExec), {
      name: "query_gene",
      description: queryGeneDescription,
      schema: queryGeneInputSchema,
    }),
    langchainTool((input) => querySignature.execute(input, emptyExec), {
      name: "query_signature",
      description: [
        "One NMF splicing signature in one cohort (cancer + signature_name + aspect).",
        "events|degs|genes: signature_name is the cluster id; pvalue_threshold applies to events/degs.",
        "annotation: cluster_annotation row.",
        "top_samples|mean_psi: signature_name must be the real `{cancer}_signature` column (e.g. psi_luad_dt_r1_v8).",
      ].join(" "),
      schema: querySignatureInputSchema,
    }),
    langchainTool((input) => queryEvent.execute(input, emptyExec), {
      name: "query_event",
      description: [
        "One splicing event by UID + aspect.",
        "psi|details need cancer (lowercase). survival|pancancer|gtex are cross-cohort / GTEx; limit defaults 1000 (many samples for psi).",
      ].join(" "),
      schema: queryEventInputSchema,
    }),
    langchainTool((input) => querySample.execute(input, emptyExec), {
      name: "query_sample",
      description: [
        "One TCGA sample: cancer + sample_uid + aspect.",
        "metadata — full {cancer}_meta row. signature_profile — PSIs across signatures (limit, default 50).",
      ].join(" "),
      schema: querySampleInputSchema,
    }),
    langchainTool((input) => count.execute(input, emptyExec), {
      name: "count",
      description:
        "Fast row counts. kind junctions|exons is global; events|samples|genes|degs|signatures need cancer.",
      schema: countInputSchema,
    }),
    langchainTool((input) => listEntities.execute(input, emptyExec), {
      name: "list_entities",
      description:
        "Enumerate: cancers|tables (global); sample_types|signatures|clusters|event_types|samples need cancer. sample_types uses sample_field (default histological_type). limit only for samples.",
      schema: listEntitiesInputSchema,
    }),
    langchainTool((input) => rank.execute(input, emptyExec), {
      name: "rank",
      description:
        "Top-N rankings. Supported: (cohorts,event_count|mean_hazard)+gene; (genes,event_count)+cancer; (events,hazard|pvalue)+cancer; (signatures,sample_count)+cancer; (samples,psi)+cancer+event_uid. prognosis/exact/pt apply where SQL templates use them.",
      schema: rankInputSchema,
    }),
    langchainTool((input) => searchAnnotations.execute(input, emptyExec), {
      name: "search_annotations",
      description:
        "Free-text search over cluster_annotation (phenotype-style queries).",
      schema: searchAnnotationsInputSchema,
    }),
    langchainTool((input) => executeSql.execute(input, emptyExec), {
      name: "execute_sql",
      description: executeSqlDescription,
      schema: executeSqlInputSchema,
    }),
  ];
}

const PRIMARY_TOOLS = Object.freeze([
  queryGene,
  querySignature,
  queryEvent,
  querySample,
  count,
  listEntities,
  rank,
  searchAnnotations,
  executeSql,
  readSkill,
]);

/** `streamText({ tools })` expects a `Record<name, Tool>` — not the array above. */
const primaryTools = Object.freeze({
  query_gene: queryGene,
  query_signature: querySignature,
  query_event: queryEvent,
  query_sample: querySample,
  count,
  list_entities: listEntities,
  rank,
  search_annotations: searchAnnotations,
  execute_sql: executeSql,
  read_skill: readSkill,
});

function createPrimaryTools() {
  return primaryTools;
}

module.exports = {
  COUNT_KIND,
  EVENT_ASPECT,
  LIST_KIND,
  PRIMARY_TOOLS,
  RANK_METRIC,
  RANK_SCOPE,
  SAMPLE_ASPECT,
  SIGNATURE_ASPECT,
  count,
  createLangChainOncoTools,
  createPrimaryTools,
  executeSql,
  listEntities,
  primaryTools,
  queryEvent,
  queryGene,
  querySample,
  querySignature,
  rank,
  readSkill,
  searchAnnotations,
};