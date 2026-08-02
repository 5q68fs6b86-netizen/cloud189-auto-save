#!/usr/bin/env node
/**
 * 特别篇检测验证脚本：用 CloudSaver 搜索 20 个剧，创建懒转存任务，验证 STRM 输出。
 * 用法: node scripts/validate-specials.mjs
 * 前提: 服务运行在 localhost:3000，CloudSaver 已配置
 */

import { execSync } from 'child_process';

const BASE = process.env.CLOUD189_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.CLOUD189_API_KEY || '';
const STRM_ROOT = process.env.CLOUD189_STRM_ROOT || '/opt/cloud189/strm';
if (!API_KEY) {
    console.error('请设置环境变量 CLOUD189_API_KEY（服务配置 system.apiKey）');
    process.exit(1);
}
const HEADERS = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };
const POLL_INTERVAL = 5000; // 5s
const POLL_TIMEOUT = 90000; // 90s — 懒转存任务不会变 completed，改为等 STRM 出现

const ANIME = [
    '86不存在的战区', '弦音 风舞高中弓道部', 'WIXOSS DIVA', '无职转生',
    '葬送的芙莉莲', '咒术回战', '间谍过家家', '紫罗兰永恒花园',
    '进击的巨人', '鬼灭之刃'
];
const DRAMAS = [
    '庆余年', '狂飙', '三体', '漫长的季节', '繁花',
    '与凤行', '墨雨云间', '长相思', '凡人歌', '庶民样本'
];

async function api(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, { headers: HEADERS, ...opts });
    return res.json();
}

async function searchCloudSaver(keyword) {
    const data = await api(`/api/cloudsaver/search?keyword=${encodeURIComponent(keyword)}&mode=list`);
    if (!data.success || !Array.isArray(data.data)) return null;
    // 找第一个有天翼链接的结果
    for (const item of data.data) {
        const link = (item.cloudLinks || []).find(l => l.link?.includes('cloud.189.cn'));
        if (link) return { title: item.title, link: link.link, accessCode: link.accessCode || '' };
    }
    return null;
}

async function getAccountId() {
    const data = await api('/api/accounts');
    if (!data.success || !data.data?.length) throw new Error('无可用账号');
    return data.data[0].id;
}

async function getTargetFolderId(accountId) {
    // emby 目录 ID（已知）
    return '723831240465883674';
}

async function createTask(accountId, targetFolderId, shareLink, accessCode, title) {
    const body = {
        accountId,
        shareLink,
        accessCode,
        targetFolderId,
        taskName: title,
        enableOrganizer: true,
        enableLazyStrm: true,
        enableCron: false,
        taskGroup: '验证测试',
        remark: 'validate-specials 自动创建'
    };
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    if (!data.success) return { error: data.error };
    const tasks = data.data || [];
    return tasks.map(t => ({ id: t.id, name: t.resourceName }));
}

