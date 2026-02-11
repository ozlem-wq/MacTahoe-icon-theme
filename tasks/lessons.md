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
3. Git history fully cleaned with `git reset --soft` + `git push --force-with-lease` (sensitive commit permanently removed from remote)
4. CLAUDE.md updated with mandatory pre-commit secret scanning rules
5. .gitignore expanded to cover common secret file patterns

### Prevention Rule
**BEFORE EVERY `git add` or `git commit`:**
Scan all staged files for passwords, tokens, API keys, private keys, and connection strings.
If found, redact and replace with `<PLACEHOLDER>` descriptions.

### Credentials Rotation Status
- Metabase admin password: **ROTATED** (new password set via Metabase API)
- Coolify API token: **NOT ROTATED** (requires manual creation via Coolify Dashboard)
- Supabase PG password: **NOT ROTATED** (reverted after failed attempts - Supabase uses 15+ PG users sharing one env var, changing one breaks others)

---

## 2026-02-11: Supabase PG Password Rotation Failure

### What Happened
Two attempts to rotate the Supabase PostgreSQL password both failed and were reverted:

**Attempt 1**: Changed `SERVICE_PASSWORD_POSTGRES` env var in Coolify
- Result: Supabase crashed because PG data volume still had old password
- Fix: Reverted env var, restarted

**Attempt 2**: Used ALTER USER via Metabase SQL + updated env var
- Result: Only `postgres` user password changed, but `supabase_admin`, `authenticator`, `supabase_auth_admin` still had old password
- Supabase-analytics and dependent services failed
- Fix: Reverted env var, stop/start cycle, full recovery

### Root Cause
Supabase architecture uses a single `SERVICE_PASSWORD_POSTGRES` env var for multiple PG users. Changing the password requires:
1. SSH access to the server
2. ALTER USER on ALL PG users simultaneously
3. Update Coolify env var
4. Restart all Supabase services

### Lesson
Never attempt partial password rotation on Supabase. Either rotate all PG users at once (via SSH + psql) or don't rotate at all.

---

## 2026-02-11: Coolify Docker Network Isolation

### What Happened
Metabase deployed on server 0 (localhost) couldn't reach Supabase PG on server 1 (cx33).

### Root Cause
Coolify places services on different "servers" into completely isolated Docker networks. Adding `external` network declarations to docker-compose is overridden by Coolify during deployment.

### Fix
Deploy both services on the same Coolify server and enable `connect_to_docker_network: true`.

### Lesson
When services need to communicate via Docker internal networking in Coolify, they **must** be on the same server with `connect_to_docker_network: true` enabled.

---

## 2026-02-11: Coolify docker_compose_raw Requires Base64

### What Happened
Sending raw YAML in the `docker_compose_raw` field of `POST /api/v1/services` caused a validation error.

### Fix
Base64 encode the YAML content before sending it in the API request.

### Lesson
Coolify API v4 expects `docker_compose_raw` to be base64 encoded, not raw YAML.
