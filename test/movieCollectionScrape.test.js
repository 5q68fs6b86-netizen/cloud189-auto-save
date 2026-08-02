const test = require('node:test');
const assert = require('node:assert/strict');

const { ScrapeService } = require('../src/services/ScrapeService');

test('合集刮削以标题和年份区分同年电影', async () => {
    const service = new ScrapeService();
    service._getStrmFiles = async () => ['Beta (2020).strm', 'Alpha (2020).strm'];
    service._parseStrmPath = () => ({ showDir: '/tmp' });
    service._generateFileIfNotExists = async () => {};
    const requestedIds = [];
    service.tmdb.getMovieDetails = async (id) => {
        requestedIds.push(String(id));
        return { id, title: String(id), cast: [], posterPath: null };
    };

    const result = await service._scrapeCollection('/tmp', [
        { name: 'Alpha', year: 2020, tmdbId: '1', organizedFileName: 'Alpha (2020).mkv' },
        { name: 'Beta', year: 2020, tmdbId: '2', organizedFileName: 'Beta (2020).mkv' }
    ]);

    assert.deepEqual(requestedIds, ['1', '2']);
    assert.equal(result.scraped, 2);
});
