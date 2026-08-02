const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMediaTitle, resolveTitleMeta, isAnimeStyle } = require('../src/utils/mediaTitleParser');

test('isAnimeStyle: 方括号堆叠判定为动漫', () => {
    assert.equal(isAnimeStyle('[MAI] Puella Magi Madoka Magica [08][Ma10p_2160p].mkv'), true);
    assert.equal(isAnimeStyle('[Nekomoe kissaten][20 Seiki Denki Mokuroku][04][1080p].mp4'), true);
    assert.equal(isAnimeStyle('【喵萌奶茶屋】★07月新番★[时光代理人][01][1080p].mp4'), true);
});

test('isAnimeStyle: 标准点分命名不是动漫', () => {
    assert.equal(isAnimeStyle('Detective.Conan.Movie10.2006.BluRay.mkv'), false);
    assert.equal(isAnimeStyle('光阴之外.S01E31.2025.2160p.WEB-DL.mkv'), false);
    assert.equal(isAnimeStyle('Some.Movie.2024.1080p.mkv'), false);
});

test('isAnimeStyle: " - 01 " 集号分隔判定为动漫', () => {
    assert.equal(isAnimeStyle('Frieren - Beyond Journeys End - 01 [1080p].mkv'), true);
});

test('parseMediaTitle: 动漫走 anitomy 解析出集号', () => {
    const p = parseMediaTitle('[MAI] Puella Magi Madoka Magica [08][Ma10p_2160p][x265_flac_aac_ass].mkv');
    assert.equal(p.episode, 8);
    assert.ok(p.cleanTitle.includes('Puella Magi Madoka Magica'), `标题应含作品名: ${p.cleanTitle}`);
    assert.ok(!p.cleanTitle.includes('MAI'), '标题不应含字幕组');
});

test('parseMediaTitle: 动漫中文标题 + 集号', () => {
    const p = parseMediaTitle('【喵萌奶茶屋】★07月新番★[时光代理人][01][1080p][简日双语].mp4');
    assert.equal(p.episode, 1);
    assert.ok(p.cleanTitle.includes('时光代理人'), `标题应含作品名: ${p.cleanTitle}`);
});

test('parseMediaTitle: 非动漫 SxxExx 不受影响', () => {
    const p = parseMediaTitle('光阴之外.S01E31.2025.2160p.WEB-DL.mkv');
    assert.equal(p.season, 1);
    assert.equal(p.episode, 31);
    assert.equal(p.year, 2025);
    assert.ok(p.cleanTitle.includes('光阴之外'), `标题: ${p.cleanTitle}`);
});

test('parseMediaTitle: 非动漫电影不受影响', () => {
    const p = parseMediaTitle('Detective.Conan.Movie10.2006.BluRay.mkv');
    assert.equal(p.year, 2006);
    assert.equal(p.episode, null);
});

test('resolveTitleMeta: 中文标题优先 + 文件名补年份', () => {
    const meta = resolveTitleMeta(
        { resourceName: '魔法少女小圆 系列合集(2011-2015)', shareFolderName: '2.魔法少女小圆 剧场版 前篇 起始的物语 [Kamigami&MAI]' },
        [{ name: '[MAI] Puella Magi Madoka Magica Movie 1 Beginnings (2012) [Ma10p_2160p].mkv' }]
    );
    // title 取中文目录名，year 取文件名的 2012（比父级 2011 精确）
    assert.ok(meta.title.includes('魔法少女小圆'), `title: ${meta.title}`);
    assert.equal(meta.year, 2012);
});

test('resolveTitleMeta: 纯英文资源回退文件标题', () => {
    const meta = resolveTitleMeta(
        { resourceName: 'Some.Movie.2024', shareFolderName: '' },
        [{ name: 'Some.Movie.2024.1080p.BluRay.mkv' }]
    );
    assert.ok(meta.title.length > 0, '应有标题');
    assert.equal(meta.year, 2024);
});

test('resolveTitleMeta: 动漫剧集文件名补集号', () => {
    const meta = resolveTitleMeta(
        { resourceName: '魔法少女小圆 (2011)', shareFolderName: '1.魔法少女小圆 [Kamigami&MAI]' },
        [{ name: '[MAI] Puella Magi Madoka Magica [08][Ma10p_2160p].mkv' }]
    );
    assert.equal(meta.episode, 8);
});
