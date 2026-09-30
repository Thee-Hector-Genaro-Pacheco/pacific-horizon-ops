export const QUERY_PRESETS: Record<string, string> = {
  'promotions-old': 'category:promotions older_than:1y',
  'social-old': 'category:social older_than:1y',
  'large-old': 'older_than:1y larger:5M',
};

export interface QueryValidationResult {
  safe: boolean;
  reason?: string;
}

/**
 * Validates that a Gmail search query adheres to safety guardrails.
 * Explicitly rejects sender-only queries (e.g. from:nike.com) that lack a safe category boundary.
 */
export function validateSafeQuery(query: string): QueryValidationResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { safe: false, reason: 'Query cannot be empty.' };
  }

  const lower = trimmed.toLowerCase();

  // Check for dangerous blanket queries
  if (lower === 'in:inbox' || lower === 'all' || lower === '*' || lower === 'is:unread') {
    return {
      safe: false,
      reason: 'Blanket queries without category and date filters are prohibited.',
    };
  }

  // Sender filtering safety guard:
  // from:<domain> without category:promotions or category:social is strictly rejected
  // because retailers send both promotional emails and critical receipts/order confirmations.
  if (lower.includes('from:')) {
    const hasSafeCategory =
      lower.includes('category:promotions') ||
      lower.includes('category:social') ||
      lower.includes('label:promotions') ||
      lower.includes('label:social');

    if (!hasSafeCategory) {
      return {
        safe: false,
        reason:
          'Sender-based filtering (from:...) must be combined with category:promotions or category:social. ' +
          'Sender alone is not sufficient evidence because transaction receipts, invoices, and order confirmations may share the same domain.',
      };
    }
  }

  return { safe: true };
}

/**
 * Resolves a query from a preset name or custom query string, validating safety.
 */
export function resolveQuery(preset?: string, customQuery?: string): string {
  if (preset) {
    const query = QUERY_PRESETS[preset];
    if (!query) {
      const available = Object.keys(QUERY_PRESETS).join(', ');
      throw new Error(`Unknown query preset "${preset}". Available presets: ${available}`);
    }
    return query;
  }

  if (customQuery) {
    const validation = validateSafeQuery(customQuery);
    if (!validation.safe) {
      throw new Error(`Unsafe query rejected: ${validation.reason}`);
    }
    return customQuery;
  }

  // Default to promotions-old
  return QUERY_PRESETS['promotions-old'];
}
