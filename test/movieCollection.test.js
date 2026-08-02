const test = require('node:test');
const assert = require('node:assert/strict');

const { detectMovieCollection } = require('../src/utils/mediaTitleParser');
const { MediaLibraryLayoutService } = require('../src/services/mediaLibraryLayout');

// 柯南剧场版合集：标题含"剧场版/电影/合集"，文件是独立电影命名（MovieNN + 各自年份）
const CONAN_TITLE = '【日漫电影】名侦探柯南剧场版01-26合集(1997-2023)1080P蓝光收藏版 国粤日三语音轨 内封简繁日字幕 TrueHD5.1【211.78GB】(根)';
const CONAN_FILES = [
    { id: '1', name: "Detective.Conan.Movie01.The.Time.Bombed.Skyscraper.1997.BluRay.1080p.x265-CHD.mkv" },
    { id: '2', name: "Detective.Conan.Movie02.The.Fourteenth.Target.1998.BluRay.1080p.x265-CHD.mkv" },
    { id: '3', name: "Detective.Conan.Movie10.The.Private.Eyes.Requiem.2006.BluRay.1080p.x265-CHD.mkv" },
    { id: '4', name: "Detective.Conan.Movie26.Black.Iron.Submarine.2023.BluRay.1080p.x265-CHD.mkv" }
];

test('detectMovieCollection: 柯南剧场版合集判为电影合集', () => {
    const result = detectMovieCollection(CONAN_TITLE, CONAN_FILES);
    assert.equal(result.isMovieCollection, true);
    // 每个文件解析出各自独立的年份
    const years = CONAN_FILES.map((f) => result.perFileNames.get(f.name).year);
    assert.deepEqual(years, [1997, 1998, 2006, 2023]);
});

test('detectMovieCollection: 普通剧集（多文件带 SxxExx）不是电影合集', () => {
    const files = [
        { id: '1', name: '光阴之外.S01E30.2025.2160p.WEB-DL.mkv' },
        { id: '2', name: '光阴之外.S01E31.2025.2160p.WEB-DL.mkv' }
    ];
    const result = detectMovieCollection('光阴之外 全31集 4K', files);
    assert.equal(result.isMovieCollection, false);
});

test('detectMovieCollection: 含"电影"字样的剧集被文件级季集证据否决', () => {
    // "电影少女"是剧集，标题含"电影"，但文件带 SxxExx → 不能误判为电影合集
    const files = [
        { id: '1', name: '电影少女.S01E01.mkv' },
        { id: '2', name: '电影少女.S01E02.mkv' }
    ];
    const result = detectMovieCollection('电影少女 2018 全12集', files);
    assert.equal(result.isMovieCollection, false);
});

test('detectMovieCollection: 标题含"合集"但无电影信号、文件无年份 → 不判合集', () => {
    const files = [
        { id: '1', name: 'Some.Show.E01.mkv' },
        { id: '2', name: 'Some.Show.E02.mkv' }
    ];
    // 标题有"合集"但文件既无 Movie 字样也无年份 → 证据不足
    const result = detectMovieCollection('某资源合集', files);
    assert.equal(result.isMovieCollection, false);
});

test('detectMovieCollection: 单文件永远不是合集', () => {
    const result = detectMovieCollection(CONAN_TITLE, [CONAN_FILES[0]]);
    assert.equal(result.isMovieCollection, false);
});

test('resolveLibraryInfo 确定性分支: 电影合集判 movie 且逐文件独立命名', async () => {
    const service = new MediaLibraryLayoutService(); // 无 taskService/tmdbService → 走确定性分支
    const libraryInfo = await service.resolveLibraryInfo({
        resourceName: CONAN_TITLE,
        files: CONAN_FILES,
        task: null,
        forceRefresh: true,
        useAi: false
    });

    assert.equal(libraryInfo.mediaType, 'movie');
    assert.equal(libraryInfo.seasonBased, false);
    assert.equal(libraryInfo.categoryName, '电影');
    // 每个 episode 条目带各自独立的年份
    const yearById = new Map((libraryInfo.resourceInfo.episode || []).map((ep) => [ep.id, ep.year]));
    assert.equal(yearById.get('1'), 1997);
    assert.equal(yearById.get('4'), 2023);
});

