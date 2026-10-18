import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import {
  PhotoBoothAnalyticsClient,
  loadPhotoBoothConfig,
  DEFAULT_PHOTO_BOOTH_ANALYTICS_URL,
  type FetchLike,
} from '../src/photobooth/client.js';
import { PhotoBoothAnalyticsError } from '../src/photobooth/types.js';
import { PHOTO_BOOTH_TOOLS, PHOTO_BOOTH_TOOL_NAMES, executePhotoBoothTool } from '../src/photobooth/tools.js';
import { answerPhotoBoothQuestion, PHOTO_BOOTH_SYSTEM_PROMPT } from '../src/photobooth/agent.js';
import { describeEventSummary, findSemanticViolations } from '../src/photobooth/semantics.js';
import {
  SECRET,
  URL,
  EVENT_A,
  EVENT_B,
  eventSummary,
  latestEvent,
  mockFetch,
  makeClient,
  captureConsole,
  textMessage,
  toolMessage,
  fakeAnthropic,
  toolResultsIn,
} from './helpers/photoBoothFakes.js';

describe('Photo Booth analytics config', () => {
  it('fails closed when PHOTO_BOOTH_REPORTING_API_KEY is missing', () => {
    assert.throws(
      () => loadPhotoBoothConfig({ PHOTO_BOOTH_ANALYTICS_URL: URL }),
      (err: unknown) => err instanceof PhotoBoothAnalyticsError && err.kind === 'config' && /PHOTO_BOOTH_REPORTING_API_KEY/.test(err.message)
    );
    assert.throws(() => loadPhotoBoothConfig({ PHOTO_BOOTH_REPORTING_API_KEY: '   ' }), PhotoBoothAnalyticsError);
  });

  it('missing key surfaces as an explicit tool error, never as data', async () => {
    let fetchCalled = false;
    const result = await (async () => {
      try {
        PhotoBoothAnalyticsClient.fromEnv({}, async () => {
          fetchCalled = true;
          return new Response('{}');
        });
        return 'constructed';
      } catch (err) {
        return err;
      }
    })();
    assert.ok(result instanceof PhotoBoothAnalyticsError);
    assert.equal(fetchCalled, false);
  });

  it('defaults the URL but never the key, and rejects plain-http remote URLs', () => {
    const cfg = loadPhotoBoothConfig({ PHOTO_BOOTH_REPORTING_API_KEY: SECRET });
    assert.equal(cfg.url, DEFAULT_PHOTO_BOOTH_ANALYTICS_URL);
    assert.equal(cfg.timeoutMs, 10_000);
    assert.throws(
      () => loadPhotoBoothConfig({ PHOTO_BOOTH_REPORTING_API_KEY: SECRET, PHOTO_BOOTH_ANALYTICS_URL: 'http://evil.example.com/x' }),
      PhotoBoothAnalyticsError
    );
  });
});

describe('Photo Booth analytics client request shapes', () => {
  it('latest_event posts {operation} with bearer auth and JSON content type', async () => {
    const { fetchImpl, requests } = mockFetch();
    const result = await makeClient(fetchImpl).latestEvent();
    assert.equal(result.eventId, EVENT_A);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, URL);
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(requests[0].body, { operation: 'latest_event' });
    assert.equal(requests[0].headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
  });

  it('event_summary posts {operation, eventId}', async () => {
    const { fetchImpl, requests } = mockFetch();
    const s = await makeClient(fetchImpl).eventSummary(EVENT_A);
    assert.equal(s.sessions.total, 97);
    assert.deepEqual(requests[0].body, { operation: 'event_summary', eventId: EVENT_A });
  });

  it('feedback_summary posts {operation, eventId}', async () => {
    const { fetchImpl, requests } = mockFetch();
    await makeClient(fetchImpl).feedbackSummary(EVENT_A);
    assert.deepEqual(requests[0].body, { operation: 'feedback_summary', eventId: EVENT_A });
  });

  it('delivery_health posts {operation, eventId}', async () => {
    const { fetchImpl, requests } = mockFetch();
    const d = await makeClient(fetchImpl).deliveryHealth(EVENT_A);
    assert.equal(d.hasUnfinalizedSessions, true);
    assert.deepEqual(requests[0].body, { operation: 'delivery_health', eventId: EVENT_A });
  });

  it('compare_events posts {operation, eventIdA, eventIdB}', async () => {
    const { fetchImpl, requests } = mockFetch();
    const c = await makeClient(fetchImpl).compareEvents(EVENT_A, EVENT_B);
    assert.equal(c.deltas.sessionsTotalDelta, -47);
    assert.deepEqual(requests[0].body, { operation: 'compare_events', eventIdA: EVENT_A, eventIdB: EVENT_B });
  });

  it('rejects non-UUID event IDs before any network call', async () => {
    const { fetchImpl, requests } = mockFetch();
    await assert.rejects(makeClient(fetchImpl).eventSummary('latest'), (e: unknown) => e instanceof PhotoBoothAnalyticsError && e.kind === 'invalid_input');
    assert.equal(requests.length, 0);
  });
});

