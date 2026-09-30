# Pacific Horizon Ops (PHRO-001)

Agentic operations platform for Pacific Horizon Labs.

Horizon is Pacific Horizon Labs' AI operations agent, designed to assist with business communications, customer inquiries, bookings, scheduling, follow-ups, and internal workflows across connected platforms.

This prototype (`PHRO-001`) connects to Google Workspace Gmail (`hector@pacifichorizonlabs.com`), fetches recent emails, classifies each message with Claude, and drafts replies into Gmail threads when appropriate.

---

## Architecture & Guarantees

- **No Outbound Email Sending**: The system creates **drafts only** (`users.drafts.create`). There is strictly no code path calling `messages.send` or `drafts.send`. You retain full human review before any email is sent.
- **Strict Scope Boundaries**: Requests only the minimum required OAuth scopes:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.compose`
- **Policy Guardrails**: Replies are only drafted if:
  1. `requiresResponse === true`
  2. Category is neither `system_notification` nor `vendor_or_marketing`
  3. Classification confidence is `>= 0.70`
  4. Dry-run mode is disabled
- **No Hallucinated Commitments**: Grounded in `business.md`. The model is instructed to never invent rates, dates, or promises not in documentation, and must request missing information instead.
- **De-duplication**: Tracks handled messages in `data/processed.json` so rerunning the tool will not reprocess or duplicate drafts.
- **Audit Logging**: Appends full classifications and policy outcomes to `data/runs.jsonl`.

---

## Project Structure

```
pacific-horizon-ops/
├── src/
│   ├── auth.ts        # OAuth2 loopback authentication & token persistence
│   ├── gmail.ts       # Gmail thread/message fetching & reply draft creation
│   ├── classify.ts    # Claude email classification with Zod schema validation
│   └── run.ts         # Orchestration pipeline: fetch → classify → policy → draft → log
├── business.md        # Photo booth business facts & rules for Claude context
├── .env.example       # Template for environment variables
├── .gitignore         # Excludes secrets, tokens, credentials, and data/
├── package.json       # Project dependencies and npm scripts
├── tsconfig.json      # TypeScript ESM configuration
└── README.md          # Setup instructions and documentation
```

---

## Setup Guide

### 1. Google Cloud Project & Gmail API
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new Google Cloud project (e.g., `pacific-horizon-ops`).
3. In the sidebar, navigate to **APIs & Services** > **Library**.
4. Search for **Gmail API** and click **Enable**.

### 2. Configure OAuth Consent Screen
1. Navigate to **APIs & Services** > **OAuth consent screen**.
2. Select User Type: **Internal** (recommended for Google Workspace accounts, removing verification requirements and weekly token expirations).
3. Fill in the App Name (e.g. `Pacific Horizon Ops`) and your support email (`hector@pacifichorizonlabs.com`).
4. Under **Scopes**, add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
5. Save and continue.

### 3. Generate OAuth Credentials
1. Go to **APIs & Services** > **Credentials**.
2. Click **Create Credentials** > **OAuth client ID**.
3. Select Application type: **Desktop app**.
4. Name it (e.g. `Pacific Horizon Ops CLI`).
5. Download the credentials JSON file and save it in the root of this project as:
   ```
   credentials.json
   ```

### 4. Configure Environment Variables
1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and set your Anthropic API key:
   ```env
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   ANTHROPIC_MODEL=claude-sonnet-5
   GMAIL_QUERY=in:inbox newer_than:7d
   ```

### 5. Install Dependencies
```bash
npm install
```

---

## Running the Prototype

### Dry-Run Mode (Recommended First Step)
Runs the entire pipeline (fetches threads, classifies with Claude, checks policy, and logs to `data/runs.jsonl`), but **creates zero drafts**:

```bash
npm run start -- --dry-run
```

On first launch, this will:
1. Start a local loopback server on `localhost:3000`.
2. Automatically open your browser to the Google OAuth consent screen.
3. Upon approval, exchange the code for access and refresh tokens, and save them to `token.json`.
4. Subsequent runs will use and automatically refresh `token.json`.

### Live Mode
Once verified in dry-run mode, run without `--dry-run` to enable draft creation:

```bash
npm run start
```

---

## Action & Approval Engine (PHRO-002)

When live mode creates a Gmail draft, it registers a durable action record with state `AWAITING_APPROVAL`.

### Approval CLI Commands
```bash
# List all actions currently awaiting human approval
npm run approvals:list

# List all historical actions
npm run approvals:list -- --all

# Authorize an action (transitions AWAITING_APPROVAL -> APPROVED)
npm run approvals:approve -- <actionId>