test('resolveLibraryInfo 确定性分支: 普通多文件剧集仍判 tv', async () => {
    const service = new MediaLibraryLayoutService();
    const files = [
        { id: '1', name: '金关.S01E14.2026.WEB-DL.mkv' },
        { id: '2', name: '金关.S01E15.2026.WEB-DL.mkv' }
    ];
    const libraryInfo = await service.resolveLibraryInfo({
        resourceName: '金关 (2026) 全30集',
        files,
        task: null,
        forceRefresh: true,
        useAi: false
    });
    assert.equal(libraryInfo.mediaType, 'tv');
    assert.equal(libraryInfo.seasonBased, true);
});

test('buildFileName: movie 合集使用文件自己的年份', () => {
    const service = new MediaLibraryLayoutService();
    const libraryInfo = { mediaType: 'movie', categoryName: '电影', canonicalTitle: '名侦探柯南剧场版合集', year: '1997', resourceFolderName: '名侦探柯南剧场版合集 (1997)' };
    const resourceInfo = { name: '名侦探柯南剧场版合集', year: '1997', type: 'movie' };
    const aiFile = { name: 'Detective Conan Movie10', year: 2006, season: '01', episode: '03', extension: '.mkv' };
    const fileName = service.buildFileName({ name: 'x.mkv' }, aiFile, resourceInfo, libraryInfo);
    // 默认 movieTemplate: {name} ({year}){ext} → 用 aiFile.year=2006 而非合集 1997
    assert.match(fileName, /2006/);
    assert.doesNotMatch(fileName, /1997/);
});

test('applyLayoutToFiles: 锁定布局缺 episode 数据时电影仍逐文件独立命名', () => {
    // 生产 bug 场景：懒任务第二次 resolveLibraryInfo 命中锁定布局，
    // 序列化后的布局不含 resourceInfo/episode 数组 → episodeMap 为空。
    // 电影兜底分支必须用文件自己的标题/年份，否则全部碰撞成"版本N"。
    const service = new MediaLibraryLayoutService();
    const lockedInfo = {
        mediaType: 'movie', categoryName: '电影', seasonBased: false,
        canonicalTitle: '名侦探柯南剧场版合集', year: '1997',
        resourceFolderName: '名侦探柯南剧场版合集 (1997)', locked: true
    };
    const files = [
        { id: '1', name: 'Detective.Conan.Movie01.The.Time-Bombed.Skyscraper.1997.BluRay.1080p.x265-CHD.mkv' },
        { id: '2', name: 'Detective.Conan.Movie10.The.Private.Eyes.Requiem.2006.BluRay.1080p.x265-CHD.mkv' }
    ];
    const applied = service.applyLayoutToFiles({
        localStrmPrefix: '', libraryInfo: lockedInfo, resourceInfo: null, files
    });
    const names = applied.files.map((f) => f.name);
    assert.ok(names[0].includes('1997'), `第1个应含 1997: ${names[0]}`);
    assert.ok(names[1].includes('2006'), `第2个应含 2006: ${names[1]}`);
    assert.notEqual(names[0], names[1], '两个文件名不应相同（碰撞）');
    // 电影无 Season 目录
    assert.equal(applied.files[0].relativeDir, '');
});

test('AI 路径: 电影合集跳过任务级 TMDB 锚定，但逐文件匹配 TMDB', async () => {
    // 生产 bug 场景：AI 判对 movie 后走 TMDB 锚定，searchMovie("名侦探柯南")
    // 命中第一部剧场版（计时引爆摩天楼），把合集文件夹名改成那一部的标题。
    // 修复后：合集跳过任务级锚定（_resolveTmdb），但逐文件 searchMovie 匹配各自的 TMDB 条目。
    const searchedTitles = [];
    const fakeTaskService = {
        _analyzeResourceInfo: async () => ({
            name: '名侦探柯南剧场版合集', year: 1997, type: 'movie', season: '01',
            episode: CONAN_FILES.map((f, i) => ({
                id: f.id, name: '名侦探柯南剧场版合集', season: '01',
                episode: String(i + 1).padStart(2, '0'), extension: '.mkv'
            }))
        })
    };
    const fakeTmdbService = {
        searchMovie: async (title) => {
            searchedTitles.push(title);
            return { id: 21422, title: '名侦探柯南：计时引爆摩天楼', type: 'movie', posterPath: '/poster.jpg' };
        },
        searchTV: async () => null
    };
    const service = new MediaLibraryLayoutService({ taskService: fakeTaskService, tmdbService: fakeTmdbService });
    const libraryInfo = await service.resolveLibraryInfo({
        resourceName: CONAN_TITLE,
        files: CONAN_FILES,
        task: null,
        forceRefresh: true,
        useAi: true
    });
    // 任务级锚定不应发生：文件夹名保留合集标题，tmdbId 为空
    assert.equal(libraryInfo.tmdbId, '', '不应锚定到单一 TMDB 条目');
    assert.equal(libraryInfo.mediaType, 'movie');
    assert.ok(libraryInfo.resourceFolderName.includes('合集'), `文件夹名应含"合集": ${libraryInfo.resourceFolderName}`);
    assert.ok(!libraryInfo.resourceFolderName.includes('计时引爆'), `文件夹名不应是单部标题: ${libraryInfo.resourceFolderName}`);
    // 逐文件 TMDB 匹配应发生：files 数组存在且每条有 tmdbId
    assert.ok(Array.isArray(libraryInfo.files), '应有 files 数组');
    assert.equal(libraryInfo.files.length, CONAN_FILES.length);
    assert.ok(libraryInfo.files.every((f) => f.tmdbId === '21422'), '每个文件应有 tmdbId');
    assert.ok(searchedTitles.length > 0, '应触发逐文件 searchMovie');
});

