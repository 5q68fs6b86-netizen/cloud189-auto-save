const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PtSourceService,
    DEFAULT_MIKAN_BASE_URL,
    buildMikanBaseUrls,
    normalizeMikanBaseUrl
} = require('../src/services/ptSource');

test('Mikan base URL is normalized without a trailing slash', () => {
    assert.equal(
        normalizeMikanBaseUrl(' https://mikanime.tv/ '),
        'https://mikanime.tv'
    );
    assert.equal(normalizeMikanBaseUrl(''), DEFAULT_MIKAN_BASE_URL);
});

test('custom Mikan base URL is preferred and fallback URLs stay unique', () => {
    const urls = buildMikanBaseUrls('https://example.com/mikan/');
    assert.equal(urls[0], 'https://example.com/mikan');
    assert.equal(urls[1], DEFAULT_MIKAN_BASE_URL);
    assert.equal(new Set(urls).size, urls.length);
});

test('Mikan base URL rejects credentials and query parameters', () => {
    assert.throws(() => normalizeMikanBaseUrl('ftp://mikan.example.com'), /HTTP\(S\)/);
    assert.throws(() => normalizeMikanBaseUrl('https://user:pass@mikan.example.com'), /HTTP\(S\)/);
    assert.throws(() => normalizeMikanBaseUrl('https://mikan.example.com/?token=1'), /查询参数/);
});

test('DMHY groups use the native publisher RSS instead of treating author as a title keyword', async () => {
    const service = new PtSourceService();
    service._fetch = async (url) => {
        if (url.includes('/topics/view/123.html')) {
            return '<a href="/topics/list/user_id/32769">CAMOE</a>';
        }
        return `
            <rss><channel><item>
                <title><![CDATA[[CAMOE] 魔法少女小圆 01]]></title>
                <link>https://share.dmhy.org/topics/view/123.html</link>
                <author><![CDATA[CAMOE]]></author>
                <guid>https://share.dmhy.org/topics/view/123.html</guid>
            </item></channel></rss>
        `;
    };

    const [result] = await service._searchDmhy('魔法少女小圆');

    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].name, 'CAMOE');
    assert.equal(
        result.groups[0].rssUrl,
        'https://share.dmhy.org/topics/rss/user_id/32769/rss/rss.xml?keyword=%E9%AD%94%E6%B3%95%E5%B0%91%E5%A5%B3%E5%B0%8F%E5%9C%86'
    );
});

test('AnimeGarden searches resources and returns directly usable RSS groups', async () => {
    const service = new PtSourceService();
    service._fetchJSON = async () => ({
        resources: [{ title: '魔法少女小圆 01', publisher: { name: 'LoliHouse' } }]
    });

    const [result] = await service._searchAnimeGarden('魔法少女小圆');

    assert.equal(result.directRss, true);
    assert.equal(result.itemCount, 1);
    assert.equal(result.preview[0], '魔法少女小圆 01');
    assert.equal(
        result.groups[0].rssUrl,
        'https://api.animes.garden/feed.xml?search=%E9%AD%94%E6%B3%95%E5%B0%91%E5%A5%B3%E5%B0%8F%E5%9C%86&publisher=LoliHouse'
    );
});

test('Nyaa group keeps the search RSS and adds an exact subgroup filter', async () => {
    const service = new PtSourceService();
    service._fetch = async () => `
        <rss><channel><item>
            <title><![CDATA[[LoliHouse] 魔法少女小圆 01]]></title>
            <guid>one</guid>
        </item></channel></rss>
    `;

    const [result] = await service._searchNyaa('魔法少女小圆');

    assert.equal(
        result.groups[0].rssUrl,
        'https://nyaa.si/?page=rss&q=%E9%AD%94%E6%B3%95%E5%B0%91%E5%A5%B3%E5%B0%8F%E5%9C%86'
    );
    assert.equal(result.groups[0].includePattern, '^\\[LoliHouse\\]');
});
