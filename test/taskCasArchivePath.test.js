const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTaskTargetRelativePath } = require('../src/services/task');

test('organized task CAS mirrors category, resource and media path', () => {
    assert.equal(
        buildTaskTargetRelativePath(
            { realFolderName: 'ignored' },
            { relativePath: 'Season 02/Show - S02E03.mkv' },
            { categoryName: '动漫', resourceFolderName: 'Show (2026)' }
        ),
        '动漫/Show (2026)/Season 02/Show - S02E03.mkv'
    );
});

test('regular task CAS keeps the task folder under selected target', () => {
    assert.equal(
        buildTaskTargetRelativePath(
            { targetFolderName: '媒体库', realFolderName: '媒体库/作品A' },
            { relativePath: 'Season 01/E01.mkv' }
        ),
        '作品A/Season 01/E01.mkv'
    );
    assert.equal(
        buildTaskTargetRelativePath(
            { targetFolderName: '媒体库', realFolderName: '作品B' },
            { name: 'Movie.mkv' }
        ),
        '作品B/Movie.mkv'
    );
});

test('root task does not duplicate the selected target folder', () => {
    assert.equal(
        buildTaskTargetRelativePath(
            { targetFolderName: '媒体库', realFolderName: '媒体库' },
            { relativePath: 'E01.mkv' }
        ),
        'E01.mkv'
    );
});