describe('Photo Booth analytics client failure handling', () => {
  it('reports unauthorized upstream responses clearly', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    await assert.rejects(makeClient(fetchImpl).latestEvent(), (e: unknown) => {
      assert.ok(e instanceof PhotoBoothAnalyticsError);
      assert.equal(e.kind, 'unauthorized');
      assert.equal(e.status, 401);
      assert.match(e.message, /PHOTO_BOOTH_REPORTING_API_KEY/);
      assert.ok(!e.message.includes(SECRET));
      return true;
    });
  });

  it('treats non-JSON bodies as malformed', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: '<html>gateway</html>' }));
    await assert.rejects(makeClient(fetchImpl).latestEvent(), (e: unknown) => e instanceof PhotoBoothAnalyticsError && e.kind === 'malformed_response');
  });

  it('treats schema mismatches as malformed instead of defaulting to zeros', async () => {
    const broken = eventSummary();
    delete (broken as Partial<typeof broken>).sessions;
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: broken }));
    await assert.rejects(makeClient(fetchImpl).eventSummary(EVENT_A), (e: unknown) => {
      assert.ok(e instanceof PhotoBoothAnalyticsError);
      assert.equal(e.kind, 'malformed_response');
      assert.match(e.message, /sessions/);
      return true;
    });
  });

  it('rejects a response for the wrong operation', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: latestEvent }));
    await assert.rejects(makeClient(fetchImpl).eventSummary(EVENT_A), (e: unknown) => e instanceof PhotoBoothAnalyticsError && e.kind === 'malformed_response');
  });

  it('maps 5xx, network failures, and timeouts to distinct error kinds', async () => {
    const upstream = mockFetch(() => ({ status: 500, body: { error: 'Could not retrieve analytics' } }));
    await assert.rejects(makeClient(upstream.fetchImpl).latestEvent(), (e: unknown) => e instanceof PhotoBoothAnalyticsError && e.kind === 'upstream_error' && e.status === 500);

    const network = mockFetch(() => 'throw');
    await assert.rejects(makeClient(network.fetchImpl).latestEvent(), (e: unknown) => e instanceof PhotoBoothAnalyticsError && e.kind === 'network');

    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    await assert.rejects(makeClient(hanging, 20).latestEvent(), (e: unknown) => e instanceof PhotoBoothAnalyticsError && e.kind === 'timeout');
  });

  it('keeps a valid empty latest_event distinguishable from a failure', async () => {
    const empty = mockFetch(() => ({ status: 200, body: { operation: 'latest_event', eventId: null, lastActivityAt: null, sessionCount: 0 } }));
    const ok = await executePhotoBoothTool('get_latest_photo_booth_event', {}, makeClient(empty.fetchImpl));
    assert.equal(ok.ok, true);
    assert.ok(ok.ok && ok.caveats.some((c) => /valid empty result/.test(c)));

    const failing = mockFetch(() => ({ status: 500, body: { error: 'Could not retrieve analytics' } }));
    const capture = captureConsole();
    const failed = await executePhotoBoothTool('get_latest_photo_booth_event', {}, makeClient(failing.fetchImpl)).finally(capture.restore);
    assert.equal(failed.ok, false);
    assert.ok(!failed.ok && failed.error.kind === 'upstream_error');
    assert.ok(!('data' in failed));
  });
});

