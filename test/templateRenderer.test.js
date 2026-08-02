const test = require('node:test');
const assert = require('node:assert/strict');

const { renderFileName, migrateTemplate } = require('../src/utils/templateRenderer');

test('migrateTemplate: 旧电影模板迁移为条件渲染', () => {
    assert.equal(migrateTemplate('{name} ({year}){ext}'), '{{name}}{% if year %} ({{year}}){% endif %}{{ext}}');
});

test('migrateTemplate: 旧剧集模板迁移', () => {
    assert.equal(migrateTemplate('{name} - {se}{ext}'), '{{name}} - {{se}}{{ext}}');
});

test('renderFileName: 新格式条件渲染（有年份）', () => {
    const result = renderFileName('{{name}}{% if year %} ({{year}}){% endif %}{{ext}}', { name: '柯南', year: 2006, ext: '.mkv' });
    assert.equal(result, '柯南 (2006).mkv');
});

test('renderFileName: 新格式条件渲染（无年份不留空括号）', () => {
    const result = renderFileName('{{name}}{% if year %} ({{year}}){% endif %}{{ext}}', { name: '柯南', year: '', ext: '.mkv' });
    assert.equal(result, '柯南.mkv');
});

test('renderFileName: 剧集模板', () => {
    const result = renderFileName('{{name}} - {{se}}{{ext}}', { name: '小圆', se: 'S01E08', ext: '.mkv' });
    assert.equal(result, '小圆 - S01E08.mkv');
});

test('renderFileName: 旧格式自动迁移（电影有年份）', () => {
    const result = renderFileName('{name} ({year}){ext}', { name: '柯南', year: 2006, ext: '.mkv' });
    assert.equal(result, '柯南 (2006).mkv');
});

test('renderFileName: 旧格式自动迁移（电影无年份）', () => {
    const result = renderFileName('{name} ({year}){ext}', { name: '柯南', year: '', ext: '.mkv' });
    assert.equal(result, '柯南.mkv');
});

test('renderFileName: 旧格式自动迁移（剧集）', () => {
    const result = renderFileName('{name} - {se}{ext}', { name: '小圆', se: 'S01E08', ext: '.mkv' });
    assert.equal(result, '小圆 - S01E08.mkv');
});

test('renderFileName: 已是 nunjucks格式不二次迁移', () => {
    const result = renderFileName('{{name}}{% if year %} ({{year}}){% endif %}{{ext}}', { name: '柯南', year:2006, ext: '.mkv' });
    assert.equal(result, '柯南 (2006).mkv');
});

test('renderFileName: 模板语法错误回退简单拼接', () => {
    const result = renderFileName('{{name} {% invalid %}', { name: '柯南', year: 2006, ext: '.mkv' });
    assert.ok(result.includes('柯南'), `回退应含标题: ${result}`);
});
