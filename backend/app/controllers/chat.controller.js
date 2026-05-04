const fs = require("fs/promises");
const path = require("path");
const { createUIMessageStream, pipeUIMessageStreamToResponse, streamText, convertToModelMessages } = require("ai");
const { openai } = require("@ai-sdk/openai");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const { dbCredentials } = require("../config/neoxdb.config.js");
const { MemorySaver } = require("@langchain/langgraph-checkpoint");
const {
  createLangChainOncoTools,
} = require("../tools/primarytools.js");
const { createDeepAgent } = require("deepagents");
const { ChatOpenAI } = require("@langchain/openai");

const MAX_AGENTS_MD_BYTES = 96_000;

/** Shared in-process checkpointer; separate conversations via `configurable.thread_id`. */
const checkpointer = new MemorySaver();

/**
 * LangChain-style "project memory": static instructions file appended to system
 * each request (matches AGENTS.md header: injected every turn).
 */
async function loadAgentsMdBlock(agentsMdPath) {
  try {
    const stat = await fs.stat(agentsMdPath);
    if (!stat.isFile()) {
      return "";
    }
    if (stat.size > MAX_AGENTS_MD_BYTES) {
      const text = await fs.readFile(agentsMdPath, "utf8");
      return `\n\n--- AGENTS.md (project memory, truncated) ---\n${text.slice(0, MAX_AGENTS_MD_BYTES)}\n…`;
    }
    const text = await fs.readFile(agentsMdPath, "utf8");
    return `\n\n--- AGENTS.md (project memory) ---\n${text}`;
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return "";
    }
    console.warn("AGENTS.md:", e.message);
    return "";
  }
}

/** UIMessage from @ai-sdk/react uses `parts`; legacy uses `content`. */
function textFromClientMessage(m) {
  if (m == null) {
    return "";
  }
  if (typeof m.content === "string" && m.content.length > 0) {
    return m.content;
  }
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p) => p && p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

function clientUiMessagesToLangChain(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m.role !== "string") {
      continue;
    }
    const text = textFromClientMessage(m);
    if (m.role === "user" && text.length > 0) {
      out.push(new HumanMessage(text));
    } else if (m.role === "assistant" && text.length > 0) {
      out.push(new AIMessage(text));
    }
  }
  return out;
}

function stringifyLangChainMessageContent(msg) {
  const c = msg?.content;
  if (c == null) {
    return "";
  }
  if (typeof c === "string") {
    return c;
  }
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object" && block.type === "text") {
          return block.text ?? "";
        }
        return "";
      })
      .join("");
  }
  return String(c);
}

