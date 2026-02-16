import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './latest.js';

function makeRequest(query = '') {
  return new Request(`https://worldmonitor.app/api/youtube/latest${query}`);
}

const ORIGINAL_FETCH = globalThis.fetch;

test('rejects missing channel parameters', async () => {
  const response = await handler(makeRequest());
  assert.equal(response.status, 400);
});

test('returns latest video when channelId is provided', async () => {
  try {
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('feeds/videos.xml')) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <yt:videoId>abcDEF12345</yt:videoId>
              <title><![CDATA[Test Episode]]></title>
              <published>2026-02-16T00:00:00+00:00</published>
            </entry>
          </feed>`,
          { status: 200, headers: { 'Content-Type': 'application/xml' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const response = await handler(
      makeRequest('?channelId=UCZa18YV7qayTh-MRIrBhDpA'),
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.videoId, 'abcDEF12345');
    assert.equal(data.title, 'Test Episode');
    assert.equal(data.channelId, 'UCZa18YV7qayTh-MRIrBhDpA');
    assert.deepEqual(data.recentVideoIds, ['abcDEF12345']);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('resolves handle to channelId and returns latest video', async () => {
  try {
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/@lexfridman')) {
        return new Response(
          '<html><body>"channelId":"UCJIfeSCssxSC_Dhc5s7woww"</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      if (value.includes('feeds/videos.xml')) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <feed>
            <entry>
              <yt:videoId>YFjfBk8HI5o</yt:videoId>
              <title>Lex Latest</title>
              <published>2026-02-15T00:00:00+00:00</published>
            </entry>
          </feed>`,
          { status: 200, headers: { 'Content-Type': 'application/xml' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const response = await handler(makeRequest('?channel=@lexfridman'));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.videoId, 'YFjfBk8HI5o');
    assert.equal(data.channelId, 'UCJIfeSCssxSC_Dhc5s7woww');
    assert.deepEqual(data.recentVideoIds, ['YFjfBk8HI5o']);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});
