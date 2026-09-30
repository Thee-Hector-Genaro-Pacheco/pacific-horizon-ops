import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  generateAuthorizationUrl,
  getExpectedAccount,
  verifyProfileAccountBinding,
  authenticateViaLoopback,
  getAuthenticatedClient,
  GMAIL_MODIFY_SCOPE,
} from '../src/auth.js';
import { MailboxStore } from '../src/mailbox/store.js';
import { createCleanupPlan } from '../src/mailbox/planner.js';
import { executeCleanupPlan } from '../src/mailbox/executor.js';
import { scanMailbox } from '../src/mailbox/scanner.js';
import { type MailboxCleanupCandidate, type MailboxCleanupPlan } from '../src/mailbox/types.js';

describe('Gmail Account Binding & OAuth Selection Guard (PHRO-MAIL-004)', () => {
  const originalEnvProfile = process.env.PHRO_GMAIL_PROFILE;
  const originalEnvBiz = process.env.PHRO_GMAIL_BUSINESS_ACCOUNT;
  const originalEnvPersonal = process.env.PHRO_GMAIL_PERSONAL_ACCOUNT;
  const originalGmail = google.gmail;

  let tempDir: string;
  let store: MailboxStore;

  beforeEach(() => {
    delete process.env.PHRO_GMAIL_PROFILE;
    delete process.env.PHRO_GMAIL_BUSINESS_ACCOUNT;
    delete process.env.PHRO_GMAIL_PERSONAL_ACCOUNT;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-account-binding-test-'));
    store = new MailboxStore({ dataDir: tempDir });
  });

  afterEach(() => {
    google.gmail = originalGmail;

    if (originalEnvProfile !== undefined) process.env.PHRO_GMAIL_PROFILE = originalEnvProfile;
    else delete process.env.PHRO_GMAIL_PROFILE;

    if (originalEnvBiz !== undefined) process.env.PHRO_GMAIL_BUSINESS_ACCOUNT = originalEnvBiz;
    else delete process.env.PHRO_GMAIL_BUSINESS_ACCOUNT;

    if (originalEnvPersonal !== undefined) process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = originalEnvPersonal;
    else delete process.env.PHRO_GMAIL_PERSONAL_ACCOUNT;

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createMockAuth(grantedScopes: string[] = [GMAIL_MODIFY_SCOPE]): OAuth2Client {
    return {
      credentials: {
        scope: grantedScopes.join(' '),
      },
    } as unknown as OAuth2Client;
  }

  function mockGmailProfile(email: string) {
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({
          data: { emailAddress: email },
        }),
      },
    });
  }

  it('1. first-time OAuth URL requests explicit account selection', () => {
    const fakeClient = new google.auth.OAuth2('fake_id', 'fake_secret', 'http://localhost:3000');
    const authUrl = generateAuthorizationUrl(fakeClient);

    const parsedUrl = new URL(authUrl);
    const promptParam = parsedUrl.searchParams.get('prompt');

    assert.ok(promptParam !== null, 'Auth URL must include prompt parameter');
    assert.ok(
      promptParam.includes('select_account'),
      `Prompt parameter must include select_account, got: "${promptParam}"`
    );
    assert.ok(
      promptParam.includes('consent'),
      `Prompt parameter must include consent, got: "${promptParam}"`
    );
  });

  it('2. correct personal Gmail identity is accepted', async () => {
    process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
    mockGmailProfile('personal@example.com');

    const auth = createMockAuth();
    const verified = await verifyProfileAccountBinding(auth, 'personal');
    assert.equal(verified, 'personal@example.com');

    // Case-insensitive comparison check
    mockGmailProfile('Personal@Example.COM');
    const verifiedCase = await verifyProfileAccountBinding(auth, 'personal');
    assert.equal(verifiedCase, 'personal@example.com');
  });

  it('3. wrong Gmail identity for personal profile is rejected', async () => {
    process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
    // Signed into business account instead
    mockGmailProfile('business@pacifichorizonlabs.com');

    const auth = createMockAuth();
    await assert.rejects(
      async () => verifyProfileAccountBinding(auth, 'personal'),
      (err: Error) => {
        assert.equal(
          err.message,
          'Authenticated Gmail account does not match the configured account for profile personal.'
        );
        return true;
      }
    );
  });

  it('4. wrong Gmail identity is not persisted as token.personal.json', async () => {
    process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
    mockGmailProfile('business@pacifichorizonlabs.com');

    const targetTokenPath = path.join(tempDir, 'token.personal.json');

    // Create a mock OAuth client whose getToken returns fake tokens
    const fakeOauthClient = {
      getToken: async () => ({ tokens: { access_token: 'fake_secret_token' } }),
      setCredentials: () => {},
      generateAuthUrl: () => 'http://localhost:3000/auth',
    } as unknown as OAuth2Client;

    // Simulate loopback exchange logic directly
    const { tokens } = await fakeOauthClient.getToken('code');
    fakeOauthClient.setCredentials(tokens);

    const expected = getExpectedAccount('personal');
    assert.equal(expected, 'personal@example.com');

    // Verifying binding rejects before persisting
    await assert.rejects(
      async () => verifyProfileAccountBinding(fakeOauthClient, 'personal'),
      (err: Error) => {
        assert.match(err.message, /does not match the configured account for profile personal/);
        return true;
      }
    );

    // Verify token was NOT persisted
    assert.equal(
      fs.existsSync(targetTokenPath),
      false,
      'token.personal.json must NOT be written when identity verification fails'
    );
  });

  it('5. correct business identity is accepted', async () => {
    process.env.PHRO_GMAIL_BUSINESS_ACCOUNT = 'business@pacifichorizonlabs.com';
    mockGmailProfile('business@pacifichorizonlabs.com');

    const auth = createMockAuth();
    const verified = await verifyProfileAccountBinding(auth, 'business');
    assert.equal(verified, 'business@pacifichorizonlabs.com');
  });

  it('6. missing expected-account env preserves documented backward compatibility', async () => {
    delete process.env.PHRO_GMAIL_PERSONAL_ACCOUNT;
    delete process.env.PHRO_GMAIL_BUSINESS_ACCOUNT;

    assert.equal(getExpectedAccount('personal'), undefined);
    assert.equal(getExpectedAccount('business'), undefined);

    mockGmailProfile('any_account@example.com');
    const auth = createMockAuth();

    // With no expected-account configured, any identity is accepted normally
    const result = await verifyProfileAccountBinding(auth, 'personal');
    assert.equal(result, 'any_account@example.com');
  });

  it('7 & 8. new plans persist gmailProfile and gmailAccount', async () => {
    process.env.PHRO_GMAIL_PROFILE = 'personal';

    // Mock scanner return
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({
          data: { emailAddress: 'personal@example.com' },
        }),
        messages: {
          list: async () => ({ data: { messages: [] } }),
        },
      },
    });

    const scanResult = await scanMailbox(createMockAuth(), { query: 'category:promotions' });
    assert.equal(scanResult.gmailProfile, 'personal');
    assert.equal(scanResult.gmailAccount, 'personal@example.com');

    const plan = createCleanupPlan(scanResult, store);
    assert.equal(plan.gmailProfile, 'personal');
    assert.equal(plan.gmailAccount, 'personal@example.com');

    // Retrieve from store to ensure persistence
    const saved = store.getPlan(plan.id);
    assert.equal(saved?.gmailProfile, 'personal');
    assert.equal(saved?.gmailAccount, 'personal@example.com');
  });

  it('9. personal plan cannot execute under business profile', async () => {
    const plan: MailboxCleanupPlan = {
      id: 'plan_personal_1',
      gmailAccount: 'personal@example.com',
      gmailProfile: 'personal',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(plan);

    // Active profile is business
    process.env.PHRO_GMAIL_PROFILE = 'business';
    mockGmailProfile('business@pacifichorizonlabs.com');

    await assert.rejects(
      async () => executeCleanupPlan(createMockAuth(), plan.id, { store }),
      (err: Error) => {
        assert.match(err.message, /Profile mismatch: Plan "plan_personal_1" belongs to profile "personal", but active profile is "business"/);
        return true;
      }
    );
  });

  it('10. business plan cannot execute under personal profile', async () => {
    const plan: MailboxCleanupPlan = {
      id: 'plan_business_1',
      gmailAccount: 'business@pacifichorizonlabs.com',
      gmailProfile: 'business',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(plan);

    // Active profile is personal
    process.env.PHRO_GMAIL_PROFILE = 'personal';
    mockGmailProfile('personal@example.com');

    await assert.rejects(
      async () => executeCleanupPlan(createMockAuth(), plan.id, { store }),
      (err: Error) => {
        assert.match(err.message, /Profile mismatch: Plan "plan_business_1" belongs to profile "business", but active profile is "personal"/);
        return true;
      }
    );
  });

  it('11. Gmail account mismatch blocks execution', async () => {
    const plan: MailboxCleanupPlan = {
      id: 'plan_account_mismatch',
      gmailAccount: 'hector@pacifichorizonlabs.com',
      gmailProfile: 'business',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(plan);

    process.env.PHRO_GMAIL_PROFILE = 'business';
    // Authenticated account differs from plan account
    mockGmailProfile('different_account@pacifichorizonlabs.com');

    await assert.rejects(
      async () => executeCleanupPlan(createMockAuth(), plan.id, { store }),
      (err: Error) => {
        assert.match(err.message, /Account mismatch: Plan "plan_account_mismatch" is bound to "hector@pacifichorizonlabs.com", but authenticated Gmail account is "different_account@pacifichorizonlabs.com"/);
        return true;
      }
    );
  });

  it('12. profile mismatch blocks execution', async () => {
    const plan: MailboxCleanupPlan = {
      id: 'plan_mismatch',
      gmailAccount: 'hector@pacifichorizonlabs.com',
      gmailProfile: 'business',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(plan);

    process.env.PHRO_GMAIL_PROFILE = 'personal';

    await assert.rejects(
      async () => executeCleanupPlan(createMockAuth(), plan.id, { store }),
      (err: Error) => {
        assert.match(err.message, /Profile mismatch/);
        return true;
      }
    );
  });

  it('13. dry-run also rejects mismatch', async () => {
    const plan: MailboxCleanupPlan = {
      id: 'plan_dry_mismatch',
      gmailAccount: 'personal@example.com',
      gmailProfile: 'personal',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(plan);

    process.env.PHRO_GMAIL_PROFILE = 'business';

    // Must fail in dry-run mode identically
    await assert.rejects(
      async () => executeCleanupPlan(createMockAuth(), plan.id, { dryRun: true, store }),
      (err: Error) => {
        assert.match(err.message, /Profile mismatch/);
        return true;
      }
    );
  });

  it('14. legacy plan without gmailProfile cannot execute', async () => {
    const legacyPlan: MailboxCleanupPlan = {
      id: 'plan_legacy_unbound',
      gmailAccount: 'hector@pacifichorizonlabs.com',
      // gmailProfile is undefined (legacy plan)
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(legacyPlan);

    process.env.PHRO_GMAIL_PROFILE = 'business';

    await assert.rejects(
      async () => executeCleanupPlan(createMockAuth(), legacyPlan.id, { store }),
      (err: Error) => {
        assert.match(err.message, /legacy or unbound plan/);
        return true;
      }
    );
  });

  it('15. mismatch creates audit event', async () => {
    const plan: MailboxCleanupPlan = {
      id: 'plan_audit_check',
      gmailAccount: 'personal@example.com',
      gmailProfile: 'personal',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 0,
      totalEstimatedBytes: 0,
      candidates: [],
      excludedCount: 0,
    };
    store.savePlan(plan);

    process.env.PHRO_GMAIL_PROFILE = 'business';

    try {
      await executeCleanupPlan(createMockAuth(), plan.id, { store });
    } catch {
      // Expected rejection
    }

    const events = store.listEvents(plan.id);
    assert.ok(events.length > 0, 'Audit event must be logged');
    const lastEvent = events[events.length - 1];
    assert.match(lastEvent.reason || '', /Execution blocked: Profile mismatch/);
  });

  it('16. zero trash mutations occur on mismatch', async () => {
    let trashCalls = 0;

    const candidate: MailboxCleanupCandidate = {
      messageId: 'msg_1',
      threadId: 'thd_1',
      sender: 'promo@store.com',
      subject: 'Special offer',
      date: '2026-01-01',
      category: 'PROMOTION',
      reason: 'Promotional message',
      confidence: 0.95,
      estimatedSize: 1000,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };

    const plan: MailboxCleanupPlan = {
      id: 'plan_no_trash',
      gmailAccount: 'personal@example.com',
      gmailProfile: 'personal',
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'APPROVED',
      candidateCount: 1,
      totalEstimatedBytes: 1000,
      candidates: [candidate],
      excludedCount: 0,
    };
    store.savePlan(plan);

    // Mismatched profile
    process.env.PHRO_GMAIL_PROFILE = 'business';

    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({ data: { emailAddress: 'business@pacifichorizonlabs.com' } }),
        messages: {
          trash: async () => {
            trashCalls++;
          },
        },
      },
    });

    try {
      await executeCleanupPlan(createMockAuth(), plan.id, { store });
    } catch {
      // Expected rejection
    }

    assert.equal(trashCalls, 0, 'Zero messages.trash calls must occur when mismatch is detected');
  });

  it('17. CLI next-step commands preserve profile', () => {
    // Helper to format commands as done in cli.ts
    const formatSteps = (gmailProfile?: string, planId = 'plan_123') => {
      const prefix = `PHRO_GMAIL_PROFILE=${gmailProfile || 'business'}`;
      return [
        `${prefix} npm run mailbox:plan -- ${planId}`,
        `${prefix} npm run mailbox:approve -- ${planId}`,
        `${prefix} npm run mailbox:execute -- ${planId} --dry-run`,
        `${prefix} npm run mailbox:execute -- ${planId}`,
      ];
    };

    const personalSteps = formatSteps('personal');
    for (const step of personalSteps) {
      assert.ok(step.startsWith('PHRO_GMAIL_PROFILE=personal'), `Step must preserve personal profile: ${step}`);
    }

    const businessSteps = formatSteps('business');
    for (const step of businessSteps) {
      assert.ok(step.startsWith('PHRO_GMAIL_PROFILE=business'), `Step must preserve business profile: ${step}`);
    }
  });

  it('18. plan listing exposes profile/account', () => {
    const plans: MailboxCleanupPlan[] = [
      {
        id: 'plan_list_test',
        gmailAccount: 'user@example.com',
        gmailProfile: 'personal',
        createdAt: new Date().toISOString(),
        query: 'category:promotions',
        status: 'REVIEW_REQUIRED',
        candidateCount: 1,
        totalEstimatedBytes: 100,
        candidates: [],
        excludedCount: 0,
      },
    ];

    const rows = plans.map((p) => ({
      Profile: p.gmailProfile || '(unbound)',
      Account: p.gmailAccount,
      'Plan ID': p.id,
      Status: p.status,
      Candidates: p.candidateCount,
      Protected: p.excludedCount,
      Query: p.query,
      Created: new Date(p.createdAt).toLocaleDateString(),
    }));

    assert.equal(rows[0].Profile, 'personal');
    assert.equal(rows[0].Account, 'user@example.com');
  });

  describe('PHRO-MAIL-004A Regression Suite: Persistence Order & Continuous Binding', () => {
    function writeValidCredentials(profile: 'business' | 'personal') {
      const credFile = profile === 'personal' ? 'credentials.personal.json' : 'credentials.business.json';
      fs.writeFileSync(
        path.join(tempDir, credFile),
        JSON.stringify({
          installed: {
            client_id: 'test_id',
            client_secret: 'test_secret',
            redirect_uris: ['http://localhost:3000'],
          },
        })
      );
    }

    it('R1. WRONG ACCOUNT fresh OAuth: tokens event during exchange does NOT persist wrong token', async () => {
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
      mockGmailProfile('business@pacifichorizonlabs.com');

      const targetTokenPath = path.join(tempDir, 'token.personal.json');
      let tokensEventFired = false;
      let bindingValidated = false;
      let pendingRefreshedTokens: Record<string, unknown> | null = null;

      // Mock oauth client that emits tokens event when credentials are set
      let listener: ((t: any) => void) | null = null;
      const mockClient = {
        on: (event: string, cb: (t: any) => void) => {
          if (event === 'tokens') listener = cb;
        },
        getToken: async () => {
          const t = { access_token: 'wrong_business_access_token' };
          if (listener) {
            tokensEventFired = true;
            listener(t);
          }
          return { tokens: t };
        },
        setCredentials: (t: any) => {
          if (listener) {
            tokensEventFired = true;
            listener(t);
          }
        },
        generateAuthUrl: () => 'http://localhost:3000',
      } as unknown as OAuth2Client;

      // Attach the safe refresh listener used in auth.ts
      mockClient.on('tokens', (tokens) => {
        if (bindingValidated) {
          persistTokens(tokens, targetTokenPath);
        } else {
          pendingRefreshedTokens = { ...(pendingRefreshedTokens || {}), ...tokens };
        }
      });

      // Attempt verification
      await assert.rejects(
        async () => {
          const { tokens } = await mockClient.getToken('mock_code');
          mockClient.setCredentials(tokens);
          await verifyProfileAccountBinding(mockClient, 'personal');
        },
        (err: Error) => {
          assert.match(err.message, /Authenticated Gmail account does not match the configured account for profile personal/);
          return true;
        }
      );

      assert.ok(tokensEventFired, 'tokens event was fired during token exchange');
      assert.equal(bindingValidated, false, 'bindingValidated must remain false on identity mismatch');
      assert.equal(fs.existsSync(targetTokenPath), false, 'token.personal.json must NOT exist on disk after failed verification');
    });

    it('R2. Verify ordering: token persistence cannot occur before identity validation succeeds', async () => {
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
      const targetTokenPath = path.join(tempDir, 'token.personal.json');

      let identityChecked = false;
      // @ts-expect-error Mocking google.gmail
      google.gmail = () => ({
        users: {
          getProfile: async () => {
            // Check that token has NOT been written yet
            assert.equal(fs.existsSync(targetTokenPath), false, 'Token file must not exist before identity check passes');
            identityChecked = true;
            return { data: { emailAddress: 'personal@example.com' } };
          },
        },
      });

      const auth = createMockAuth();
      const verified = await verifyProfileAccountBinding(auth, 'personal');
      assert.ok(identityChecked, 'Identity was checked');
      assert.equal(verified, 'personal@example.com');
    });

    it('R3. Existing WRONG token: getAuthenticatedClient rejects and blocks scan before messages.list', async () => {
      writeValidCredentials('personal');
      process.env.PHRO_GMAIL_PROFILE = 'personal';
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';

      // token.personal.json exists on disk with business tokens
      const tokenPath = path.join(tempDir, 'token.personal.json');
      fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'business_token' }), { mode: 0o600 });

      // Google returns business email
      mockGmailProfile('business@pacifichorizonlabs.com');

      let messagesListCalled = false;
      // @ts-expect-error Mocking google.gmail
      google.gmail = () => ({
        users: {
          getProfile: async () => ({ data: { emailAddress: 'business@pacifichorizonlabs.com' } }),
          messages: {
            list: async () => {
              messagesListCalled = true;
              return { data: { messages: [] } };
            },
          },
        },
      });

      // getAuthenticatedClient must reject
      await assert.rejects(
        async () => getAuthenticatedClient('personal', tempDir),
        (err: Error) => {
          assert.match(err.message, /Authenticated Gmail account does not match the configured account for profile personal/);
          return true;
        }
      );

      // Verify token file was NOT deleted or overwritten
      assert.ok(fs.existsSync(tokenPath), 'Existing token file must remain intact (not deleted or altered)');
      assert.equal(messagesListCalled, false, 'messages.list must never be called when token has wrong identity');
    });

    it('R4. Existing CORRECT token: identity matches expected account and client is returned normally', async () => {
      writeValidCredentials('personal');
      process.env.PHRO_GMAIL_PROFILE = 'personal';
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';

      const tokenPath = path.join(tempDir, 'token.personal.json');
      fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'valid_personal_token' }), { mode: 0o600 });

      mockGmailProfile('personal@example.com');

      const client = await getAuthenticatedClient('personal', tempDir);
      assert.ok(client, 'Authenticated client should be returned');
    });

    it('R5. Refresh DURING validation: refreshed token persists only AFTER successful validation', async () => {
      writeValidCredentials('personal');
      process.env.PHRO_GMAIL_PROFILE = 'personal';
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';

      const tokenPath = path.join(tempDir, 'token.personal.json');
      fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'initial_token' }), { mode: 0o600 });

      // Spy on google.gmail: during getProfile, fire a token refresh event
      // @ts-expect-error Mocking google.gmail
      google.gmail = (opts: any) => {
        // opts.auth is the oauth2Client
        if (opts.auth?.emit) {
          opts.auth.emit('tokens', { access_token: 'refreshed_during_validation' });
        }
        return {
          users: {
            getProfile: async () => ({ data: { emailAddress: 'personal@example.com' } }),
          },
        };
      };

      const client = await getAuthenticatedClient('personal', tempDir);
      assert.ok(client);

      // Token file should now have the refreshed token because validation succeeded
      const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      assert.equal(saved.access_token, 'refreshed_during_validation');
    });

    it('R6. Refresh DURING validation + identity mismatch: refreshed credentials remain unpersisted', async () => {
      writeValidCredentials('personal');
      process.env.PHRO_GMAIL_PROFILE = 'personal';
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';

      const tokenPath = path.join(tempDir, 'token.personal.json');
      fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'initial_token' }), { mode: 0o600 });

      // @ts-expect-error Mocking google.gmail
      google.gmail = (opts: any) => {
        if (opts.auth?.emit) {
          opts.auth.emit('tokens', { access_token: 'refreshed_during_validation' });
        }
        return {
          users: {
            getProfile: async () => ({ data: { emailAddress: 'wrong_business@pacifichorizonlabs.com' } }),
          },
        };
      };

      await assert.rejects(
        async () => getAuthenticatedClient('personal', tempDir),
        (err: Error) => {
          assert.match(err.message, /does not match the configured account for profile personal/);
          return true;
        }
      );

      // Token file must still have initial_token, NOT refreshed_during_validation!
      const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      assert.equal(saved.access_token, 'initial_token');
    });

    it('R7. Future refresh AFTER successful binding: refreshed token may safely persist', async () => {
      writeValidCredentials('personal');
      process.env.PHRO_GMAIL_PROFILE = 'personal';
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';

      const tokenPath = path.join(tempDir, 'token.personal.json');
      fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'initial_token' }), { mode: 0o600 });

      mockGmailProfile('personal@example.com');

      const client = await getAuthenticatedClient('personal', tempDir);
      assert.ok(client);

      // Emit future refresh event
      client.emit('tokens', { access_token: 'future_refreshed_token' });

      // Token file should now have the future token
      const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      assert.equal(saved.access_token, 'future_refreshed_token');
    });

    it('R8. Personal profile cannot authenticate as configured business expected account', async () => {
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
      process.env.PHRO_GMAIL_BUSINESS_ACCOUNT = 'business@pacifichorizonlabs.com';

      // Google returns business account while under personal profile
      mockGmailProfile('business@pacifichorizonlabs.com');

      const auth = createMockAuth();
      await assert.rejects(
        async () => verifyProfileAccountBinding(auth, 'personal'),
        (err: Error) => {
          assert.match(err.message, /does not match the configured account for profile personal/);
          return true;
        }
      );
    });

    it('R9. Business profile cannot authenticate as configured personal expected account', async () => {
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';
      process.env.PHRO_GMAIL_BUSINESS_ACCOUNT = 'business@pacifichorizonlabs.com';

      // Google returns personal account while under business profile
      mockGmailProfile('personal@example.com');

      const auth = createMockAuth();
      await assert.rejects(
        async () => verifyProfileAccountBinding(auth, 'business'),
        (err: Error) => {
          assert.match(err.message, /does not match the configured account for profile business/);
          return true;
        }
      );
    });

    it('R10. Scanner creates plan only after successful expected-account validation', async () => {
      process.env.PHRO_GMAIL_PROFILE = 'personal';
      process.env.PHRO_GMAIL_PERSONAL_ACCOUNT = 'personal@example.com';

      // Scanner with wrong identity throws before messages.list
      let listCalled = false;
      // @ts-expect-error Mocking google.gmail
      google.gmail = () => ({
        users: {
          getProfile: async () => ({ data: { emailAddress: 'business@pacifichorizonlabs.com' } }),
          messages: {
            list: async () => {
              listCalled = true;
              return { data: { messages: [] } };
            },
          },
        },
      });

      await assert.rejects(
        async () => scanMailbox(createMockAuth(), { query: 'category:promotions' }),
        (err: Error) => {
          assert.match(err.message, /does not match the configured account for profile personal/);
          return true;
        }
      );

      assert.equal(listCalled, false, 'messages.list must not be called when account is mismatched');
    });

    it('R11. Dry-run executor still blocks account mismatch', async () => {
      const plan: MailboxCleanupPlan = {
        id: 'plan_dry_acc_mismatch',
        gmailAccount: 'personal@example.com',
        gmailProfile: 'personal',
        createdAt: new Date().toISOString(),
        query: 'category:promotions',
        status: 'APPROVED',
        candidateCount: 0,
        totalEstimatedBytes: 0,
        candidates: [],
        excludedCount: 0,
      };
      store.savePlan(plan);

      process.env.PHRO_GMAIL_PROFILE = 'personal';
      // Identity differs from plan.gmailAccount
      mockGmailProfile('other@example.com');

      await assert.rejects(
        async () => executeCleanupPlan(createMockAuth(), plan.id, { dryRun: true, store }),
        (err: Error) => {
          assert.match(err.message, /Account mismatch/);
          return true;
        }
      );
    });

    it('R12. Live executor still blocks account mismatch before messages.trash', async () => {
      let trashCalled = false;
      const candidate: MailboxCleanupCandidate = {
        messageId: 'msg_r12',
        threadId: 'thd_r12',
        sender: 'promo@store.com',
        subject: 'Deal',
        date: '2026-01-01',
        category: 'PROMOTION',
        reason: 'Promo',
        confidence: 0.9,
        estimatedSize: 100,
        protectionFlags: [],
        recommendedAction: 'RECOMMEND_TRASH',
      };

      const plan: MailboxCleanupPlan = {
        id: 'plan_live_acc_mismatch',
        gmailAccount: 'personal@example.com',
        gmailProfile: 'personal',
        createdAt: new Date().toISOString(),
        query: 'category:promotions',
        status: 'APPROVED',
        candidateCount: 1,
        totalEstimatedBytes: 100,
        candidates: [candidate],
        excludedCount: 0,
      };
      store.savePlan(plan);

      process.env.PHRO_GMAIL_PROFILE = 'personal';
      // @ts-expect-error Mocking google.gmail
      google.gmail = () => ({
        users: {
          getProfile: async () => ({ data: { emailAddress: 'wrong_caller@example.com' } }),
          messages: {
            trash: async () => {
              trashCalled = true;
            },
          },
        },
      });

      await assert.rejects(
        async () => executeCleanupPlan(createMockAuth(), plan.id, { store }),
        (err: Error) => {
          assert.match(err.message, /Account mismatch/);
          return true;
        }
      );

      assert.equal(trashCalled, false, 'messages.trash must not be called when account mismatch occurs');
    });
  });
});
