const test = require('node:test');
const assert = require('node:assert/strict');

const { TaskService } = require('../src/services/task');

test('重复触发同一任务时复用正在执行的 Promise', async () => {
    const service = Object.create(TaskService.prototype);
    service.activeTaskExecutions = new Map();
    let executeCount = 0;
    let releaseExecution;
    const gate = new Promise((resolve) => {
        releaseExecution = resolve;
    });
    service._processTaskInternal = async () => {
        executeCount++;
        await gate;
        return '执行完成';
    };

    const first = service.processTask({ id: 1, resourceName: '测试任务' });
    const second = service.processTask({ id: 1, resourceName: '测试任务' });
    releaseExecution();

    assert.deepEqual(await Promise.all([first, second]), ['执行完成', '执行完成']);
    assert.equal(executeCount, 1);
});

test('可等待 createTask 保存的首次执行 Promise', async () => {
    const service = Object.create(TaskService.prototype);
    service.initialTaskExecutions = new WeakMap();
    service.activeTaskExecutions = new Map();
    const task = { id: 2 };
    service.initialTaskExecutions.set(task, Promise.resolve('首次执行完成'));

    assert.equal(await service.waitForInitialTaskExecution(task), '首次执行完成');
});
