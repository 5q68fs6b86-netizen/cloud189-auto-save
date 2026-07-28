/**
 * 统计 handler: /stats（新功能）
 */
const { send, typing } = require('../messaging');
const { statsCard } = require('../templates');
const { serializeCb } = require('../keyboards');
const { CB } = require('../constants');
const { friendlyError } = require('../errors');

async function handleStats(svc, msg) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        // 1. 状态分布
        const statusResults = await svc.taskRepo
            .createQueryBuilder('task')
            .select('task.status', 'status')
            .addSelect('COUNT(*)', 'cnt')
            .groupBy('task.status')
            .getRawMany();

        const statusCounts = {};
        statusResults.forEach(r => {
            statusCounts[r.status] = parseInt(r.cnt);
        });

        // 2. 近7天新增
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentCount = await svc.taskRepo
            .createQueryBuilder('task')
            .where('task.createdAt >= :date', { date: sevenDaysAgo.toISOString() })
            .getCount();

        // 3. 失败 TOP5
        const failedTasks = await svc.taskRepo.find({
            where: { status: 'failed' },
            order: { updatedAt: 'DESC' },
            take: 5,
        });

        const text = statsCard(statusCounts, recentCount, failedTasks);
        const keyboard = failedTasks.map(task => [{
            text: `🔁 重试 ${String(task.resourceName || `任务 #${task.id}`).substring(0, 24)}`,
            callback_data: serializeCb({ t: CB.TASK_RETRY, i: task.id }),
        }]);
        keyboard.push([{
            text: '🔄 刷新统计',
            callback_data: serializeCb({ t: CB.STATS_REFRESH }),
        }]);
        await send(svc.bot, chatId, text, { keyboard });
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

module.exports = { handleStats };
