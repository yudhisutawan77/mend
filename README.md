# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yudhisutawan77/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yudhisutawan77/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — join make.fun with referral code `f8xqdby0` (https://make.fun/r/f8xqdby0).

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and this one tool reads them all: a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. Each format is read as `SPEC.md` says, and
every file is changed or nothing is.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`, or `auto` (the default), which detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; there is nothing to install.

## How it works

- **Matching (SPEC section 5).** Old lines are found at the first of three
  tiers that has a match: exact, trailing whitespace ignored, then leading
  and trailing whitespace ignored. At tier 2 the new lines are re-indented
  to the file's own indentation, and context lines are always written as
  the file's own matched lines, never the patch's.
- **Unified diffs (section 6).** Sections from `diff --git` or `---`/`+++`
  pairs; hunks take the occurrence nearest their (often wrong) line number,
  create/delete/move/change kinds, and `\ No newline at end of file`
  handling for the final line break.
- **SEARCH/REPLACE (section 7).** Blocks with their path on the nearest
  non-blank, non-fence line above them; the old lines must occur exactly
  once.
- **V4A (section 8).** Add/Delete/Update sections with anchors, a cursor
  that walks the file in order, `*** End of File` chunks and `*** Move to:`.
- **JSON (section 9).** One array or JSON Lines of `create`, `str_replace`
  and `insert` edits, including CRLF files.
- **Order and atomicity (section 10).** Edits apply in patch order to the
  tree as earlier edits left it; a failed edit changes nothing, the edits
  after it still run, and when any edit failed no file is written.

## Exit codes and output

- Exit 2, one line: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>`.
- Exit 1: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`; no file is written.
- Exit 0: one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>`
  for a move), in byte order, then `ok: <n> files`.

## Files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh
  directory, and posts what it did.
- `SPEC.md`: the specification (in the kit; the contract this tool follows).
- `LICENSE`: MIT.
