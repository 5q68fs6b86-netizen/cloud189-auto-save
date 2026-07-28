const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeMediaTitle, rankSearchResults } = require('../src/services/tmdb');

test('TMDB ranking prefers an exact old title over a newer spin-off', () => {
    const results = [
        {
            id: 1,
            name: '名侦探柯南：犯人犯泽先生',
            original_name: '名探偵コナン 犯人の犯沢さん',
            first_air_date: '2022-10-04'
        },
        {
            id: 2,
            name: '名侦探柯南',
            original_name: '名探偵コナン',
            first_air_date: '1996-01-08'
        }
    ];

    const ranked = rankSearchResults(results, '名侦探柯南');

    assert.equal(ranked[0].media.id, 2);
});

test('TMDB ranking uses year to disambiguate identical titles', () => {
    const results = [
        { id: 1, name: '测试剧', first_air_date: '2024-01-01' },
        { id: 2, name: '测试剧', first_air_date: '1999-01-01' }
    ];

    const ranked = rankSearchResults(results, '测试剧', '1999');

    assert.equal(ranked[0].media.id, 2);
});

test('TMDB title normalization ignores punctuation, spacing and width', () => {
    assert.equal(normalizeMediaTitle('名侦探柯南：特别篇'), normalizeMediaTitle('名侦探柯南 特别篇'));
    assert.equal(normalizeMediaTitle('ＴＥＳＴ Show'), 'testshow');
});
