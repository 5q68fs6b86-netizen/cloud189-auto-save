const test = require('node:test');
const assert = require('node:assert/strict');

const { PtRenameService } = require('../src/services/ptRename');

test('AI organized path uses TMDB canonical title for both directory and file', () => {
    const service = new PtRenameService();
    const result = service.organizePathByAi(
        { name: '二十世纪电气目录 - 喵萌奶茶屋' },
        { title: '[Nekomoe kissaten][20 Seiki Denki Mokuroku][04][1080p]' },
        { name: '[Nekomoe kissaten][20 Seiki Denki Mokuroku][04].mp4' },
        {},
        { name: '20 Seiki Denki Mokuroku', year: 2026, type: 'tv', season: '01' },
        { name: '20 Seiki Denki Mokuroku', season: '01', episode: '04', extension: '.mp4' },
        '动漫',
        {
            categoryName: '动漫',
            canonicalTitle: '二十世纪电气目录',
            resourceFolderName: '二十世纪电气目录 (2026)'
        }
    );

    assert.deepEqual(result, {
        dirName: '动漫/二十世纪电气目录 (2026)/Season 01',
        fileName: '二十世纪电气目录 - S01E04.strm'
    });
});

test('AI organized path keeps the AI title when TMDB metadata is unavailable', () => {
    const service = new PtRenameService();
    const result = service.organizePathByAi(
        { name: 'Fallback subscription' },
        { title: 'Fallback release' },
        { name: 'Fallback.Show.S02E03.mkv' },
        {},
        { name: 'Fallback Show', year: 2025, type: 'tv', season: '02' },
        { name: 'Fallback Show', season: '02', episode: '03', extension: '.mkv' }
    );

    assert.deepEqual(result, {
        dirName: '电视剧/Fallback Show (2025)/Season 02',
        fileName: 'Fallback Show - S02E03.strm'
    });
});

test('AI organized movie uses the canonical title without adding a second year', () => {
    const service = new PtRenameService();
    const result = service.organizePathByAi(
        { name: 'Movie subscription' },
        { title: 'Movie release' },
        { name: 'Original.Movie.2024.mkv' },
        {},
        { name: 'Original Movie', year: 2024, type: 'movie' },
        { name: 'Original Movie', extension: '.mkv' },
        '电影',
        {
            categoryName: '电影',
            canonicalTitle: '标准电影名',
            resourceFolderName: '标准电影名 (2024)'
        }
    );

    assert.deepEqual(result, {
        dirName: '电影/标准电影名 (2024)',
        fileName: '标准电影名 (2024).strm'
    });
});