async function pollTask(taskId, taskName) {
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT) {
        // 查任务状态，拿到实际 resourceName 和 layout
        const data = await api('/api/tasks');
        const task = (data.data || []).find(t => t.id === taskId);
        if (task?.status === 'failed') {
            return { status: 'failed', error: task.lastError };
        }
        // 用任务的实际名称（organizer 产出的 canonical title）查 STRM
        const actualName = task?.resourceName || taskName;
        const strm = checkStrmTree(actualName);
        if (strm.found && (strm.season00.length + strm.season01.length + strm.other.length) > 0) {
            return { status: 'strm_ready', strm, actualName };
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return { status: 'timeout' };
}

function checkStrmTree(taskName) {
    try {
        const dirs = execSync(
            `find "${STRM_ROOT}" -maxdepth 3 -type d -name '*${taskName.replace(/'/g, '')}*' 2>/dev/null`,
            { encoding: 'utf8' }
        ).trim().split('\n').filter(Boolean);
        if (!dirs.length) return { found: false };

        const result = { found: true, season00: [], season01: [], other: [] };
        for (const dir of dirs) {
            const strms = execSync(
                `find "${dir}" -name '*.strm' 2>/dev/null`,
                { encoding: 'utf8' }
            ).trim().split('\n').filter(Boolean);
            for (const s of strms) {
                if (s.includes('Season 00')) result.season00.push(s.split('/').pop());
                else if (s.includes('Season 01')) result.season01.push(s.split('/').pop());
                else result.other.push(s.split('/').pop());
            }
        }
        return result;
    } catch {
        return { found: false };
    }
}

async function main() {
    console.log('=== 特别篇检测验证 ===\n');

    const accountId = await getAccountId();
    const targetFolderId = await getTargetFolderId(accountId);
    console.log(`账号: ${accountId}, 目标目录: ${targetFolderId}\n`);

    const results = [];
    const createdTaskIds = [];

    for (const category of [['日漫', ANIME], ['国产剧', DRAMAS]]) {
        const [label, titles] = category;
        console.log(`\n--- ${label} ---`);

        for (const title of titles) {
            process.stdout.write(`  ${title}: `);

            // 1. 搜索
            const resource = await searchCloudSaver(title);
            if (!resource) {
                console.log('⏭ 无天翼源，跳过');
                results.push({ title, label, verdict: 'SKIP', reason: '无天翼源' });
                continue;
            }

            // 2. 创建任务
            const tasks = await createTask(accountId, targetFolderId, resource.link, resource.accessCode, title);
            if (tasks.error) {
                console.log(`❌ 创建失败: ${tasks.error}`);
                results.push({ title, label, verdict: 'FAIL', reason: tasks.error });
                continue;
            }

            // 3. 等待 STRM 生成
            for (const task of tasks) {
                createdTaskIds.push(task.id);
                const poll = await pollTask(task.id, task.name || title);
                const strm = poll.strm || checkStrmTree(task.name || title);

                let verdict = 'OK';
                let detail = '';

                if (poll.status === 'timeout') {
                    verdict = 'TIMEOUT';
                } else if (poll.status === 'failed') {
                    verdict = 'FAIL';
                    detail = poll.error || '';
                } else if (!strm.found) {
                    verdict = 'WARN';
                    detail = 'STRM 目录未找到';
                } else {
                    const s00 = strm.season00.length;
                    const s01 = strm.season01.length;
                    const other = strm.other.length;
                    detail = `S00:${s00} S01:${s01} 其他:${other}`;

                    if (label === '国产剧' && s00 > 0) {
                        verdict = 'WARN';
                        detail += ' (国产剧不应有 S00)';
                    }
                }

                const icon = verdict === 'OK' ? '✓' : verdict === 'WARN' ? '⚠' : verdict === 'SKIP' ? '⏭' : '❌';
                console.log(`${icon} ${verdict} ${detail}`);
                results.push({ title, label, verdict, reason: detail, taskId: task.id });
            }
        }
    }

    // 汇总
    console.log('\n=== 汇总 ===');
    console.log('标题 | 类型 | 结果 | 详情');
    console.log('---|---|---|---');
    for (const r of results) {
        console.log(`${r.title} | ${r.label} | ${r.verdict} | ${r.reason || ''}`);
    }

    const ok = results.filter(r => r.verdict === 'OK').length;
    const warn = results.filter(r => r.verdict === 'WARN').length;
    const fail = results.filter(r => r.verdict === 'FAIL').length;
    const skip = results.filter(r => r.verdict === 'SKIP').length;
    console.log(`\n总计: ${ok} OK, ${warn} WARN, ${fail} FAIL, ${skip} SKIP`);

    // 清理提示
    if (createdTaskIds.length) {
        console.log(`\n清理: 删除 ${createdTaskIds.length} 个测试任务`);
        console.log(`  curl -X DELETE -H 'x-api-key: ${API_KEY}' -H 'Content-Type: application/json' \\`);
        console.log(`    -d '{"taskIds":[${createdTaskIds.join(',')}],"deleteCloud":true}' \\`);
        console.log(`    ${BASE}/api/tasks/batch`);
    }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
