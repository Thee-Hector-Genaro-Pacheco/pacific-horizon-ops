import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  getActiveProfile,
  resolveTokenPath,
  resolveCredentialPath,
  persistTokens,
  VALID_PROFILES,
} from '../src/auth.js';

describe('Gmail Multi-Profile & OAuth Client Isolation (PHRO-MAIL-002 / PHRO-MAIL-003)', () => {
  const originalEnv = process.env.PHRO_GMAIL_PROFILE;
  let tempDir: string;

  beforeEach(() => {
    delete process.env.PHRO_GMAIL_PROFILE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-profiles-test-'));
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PHRO_GMAIL_PROFILE = originalEnv;
    } else {
      delete process.env.PHRO_GMAIL_PROFILE;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. business prefers credentials.business.json', () => {
    const businessCredPath = path.join(tempDir, 'credentials.business.json');
    const legacyCredPath = path.join(tempDir, 'credentials.json');
    fs.writeFileSync(businessCredPath, JSON.stringify({ type: 'business_client' }));
    fs.writeFileSync(legacyCredPath, JSON.stringify({ type: 'legacy_client' }));

    const res = resolveCredentialPath('business', tempDir);
    assert.equal(res.profile, 'business');
    assert.equal(res.credentialPath, businessCredPath);
    assert.equal(res.isFallback, false);
  });

  it('2. business falls back to credentials.json when profile-specific file is absent', () => {
    const legacyCredPath = path.join(tempDir, 'credentials.json');
    fs.writeFileSync(legacyCredPath, JSON.stringify({ type: 'legacy_client' }));

    const res = resolveCredentialPath('business', tempDir);
    assert.equal(res.profile, 'business');
    assert.equal(res.credentialPath, legacyCredPath);
    assert.equal(res.isFallback, true);
  });

  it('3. personal resolves credentials.personal.json', () => {
    const personalCredPath = path.join(tempDir, 'credentials.personal.json');
    fs.writeFileSync(personalCredPath, JSON.stringify({ type: 'personal_client' }));

    // Even if legacy credentials.json or credentials.business.json exist
    fs.writeFileSync(path.join(tempDir, 'credentials.json'), JSON.stringify({ type: 'legacy_client' }));
    fs.writeFileSync(path.join(tempDir, 'credentials.business.json'), JSON.stringify({ type: 'business_client' }));

    process.env.PHRO_GMAIL_PROFILE = 'personal';
    const resFromEnv = resolveCredentialPath(undefined, tempDir);
    assert.equal(resFromEnv.profile, 'personal');
    assert.equal(resFromEnv.credentialPath, personalCredPath);
    assert.equal(resFromEnv.isFallback, false);

    const resExplicit = resolveCredentialPath('personal', tempDir);
    assert.equal(resExplicit.profile, 'personal');
    assert.equal(resExplicit.credentialPath, personalCredPath);
    assert.equal(resExplicit.isFallback, false);
  });

  it('4. personal never falls back to credentials.json', () => {
    // Only legacy credentials.json exists; credentials.personal.json is missing
    fs.writeFileSync(path.join(tempDir, 'credentials.json'), JSON.stringify({ type: 'legacy_client' }));

    assert.throws(
      () => resolveCredentialPath('personal', tempDir),
      (err: Error) => {
        assert.match(err.message, /credentials\.personal\.json/);
        assert.match(err.message, /External audience/);
        return true;
      }
    );
  });

  it('5. personal never resolves credentials.business.json', () => {
    // Only credentials.business.json exists; credentials.personal.json is missing
    fs.writeFileSync(path.join(tempDir, 'credentials.business.json'), JSON.stringify({ type: 'business_client' }));

    assert.throws(
      () => resolveCredentialPath('personal', tempDir),
      (err: Error) => {
        assert.match(err.message, /credentials\.personal\.json/);
        return true;
      }
    );
  });

  it('6. missing personal credentials fails safely before OAuth begins', () => {
    // Neither credentials file exists
    assert.throws(
      () => resolveCredentialPath('personal', tempDir),
      (err: Error) => {
        assert.match(err.message, /credentials\.personal\.json/);
        assert.match(err.message, /Personal Gmail accounts cannot use the business Internal OAuth client/);
        return true;
      }
    );
  });

  it('7. business and personal credential paths cannot collide', () => {
    fs.writeFileSync(path.join(tempDir, 'credentials.business.json'), JSON.stringify({ type: 'biz' }));
    fs.writeFileSync(path.join(tempDir, 'credentials.personal.json'), JSON.stringify({ type: 'personal' }));

    const businessRes = resolveCredentialPath('business', tempDir);
    const personalRes = resolveCredentialPath('personal', tempDir);

    assert.notEqual(businessRes.credentialPath, personalRes.credentialPath);
    assert.equal(path.basename(businessRes.credentialPath), 'credentials.business.json');
    assert.equal(path.basename(personalRes.credentialPath), 'credentials.personal.json');
  });

  it('8. business and personal token paths cannot collide', () => {
    fs.writeFileSync(path.join(tempDir, 'token.business.json'), JSON.stringify({ type: 'biz_token' }));
    fs.writeFileSync(path.join(tempDir, 'token.personal.json'), JSON.stringify({ type: 'personal_token' }));

    const businessRes = resolveTokenPath('business', tempDir);
    const personalRes = resolveTokenPath('personal', tempDir);

    assert.notEqual(businessRes.tokenPath, personalRes.tokenPath);
    assert.equal(path.basename(businessRes.tokenPath), 'token.business.json');
    assert.equal(path.basename(personalRes.tokenPath), 'token.personal.json');
  });

  it('9. credentials profile files remain gitignored', () => {
    const checkOutput = execSync(
      'git check-ignore credentials.json credentials.business.json credentials.personal.json',
      { encoding: 'utf-8' }
    );
    const ignoredFiles = checkOutput.trim().split('\n');
    assert.ok(ignoredFiles.includes('credentials.json'));
    assert.ok(ignoredFiles.includes('credentials.business.json'));
    assert.ok(ignoredFiles.includes('credentials.personal.json'));
  });

  it('10. token profile files remain gitignored', () => {
    const checkOutput = execSync(
      'git check-ignore token.json token.business.json token.personal.json',
      { encoding: 'utf-8' }
    );
    const ignoredFiles = checkOutput.trim().split('\n');
    assert.ok(ignoredFiles.includes('token.json'));
    assert.ok(ignoredFiles.includes('token.business.json'));
    assert.ok(ignoredFiles.includes('token.personal.json'));
  });

  it('11. default profile is business when PHRO_GMAIL_PROFILE is unset', () => {
    delete process.env.PHRO_GMAIL_PROFILE;
    assert.equal(getActiveProfile(), 'business');
    assert.equal(getActiveProfile(undefined), 'business');
  });

  it('12. business resolves token.business.json with fallback to token.json', () => {
    // Case A: token.business.json exists
    const businessTokenPath = path.join(tempDir, 'token.business.json');
    fs.writeFileSync(businessTokenPath, JSON.stringify({ type: 'business' }));

    const resWithBusinessFile = resolveTokenPath('business', tempDir);
    assert.equal(resWithBusinessFile.profile, 'business');
    assert.equal(resWithBusinessFile.tokenPath, businessTokenPath);
    assert.equal(resWithBusinessFile.isFallback, false);

    // Case B: fallback to token.json
    fs.rmSync(businessTokenPath);
    const legacyTokenPath = path.join(tempDir, 'token.json');
    fs.writeFileSync(legacyTokenPath, JSON.stringify({ type: 'legacy' }));

    const resWithLegacyFallback = resolveTokenPath('business', tempDir);
    assert.equal(resWithLegacyFallback.profile, 'business');
    assert.equal(resWithLegacyFallback.tokenPath, legacyTokenPath);
    assert.equal(resWithLegacyFallback.isFallback, true);
  });

  it('13. missing personal token does not overwrite business token', () => {
    const businessTokenPath = path.join(tempDir, 'token.business.json');
    const originalBusinessData = { account: 'business@pacifichorizonlabs.com', secret: 'biz-secret' };
    fs.writeFileSync(businessTokenPath, JSON.stringify(originalBusinessData), { mode: 0o600 });

    const personalRes = resolveTokenPath('personal', tempDir);
    assert.equal(fs.existsSync(personalRes.tokenPath), false);

    const personalTokens = { account: 'personal@gmail.com', secret: 'personal-secret' };
    persistTokens(personalTokens, personalRes.tokenPath);

    assert.equal(fs.existsSync(personalRes.tokenPath), true);
    const writtenPersonal = JSON.parse(fs.readFileSync(personalRes.tokenPath, 'utf-8'));
    assert.equal(writtenPersonal.account, 'personal@gmail.com');

    // Business token remains untouched
    assert.equal(fs.existsSync(businessTokenPath), true);
    const unchangedBusiness = JSON.parse(fs.readFileSync(businessTokenPath, 'utf-8'));
    assert.deepEqual(unchangedBusiness, originalBusinessData);
  });

  it('14. invalid profile name fails safely', () => {
    const invalidNames = ['admin', 'work', 'other', 'BUSINESS_PROFILE', '', '   '];

    for (const name of invalidNames) {
      assert.throws(
        () => getActiveProfile(name),
        (err: Error) => {
          assert.match(err.message, /Invalid Gmail profile/);
          return true;
        }
      );
    }
  });
});
