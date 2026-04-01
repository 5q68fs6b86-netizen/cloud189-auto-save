const path = require('path');
const cloud189Utils = require('../utils/Cloud189Utils');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const { Cloud189Service } = require('./cloud189');
const { StrmService } = require('./strm');
const { BatchTaskDto } = require('../dto/BatchTaskDto');
const { StreamProxyService } = require('./streamProxy');

class LazyShareStrmService {
    constructor(accountRepo, taskService) {
        this.accountRepo = accountRepo;
        this.taskService = taskService;
        this.strmService = new StrmService();
        this.streamProxyService = new StreamProxyService();
        this.cache = new Map();
        this.inflight = new Map();
        this.cacheTtlMs = 60 * 1000;
    }

    async generateFromShare(params) {
        const accountId = Number(params.accountId);
        const targetFolderId = String(params.targetFolderId || '').trim();
        const shareLink = String(params.shareLink || '').trim();
        const localPathPrefix = String(params.localPathPrefix || '').trim();
        const overwriteExisting = !!params.overwriteExisting;

        if (!accountId) {
            throw new Error('账号不能为空');
        }
        if (!targetFolderId) {
            throw new Error('目标目录不能为空');
        }
        if (!shareLink) {
            throw new Error('分享链接不能为空');
        }
        if (!localPathPrefix) {
            throw new Error('本地STRM目录不能为空');
        }

        const account = await this.accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('账号不存在');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        const shareData = await this._resolveShare(shareLink, params.accessCode, cloud189);
        const entries = await this._collectShareEntries(cloud189, shareData.shareInfo, shareData.accessCode);
        const mediaEntries = this._filterMediaEntries(entries);
        if (!mediaEntries.length) {
            throw new Error('分享目录中没有匹配媒体后缀的文件');
        }

        const rootName = shareData.shareInfo.isFolder ? shareData.shareInfo.fileName : '';
        const groups = this._groupEntriesByRelativeDir(mediaEntries);

        for (const [relativeDir, files] of groups.entries()) {
            const targetRoot = this._normalizeRelativePath(path.join(localPathPrefix, rootName, relativeDir));
            await this.strmService.generateCustom(
                targetRoot,
                files,
                async (file) => this.streamProxyService.buildStreamUrl({
                    type: 'lazyShare',
                    accountId,
                    shareId: shareData.shareInfo.shareId,
                    fileId: file.id,
                    fileName: file.name,
                    targetFolderId,
                    rootName,
                    relativeDir
                }),
                overwriteExisting,
                false
            );
        }

        const message = `懒转存STRM生成完成，资源: ${shareData.shareInfo.fileName}，文件数: ${mediaEntries.length}`;
        logTaskEvent(message);
        return {
            message,
            rootName: shareData.shareInfo.fileName,
            fileCount: mediaEntries.length
        };
    }

    async resolveLatestUrlByPayload(payload) {
        const cacheKey = this._getCacheKey(payload);
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.url;
        }
        if (this.inflight.has(cacheKey)) {
            return await this.inflight.get(cacheKey);
        }

