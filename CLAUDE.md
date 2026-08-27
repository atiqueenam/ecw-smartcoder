# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Tampermonkey userscript system that runs inside eClinicalWorks (eCW), a medical EHR web app. It has two layers:

- **Loader** (`loader/SmartCoder-Loader.user.js`) — the one script users actually install. It picks a client, downloads and verifies that client's script from GitHub, caches it, and runs it.
- **Clients** (`clients/<id>/smartcoder.js`) — one large, fully independent userscript per clinic that implements the real feature: an automated medical coding/billing assistant (CPT/ICD suggestion, add/delete, insurance-specific rules, patient history scraping, etc.) driven by DOM scraping of eCW pages.

There is no build step, package manager, or test suite. Plain Node.js (ESM) is used only for `tools/build-registry.mjs`.

## Commands

Regenerate `registry/clients.json` after adding/editing a client (must be run from the repo root — paths are relative to `process.cwd()`):

```
node tools/build-registry.mjs
```

This is also run automatically by `.github/workflows/update-registry.yml` on any push to `main`/`dev` touching `clients/**`, and it commits the regenerated `registry/clients.json` back to the branch. CI uses Node 24.

There is no lint/test/build command in this repo — validation happens inside `build-registry.mjs` (schema checks + `new Function(...)` syntax check on each client script) and inside the loader itself at runtime (registry schema validation, SHA-256 verification).

## Architecture

### Loader (`loader/SmartCoder-Loader.user.js`)

- Runs at `document-start` on eCW hostnames (`@match` covers `eclinicalworks.com`, `ecwcloud.com`, `eclinicalweb.com`), waits until the app is authenticated (no visible password field) before doing anything.
- Downloads `registry/clients.json` from `REPOSITORY_RAW` (a raw.githubusercontent.com URL) via `GM_xmlhttpRequest`, validates its shape (`validateRegistry`), and caches it in `localStorage`.
- Resolves which client to run: explicit user selection > auto-detect by current hostname against each client's `hostnames` in the registry.
- Downloads that client's `smartcoder.js`, verifies its SHA-256 against the checksum recorded in the registry (`obtainClientScript`), and only then executes it via `new Function(...)` bound to `unsafeWindow`. Falls back to the last verified cached script if GitHub is unreachable.
- A registry/script refetch happens on an actual browser reload (detected via the Navigation Timing API) or when the user clicks the injected "check updates" control; plain SPA navigation reuses the cached registry/script.
- Injects UI into eCW's own page header (`#ecsHeader`): a client picker dropdown and a "check updates and reload" button, re-applied via `MutationObserver` since eCW re-renders its header.
- The root-level `SmartCoder-Loader.user.js` is a duplicate of `loader/SmartCoder-Loader.user.js` — keep both in sync (or find out why the duplicate exists) when editing the loader.
- **Branch mismatch to be aware of**: the userscript's own Tampermonkey `@updateURL` (self-update) points at the `main` branch raw URL, but the in-code `REPOSITORY_RAW` constant that the loader uses to fetch the registry and client scripts points at `dev`. Confirm which branch is actually intended before changing either.

### Registry (`registry/clients.json`)

Generated output, not hand-edited. `tools/build-registry.mjs` walks `clients/*/client.json`, validates each (id matches folder name; unique id/siteId/hostnames; valid hostname syntax; `entry` is a `.js` filename), reads and syntax-checks the referenced script, computes its SHA-256, and writes the sorted, schema-versioned registry. The loader independently re-validates this same schema before trusting it.

### Clients (`clients/<id>/`)

Each folder is:
- `client.json` — `{ id, name, siteId, hostnames[], version, entry, enabled }`. `id` must equal the folder name and match `^[a-z0-9-]+$`; disabling a client (`"enabled": false`) removes it from the generated registry without deleting its files.
- `smartcoder.js` — a self-contained ~6,000–7,500 line Tampermonkey userscript for one clinic. Each file starts with a dense, chronological `CHANGELOG` comment block (version, date, one-line-per-fix) — when editing a client script, add a new entry there rather than deleting history.

**Clients do not share code.** There is no common library — fixes for generic (non-client-specific) bugs are manually ported and re-implemented across every `clients/*/smartcoder.js` file independently. Changelog entries frequently cross-reference this, e.g. "Same fix: Hasan 1.68, Getwell 5.31". When making a change that isn't a client-specific business rule, check whether the same fix is needed in the other client files, and note the cross-reference in each changelog when you port it.

Within a client script, recurring concerns include: parsing patient/encounter HTML fetched from eCW's own pages (`parseHtml`, `parseAssessments`, `parseCodeContainer`, etc.), per-payer/insurance business rules (Medicaid/Medicare/UHC/Empire/etc. detection and code eligibility), and DOM automation for adding/deleting ICD/CPT rows with retry logic for eCW's own UI lag.

## Adding, updating, or removing a client

(See `README.md` for the full walkthrough.) In short: copy a client folder under `clients/<new-id>/`, add `smartcoder.js` and a `client.json` with a unique `id`/`siteId`/hostnames, commit to `main` — the workflow regenerates `registry/clients.json` automatically. To update a client, bump its `client.json` `version` in the same commit as the script change (the registry rebuild and cache-busting depend on the version/checksum changing). To remove one from the dropdown without deleting it, set `"enabled": false`.

## Security/privacy constraints

