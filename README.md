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

## Acceptance Criteria & Testing Verification

1. **Authentication**: First run opens Google consent and creates `token.json`.
2. **Current Inbox Classification**: When run against standard onboarding emails (e.g. Google Workspace emails), all are classified as `system_notification`, zero drafts are created, and all decisions are logged to `data/runs.jsonl`.
3. **De-duplication**: Running the script a second time detects that all messages exist in `data/processed.json` and skips re-processing.
4. **Draft Creation**: Sending an inquiry (e.g. "Hi Hector, what is your availability for a photo booth on October 12 in Irvine?") from another email account and running `npm run start` creates a professional reply draft in that email's thread, visible under Gmail's **Drafts** folder.
5. **Approval Workflow**: A created draft registers an action in `data/actions.json` under `AWAITING_APPROVAL`. `npm run approvals:list` displays it, and `npm run approvals:approve -- <actionId>` transitions it to `APPROVED` with audit events recorded in `data/action-events.jsonl`.
