/**
 * 消息模板 —— 统一 HTML 格式
 */
const { escapeHtml, bold, code, link } = require('./escape');
const { TASK_STATUS } = require('./constants');

/**
 * 格式化任务状态
 */
function formatStatus(status) {
    const statusMap = {
        [TASK_STATUS.PENDING]: '⏳ 等待执行',
        [TASK_STATUS.PROCESSING]: '🔄 追剧中',
        [TASK_STATUS.COMPLETED]: '✅ 已完结',
        [TASK_STATUS.FAILED]: '❌ 失败',
    };
    return statusMap[status] || status;
}

/**
 * 脱敏用户名
 */
function desensitizeUsername(username) {
    if (!username) return '未知账号';
    if (username.length <= 6) return username.substring(0, 1) + '****';
    return username.replace(/(.{3}).*(.{4})/, '$1****$2');
}

/**
 * 任务列表卡片
 */
function taskCard(task) {
    const name = task.resourceName || '未命名';
    const episodes = `${task.currentEpisodes || 0}${task.totalEpisodes ? '/' + task.totalEpisodes : ''} 集`;
    const status = formatStatus(task.status);
    const updated = task.lastFileUpdateTime
        ? new Date(task.lastFileUpdateTime).toLocaleString('zh-CN')
        : '-';

    return (
        `📺 ${bold(name)}\n` +
        `⏱ 进度：${escapeHtml(episodes)}\n` +
        `🔄 状态：${status}\n` +
        `⌚️ 更新：${escapeHtml(updated)}\n` +
        `🆔 ID：${task.id}`
    );
}

/**
 * 任务详情卡片（完整字段）
 */
function taskDetailCard(task) {
    const name = task.resourceName || '未命名';
    const status = formatStatus(task.status);
    const episodes = `${task.currentEpisodes || 0}${task.totalEpisodes ? '/' + task.totalEpisodes : ''} 集`;
    const created = task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN') : '-';
    const updated = task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN') : '-';
    const lastFile = task.lastFileUpdateTime ? new Date(task.lastFileUpdateTime).toLocaleString('zh-CN') : '-';
    const lastErr = task.lastError ? escapeHtml(task.lastError.substring(0, 200)) : '无';
    const retries = task.retryCount || 0;
    const remark = task.remark ? escapeHtml(task.remark) : '-';
    const shareLink = task.shareLink || '-';

    return (
        `📺 ${bold(name)}\n\n` +
        `🆔 ID：${task.id}\n` +
        `🔄 状态：${status}\n` +
        `⏱ 进度：${escapeHtml(episodes)}\n` +
        `🔗 分享链接：${code(shareLink)}\n` +
        `📂 目标文件夹ID：${code(task.targetFolderId || '-')}\n` +
        `📝 备注：${remark}\n` +
        `🔁 重试次数：${retries}\n` +
        `❗ 最后错误：${lastErr}\n` +
        `📅 创建时间：${escapeHtml(created)}\n` +
        `📅 更新时间：${escapeHtml(updated)}\n` +
        `📅 最后文件更新：${escapeHtml(lastFile)}`
    );
}

/**
 * 统计信息卡片
 */
function statsCard(statusCounts, recentCount, failedTasks) {
    let text = `📊 ${bold('系统统计')}\n\n`;

    text += `📋 ${bold('任务状态分布')}\n`;
    for (const [status, count] of Object.entries(statusCounts)) {
        text += `  ${formatStatus(status)}：${count}\n`;
    }

    text += `\n📈 最近 7 天新增任务：${recentCount}\n`;

    if (failedTasks && failedTasks.length > 0) {
        text += `\n❌ ${bold('最近失败任务 TOP5')}\n`;
        failedTasks.forEach((task, i) => {
            const name = escapeHtml(task.resourceName || '未命名');
            const err = task.lastError
                ? escapeHtml(task.lastError.substring(0, 60))
                : '未知错误';
            text += `  ${i + 1}. ${name}\n     ${err}\n`;
        });
    }

    return text;
}

/**
 * 帮助文本
 */
function helpText() {
    return (
        `🤖 ${bold('天翼云盘机器人使用指南')}\n\n` +
        `全部功能已放在下方按钮菜单中，无需记忆命令。\n\n` +
        `📋 ${bold('任务')}：查看各状态任务，并通过按钮执行、重试、生成 STRM、刷新 Emby、看日志或删除。\n` +
        `🔍 ${bold('搜索')}：支持 CloudSaver、影巢、PT 与 TMDB。\n` +
        `📺 ${bold('追剧')}：点击普通追剧或懒转存追剧后输入剧名和年份。\n` +
        `📁 ${bold('目录')}：查看、添加和删除常用目录。\n` +
        `📡 ${bold('订阅')}：查看分享订阅和 PT 订阅。\n\n` +
        `创建转存任务仍可直接发送天翼云盘分享链接（支持访问码）。`
    );
}

