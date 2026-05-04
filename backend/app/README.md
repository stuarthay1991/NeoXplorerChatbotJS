# OncoSplice Agent

AI assistant for querying alternative splicing events across 24 TCGA cancer cohorts and GTEx normal tissue. Built on the LangChain Deep Agents SDK, backed by a PostgreSQL database of pre-computed splicing signatures, survival associations, and differential expression.

## Prerequisites

- **Python 3.11+**
- **PostgreSQL 14+** with the `pg_trgm` extension
- The OncoSplice database dump (`oncocasen_2026.sql`, ~11 GB)
- An API key for at least one supported LLM provider

## Quick start

```bash
# 1. Clone and install
git clone <repo-url> && cd OncoSplice
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Configure
cp .env.example .env
# Edit .env — set your API key and (optionally) LLM_MODEL

# 3. Load the database (30–90 min)
./db/load_db.sh
psql -d oncosplice_db -f db/build_indices.sql

# 4. Run
python scripts/gradio_app.py          # Web UI  → http://127.0.0.1:7860
python scripts/chat.py                # Terminal chat
python scripts/chat.py "your question" # One-shot query
```

## Choosing an LLM

Set `LLM_MODEL` in `.env` using the format `provider:model_name`. If unset, defaults to `anthropic:claude-sonnet-4-6`.

| Provider | Example `LLM_MODEL` value | Package to install | API key env var |
|----------|---------------------------|--------------------|-----------------|
| Anthropic | `anthropic:claude-sonnet-4-6` | `langchain-anthropic` (included) | `ANTHROPIC_API_KEY` |
| OpenAI | `openai:gpt-4o` | `langchain-openai` | `OPENAI_API_KEY` |
| Google | `google:gemini-2.0-flash` | `langchain-google-genai` | `GOOGLE_API_KEY` |
| Groq | `groq:llama-3.3-70b-versatile` | `langchain-groq` | `GROQ_API_KEY` |
| AWS Bedrock | `aws:anthropic.claude-3-5-sonnet-20241022-v2:0` | `langchain-aws` | boto3 credential chain |
| Ollama | `ollama:llama3` | `langchain-ollama` | none (local) |

Install the provider package for whichever model you pick:

```bash
pip install langchain-openai  # example for OpenAI
```

## Project layout

```
oncosplice_agent/         Core package
  agent.py                  Agent assembly and 9 operator tools
  llm.py                    LLM provider resolution from .env
  operators.py              ~35 parameterised SQL templates
  models.py                 Cancer codes, data models
  streaming.py              Token-streaming helpers
scripts/
  gradio_app.py             Gradio web UI
  chat.py                   Terminal streaming chat
  smoke_test.py             Quick sanity check
skills/                     Agent skills (schema docs, SQL-authoring rules)
db/
  load_db.sh                Database loader
  build_indices.sql         Index build script
```

## Database

The agent queries a PostgreSQL database containing per-cancer table families (`{cancer}_meta`, `{cancer}_signature`, `{cancer}_fullsig`, `{cancer}_fulldegene`, `{cancer}_splice`) plus cross-cancer tables (`survival`, `cluster_annotation`, `supersig`, `gtex`, etc.). See `skills/schema-per-cancer/SKILL.md` and `skills/schema-global/SKILL.md` for full schema documentation.

## License

Internal research use.
