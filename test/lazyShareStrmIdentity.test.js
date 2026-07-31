const test = require('node:test');
const assert = require('node:assert/strict');

const { LazyShareStrmService } = require('../src/services/lazyShareStrm');
const { StreamProxyService } = require('../src/services/streamProxy');

function createService(files) {
    const service = Object.create(LazyShareStrmService.prototype);
    const cloud189 = {
        listFiles: async () => ({
            fileListAO: { fileList: files }
        })
    };
    return { service, cloud189 };
}

test('按源文件 MD5 和大小命中重命名后的目标文件', async () => {
    const { service, cloud189 } = createService([
        { id: 'target-1', name: '整理后的名称.mp4', md5: 'ABC123', size: 1024 }
    ]);

    const result = await service._findTransferredFile(cloud189, 'folder-1', {
        fileId: 'share-1',
        fileName: '整理后的名称.mp4',
        originalFileName: '分享原名.1080p.mp4',
        sourceMd5: 'abc123',
        sourceSize: 1024
    });

    assert.equal(result.id, 'target-1');
});

test('有源指纹时不因同名文件而误命中', async () => {
    const { service, cloud189 } = createService([
        { id: 'wrong', name: '整理后的名称.mp4', md5: 'DIFFERENT', size: 1024 }
    ]);

    const result = await service._findTransferredFile(cloud189, 'folder-1', {
        fileName: '整理后的名称.mp4',
        sourceMd5: 'ABC123',
        sourceSize: 1024
    });

    assert.equal(result, null);
});

test('同一源指纹对应多个目标文件时确定性选择目标 UFID', async () => {
    const { service, cloud189 } = createService([
        { id: 'target-2', name: 'b.mp4', md5: 'ABC123', size: 1024 },
        { id: 'target-1', name: 'a.mp4', md5: 'ABC123', size: 1024 }
    ]);

    const result = await service._findTransferredFile(cloud189, 'folder-1', {
        fileName: '整理后的名称.mp4',
        sourceMd5: 'ABC123',
        sourceSize: 1024
    });

    assert.equal(result.id, 'target-1');
});

test('CAS 已转存存根必须继续还原，不能直接返回存根', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    service.transferInflight = new Map();
    service._findTransferredFile = async () => ({ id: 'cas-target', name: 'video.mp4.cas' });
    service._restoreCasTransferredFile = async (_cloud189, _folderId, file) => ({
        id: 'restored-target',
        name: file.name.replace(/\.cas$/, '')
    });
    service._submitShareSaveTask = async () => {
        throw new Error('已有 CAS 存根时不应重复提交转存');
    };

    const result = await service._ensureTransferredFile({}, {
        accountId: 1,
        shareId: 'share-1',
        fileId: 'source-1',
        fileName: 'video.mp4.cas',
        originalFileName: 'video.mp4',
        isCas: true
    }, 'folder-1');

    assert.equal(result.id, 'restored-target');
});

test('分享目录收集保留源文件指纹', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    const cloud189 = {
        listShareDir: async () => ({
            fileListAO: {
                folderList: [],
                fileList: [{ id: 'source-1', name: 'video.mp4', md5: 'ABC123', size: 1024 }]
            }
        })
    };

    const files = await service._collectShareEntries(cloud189, {
        isFolder: true,
        fileId: 'root',
        shareId: 'share-1',
        shareMode: 1
    }, '');

    assert.equal(files[0].md5, 'ABC123');
    assert.equal(files[0].size, 1024);
});

test('播放 token 保留源文件指纹', () => {
    const service = Object.create(StreamProxyService.prototype);
    service._getSecret = () => 'test-secret';

    const token = service.buildToken({
        type: 'lazyShare',
        accountId: 1,
        shareId: 'share-1',
        shareMode: 5,
        fileId: 'source-1',
        fileName: '整理后的名称.mp4',
        sourceMd5: 'abc123',
        sourceSize: 1024
    });
    const payload = service.parseToken(token);

    assert.equal(payload.sourceMd5, 'ABC123');
    assert.equal(payload.sourceSize, 1024);
    assert.equal(payload.shareMode, 5);
});

test('PT subscription token 的直链身份和缓存键保持不变', () => {
    const service = Object.create(StreamProxyService.prototype);
    service._getSecret = () => 'test-secret';
    const payload = service.parseToken(service.buildToken({
        type: 'subscription',
        accountId: 7,
        fileId: 'pt-cloud-file',
        fileName: 'episode.mkv'
    }));

    assert.equal(payload.type, 'subscription');
    assert.equal(payload.fileId, 'pt-cloud-file');
    assert.equal(service._getCacheKey(payload), '7:direct:pt-cloud-file');
});