describe('Photo Booth tool registry', () => {
  it('exposes exactly the five read-only tools', () => {
    assert.deepEqual(PHOTO_BOOTH_TOOLS.map((t) => t.name), [...PHOTO_BOOTH_TOOL_NAMES]);
    const summaryTool = PHOTO_BOOTH_TOOLS.find((t) => t.name === 'get_photo_booth_event_summary')!;
    assert.deepEqual(summaryTool.input_schema.required, ['eventId']);
    const compareTool = PHOTO_BOOTH_TOOLS.find((t) => t.name === 'compare_photo_booth_events')!;
    assert.deepEqual(compareTool.input_schema.required, ['eventIdA', 'eventIdB']);
  });

  it('never includes the secret in tool results or logs, even on failure', async () => {
    const leaky = mockFetch((body) =>
      body.operation === 'event_summary'
        ? { status: 400, body: { error: `bad token ${SECRET}` } }
        : { status: 401, body: { error: 'Unauthorized' } }
    );
    const client = makeClient(leaky.fetchImpl);
    const capture = captureConsole();
    const results = [];
    try {
      results.push(await executePhotoBoothTool('get_latest_photo_booth_event', {}, client));
      results.push(await executePhotoBoothTool('get_photo_booth_event_summary', { eventId: EVENT_A }, client));
      results.push(await executePhotoBoothTool('get_photo_booth_delivery_health', { eventId: 'nope' }, client));
    } finally {
      capture.restore();
    }
    const ok = mockFetch();
    results.push(await executePhotoBoothTool('get_photo_booth_event_summary', { eventId: EVENT_A }, makeClient(ok.fetchImpl)));

    for (const r of results) assert.ok(!JSON.stringify(r).includes(SECRET), JSON.stringify(r));
    for (const line of capture.lines) assert.ok(!line.includes(SECRET), line);
    assert.ok(capture.lines.length > 0, 'failures should be logged');
  });
});

