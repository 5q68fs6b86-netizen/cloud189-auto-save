const test = require('node:test');
const assert = require('node:assert/strict');

const { EmbyService } = require('../src/services/emby');

function createService() {
    const service = Object.create(EmbyService.prototype);
    service.embyPathReplace = '';
    service._strmService = {
        resolveTaskStrmRoot: () => '电影/名侦探柯南：百万美元的五棱星 (2024)'
    };
    return service;
}

test('整理器任务按实际 STRM 布局通知 Emby', () => {
    const service = createService();
    const result = service._resolveNotifyPath({
        enableOrganizer: true,
        libraryLayout: '{"mediaType":"movie"}',
        realFolderName: 'emby/发布标题',
        account: { localStrmPrefix: '/strm' }
    });

    assert.equal(result, '/strm/电影/名侦探柯南：百万美元的五棱星 (2024)');
});

test('STRM 子前缀不会在 Emby 路径中重复', () => {
    const service = createService();
    service._strmService.resolveTaskStrmRoot = () => 'emby/电影/作品A (2024)';

    assert.equal(service._resolveNotifyPath({
        enableOrganizer: true,
        libraryLayout: '{"mediaType":"movie"}',
        account: { localStrmPrefix: '/strm/emby' }
    }), '/strm/emby/电影/作品A (2024)');
});

test('普通任务继续使用云盘到 Emby 的路径映射', () => {
    const service = createService();
    service.embyPathReplace = 'emby:/media';

    assert.equal(service._resolveNotifyPath({
        enableOrganizer: false,
        realFolderName: 'emby/作品A'
    }), '/media/作品A');
});