# Reject an action (transitions AWAITING_APPROVAL -> REJECTED)
npm run approvals:reject -- <actionId>
```

> **Note on Safety**: Approving an action records authorization in persistent state and audit events. It **never** triggers an email send in PHRO-002.

### Running Automated Tests
```bash
npm test
```

---

## Voice Operations Agent (PHRO-003)

PHRO-003 introduces an interactive voice agent ("Horizon") built on Twilio Programmable Voice and **Twilio ConversationRelay** over WebSockets.

### Architecture

```
Twilio Voice Call
      │
      ▼
POST /voice/twiml ──────────> Returns TwiML with <Connect><ConversationRelay url="wss://.../voice/ws?sessionId=..." />
      │
      ▼
WS   /voice/ws    ──────────> Bi-directional real-time speech relay:
                               - Agent speaks greeting, summary, or exact stored draft
                               - Listens to caller intents (SUMMARY, READ_DRAFT, REPEAT, APPROVE, REJECT, HELP, END_CALL)
                               - Enforces strict two-step verbal confirmation
```

### Required Environment Variable Names

Configure these names in your `.env` file (placeholders provided in `.env.example`):
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER_E164`: Caller ID for outbound calls
- `PHRO_OWNER_PHONE_E164`: The single authorized destination number for outbound calls
- `PHRO_PUBLIC_BASE_URL`: Public HTTPS URL (e.g. `https://phro.example.com` or tunnel URL)
- `PHRO_PUBLIC_WSS_URL`: Public WSS URL (e.g. `wss://phro.example.com` or tunnel URL)
- `PHRO_VOICE_PORT`: Local server port (defaults to `3100`)
- `PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION`: (Optional development flag, defaults to `false`)

### Prerequisites (Twilio & Networking)
1. **Twilio Account & Number**: An active Twilio account with Voice capabilities and ConversationRelay enabled.
2. **HTTPS & WSS Tunnels**: Twilio requires public endpoints with valid SSL for webhook callbacks and WebSocket connections. In development, expose local port `3100` via ngrok or Cloudflare tunnel.
3. **No Call Recording**: Call recording is strictly disabled and raw audio is never persisted.

### Voice CLI Commands
```bash
# Start the HTTP/WebSocket voice server
npm run voice:serve

# Dry-run validation (checks eligibility, locks destination to owner, does NOT dial Twilio)
npm run voice:call -- <actionId> --dry-run

# Place live outbound call to owner phone regarding an AWAITING_APPROVAL action
npm run voice:call -- <actionId>

# Inspect voice sessions
npm run voice:sessions
npm run voice:sessions -- --all
```

### Voice Safeguards & Two-Step Confirmation
- **Target Lock**: Only actions in `AWAITING_APPROVAL` can be called about. Calls are strictly locked to `PHRO_OWNER_PHONE_E164`. Arbitrary numbers cannot be dialed.
- **Stored Data Fidelity**: Summary uses stored classification data; reading drafts reads the exact persisted `draftReply`. Draft text is never regenerated on the fly.
- **Two-Step Approval**: Saying "Approve" transitions the call to confirmation mode. The caller must explicitly say:
  - `"confirm approval"` or `"confirm the approval"`
  Fuzzy affirmations like `"yes"`, `"yeah"`, `"sure"`, `"okay"`, or `"do it"` are **never** accepted as confirmation.
- **Two-Step Rejection**: Rejections similarly require saying `"confirm rejection"`.
- **Fail-Closed State Check**: If an action is modified externally during a call, the voice agent aborts and will not overwrite the updated state.
- **NO EMAIL SEND**: Voice approval records `approvalSource = "voice"` and moves the action to `APPROVED`. **It does not send any email.**

---

## Safe Gmail Mailbox Cleanup (PHRO-MAIL-001)

> **IMPORTANT SAFETY NOTICE**: Pacific Rising Ops **NEVER** permanently deletes Gmail messages in PHRO-MAIL-001. All cleanup operations move messages strictly to **Gmail Trash**.

### What It Does
- **Scan & Plan Separation**: Scanning never modifies your mailbox. It produces a persisted, reviewable cleanup plan in status `REVIEW_REQUIRED`.
- **Deterministic Protection First**: Automatically protects:
  - Receipts, invoices, order confirmations, refund confirmations, shipping confirmations, delivery notices
  - Account security notices, password resets, 2FA/login verification alerts
  - Bank statements, tax forms (W-2, 1099), payroll, wire/deposit alerts
  - Government and legal correspondence