This is a public repository.
- Never commit patient data (PHI), passwords, cookies, access tokens, or private keys — including inside test fixtures, changelog comments, or commit messages.
- The loader's SHA-256 verification is the only thing standing between this repo and arbitrary code execution inside a live EHR session — do not weaken or bypass it (e.g. don't add a way to load unverified scripts) when touching the loader.


## Primary Working Style

Act like a normal conversational coding assistant with direct access to this repository.

My preferred workflow is similar to using Claude chat with a GitHub repository attached:

1. I describe a problem, feature, or change.
2. Understand my request using the current conversation and only the relevant project files.
3. Discuss or explain the solution when discussion is needed.
4. When I explicitly ask to implement, update, change, fix, add, remove, or replace something, edit the appropriate project files directly.
5. After implementation, briefly tell me what changed.

Do not turn ordinary requests into large autonomous repository investigations.

---

## Token and Context Efficiency — HIGH PRIORITY

Minimize unnecessary token and context usage.

- Do NOT scan or analyze the entire repository for every request.
- Do NOT read unrelated files.
- Do NOT repeatedly read files that have already been inspected and have not changed.
- Use targeted searches to locate relevant code.
- Once the relevant implementation is found, focus on those files.
- Do not investigate unrelated functionality.
- Do not perform repository-wide analysis unless the task genuinely requires it.
- Do not load large files unnecessarily.
- Do not inspect generated files, dependencies, build output, or vendor code unless required.
- Avoid unnecessary tool calls.
- Avoid unnecessary command execution.
- Do not run tests, builds, linters, or other commands automatically unless they are needed to validate a change.
- Do not use extensive exploration just to provide a simple answer.
- Prefer the smallest amount of context necessary to complete the task correctly.

If sufficient information is already available in the conversation or currently inspected files, use it instead of searching for more context.

---

## Chat Behavior

For normal questions, behave like Claude chat.

If I ask:
- how something works
- whether something is possible
- for an explanation
- for an opinion about an implementation
- what should be changed
- where something is located

Answer the question directly.

Do NOT modify code merely because we are discussing code.

Do NOT start an implementation unless my request clearly asks for a change.

Keep normal answers concise unless I ask for detailed analysis.

---

## Implementation Behavior

When I explicitly request a code change:

- Modify the actual project files directly.
- Find the existing implementation before creating new code.
- Make the smallest changes necessary.
- Preserve existing architecture and behavior unless the requested change requires otherwise.
- Prefer modifying existing code over creating unnecessary new files or duplicate implementations.
- Do not rewrite entire files when a targeted change is sufficient.
- Do not refactor unrelated code.
- Do not rename or reorganize unrelated files.
- Do not change formatting across unrelated sections.
- Do not add dependencies unless genuinely necessary.
- Do not change configuration unrelated to the requested feature.
- Follow the coding style and patterns already used by the project.

If replacing existing logic, replace/update the appropriate implementation rather than leaving old and new implementations active simultaneously.

---

## Preserve Existing Functionality

Existing working functionality should remain unchanged unless I explicitly request otherwise.

Before changing shared logic:

- Consider whether other functionality depends on it.
- Avoid regressions.
- Preserve existing interfaces when practical.
- Do not remove existing behavior simply because a cleaner implementation is possible.

A feature request is NOT permission to redesign unrelated parts of the system.

---

## Repository Exploration

Start with the most likely relevant files.

Use filenames, imports, function names, identifiers, and targeted searches to locate the implementation.

Do NOT begin every task by recursively reading the repository.

Expand the investigation only when the initially relevant files are insufficient.

Ignore directories such as these unless specifically needed:

- node_modules
- dist
- build
- coverage
- vendor
- .git
- generated output

If the repository is already understood from the current session, reuse that understanding instead of rediscovering the architecture.

---

## Handling Uncertainty

Do not guess about important project behavior.

If there are multiple possible implementations:

1. Inspect the smallest amount of relevant code needed to resolve the uncertainty.
2. If the decision still depends on my preference, ask me.
3. Do not explore unrelated parts of the repository hoping to find additional context.

If a requested change could significantly alter existing behavior, explain the concern before making a destructive change.

---

## Commands and Tools

Use terminal commands only when they provide meaningful value.

Good reasons include:
- locating relevant code
- checking syntax
- running a targeted test
- validating an implementation
- checking a specific build issue

Avoid commands that provide information already available.

Do not automatically run large test suites or builds after every small modification.

When validation is useful, prefer the smallest relevant validation first.

---

## Git Behavior

Do NOT automatically:

- commit
- push
- pull
- merge
- rebase
- reset
- checkout another branch
- create branches
- delete branches
- modify remote repositories

unless I explicitly ask.

I will normally review changes and handle Git operations myself.

You may use read-only Git commands such as `git diff` or `git status` when useful.

Never discard my uncommitted changes.

---

## After Making Changes

Do not provide a long report.

Give me a concise summary containing:

- what was changed
- which important files were changed
- anything I should manually test or verify

Do not paste entire modified files into chat unless I ask.

The files have already been modified directly, so repeating all of the code in the conversation wastes context.

---

## General Principle

Use the repository as contextual knowledge, not as something that must be completely re-analyzed for every message.

The desired experience is:

Normal Claude conversation
→ understand the request
→ inspect only relevant code when necessary
→ discuss when appropriate
→ directly implement when requested
→ concise summary

NOT:

Every request
→ scan repository
→ read many files
→ run many commands
→ perform broad analysis
→ consume unnecessary context
→ make unrelated changes

Optimize for correctness, minimal changes, and efficient context usage.
