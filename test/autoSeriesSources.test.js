const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSourcePreferences } = require('../src/services/autoSeries');
const { PtService } = require('../src/services/ptService');

test('auto series source preferences preserve order, remove duplicates and fill missing sources', () => {
    assert.deepEqual(normalizeSourcePreferences([
        { source: 'pt', enabled: true },
        { source: 'cloudsaver', enabled: false },
        { source: 'pt', enabled: false },
        { source: 'invalid', enabled: true }
    ]), [
        { source: 'pt', enabled: true },
        { source: 'cloudsaver', enabled: false },
        { source: 'hdhive', enabled: true }
    ]);
});

test('PT deterministic ranking prefers high quality episodic samples', () => {
    const service = new PtService();
    const highQuality = {
        items: [
            { title: '测试剧 S01E01 2160p HDR BluRay', episodeNumber: 1 },
            { title: '测试剧 S01E02 2160p HDR BluRay', episodeNumber: 2 }
        ]
    };
    const lowQuality = {
        items: [
            { title: '测试剧 预告 720p' },
            { title: '测试剧 sample 720p' }
        ]
    };

    assert.ok(
        service._scoreAutoSeriesCandidate(highQuality, '测试剧', null)
        > service._scoreAutoSeriesCandidate(lowQuality, '测试剧', null)
    );
});