        const pending = this._resolveAndCache(payload)
            .finally(() => this.inflight.delete(cacheKey));
        this.inflight.set(cacheKey, pending);
        return await pending;
    }

    async _resolveAndCache(payload) {
        const account = await this.accountRepo.findOneBy({ id: Number(payload.accountId) });
        if (!account) {
            throw new Error('播放账号不存在');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        const targetFolderId = await this._ensureTargetFolder(
            cloud189,
            payload.targetFolderId,
            payload.rootName,
            payload.relativeDir
        );
        let targetFile = await this._findFileByName(cloud189, targetFolderId, payload.fileName);

        if (!targetFile) {
            await this._saveShareFile(cloud189, payload, targetFolderId);
            targetFile = await this._findFileByName(cloud189, targetFolderId, payload.fileName);
        }

        if (!targetFile) {
            throw new Error('懒转存完成后未找到目标文件');
        }

        const latestUrl = await cloud189.getDownloadLink(targetFile.id);
        this.cache.set(this._getCacheKey(payload), {
            url: latestUrl,
            expiresAt: Date.now() + this.cacheTtlMs
        });
        return latestUrl;
    }

    async _resolveShare(shareLink, accessCode, cloud189) {
        const { url, accessCode: parsedAccessCode } = cloud189Utils.parseCloudShare(shareLink);
        const normalizedShareLink = url || shareLink;
        const finalAccessCode = String(accessCode || parsedAccessCode || '').trim();
        const shareCode = cloud189Utils.parseShareCode(normalizedShareLink);
        const shareInfo = await this.taskService.getShareInfo(cloud189, shareCode);
        if (shareInfo.shareMode == 1) {
            if (!finalAccessCode) {
                throw new Error('分享链接为加密链接，请提供访问码');
            }
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, finalAccessCode);
            if (!accessCodeResponse?.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        if (!shareInfo.shareId) {
            throw new Error('获取分享信息失败');
        }
        return {
            shareLink: normalizedShareLink,
            accessCode: finalAccessCode,
            shareInfo
        };
    }

    async _collectShareEntries(cloud189, shareInfo, accessCode, folderId = null, relativeDir = '') {
        if (!shareInfo.isFolder) {
            return [{
                id: String(shareInfo.fileId),
                name: shareInfo.fileName,
                relativeDir: ''
            }];
        }

        const currentFolderId = folderId || shareInfo.fileId;
        const resp = await cloud189.listShareDir(
            shareInfo.shareId,
            currentFolderId,
            shareInfo.shareMode,
            accessCode
        );
        if (!resp?.fileListAO) {
            return [];
        }

        const result = [];
        for (const folder of (resp.fileListAO.folderList || [])) {
            const nextRelativeDir = path.join(relativeDir, folder.name);
            const children = await this._collectShareEntries(
                cloud189,
                shareInfo,
                accessCode,
                folder.id,
                nextRelativeDir
            );
            result.push(...children);
        }

        for (const file of (resp.fileListAO.fileList || [])) {
            result.push({
                id: String(file.id),
                name: file.name,
                relativeDir
            });
        }

        return result;
    }

    _filterMediaEntries(entries) {
        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix')
            .split(';')
            .map((suffix) => suffix.toLowerCase());
        return entries.filter((file) => {
            const fileExt = '.' + String(file.name).split('.').pop().toLowerCase();
            return mediaSuffixs.includes(fileExt);
        });
    }

    _groupEntriesByRelativeDir(entries) {
        const groups = new Map();
        for (const entry of entries) {
            const relativeDir = this._normalizeRelativePath(entry.relativeDir || '');
            if (!groups.has(relativeDir)) {
                groups.set(relativeDir, []);
            }
            groups.get(relativeDir).push(entry);
        }
        return groups;
    }

    _normalizeRelativePath(targetPath = '') {
        return String(targetPath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/{2,}/g, '/');
    }

    _getCacheKey(payload) {
        return [
            payload.accountId,
            payload.shareId,
            payload.fileId,
            payload.targetFolderId,
            payload.rootName || '',
            payload.relativeDir || ''
        ].join(':');
    }

    async _ensureTargetFolder(cloud189, baseFolderId, rootName, relativeDir) {
        let currentFolderId = String(baseFolderId || '-11');
        const segments = [];
        if (rootName) {
            segments.push(rootName);
        }
        const normalizedRelativeDir = this._normalizeRelativePath(relativeDir);
        if (normalizedRelativeDir) {
            segments.push(...normalizedRelativeDir.split('/'));
        }

        for (const segment of segments) {
            currentFolderId = await this._ensureChildFolder(cloud189, currentFolderId, segment);
        }
        return currentFolderId;
    }

    async _ensureChildFolder(cloud189, parentFolderId, folderName) {
        const folderInfo = await cloud189.listFiles(parentFolderId);
        const folders = folderInfo?.fileListAO?.folderList || [];
        const existFolder = folders.find((folder) => folder.name === folderName);
        if (existFolder?.id) {
            return String(existFolder.id);
        }
        const created = await cloud189.createFolder(folderName, parentFolderId);
        if (!created?.id) {
            throw new Error(`创建目录失败: ${folderName}`);
        }
        return String(created.id);
    }

    async _findFileByName(cloud189, folderId, fileName) {
        const folderInfo = await cloud189.listFiles(folderId);
        const files = folderInfo?.fileListAO?.fileList || [];
        return files.find((file) => file.name === fileName) || null;
    }

    async _saveShareFile(cloud189, payload, targetFolderId) {
        logTaskEvent(`懒转存开始: ${payload.fileName}`);
        const batchTaskDto = new BatchTaskDto({
            taskInfos: JSON.stringify([{
                fileId: payload.fileId,
                fileName: payload.fileName,
                isFolder: 0
            }]),
            type: 'SHARE_SAVE',
            targetFolderId,
            shareId: payload.shareId
        });
        await this.taskService.createBatchTask(cloud189, batchTaskDto);
        logTaskEvent(`懒转存完成: ${payload.fileName}`);
    }
}

module.exports = { LazyShareStrmService };
