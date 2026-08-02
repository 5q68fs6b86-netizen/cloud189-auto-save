const cron = require('node-cron');

function validateLazyFileCleanupSettings(settings = {}) {
    const taskSettings = settings.task || {};
    const retentionHours = Number(taskSettings.lazyFileRetentionHours);
    if (!Number.isFinite(retentionHours) || retentionHours < 1) {
        return '懒转存文件保留时长不能小于 1 小时';
    }
    if (!cron.validate(taskSettings.lazyFileCleanupCron || '')) {
        return '懒转存清理 Cron 表达式无效';
    }
    return null;
}

module.exports = { validateLazyFileCleanupSettings };