- **Sender Alone Is Not Sufficient**: Prohibits bare `from:<domain>` rules. Retailers and vendors frequently send receipts and purchase confirmations from the same domain as marketing newsletters.
- **Revalidation Guard**: Immediately before moving any approved candidate to Trash, the executor refetches live Gmail metadata and re-runs protection checks. If an email was updated or triggers protection, it is safely skipped.
- **Trash-Only Mutation**: Uses exclusively `gmail.users.messages.trash`. Permanent message removal (`messages.delete`) is completely omitted from the codebase.
- **Auditability**: Every plan is stored in `data/mailbox-cleanup-plans.json` with immutable event history in `data/mailbox-cleanup-events.jsonl`.

### What It Explicitly Does NOT Do
- Never calls Gmail permanent delete APIs (`messages.delete`, `threads.delete`).
- Never empties Gmail Trash.
- Never runs automatic or scheduled deletions.
- Never trashes messages during `scan` or `approve` commands.
- Never sends emails.

### OAuth `gmail.modify` Requirement & Manual Reauthorization
Moving messages to Trash requires the official `https://www.googleapis.com/auth/gmail.modify` scope.
The scope list in `src/auth.ts` has been updated to include `gmail.modify`.
> **Manual Action Required**: Because the existing `token.json` was issued under read and compose scopes, Hector must manually reauthorize when ready (e.g. by backing up or removing `token.json` and authenticating through the Google OAuth consent screen) before live `mailbox:execute` can move messages to Trash.

### Safe Example Commands
```bash
# 1. Scan for old promotional emails and create a reviewable plan (read-only)
npm run mailbox:scan -- --preset promotions-old

# 2. Scan social notifications or use custom queries (must include safe category filter)
npm run mailbox:scan -- --preset social-old
npm run mailbox:scan -- --query "category:promotions older_than:1y"

# 3. List all persisted cleanup plans
npm run mailbox:plans

# 4. View candidate details and protection flags for a specific plan
npm run mailbox:plan -- <planId>

# 5. Authorize an inspected plan (read-only authorization step)
npm run mailbox:approve -- <planId>

# 6. Simulate execution without touching Gmail
npm run mailbox:execute -- <planId> --dry-run

# 7. Live execution: Move authorized messages to Gmail Trash
npm run mailbox:execute -- <planId>
```

### Cleanup Plan Lifecycle
```
[SCAN] ──> CREATED ──> REVIEW_REQUIRED ──(npm run mailbox:approve)──> APPROVED ──(npm run mailbox:execute)──> EXECUTING ──> COMPLETED / FAILED
```

### Recovery & Safety Assumptions
- Messages moved to Gmail Trash remain recoverable from the Gmail Trash folder within Google's standard 30-day retention window.
- Storage impact is computed strictly from Gmail's `sizeEstimate` metadata; if size estimates are absent, storage impact is reported as unavailable rather than fabricated.

---

## Multi-Gmail Profile & OAuth Client Isolation (PHRO-MAIL-002 / PHRO-MAIL-003)

PHRO supports switching between completely isolated Gmail profiles with both token and OAuth client credential separation:
- **`business`** (default): Google Workspace business account (`@pacifichorizonlabs.com`)
- **`personal`**: Personal Google account (`@gmail.com`)

### Conceptual Layout

```
Business profile:
  credentials.business.json
  token.business.json

Personal profile:
  credentials.personal.json
  token.personal.json

Legacy business compatibility:
  credentials.json
  token.json
```

### Profile Selection & Configuration

Profile selection is explicit and controlled via the `PHRO_GMAIL_PROFILE` environment variable. If unspecified, it safely defaults to `business`.

```bash
# Explicit business profile run
PHRO_GMAIL_PROFILE=business npm run mailbox:scan -- --query "category:promotions"

# Explicit personal profile run
PHRO_GMAIL_PROFILE=personal npm run mailbox:scan -- --query "category:promotions"

# Default behavior (uses business profile)
npm run mailbox:scan -- --query "category:promotions"
```

> **Security & Explicit Selection**: PHRO will **never** automatically switch profiles based on email addresses. Profile selection must always be explicit. Only profile names, credential filenames, and token filenames are logged; secret tokens and credential contents are never logged or exposed.

### Credential & Token Isolation Rules

Each profile resolves both its OAuth client credentials and stored OAuth tokens independently:

1. **Business Profile (`business`)**:
   - **Credentials**: Resolves `credentials.business.json` if present; falls back to legacy `credentials.json` if absent. Fails with a clear setup error if neither exists.
   - **Tokens**: Resolves `token.business.json` if present; falls back to legacy `token.json` if absent.
