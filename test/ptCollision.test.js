const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPtCollisionCandidates } = require('../src/services/ptService');

test('PT collision candidates preserve extension and add deterministic release identity', () => {
    assert.deepEqual(
        buildPtCollisionCandidates('Show - S01E01.mkv', {
            id: 42,
            title: '[Group] Show 1080p',
            subgroup: 'Group',
            resolution: '1080p'
        }),
        [
            'Show - S01E01.mkv',
            'Show - S01E01 [Group 1080p].mkv',
            'Show - S01E01 [Group 1080p release-42].mkv'
        ]
    );
});

test('PT collision candidates stay unique when release metadata is absent', () => {
    assert.deepEqual(
        buildPtCollisionCandidates('Movie.mp4', { id: 7, title: 'Movie' }),
        ['Movie.mp4', 'Movie [release-7].mp4']
    );
});
