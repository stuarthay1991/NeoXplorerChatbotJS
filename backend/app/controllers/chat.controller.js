const fs = require("fs/promises");
const path = require("path");
const { createUIMessageStream, pipeUIMessageStreamToResponse } = require("ai");
const { HumanMessage, AIMessage, isAIMessageChunk } = require("@langchain/core/messages");
const { MemorySaver } = require("@langchain/langgraph-checkpoint");
const { createLangChainOncoTools } = require("../tools/primarytools.js");
const { createDeepAgent, FilesystemBackend } = require("deepagents");
const { ChatOpenAI } = require("@langchain/openai");

const MAX_AGENTS_MD_BYTES = 96_000;

const APP_ROOT = path.join(__dirname, "..");
const AGENTS_MD_PATH = path.join(APP_ROOT, "AGENTS.md");
const SKILLS_DIR = path.join(APP_ROOT, "skills");

const SYSTEM_PROMPT = `You are OncoSplice Agent — an expert in cancer alternative splicing
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
`;

/** Shared in-process checkpointer; separate conversations via `configurable.thread_id`. */
const checkpointer = new MemorySaver();

const DEFAULT_OPENAI_BASE_URL = "http://localhost:4000/v1";

/** OpenAI-compatible API base URL (override with OPENAI_BASE_URL in .env). */
function getOpenAiClientConfiguration() {
  const baseURL =
    typeof process.env.OPENAI_BASE_URL === "string" &&
    process.env.OPENAI_BASE_URL.trim() !== ""
      ? process.env.OPENAI_BASE_URL.trim()
      : DEFAULT_OPENAI_BASE_URL;
  return { baseURL };
}

/** Reuse one agent graph per process (skills, tools, model wired once). */
let _agent;

/*from openai import OpenAI
client = OpenAI(base_url="http://<endpoint>/v1", api_key="z11U2fksU8JDhq6bstyedk4Hw7eQRGcn")
client.chat.completions.create(model="gpt-oss-120b", messages=[{"role":"user","content":"hi"}])*/

function createOncoAgent() {
  const lcModel = new ChatOpenAI({
    model: process.env.OPENAI_CHAT_MODEL || "nemotron-3-super",
    streaming: true,
    configuration: getOpenAiClientConfiguration(),
  });
  const backend = new FilesystemBackend({
    rootDir: APP_ROOT,
    virtualMode: false,
    maxFileSizeMb: 12,
  });
  const skillsPath = SKILLS_DIR.endsWith(path.sep)
    ? SKILLS_DIR
    : `${SKILLS_DIR}${path.sep}`;

  return createDeepAgent({
    model: lcModel,
    systemPrompt: SYSTEM_PROMPT,
    skills: [skillsPath],
    memory: [AGENTS_MD_PATH],
    backend,
    tools: createLangChainOncoTools(),
    checkpointer,
  });
}

function getOncoAgent() {
  if (_agent == null) {
    _agent = createOncoAgent();
  }
  return _agent;
}

function openAiKeyMissingResponse(res) {
  return res.status(500).json({
    error:
      "Set OPENAI_API_KEY in backend/.env (or your shell) before starting the server.",
  });
}

function parseThreadId(body) {
  const raw = body?.threadId;
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim();
  }
  return "default";
}

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

/*function setupChatVerificationAndMessageLog(arg1, arg2) {
  //Log every message sent to the LLM. Categorize the messages as one of several predetermined categories
}*/