describe('Photo Booth semantic guardrails', () => {
  const report = describeEventSummary(eventSummary() as never);

  it('system prompt encodes every metric rule', () => {
    for (const phrase of [
      'NOT unique people',
      'NEVER call them failed uploads',
      'does NOT prove the file was saved',
      'do NOT prove follows',
      'never "Google reviews"',
      'NOT Google star ratings',
      'Never invent an event title',
    ]) {
      assert.ok(PHOTO_BOOTH_SYSTEM_PROMPT.includes(phrase), phrase);
    }
  });

  it('deterministic report passes its own semantic checks', () => {
    assert.deepEqual(findSemanticViolations(report), []);
  });

  it('preserves Google Review CTA semantics', () => {
    assert.match(report, /1 Google Review CTA click\b/);
    assert.doesNotMatch(report, /google reviews?(?! cta)/i);
    assert.deepEqual(findSemanticViolations('We got 1 Google review last night.').map((v) => v.rule), ['google_reviews']);
    assert.deepEqual(findSemanticViolations('Average Google rating was 5.0.').map((v) => v.rule), ['google_rating']);
    assert.deepEqual(findSemanticViolations('There was 1 Google Review CTA click.'), []);
    assert.match(report, /private booth feedback/);
  });

  it('does not call social clicks follows', () => {
    assert.match(report, /20 Instagram CTA clicks/);
    assert.match(report, /5 TikTok CTA clicks/);
    assert.doesNotMatch(report, /follow/i);
    for (const bad of ['20 people followed us on Instagram.', 'We gained 20 new followers.', 'That is 20 Instagram follows.']) {
      assert.ok(findSemanticViolations(bad).some((v) => v.rule === 'social_follows'), bad);
    }
    assert.deepEqual(findSemanticViolations('These clicks do not prove 20 people followed the account.'), []);
  });

  it('calls preparing sessions unfinalized, not failures', () => {
    assert.match(report, /9 remain unfinalized/);
    assert.match(report, /does not establish why/);
    assert.doesNotMatch(report, /fail|crash/i);
    for (const bad of ['9 uploads failed.', 'There were 9 failed uploads.', 'We saw 9 upload failures.']) {
      assert.ok(findSemanticViolations(bad).some((v) => v.rule === 'unfinalized_as_failure'), bad);
    }
  });

  it('does not describe session counts as unique guests', () => {
    assert.match(report, /97 delivery sessions/);
    assert.doesNotMatch(report, /\b(people|guests|users|visitors)\b/i);
    for (const bad of ['97 people used the booth.', 'The booth served 97 unique guests.']) {
      assert.ok(findSemanticViolations(bad).some((v) => v.rule === 'sessions_as_people'), bad);
    }
  });

  it('does not describe download_clicked as a confirmed device save', () => {
    assert.match(report, /55 distinct sessions clicked download/);
    assert.doesNotMatch(report, /saved|successful/i);
    for (const bad of ['55 guests successfully saved their photos.', 'We had 55 successful downloads.']) {
      assert.ok(findSemanticViolations(bad).some((v) => v.rule === 'download_as_save'), bad);
    }
  });

  it('reports an event with no activity as empty, not as failed', () => {
    const empty = eventSummary();
    empty.sessions = { total: 0, ready: 0, preparing: 0, expired: 0 };
    empty.feedback = { submissions: 0, averageRating: null, ratings: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
    assert.match(describeEventSummary(empty as never), /no recorded delivery sessions/);
  });
});

describe('Photo Booth agent workflow', () => {
  let capture: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    capture = captureConsole();
  });
  afterEach(() => capture.restore());

  const goodAnswer =
    'The latest recorded booth event has 97 delivery sessions. 88 reached ready state and 9 remain unfinalized. ' +
    'The claim page was viewed from 72 distinct sessions, and 55 distinct sessions clicked download. ' +
    'There were 20 Instagram CTA clicks, 5 TikTok CTA clicks, and 1 Google Review CTA click. ' +
    'One private booth feedback submission came in with a 5.0 rating.';

  it('chains latest_event -> event_summary and feeds tool results back to the model', async () => {
    const { fetchImpl, requests: http } = mockFetch();
    const { client, requests } = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      (req) => {
        const [result] = toolResultsIn(req);
        const parsed = JSON.parse(String(result.content));
        assert.equal(parsed.ok, true);
        return toolMessage('t2', 'get_photo_booth_event_summary', { eventId: parsed.data.eventId });
      },
      textMessage(goodAnswer),
    ]);

    const result = await answerPhotoBoothQuestion('How did the latest photo booth event go?', {
      analytics: makeClient(fetchImpl),
      anthropic: client,
      model: 'test-model',
    });

    assert.equal(result.answer, goodAnswer);
    assert.equal(result.source, 'model');
    assert.deepEqual(http.map((r) => r.body), [
      { operation: 'latest_event' },
      { operation: 'event_summary', eventId: EVENT_A },
    ]);
    assert.deepEqual(result.toolCalls.map((c) => c.name), ['get_latest_photo_booth_event', 'get_photo_booth_event_summary']);
    assert.equal(requests[0].system, PHOTO_BOOTH_SYSTEM_PROMPT);
    assert.deepEqual(requests[0].tools?.map((t) => (t as Anthropic.Tool).name), [...PHOTO_BOOTH_TOOL_NAMES]);
    for (const req of requests) assert.ok(!JSON.stringify(req).includes(SECRET));
  });

  it('does not repeat an identical API call within one question', async () => {
    const { fetchImpl, requests: http } = mockFetch();
    const { client } = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_latest_photo_booth_event', {}),
      textMessage('97 delivery sessions were created.'),
    ]);
    const result = await answerPhotoBoothQuestion('How many sessions did we have?', { analytics: makeClient(fetchImpl), anthropic: client });
    assert.equal(http.length, 1);
    assert.deepEqual(result.toolCalls.map((c) => c.cached), [false, true]);
  });

  it('passes upstream failures to the model as errors, not as data', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    const { client, requests } = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      textMessage('Photo Booth analytics is unavailable right now: the reporting credentials were rejected.'),
    ]);
    const result = await answerPhotoBoothQuestion('How did the booth perform?', { analytics: makeClient(fetchImpl), anthropic: client });
    const [toolResult] = toolResultsIn(requests[1]);
    assert.equal(toolResult.is_error, true);
    const parsed = JSON.parse(String(toolResult.content));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.kind, 'unauthorized');
    assert.equal(parsed.data, undefined);
    assert.equal(result.toolCalls[0].ok, false);
  });

  it('asks the model to revise an answer that overstates the telemetry', async () => {
    const { fetchImpl } = mockFetch();
    const { client, requests } = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage('97 people used the booth, 20 people followed us on Instagram, and we got 1 Google review. 9 uploads failed.'),
      textMessage(goodAnswer),
    ]);
    const result = await answerPhotoBoothQuestion('How did the latest event go?', { analytics: makeClient(fetchImpl), anthropic: client });
    assert.equal(result.source, 'model_revised');
    assert.equal(result.answer, goodAnswer);
    const rules = new Set(result.semanticViolations.map((v) => v.rule));
    for (const r of ['sessions_as_people', 'social_follows', 'google_reviews', 'unfinalized_as_failure']) assert.ok(rules.has(r as never), r);
    const revisionPrompt = requests[3].messages[requests[3].messages.length - 1];
    assert.match(String(revisionPrompt.content), /Revise your previous answer/);
  });

  it('falls back to the deterministic report if the revision still overstates', async () => {
    const { fetchImpl } = mockFetch();
    const { client } = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage('55 guests successfully saved their photos.'),
      textMessage('Again, 55 guests successfully saved their photos.'),
    ]);
    const result = await answerPhotoBoothQuestion('How did the latest event go?', { analytics: makeClient(fetchImpl), anthropic: client });
    assert.equal(result.source, 'deterministic_fallback');
    assert.equal(result.answer, describeEventSummary(eventSummary() as never));
    assert.deepEqual(findSemanticViolations(result.answer), []);
  });
});
