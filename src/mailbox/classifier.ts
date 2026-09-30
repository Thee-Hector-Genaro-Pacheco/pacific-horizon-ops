import {
  type MailboxCategory,
  type ProtectionFlag,
  type RecommendedAction,
} from './types.js';

export interface EmailMetadataForClassification {
  messageId: string;
  sender: string;
  subject: string;
  snippet?: string;
  labelIds?: string[];
  sizeEstimate?: number | null;
  hasListUnsubscribeHeader?: boolean;
}

export interface ClassificationResult {
  category: MailboxCategory;
  confidence: number;
  reason: string;
  protectionFlags: ProtectionFlag[];
  recommendedAction: RecommendedAction;
}

// Regex patterns for deterministic safety checks
const RECEIPT_PATTERNS =
  /\b(receipt|invoice|order\s+confirmation|order\s+placed|your\s+order|purchased?|payment\s+received|payment\s+confirmation|billing\s+statement|refund\s+processed|refund\s+confirmation|shipping\s+confirmation|shipped|tracking\s+number|delivery\s+update|package\s+delivered|pickup\s+ready|subscription\s+renewal|tax\s+invoice)\b/i;

const FINANCIAL_PATTERNS =
  /\b(bank\s+statement|account\s+statement|wire\s+transfer|deposit|credit\s+card|debit\s+card|transaction\s+alert|zelle|venmo|paypal\s+receipt|w-2|1099|tax\s+document|tax\s+return|direct\s+deposit|payroll|investment\s+statement)\b/i;

const SECURITY_PATTERNS =
  /\b(password\s+reset|reset\s+your\s+password|security\s+alert|login\s+alert|verification\s+code|one-time\s+passcode|otp|2fa|two-factor|two\s+step|suspicious\s+activity|unauthorized\s+access|new\s+device|new\s+sign-in|signed\s+in\s+from|passcode)\b/i;

const LEGAL_GOV_PATTERNS =
  /\b(irs|internal\s+revenue|franchise\s+tax|department\s+of|court|subpoena|legal\s+notice|government\s+notice|tax\s+authority|contract\s+agreement|docusign|terms\s+of\s+service\s+update|privacy\s+policy\s+update)\b/i;

const PROMOTION_PATTERNS =
  /\b(sale|discount|% off|promo|special\s+offer|deals|clearance|save\s+now|limited\s+time|flash\s+sale|exclusive\s+offer|shop\s+now)\b/i;

const SOCIAL_PATTERNS =
  /\b(notification|mentioned\s+you|tagged\s+you|new\s+follower|connection\s+request|invited\s+you|liked\s+your|friend\s+request)\b/i;

/**
 * Deterministically analyzes email metadata for critical protection flags.
 * Rule: If ANY protection flag is triggered, the email MUST NOT be recommended for trash.
 */
export function detectProtectionFlags(
  subject: string,
  snippet: string = '',
  sender: string = ''
): { flags: ProtectionFlag[]; primaryCategory?: MailboxCategory; reason?: string } {
  const flags: ProtectionFlag[] = [];
  const text = `${subject} ${snippet} ${sender}`;

  if (RECEIPT_PATTERNS.test(text)) {
    flags.push('RECEIPT_LIKE');
    flags.push('PURCHASE_LIKE');
    return {
      flags,
      primaryCategory: 'RECEIPT',
      reason: 'Contains receipt, order confirmation, invoice, or purchase keywords',
    };
  }

  if (FINANCIAL_PATTERNS.test(text)) {
    flags.push('FINANCIAL_LIKE');
    return {
      flags,
      primaryCategory: 'FINANCIAL',
      reason: 'Contains banking, financial statement, or payment transaction keywords',
    };
  }

  if (SECURITY_PATTERNS.test(text)) {
    flags.push('SECURITY_LIKE');
    return {
      flags,
      primaryCategory: 'ACCOUNT_SECURITY',
      reason: 'Contains password reset, security alert, or login verification keywords',
    };
  }

  if (LEGAL_GOV_PATTERNS.test(text)) {
    flags.push('GOVERNMENT_LIKE');
    flags.push('LEGAL_LIKE');
    return {
      flags,
      primaryCategory: 'LEGAL',
      reason: 'Contains government notice, legal notice, contract, or regulatory keywords',
    };
  }

  return { flags };
}

/**
 * Classifies an email for mailbox cleanup eligibility using deterministic signals first.
 * Safe default: uncertain or protected messages default to KEEP_REVIEW.
 */
export function classifyEmailForCleanup(
  email: EmailMetadataForClassification
): ClassificationResult {
  const subject = email.subject || '';
  const snippet = email.snippet || '';
  const sender = email.sender || '';
  const labels = email.labelIds || [];
  const size = email.sizeEstimate || 0;

  // 1. Mandatory Protection Scan: Check for receipt, financial, security, or legal signals
  const protection = detectProtectionFlags(subject, snippet, sender);
  if (protection.flags.length > 0) {
    return {
      category: protection.primaryCategory || 'RECEIPT',
      confidence: 0.95,
      reason: protection.reason || 'Protected email type detected; must not be trashed',
      protectionFlags: protection.flags,
      recommendedAction: 'KEEP_REVIEW',
    };
  }

  // 2. Large Message Check (>= 5MB)
  const isLarge = size >= 5 * 1024 * 1024;

  // 3. Category Detection: Promotions
  const isPromoLabel = labels.includes('CATEGORY_PROMOTIONS');
  const hasPromoText = PROMOTION_PATTERNS.test(`${subject} ${snippet}`);

  if (isPromoLabel || hasPromoText) {
    return {
      category: 'PROMOTION',
      confidence: isPromoLabel ? 0.95 : 0.85,
      reason: isPromoLabel
        ? 'Categorized under Gmail Promotions with no protection flags'
        : 'Promotional marketing content detected with no transaction keywords',
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };
  }

  // 4. Category Detection: Social Notifications
  const isSocialLabel = labels.includes('CATEGORY_SOCIAL');
  const hasSocialText = SOCIAL_PATTERNS.test(`${subject} ${snippet}`);

  if (isSocialLabel || hasSocialText) {
    return {
      category: 'SOCIAL_NOTIFICATION',
      confidence: isSocialLabel ? 0.95 : 0.85,
      reason: isSocialLabel
        ? 'Categorized under Gmail Social with no protection flags'
        : 'Social network notification with no protected content',
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };
  }

  // 5. Category Detection: Newsletters
  if (email.hasListUnsubscribeHeader) {
    return {
      category: 'NEWSLETTER',
      confidence: 0.85,
      reason: 'Bulk mailing list / newsletter with List-Unsubscribe header',
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };
  }

  // 6. Large Message Review (Large messages must NOT automatically imply trash)
  if (isLarge) {
    return {
      category: 'LARGE_MESSAGE',
      confidence: 0.9,
      reason: `Large message (${(size / (1024 * 1024)).toFixed(1)}MB); flagged for user review`,
      protectionFlags: [],
      recommendedAction: 'KEEP_REVIEW',
    };
  }

  // 7. Conservative Default: If content is unknown or unverified, keep it
  return {
    category: 'UNKNOWN',
    confidence: 0.5,
    reason: 'Insufficient evidence to categorize as disposable promotion or social notice',
    protectionFlags: ['UNKNOWN_CONTENT'],
    recommendedAction: 'KEEP_REVIEW',
  };
}