2. **Personal Profile (`personal`)**:
   - **Credentials**: Resolves `credentials.personal.json` only. If absent, immediately halts before initiating any OAuth flow and instructs Hector to download a Desktop OAuth client from a GCP project configured for an External audience.
   - **Tokens**: Resolves `token.personal.json` only.
   - **STRICT ISOLATION**: `personal` profile **NEVER** falls back to `credentials.json`, `credentials.business.json`, `token.json`, or `token.business.json`.
3. **Git & File Protection**:
   - All credential and token files are untracked via `.gitignore`:
     - `credentials.json`
     - `credentials.*.json`
     - `token.json`
     - `token*.json`
   - Token files are saved with POSIX permissions `0600` (`chmod 600`).
   - Never commit either credentials or tokens to Git.

### Google Cloud OAuth Client Setup (Internal vs External)

- **Existing Business Client**: The Pacific Horizon Labs Google Cloud OAuth client in `credentials.json` (or `credentials.business.json`) is configured for an **Internal** user audience. It is strictly limited to `@pacifichorizonlabs.com` Workspace users and remains business-only.
- **Personal Gmail Client**: Personal consumer `@gmail.com` accounts cannot authenticate against an Internal OAuth client. Personal Gmail requires a separate Google Cloud OAuth client configured for an **External** audience (e.g. in "Testing" mode with your personal Gmail added to "Test Users").
- The downloaded Desktop OAuth Client JSON for that personal project is saved locally in the project root as:
  ```
  credentials.personal.json
  ```
- Once `credentials.personal.json` is in place, running any command with `PHRO_GMAIL_PROFILE=personal` will initiate the loopback OAuth flow using the personal OAuth client and save tokens strictly to `token.personal.json`.

### OAuth Account Selection & Identity Binding Guards (PHRO-MAIL-004)

To prevent accidental authentication of an unintended Google account when multiple accounts are logged into the browser:

1. **Explicit Account Selection Prompt**:
   First-time and manual authorization URLs strictly specify:
   ```
   prompt=select_account consent
   ```
   This forces Google to display the account picker rather than automatically using an existing signed-in Google session.

2. **Expected Account Binding (`.env`)**:
   You can optionally configure the expected email address for each profile in `.env`:
   ```env
   PHRO_GMAIL_BUSINESS_ACCOUNT=hector@pacifichorizonlabs.com
   PHRO_GMAIL_PERSONAL_ACCOUNT=your_personal_email@gmail.com
   ```
   - When configured, PHRO verifies the authenticated identity via `users.getProfile('me')` **before** persisting tokens.
   - If an account mismatch is detected, authorization is refused, no tokens are saved, and zero mutations occur.
   - If left blank, PHRO preserves backward compatibility while logging that identity enforcement is unset.

3. **Cleanup Plan & Execution Binding**:
   - Every cleanup plan permanently records both its originating `gmailProfile` (`business` or `personal`) and its authenticated `gmailAccount`.
   - Before executing any plan (both in `--dry-run` and live mode), the executor verifies:
     `plan.gmailProfile === activeProfile` AND `plan.gmailAccount === authenticatedAccount`.
   - Historical or legacy plans lacking `gmailProfile` are blocked from execution to guarantee safety. Mismatches generate audit log events and block all trash mutations.

---

## Acceptance Criteria & Testing Verification

1. **Authentication**: First run opens Google consent and creates `token.json`.
2. **Current Inbox Classification**: When run against standard onboarding emails, all are classified as `system_notification`, zero drafts are created, and all decisions are logged to `data/runs.jsonl`.
3. **De-duplication**: Running the script a second time detects that all messages exist in `data/processed.json` and skips re-processing.
4. **Draft Creation**: Sending an inquiry from another email account creates a reply draft in that email's thread, visible under Gmail's **Drafts** folder.
5. **Approval Workflow**: A created draft registers an action in `data/actions.json` under `AWAITING_APPROVAL`. `npm run approvals:list` displays it, and `npm run approvals:approve -- <actionId>` transitions it to `APPROVED` with audit events recorded in `data/action-events.jsonl`.
6. **Voice Operations**: `npm run voice:call -- <actionId> --dry-run` validates eligibility and safeguards. In live mode, outbound call connects via ConversationRelay, reads the exact draft, and enforces two-step `"confirm approval"` phrase matching without sending email.
7. **Safe Mailbox Cleanup**: `npm run mailbox:scan` identifies candidates without modifying Gmail. Receipt, order, security, and financial emails are strictly excluded. `npm run mailbox:approve` approves plans. `npm run mailbox:execute` re-checks protection before moving approved messages to Gmail Trash. No permanent delete API exists.