/** Simple { role, content }[] for external JSON clients (no UI `parts`). */
function simpleMessagesToLangChain(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m.role !== "string") {
      continue;
    }
    const text =
      typeof m.content === "string"
        ? m.content.trim()
        : textFromClientMessage(m);
    if (text.length === 0) {
      continue;
    }
    if (m.role === "user") {
      out.push(new HumanMessage(text));
    } else if (m.role === "assistant") {
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

function logReceivedPrompt(route, threadId, lcMessages) {
  const text = lcMessages
    .map((m) => stringifyLangChainMessageContent(m))
    .filter((t) => t.length > 0)
    .join("\n---\n");
  console.log(`[${route}] threadId=${threadId} prompt:\n${text}`);
}

/**
 * Run the deep agent and collect the full assistant text from message chunks.
 */
async function collectAgentReply(lcMessages, threadId) {
  const agent = getOncoAgent();
  const graphStreamConfig = {
    configurable: { thread_id: threadId },
    streamMode: "messages",
  };
  const parts = [];
  const lgStream = await agent.stream({ messages: lcMessages }, graphStreamConfig);
  for await (const chunk of lgStream) {
    const msg = Array.isArray(chunk) ? chunk[0] : chunk;
    if (!isAIMessageChunk(msg)) {
      continue;
    }
    const delta = stringifyLangChainMessageContent(msg);
    if (delta.length > 0) {
      parts.push(delta);
    }
  }
  return parts.join("");
}

/**
 * Normalize external API body into LangChain messages.
 * Accepts: { message }, { messages: [{role, content}] }, or UI-style { messages: [{role, parts}] }.
 */
function parseExternalChatInput(body) {
  if (typeof body?.message === "string" && body.message.trim() !== "") {
    return {
      lcMessages: [new HumanMessage(body.message.trim())],
      error: null,
    };
  }
  if (Array.isArray(body?.messages) && body.messages.length > 0) {
    const lcFromUi = clientUiMessagesToLangChain(body.messages);
    if (lcFromUi.length > 0) {
      return { lcMessages: lcFromUi, error: null };
    }
    const lcFromSimple = simpleMessagesToLangChain(body.messages);
    if (lcFromSimple.length > 0) {
      return { lcMessages: lcFromSimple, error: null };
    }
    return {
      lcMessages: null,
      error: "Each message needs non-empty user/assistant text (content or parts).",
    };
  }
  return {
    lcMessages: null,
    error:
      'Expected JSON body with "message" (string) or "messages" (array).',
  };
}

/** React UI: SSE UI-message stream (useChat + DefaultChatTransport). */
async function chatPost(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return openAiKeyMissingResponse(res);
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "Expected JSON body with a messages array." });
  }

  try {
    const agent = getOncoAgent();
    const lcMessages = clientUiMessagesToLangChain(messages);
    const threadId = parseThreadId(req.body);
    logReceivedPrompt("chatPost", threadId, lcMessages);

    const graphStreamConfig = {
      configurable: { thread_id: threadId },
      streamMode: "messages",
    };

    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({ type: "start-step" });
        const textId = "text-1";
        writer.write({ type: "text-start", id: textId });
        try {
          const lgStream = await agent.stream(
            { messages: lcMessages },
            graphStreamConfig,
          );
          for await (const chunk of lgStream) {
            const msg = Array.isArray(chunk) ? chunk[0] : chunk;
            if (!isAIMessageChunk(msg)) {
              continue;
            }
            const delta = stringifyLangChainMessageContent(msg);
            if (delta.length > 0) {
              writer.write({ type: "text-delta", id: textId, delta });
            }
          }
        } catch (streamErr) {
          console.error(streamErr);
          const fallback =
            streamErr && typeof streamErr.message === "string"
              ? streamErr.message
              : String(streamErr);
          writer.write({
            type: "text-delta",
            id: textId,
            delta: `\n\n[Error] ${fallback}`,
          });
        }
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "finish-step" });
        writer.write({ type: "finish" });
      },
    });
    pipeUIMessageStreamToResponse({ response: res, stream });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Chat request failed." });
    }
  }
}

/**
 * External LLM / service clients: JSON request/response (no AI SDK SSE).
 *
 * POST /api/chat/complete
 * Body: { message: "...", threadId?: "..." }
 *    or { messages: [{ role, content }], threadId?: "..." }
 * Response: { reply: "...", threadId: "..." }
 */
async function chatCompletePost(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return openAiKeyMissingResponse(res);
  }

  const { lcMessages, error } = parseExternalChatInput(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  const threadId = parseThreadId(req.body);
  logReceivedPrompt("chatCompletePost", threadId, lcMessages);

  try {
    const reply = await collectAgentReply(lcMessages, threadId);
    return res.json({ reply, threadId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message || "Chat request failed.",
      threadId,
    });
  }
}

module.exports = { chatPost, chatCompletePost };