async function chatPost(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "Set OPENAI_API_KEY in backend/.env (or your shell) before starting the server.",
    });
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "Expected JSON body with a messages array." });
  }

  try {
    const agentsMdPath = path.join(__dirname, "..", "AGENTS.md");
    const skillsDir = path.join(__dirname, "..", "skills");

    var systemPrompt = `You are OncoSplice Agent — an expert in cancer alternative splicing
genomics built on TCGA and GTEx data.

AVAILABLE COHORTS (24 TCGA cancers + GTEx normal reference):
  blca: Bladder Urothelial Carcinoma   brca: Breast Invasive Carcinoma   cesc: Cervical & Endocervical Cancer   coad: Colon Adenocarcinoma
  esca: Esophageal Carcinoma   gbm: Glioblastoma Multiforme   gtex: GTEx Normal Tissue Reference   hnsc: Head & Neck Squamous Cell Carcinoma
  kich: Kidney Chromophobe   kirc: Kidney Renal Clear Cell Carcinoma   lgg: Brain Lower Grade Glioma   lihc: Liver Hepatocellular Carcinoma
  luad: Lung Adenocarcinoma   lusc: Lung Squamous Cell Carcinoma   ov: Ovarian Serous Cystadenocarcinoma   paad: Pancreatic Adenocarcinoma
  pcpg: Pheochromocytoma & Paraganglioma   prad: Prostate Adenocarcinoma   read: Rectum Adenocarcinoma   sarc: Sarcoma
  skcm: Skin Cutaneous Melanoma   stad: Stomach Adenocarcinoma   tgct: Testicular Germ Cell Tumors   thca: Thyroid Carcinoma
  ucec: Uterine Corpus Endometrial Carcinoma

Always use the lowercase code (e.g. 'luad', 'brca') when calling tools.
Map plain-English cancer names to TCGA codes before calling.

Note: 'kirp' (Kidney Renal Papillary Cell Carcinoma) exists ONLY in the
cross-cancer 'survival' and 'cluster_annotation' tables and has no
per-cohort family — do not pass it to per-cohort operators.

You have consolidated operator tools plus one escape hatch. Each
operator tool takes an 'aspect' / 'kind' / ('scope', 'metric') literal
that dispatches to a validated, parameterised SQL template. Never write
SQL by hand unless none of these tools fit.

ENTITY-CENTRIC OPERATORS
- query_gene(gene, aspect=...)          — per-cohort events/deg/by_signature,
                                           cross-cohort survival, pan-cancer
                                           UNIONs, genome-reference lookups
- query_signature(cancer, signature_name, aspect=...) — events/degs/genes,
                                           annotation, top samples, mean PSI
- query_event(event_uid, aspect=...)    — per-sample PSI, full details,
                                           survival rows, supersig, GTEx
- query_sample(cancer, sample_uid, aspect=...) — meta row, signature profile

DIMENSION OPERATORS
- count(kind=...)                       — fast row counts
- list_entities(kind=...)               — enumerate cohorts, sample types,
                                           signatures, clusters, event types,
                                           samples, tables
- rank(scope=..., metric=...)           — top-N across cohorts/genes/events/
                                           signatures/samples
- search_annotations(search)            — free-text across cluster labels

ESCAPE HATCH
- execute_sql(query)                    — LAST RESORT. Load the
                                           'sql-authoring' skill first.

WORKFLOW
1. For database questions, pick the most specific operator above.
2. For multi-step analyses, use 'write_todos' to plan before firing tools.
3. Synthesise a concise answer quoting actual numbers. Reference the SQL
   or the operator used.
4. Only reach for 'execute_sql' if you have verified that none of the
   operator aspects cover the question.

SKILLS — loaded via deepagents from backend/app/skills (e.g. schema-per-cancer,
  schema-global, sql-authoring). Consult them before execute_sql.

ERROR HANDLING
Tool results starting with 'ERROR ' (validation) or 'ERROR (...)' (DB/SQL
failure) are surfaced back to you instead of aborting. When you see one:
1. Read the error carefully — bad column, bad cast, unknown cancer, etc.
2. Consult the relevant schema skill ('schema-per-cancer' / 'schema-global')
   to verify actual column names.
3. Prefer switching to an operator tool before retrying raw SQL.
4. If retrying 'execute_sql', fix the specific cause (e.g. join to get the
   missing column, add CAST, switch tables). Don't rerun the same query.

DO NOT
- Write SQL on the primary path — use the operators.
- Invent data — only report what the tools return.
- Call per-cohort operators with cancer='kirp'.
- Retry a failed 'execute_sql' without changing it based on the error.
`

    //const agentsMdBlock = await loadAgentsMdBlock(agentsMdPath);
    // createDeepAgent expects a LangChain BaseChatModel (e.g. ChatOpenAI), not @ai-sdk/openai.
    const lcModel = new ChatOpenAI({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1",
      streaming: true,
    });
    const agent = createDeepAgent({
      model: lcModel,
      // Pass your existing system prompt
      systemPrompt: systemPrompt, 
      // backend/app/skills and backend/app/AGENTS.md (same as skillsDir / agentsMdPath)
      skills: [skillsDir],
      memory: [agentsMdPath],
      //backend: backend,
      tools: createLangChainOncoTools(),
      checkpointer,
    });

    const lcMessages = clientUiMessagesToLangChain(messages);
    const threadId =
      typeof req.body?.threadId === "string" && req.body.threadId.trim() !== ""
        ? req.body.threadId.trim()
        : "default";
    const result = await agent.invoke(
      { messages: lcMessages },
      { configurable: { thread_id: threadId } },
    );

    const lcOut = result.messages ?? [];
    const lastLc = lcOut[lcOut.length - 1];
    const replyText = stringifyLangChainMessageContent(lastLc);

    // useChat + DefaultChatTransport expect a UI message SSE stream (not JSON body).
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({ type: "start-step" });
        const textId = "text-1";
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: replyText });
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "finish-step" });
        writer.write({ type: "finish" });
      },
    });
    pipeUIMessageStreamToResponse({ response: res, stream });
    return;

    /*const modelMessages = await convertToModelMessages(messages);
    const result = streamText({
      model: openai("gpt-4.1"),
      system: systemPrompt,
      messages: modelMessages,
      tools: {
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
      },
      experimental_context: {
        db: dbCredentials,
        memory: [agentsMdPath],
        agentsMdPath,
        skills: [skillsDir],
        readSkillCache: new Map(),
      },
    });

    result.pipeUIMessageStreamToResponse(res, {
      originalMessages: messages,
    });*/
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Chat request failed." });
    }
  }
}

module.exports = { chatPost };
