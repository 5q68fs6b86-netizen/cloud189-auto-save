const test = require('node:test');
const assert = require('node:assert/strict');

const { validateLazyFileCleanupSettings } = require('../src/utils/settingsValidation');

test('懒转存清理设置允许自定义 Cron', () => {
    assert.equal(validateLazyFileCleanupSettings({
        task: {
            lazyFileRetentionHours: 48,
            lazyFileCleanupCron: '15 3 * * 1-5'
        }
    }), null);
});

test('懒转存清理设置拒绝小于 1 小时的保留时长', () => {
    assert.equal(validateLazyFileCleanupSettings({
        task: {
            lazyFileRetentionHours: 0,
            lazyFileCleanupCron: '0 3 * * *'
        }
    }), '懒转存文件保留时长不能小于 1 小时');
});

test('懒转存清理设置拒绝无效 Cron', () => {
    assert.equal(validateLazyFileCleanupSettings({
        task: {
            lazyFileRetentionHours: 24,
            lazyFileCleanupCron: '每天凌晨三点'
        }
    }), '懒转存清理 Cron 表达式无效');
});
