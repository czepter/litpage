# CLAUDE.md

## Branch names

Format: `<type>/<short-topic>`, kebab-case, in English.

- Types: `feat/`, `fix/`, `refactor/`, `perf/`, `docs/`, `test/`, `ci/`, `chore/`.
  Examples: `feat/spam-check-enquiries`, `fix/release-tag-trigger`.
- Not allowed: a `claude/` prefix or a random hash on the end.
- Sessions start on an app-named branch (`claude/<slug>-<hash>`). Before the first commit or push, rename it with
  `git branch -m <type>/<topic>`.
- A stacked PR uses the renamed parent branch as its base.