/**
 * 常用目录列表文本
 */
function commonFolderList(folders, username) {
    const user = desensitizeUsername(username);
    if (!folders || folders.length === 0) {
        return `当前账号: ${escapeHtml(user)}\n未找到常用目录，请先添加常用目录`;
    }
    const list = folders.map(f => `📁 ${escapeHtml(f.path)}`).join('\n\n');
    return `当前账号: ${escapeHtml(user)}\n常用目录列表：\n\n${list}`;
}

/**
 * CloudSaver 搜索结果
 */
function searchResults(results) {
    const header = `💡 以下资源来自 CloudSaver\n📝 共找到 ${results.length} 个结果，输入编号可转存\n\n`;
    const items = results.map((item, index) =>
        `${index + 1}. 🎬 ${link(item.title, item.cloudLinks[0].link)}`
    ).join('\n\n');
    return header + items;
}

/**
 * PT Release 状态格式化
 */
function ptStatusFormat(status) {
    const map = {
        pending: '⏳ 排队中',
        downloading: '⬇️ 下载中',
        downloaded: '📦 已下载',
        uploading: '☁️ 秒传中',
        completed: '✅ 已完成',
        failed: '❌ 失败',
        upload_failed: '❌ 秒传失败',
    };
    return map[status] || status;
}

function parsePtMissingEpisodes(sub) {
    try {
        const parsed = JSON.parse(sub.missingEpisodesJson || '[]');
        return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch (_) {
        return [];
    }
}

/**
 * PT 订阅卡片
 */
function ptSubCard(sub, index) {
    const status = sub.enabled ? '✅ 启用' : '❌ 禁用';
    const lastCheck = sub.lastCheckTime
        ? new Date(sub.lastCheckTime).toLocaleString('zh-CN')
        : '从未';
    const lastStatus = sub.lastStatus === 'ok' ? '✅ 正常' : sub.lastStatus === 'error' ? '❌ 异常' : '未知';
    const progress = sub.totalEpisodeNumber > 0
        ? `${sub.currentEpisodeNumber || 0}/${sub.totalEpisodeNumber}`
        : '';
    const missing = parsePtMissingEpisodes(sub);
    const missingLine = missing.length
        ? `   缺集：${escapeHtml(missing.slice(0, 10).join(', '))}${missing.length > 10 ? '...' : ''}\n`
        : '';

    return (
        `${index != null ? `${index}. ` : ''}📡 ${bold(escapeHtml(sub.name))}\n` +
        `   来源：${escapeHtml(sub.sourcePreset)}\n` +
        `   状态：${status}\n` +
        `   季集去重：${sub.episodeDedup ? '✅ 开启' : '❌ 关闭'}${sub.coexist ? ' / 共存' : ''}\n` +
        `   最新批次：${sub.downloadNew ? '✅ 开启' : '❌ 关闭'}\n` +
        (progress ? `   进度：${escapeHtml(progress)}\n` : '') +
        missingLine +
        `   最后检查：${escapeHtml(lastCheck)}\n` +
        `   检查结果：${lastStatus}\n` +
        `   Release 数：${sub.releaseCount || 0}`
    );
}

/**
 * PT Release 卡片
 */
function ptReleaseCard(rel, index) {
    const status = ptStatusFormat(rel.status);
    const progress = (rel.status === 'downloading' || rel.status === 'uploading') && rel.progress > 0
        ? ` (${rel.progress}%)`
        : '';
    const updated = rel.updatedAt
        ? new Date(rel.updatedAt).toLocaleString('zh-CN')
        : '-';
    const episode = rel.episodeLabel
        ? `S${String(rel.seasonNumber || 1).padStart(2, '0')}E${rel.episodeLabel}`
        : '';
    const meta = [rel.subgroup, episode, rel.resolution, rel.quality].filter(Boolean).join(' · ');
    const metaLine = meta ? `   ${escapeHtml(meta)}\n` : '';
    const error = rel.lastError ? `\n   ❗ ${escapeHtml(rel.lastError.substring(0, 100))}` : '';

    return (
        `${index != null ? `${index}. ` : ''}${bold(escapeHtml(rel.title))}\n` +
        metaLine +
        `   状态：${status}${progress}\n` +
        `   更新：${escapeHtml(updated)}${error}`
    );
}

module.exports = {
    formatStatus,
    desensitizeUsername,
    taskCard,
    taskDetailCard,
    statsCard,
    helpText,
    commonFolderList,
    searchResults,
    ptStatusFormat,
    ptSubCard,
    ptReleaseCard,
};
