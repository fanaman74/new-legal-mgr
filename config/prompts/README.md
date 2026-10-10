# Prompts

System prompts used by the POC live here and are **versioned by filename**
(`<name>.v<N>.md`). Never edit a released version in place: copy it to the next
version number and update `config/app.yaml`/code to reference the new file, so
that every generated answer can be traced to the exact prompt that produced it.

Prompts are only used from Milestone 3 (grounded Q&A) onwards. Milestone 1
(ingestion) is fully deterministic and uses no LLM.