test('normalizeLibraryInfo: 合集保留 files 数组，非合集省略', () => {
    const service = new MediaLibraryLayoutService();
    const files = [{ id: '1', name: 'x', tmdbId: '21422', tmdbTitle: 't', posterPath: '/p.jpg' }];
    // 合集：files 应保留
    const withFiles = service.normalizeLibraryInfo({ mediaType: 'movie', canonicalTitle: '合集', files });
    assert.deepEqual(withFiles.files, files);
    // 非合集：files 省略（不影响现有序列化）
    const withoutFiles = service.normalizeLibraryInfo({ mediaType: 'movie', canonicalTitle: '单部电影' });
    assert.equal(withoutFiles.files, undefined);
    // 空 files 数组也省略
    const emptyFiles = service.normalizeLibraryInfo({ mediaType: 'movie', canonicalTitle: 'x', files: [] });
    assert.equal(emptyFiles.files, undefined);
});

test('确定性路径: 合集逐文件 TMDB 解析（useAi=false）', async () => {
    const fakeTmdbService = {
        searchMovie: async (title, year) => ({ id: 99999, title: `匹配:${title}`, posterPath: '/poster.jpg', type: 'movie' })
    };
    const service = new MediaLibraryLayoutService({ tmdbService: fakeTmdbService });
    const libraryInfo = await service.resolveLibraryInfo({
        resourceName: CONAN_TITLE,
        files: CONAN_FILES,
        task: null,
        forceRefresh: true,
        useAi: false // 走确定性分支
    });
    assert.equal(libraryInfo.mediaType, 'movie');
    assert.ok(Array.isArray(libraryInfo.files), '确定性路径也应产出 files 数组');
    assert.equal(libraryInfo.files.length, CONAN_FILES.length);
    assert.ok(libraryInfo.files.every((f) => f.tmdbId === '99999'), '每个文件应有 tmdbId');
    // 每个文件的 tmdbTitle 来自各自的独立标题
    assert.ok(libraryInfo.files[0].tmdbTitle.startsWith('匹配:'), 'tmdbTitle 应来自逐文件搜索');
});

test('AI 分块: 超过 40 部的电影合集保留后续文件标题和年份', async () => {
    const aiService = require('../src/services/ai');
    const originalChat = aiService.chat;
    const originalIsEnabled = aiService.isEnabled;

    try {
        aiService.isEnabled = () => true;
        let callCount = 0;
        aiService.chat = async () => ({
            success: true,
            data: JSON.stringify(++callCount === 1
                ? {
                    name: '电影合集', year: 2000, type: 'movie', season: '01',
                    episode: Array.from({ length: 40 }, (_, index) => ({
                        id: String(index + 1), name: `Film ${index + 1}`, year: 2000 + index,
                        season: '01', episode: String(index + 1), extension: '.mkv'
                    }))
                }
                : {
                    episode: [
                        { id: '41', name: 'Film 41', year: 2040, season: '01', episode: '41', extension: '.mkv' }
                    ]
                })
        });

        const result = await aiService.simpleChatCompletion(
            '电影合集',
            Array.from({ length: 41 }, (_, index) => ({
                id: String(index + 1),
                name: `Film.${index + 1}.${2000 + index}.mkv`
            }))
        );
        const last = result.data.episode.find((episode) => episode.id === '41');

        assert.equal(last.name, 'Film 41');
        assert.equal(last.year, 2040);
    } finally {
        aiService.chat = originalChat;
        aiService.isEnabled = originalIsEnabled;
    }
});
