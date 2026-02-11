# Lessons Learned

## 2026-02-11: Credential Leak in Git Commit

### What Happened
- `tasks/PROJE_RAPORU.md` was committed and pushed to GitHub with:
  - Coolify API token
  - Metabase admin password
  - Supabase PostgreSQL password
  - Server IP addresses with credentials

### Root Cause
- Report file was written as a "local reference document" but treated as a normal git file
- No pre-commit scan for secrets was performed
- .gitignore was minimal (only `*.xz`)
- No CLAUDE.md rule existed to prevent this

### Fix Applied
1. Commit was immediately reverted and pushed
2. Report was rewritten with all credentials replaced by placeholders
3. CLAUDE.md updated with mandatory pre-commit secret scanning rules
4. .gitignore expanded to cover common secret file patterns

### Prevention Rule
**BEFORE EVERY `git add` or `git commit`:**
Scan all staged files for passwords, tokens, API keys, private keys, and connection strings.
If found, redact and replace with `<PLACEHOLDER>` descriptions.

### Credentials to Rotate
- Coolify API token (exposed briefly on public GitHub)
- Metabase admin password
- Supabase PG password (consider rotating)
