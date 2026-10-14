# Goal draft live evaluation
Run npm run test:agent:goal-drafts -- claude or -- codex for ten scenarios.
Use --cases=01,07 to rerun selected scenarios and --tag=final to identify a prompt revision.
PWQ_EVAL_REPORT saves the full record; PWQ_EVAL_MODEL optionally selects a known supported model.
All database, habits, runtime config and API ports are isolated before importing server modules.
--ui-first starts a temporary Vite preview for the first selected scenario; its UI_READY log
reports the URL and checkpoint file. Use the actual goal button, record the preview/draft retention,
then create that checkpoint file to let confirmation checks and the remaining scenarios proceed.

Cases cover software delivery, learning with existing work, documentation, migration prerequisites,
research, short learning blocks, insufficient capacity, missing information, fully covered goals,
and same-name goal identity plus quoted instruction interference and repeated pending previews.

Hard checks: real provider, no fallback, valid task.create actions, selected goal binding, no writes
before confirmation, duplicate handling, rejected false confirmation, batch readback/idempotence,
and cancellation. Review semantic duplication as well as exact-title duplication manually.

Content rubric: goal coverage 25, executable/verifiable task wording 25, granularity/sequence 20,
context and constraints 20, clarity/assumptions 10. Each dimension is graded 0–4 against its expected
case outcomes; weighted >=85 with every dimension >=3 and all hard checks passing is considered
excellent for this evaluation. Information-poor and fully covered cases may correctly create zero
tasks. These judgments are not calibrated probabilities or a guarantee for all future goals.
Preserve failed baseline outputs. Tune the actual prompt/Skill when needed and rerun affected cases.
