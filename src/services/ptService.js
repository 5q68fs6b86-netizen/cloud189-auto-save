const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { In } = require('typeorm');

const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');
const { CasService } = require('./casService');
const { StrmService } = require('./strm');
const { StreamProxyService } = require('./streamProxy');
const { OrganizerService } = require('./organizer');
const { MediaLibraryLayoutService, joinLocalStrmPath } = require('./mediaLibraryLayout');
const { logTaskEvent } = require('../utils/logUtils');
const { getDownloader, resetDownloader } = require('./downloader');
const { PtSourceService } = require('./ptSource');
const { ptRenameService } = require('./ptRename');
const { ptTorrentService } = require('./ptTorrent');
const { CasArchiveService } = require('./casArchiveService');
const aiService = require('./ai');
const { TMDBService } = require('./tmdb');
const {
    buildEpisodeDedupKey,
    computeFileHashes,
    collectLocalFiles,
    normalizeWhitespace,
    matchReleaseFilters,
    extractInfoHashFromMagnet,
    normalizeInfoHash,
    parseNumber,
    safeJsonParse,
    safeFileName
} = require('./ptUtils');
const {
    getPtSubscriptionRepository,
    getPtReleaseRepository,
    getAccountRepository
} = require('../database');

const STATUS = {
    PENDING: 'pending',
    DOWNLOADING: 'downloading',
    DOWNLOADED: 'downloaded',
    UPLOADING: 'uploading',
    COMPLETED: 'completed',
    FAILED: 'failed',
    UPLOAD_FAILED: 'upload_failed'
};

function buildPtCollisionCandidates(requestedName, release = {}) {
    const extension = path.extname(requestedName);
    const stem = path.basename(requestedName, extension);
    const subgroup = safeFileName(
        release.subgroup || ptRenameService.extractSubgroup(release.title || ''),
        ''
    );
    const resolution = safeFileName(
        release.resolution || ptRenameService.extractResolution(release.title || ''),
        ''
    );
    const variant = [subgroup, resolution].filter(Boolean).join(' ');
    const suffixes = ['', variant, [variant, `release-${release.id}`].filter(Boolean).join(' ')];
    return [...new Set(suffixes)].map(suffix =>
        suffix ? `${stem} [${suffix}]${extension}` : requestedName
    );
}

class PtService {
    constructor() {
        this.casService = new CasService();
        this.layoutService = new MediaLibraryLayoutService();
        this.sourceService = new PtSourceService();
        this.casArchiveService = new CasArchiveService();
        this._processingLock = false;
    }

    // ==================== 测试 / 工具 ====================

    async testDownloader() {
        try {
            resetDownloader();
            const downloader = getDownloader();
            return await downloader.testConnection();
        } catch (err) {
            return { ok: false, message: err && err.message ? err.message : String(err) };
        }
    }

    getSourcePresets() {
        return this.sourceService.getPresets();
    }

    async searchSource(preset, keyword, options = {}) {
        return this.sourceService.searchSource(preset, keyword, options);
    }

    async getSourceGroups(preset, params) {
        return this.sourceService.getGroups(preset, params);
    }

    async getSourceGroupItems(rssUrl, preset) {
        return this.sourceService.getGroupItems(rssUrl, preset);
    }

    // ==================== 轮询 ====================

    async runPoll(subscriptionId = null) {
        const repo = getPtSubscriptionRepository();
        const where = subscriptionId ? { id: Number(subscriptionId) } : { enabled: true };
        const subs = await repo.find({ where });
        if (!subs.length) {
            return { processed: 0 };
        }
        let total = 0;
        for (const sub of subs) {
            try {
                const added = await this._pollSubscription(sub);
                total += added;
            } catch (err) {
                logTaskEvent(`[PT] 订阅 ${sub.name} 轮询失败: ${err.message || err}`);
                sub.lastStatus = 'error';
                sub.lastMessage = String(err.message || err).slice(0, 500);
                sub.lastCheckTime = new Date();
                await repo.save(sub);
            }
        }
        return { processed: total };
    }

    async _pollSubscription(subscription) {
        const repo = getPtSubscriptionRepository();
        const releaseRepo = getPtReleaseRepository();
        const pollingSubscription = this._preparePollingSubscription(subscription);
        logTaskEvent(`[PT] 开始拉取订阅: ${subscription.name}`);

        const fetchedItems = (await this.sourceService.fetchFeedItems(pollingSubscription)).map(item => ({
            ...item,
            infoHash: normalizeInfoHash(item.infoHash || extractInfoHashFromMagnet(item.magnetUrl || ''))
        }));
        const filteredItems = this._filterDelayedItems(
            this._selectDownloadNewItems(fetchedItems, pollingSubscription),
            pollingSubscription
        );

        const guids = [...new Set(filteredItems.map(item => item.guid).filter(Boolean))];
        const infoHashes = [...new Set(filteredItems.map(item => item.infoHash).filter(Boolean))];
        const shouldLoadExisting = guids.length || infoHashes.length || pollingSubscription.episodeDedup;
        const existingReleases = shouldLoadExisting
            ? await releaseRepo.find({ where: { subscriptionId: subscription.id } })
            : [];
        const seenGuids = new Set(existingReleases.map(release => release.guid));
        const seenInfoHashes = new Set(existingReleases.map(release => normalizeInfoHash(release.infoHash)).filter(Boolean));
        const seenEpisodes = new Set(existingReleases.map(release => this._buildEpisodeDedupeKey(release, pollingSubscription)).filter(Boolean));
        const newReleases = [];
        for (const item of filteredItems) {
            if (!item.guid) continue;
            if (seenGuids.has(item.guid)) continue;
            if (item.infoHash && seenInfoHashes.has(item.infoHash)) continue;
            if (!matchReleaseFilters(item, pollingSubscription)) {
                continue;
            }
            const episodeKey = pollingSubscription.episodeDedup ? this._buildEpisodeDedupeKey(item, pollingSubscription) : '';
            if (episodeKey && seenEpisodes.has(episodeKey)) {
                continue;
            }
            seenGuids.add(item.guid);
            if (item.infoHash) seenInfoHashes.add(item.infoHash);
            if (episodeKey) seenEpisodes.add(episodeKey);
            newReleases.push(item);
        }

        let addedCount = 0;
        for (const item of newReleases) {
            try {
                const release = releaseRepo.create({
                    subscriptionId: subscription.id,
                    guid: item.guid,
                    rawTitle: item.rawTitle || item.title || '',
                    title: item.title || '',
                    infoHash: item.infoHash || '',
                    subgroup: item.subgroup || item.author || '',
                    seasonNumber: item.seasonNumber != null ? Number(item.seasonNumber) : null,
                    episodeNumber: item.episodeNumber != null ? Number(item.episodeNumber) : null,
                    episodeLabel: item.episodeLabel || '',
                    resolution: item.resolution || '',
                    quality: item.quality || '',
                    releaseTagsJson: JSON.stringify(item.tags || []),
                    magnetUrl: item.magnetUrl || '',
                    torrentUrl: item.torrentUrl || '',
                    detailsUrl: item.detailsUrl || '',
                    size: Number(item.size || 0) || 0,
                    seeders: Number(item.seeders || 0) || 0,
                    peers: Number(item.peers || 0) || 0,
                    grabs: Number(item.grabs || 0) || 0,
                    downloadVolumeFactor: item.downloadVolumeFactor != null ? Number(item.downloadVolumeFactor) : null,
                    uploadVolumeFactor: item.uploadVolumeFactor != null ? Number(item.uploadVolumeFactor) : null,
                    publishedAt: item.publishedAt || null,
                    status: STATUS.PENDING
                });
                await releaseRepo.save(release);

                await this._dispatchToDownloader(subscription, release);
                addedCount += 1;
            } catch (err) {
                logTaskEvent(`[PT] release 入队失败 [${item.title}]: ${err.message || err}`);
            }
        }

        await this._updateSubscriptionProgress(subscription, fetchedItems);
        subscription.lastCheckTime = new Date();
        subscription.lastStatus = 'ok';
        subscription.lastMessage = this._buildPollMessage(addedCount, fetchedItems.length, filteredItems.length, subscription);
        subscription.releaseCount = (subscription.releaseCount || 0) + addedCount;
        await repo.save(subscription);

        logTaskEvent(`[PT] 订阅 ${subscription.name} 拉取完成，新增 ${addedCount}/${fetchedItems.length}`);
        return addedCount;
    }

    _preparePollingSubscription(subscription = {}) {
        const globalExcludePattern = String(
            ConfigService.getConfigValue('pt.globalExcludePattern', '')
            || ConfigService.getConfigValue('pt.excludePattern', '')
            || ''
        );
        return {
            ...subscription,
            globalExcludePattern
        };
    }

    _buildEpisodeDedupeKey(item = {}, subscription = {}) {
        const baseKey = buildEpisodeDedupKey(item);
        if (!baseKey || !subscription.coexist) {
            return baseKey;
        }
        const variant = normalizeWhitespace(
            item.subgroup
            || item.author
            || item.standbyLabel
            || item.resolution
            || item.quality
            || item.title
            || ''
        ).toLowerCase();
        return `${baseKey}:${variant || 'default'}`;
    }

    _filterDelayedItems(items = [], subscription = {}) {
        const minutes = Math.max(0, Math.trunc(parseNumber(subscription.delayedDownloadMinutes, 0) || 0));
        if (!minutes) {
            return items;
        }
        const threshold = Date.now() - minutes * 60 * 1000;
        return items.filter(item => {
            if (!item.publishedAt) {
                return true;
            }
            const time = new Date(item.publishedAt).getTime();
            return !Number.isFinite(time) || time <= threshold;
        });
    }

    _selectDownloadNewItems(items = [], subscription = {}) {
        if (!subscription.downloadNew || items.length <= 1) {
            return items;
        }
        const datedItems = items
            .map(item => ({ item, time: item.publishedAt ? new Date(item.publishedAt).getTime() : 0 }))
            .filter(entry => Number.isFinite(entry.time) && entry.time > 0);
        if (datedItems.length) {
            const latest = datedItems.reduce((best, entry) => entry.time > best.time ? entry : best, datedItems[0]);
            const latestDay = new Date(latest.time).toISOString().slice(0, 10);
            return items.filter(item => {
                if (!item.publishedAt) {
                    return false;
                }
                const time = new Date(item.publishedAt).getTime();
                return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === latestDay;
            });
        }

        const episodeItems = items
            .map(item => ({ item, episode: parseNumber(item.episodeNumber, null) }))
            .filter(entry => entry.episode != null);
        if (episodeItems.length) {
            const latestEpisode = Math.max(...episodeItems.map(entry => entry.episode));
            return items.filter(item => parseNumber(item.episodeNumber, null) === latestEpisode);
        }
        return [items[0]];
    }

    async _updateSubscriptionProgress(subscription, fetchedItems = []) {
        const releaseRepo = getPtReleaseRepository();
        const releases = await releaseRepo.find({ where: { subscriptionId: subscription.id } });
        subscription.currentEpisodeNumber = this._computeCurrentEpisodeNumber(subscription, releases);
        subscription.missingEpisodesJson = subscription.omit
            ? JSON.stringify(this._computeMissingEpisodes(fetchedItems))
            : '';

        const totalEpisodeNumber = Math.max(0, Math.trunc(parseNumber(subscription.totalEpisodeNumber, 0) || 0));
        if (subscription.autoDisabled && totalEpisodeNumber > 0 && subscription.currentEpisodeNumber >= totalEpisodeNumber) {
            subscription.enabled = false;
        }
    }

    _computeCurrentEpisodeNumber(subscription = {}, releases = []) {
        const episodes = releases
            .map(release => parseNumber(release.episodeNumber, null))
            .filter(episode => episode != null && episode > 0 && Math.trunc(episode) === episode);
        if (!episodes.length) {
            return 0;
        }
        if (subscription.downloadNew) {
            return Math.max(...episodes);
        }
        return new Set(episodes).size;
    }

    _computeMissingEpisodes(items = []) {
        const episodes = [...new Set(items
            .map(item => parseNumber(item.episodeNumber, null))
            .filter(episode => episode != null && episode > 0 && Math.trunc(episode) === episode)
            .map(Number)
        )].sort((a, b) => a - b);
        if (episodes.length <= 1) {
            return [];
        }
        const min = episodes[0];
        const max = episodes[episodes.length - 1];
        if (min === max) {
            return [];
        }
        const present = new Set(episodes);
        const missing = [];
        for (let episode = min; episode <= max; episode += 1) {
            if (!present.has(episode)) {
                missing.push(episode);
                if (missing.length >= 50) {
                    break;
                }
            }
        }
        return missing;
    }

    _buildPollMessage(addedCount, fetchedCount, eligibleCount, subscription = {}) {
        const parts = [`本次新增 ${addedCount} 条`];
        if (eligibleCount !== fetchedCount) {
            parts.push(`符合下载 ${eligibleCount}/${fetchedCount} 条`);
        }
        const missing = safeJsonParse(subscription.missingEpisodesJson, []);
        if (Array.isArray(missing) && missing.length) {
            parts.push(`缺集 ${missing.slice(0, 10).join(', ')}`);
        }
        if (subscription.autoDisabled && subscription.enabled === false) {
            parts.push('已达到总集数，自动停用');
        }
        return parts.join('；');
    }

    async _dispatchToDownloader(subscription, release) {
        const releaseRepo = getPtReleaseRepository();
        const downloader = getDownloader();
        const downloadRoot = String(ConfigService.getConfigValue('pt.downloadRoot', '') || '').trim();
        if (!downloadRoot) {
            throw new Error('未配置 PT 下载根目录');
        }
        const categoryPrefix = ConfigService.getConfigValue('pt.downloader.categoryPrefix', 'pt-sub-');
        const tagPrefix = ConfigService.getConfigValue('pt.downloader.tagPrefix', 'pt-rel-');
        const category = `${categoryPrefix}${subscription.id}`;
        const tag = `${tagPrefix}${release.id}`;
        const subscriptionSavePath = path.join(downloadRoot, `sub-${subscription.id}`);
        const savePath = path.join(subscriptionSavePath, `rel-${release.id}`);
        const torrentSource = await this._prepareTorrentSource(subscription, release);

        const torrent = await downloader.addTorrent({
            magnetUrl: release.magnetUrl || undefined,
            url: torrentSource.url || release.torrentUrl || undefined,
            torrentBuffer: torrentSource.buffer || undefined,
            torrentFileName: torrentSource.fileName || undefined,
            savePath,
            categorySavePath: subscriptionSavePath,
            category,
            tag,
            infoHash: torrentSource.infoHash || release.infoHash || undefined
        });

        if (!torrent || !torrent.hash) {
            throw new Error('种子添加超时，未能获取到种子哈希');
        }

        release.qbTorrentHash = torrent.hash;
        release.downloadPath = torrent.savePath || savePath;
        if (torrentSource.infoHash) {
            release.infoHash = torrentSource.infoHash;
        }
        if (torrentSource.rootName) {
            release.localRootName = torrentSource.rootName;
        }
        if (torrentSource.files && torrentSource.files.length) {
            release.torrentFilesJson = JSON.stringify(torrentSource.files.slice(0, 500));
            if (!release.size && torrentSource.totalSize) {
                release.size = torrentSource.totalSize;
            }
        }
        release.status = STATUS.DOWNLOADING;
        await releaseRepo.save(release);
        logTaskEvent(`[PT] 已投递到下载器: ${release.title} (tag=${tag})`);
    }

    async _prepareTorrentSource(subscription, release) {
        if (!release.torrentUrl) {
            return {
                url: release.magnetUrl || '',
                infoHash: release.infoHash || '',
                buffer: null,
                fileName: '',
                rootName: '',
                files: [],
                totalSize: 0
            };
        }

        try {
            const proxyService = this.sourceService.getProxyService(subscription.sourcePreset || 'generic');
            const result = await ptTorrentService.downloadTorrent(release.torrentUrl, { proxyService });
            if (result.type === 'magnet') {
                return {
                    url: result.magnetUrl,
                    infoHash: result.infoHash || release.infoHash || '',
                    buffer: null,
                    fileName: '',
                    rootName: '',
                    files: [],
                    totalSize: 0
                };
            }
            return {
                url: '',
                infoHash: result.infoHash || release.infoHash || '',
                buffer: result.buffer,
                fileName: `${safeFileName(release.title || `release-${release.id}`)}.torrent`,
                rootName: result.rootName || '',
                files: result.files || [],
                totalSize: result.totalSize || 0
            };
        } catch (err) {
            logTaskEvent(`[PT] 种子预下载失败，回退给下载器处理: ${release.title} ${err.message || err}`);
            return {
                url: release.torrentUrl,
                infoHash: release.infoHash || '',
                buffer: null,
                fileName: '',
                rootName: '',
                files: [],
                totalSize: 0
            };
        }
    }

    // ==================== 处理（轮询 release 状态机） ====================

    async runProcessing() {
        if (this._processingLock) {
            return { skipped: true };
        }
        this._processingLock = true;
        try {
            const releaseRepo = getPtReleaseRepository();
            const releases = await releaseRepo.find({
                where: { status: In([STATUS.DOWNLOADING, STATUS.DOWNLOADED, STATUS.UPLOADING]) }
            });
            for (const release of releases) {
                try {
                    if (release.status === STATUS.DOWNLOADING) {
                        await this._refreshDownloadStatus(release);
                    }
                    if (release.status === STATUS.DOWNLOADED) {
                        await this._uploadRelease(release);
                    }
                } catch (err) {
                    logTaskEvent(`[PT] release ${release.id} 处理出错: ${err.message || err}`);
                    release.lastError = String(err.message || err).slice(0, 500);
                    if (release.status === STATUS.DOWNLOADING) {
                        // 下载阶段错误不切失败状态，避免被一次性问题永久标失败
                    } else if (release.status === STATUS.UPLOADING) {
                        release.status = STATUS.UPLOAD_FAILED;
                    }
                    await releaseRepo.save(release);
                }
            }
            return { processed: releases.length };
        } finally {
            this._processingLock = false;
        }
    }

    async _refreshDownloadStatus(release) {
        const releaseRepo = getPtReleaseRepository();
        const downloader = getDownloader();
        if (!release.qbTorrentHash) {
            return;
        }
        const torrent = await downloader.getTorrent(release.qbTorrentHash);
        if (!torrent) {
            return;
        }
        release.downloadPath = torrent.contentPath || torrent.savePath || release.downloadPath;
        release.progress = Math.round((torrent.progress || 0) * 100);
        if (torrent.isCompleted) {
            release.status = STATUS.DOWNLOADED;
            release.progress = 100;
            await releaseRepo.save(release);
            logTaskEvent(`[PT] 下载完成: ${release.title}`);
        } else {
            await releaseRepo.save(release);
        }
    }

    async _uploadRelease(release) {
        const releaseRepo = getPtReleaseRepository();
        const subRepo = getPtSubscriptionRepository();
        const accountRepo = getAccountRepository();

        release.status = STATUS.UPLOADING;
        release.lastError = '';
        await releaseRepo.save(release);

        const subscription = await subRepo.findOneBy({ id: release.subscriptionId });
        if (!subscription) {
            throw new Error(`找不到订阅 ${release.subscriptionId}`);
        }
        const account = await accountRepo.findOneBy({ id: subscription.accountId });
        if (!account) {
            throw new Error(`找不到账号 ${subscription.accountId}`);
        }

        const localPath = await this._resolveReleaseLocalPath(release);
        if (!localPath || !fs.existsSync(localPath)) {
            throw new Error(`本地文件不存在: ${localPath || '(空)'}`);
        }

        const cloud189 = Cloud189Service.getInstance(account);

        const localFiles = await collectLocalFiles(localPath);
        if (!localFiles.length) {
            throw new Error('本地下载目录为空');
        }

        const uploadPlan = await this._buildPtUploadPlan(subscription, release, localFiles);
        const releaseRootPath = uploadPlan.rootRelativePath;
        const releaseFolderId = await this._ensureNestedFolder(
            cloud189,
            subscription.targetFolderId,
            releaseRootPath
        );
        release.cloudFolderId = releaseFolderId;
        release.cloudFolderName = releaseRootPath;
        await releaseRepo.save(release);

        const manifest = [];
        const enableFamilyTransit = !!ConfigService.getConfigValue('cas.enableFamilyTransit', true);
        const familyTransitFirst = !!ConfigService.getConfigValue('cas.familyTransitFirst', false);
        const totalFiles = localFiles.length;
        let uploadedFiles = 0;

        for (const planned of uploadPlan.files) {
            const file = planned.source;
            const cloudDir = path.posix.dirname(planned.cloudRelativePath);
            const subDirId = await this._ensureNestedFolder(
                cloud189,
                subscription.targetFolderId,
                cloudDir === '.' ? '' : cloudDir
            );
            logTaskEvent(`[PT] 哈希中: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
            const hashes = await computeFileHashes(file.fullPath);
            const destination = await this._resolvePtUploadDestination(
                cloud189,
                subDirId,
                planned.fileName,
                hashes,
                release
            );
            const casInfo = {
                name: destination.fileName,
                size: hashes.size,
                md5: hashes.md5,
                sliceMd5: hashes.sliceMd5
            };

            const uploadResult = destination.existing
                ? { fileId: destination.fileId, via: 'existing' }
                : await this._rapidUploadWithFallback(
                    cloud189,
                    subDirId,
                    casInfo,
                    destination.fileName,
                    file.fullPath,
                    enableFamilyTransit,
                    familyTransitFirst
                );
            const cloudRelativePath = path.posix.join(
                cloudDir === '.' ? '' : cloudDir,
                destination.fileName
            );
            const casResult = await this.casArchiveService.uploadStub(
                cloud189,
                subscription.targetFolderId,
                cloudRelativePath,
                casInfo,
                { casService: this.casService, overwrite: true }
            );

            manifest.push({
                relativePath: file.relativePath,
                sourceRelativePath: file.relativePath,
                cloudRelativePath,
                cloudFileName: destination.fileName,
                isMedia: planned.isMedia,
                organized: uploadPlan.organizeEnabled,
                size: file.size,
                md5: hashes.md5,
                sliceMd5: hashes.sliceMd5,
                cloudFileId: uploadResult.fileId,
                casFileId: casResult.fileId || '',
                casRelativePath: casResult.relativePath || '',
                via: uploadResult.via
            });
            uploadedFiles++;
            release.progress = Math.round((uploadedFiles / totalFiles) * 100);
            await releaseRepo.save(release);
        }

        release.manifestJson = JSON.stringify(manifest);
        release.casMetadataJson = JSON.stringify({ uploadedAt: new Date().toISOString(), count: manifest.length });
        release.status = STATUS.COMPLETED;
        release.lastError = '';
        await releaseRepo.save(release);
        logTaskEvent(`[PT] release 上传完成: ${release.title} (共 ${manifest.length} 个文件)`);

        // 生成 STRM 文件
        if (ConfigService.getConfigValue('pt.enableStrm', true)) {
            try {
                await this._generateStrmForRelease(account, subscription, release, manifest);
            } catch (strmErr) {
                logTaskEvent(`[PT] STRM 生成失败（不影响整体）: ${strmErr.message || strmErr}`);
            }
        }

        // 删除网盘源文件（复用 cas.deleteSourceAfterGenerate 配置）
        if (ConfigService.getConfigValue('cas.deleteSourceAfterGenerate', false)) {
            const isFamily = account.accountType === 'family';
            for (const entry of manifest) {
                if (entry.cloudFileId) {
                    try {
                        await this.casService.deleteSourceFileAfterGenerate(cloud189, entry.cloudFileId, entry.cloudRelativePath || entry.relativePath, isFamily);
                    } catch (delErr) {
                        logTaskEvent(`[PT] 删除网盘源文件失败: ${entry.relativePath} ${delErr.message || delErr}`);
                    }
                }
            }
        }

        // 生成 .cas 后自动删除本地源文件
        if (ConfigService.getConfigValue('pt.autoDeleteSource', true)) {
            try {
                if (fs.statSync(localPath).isDirectory()) {
                    // 共享目录：检查同订阅其他 release 是否还在使用
                    const otherActive = await releaseRepo.findOne({
                        where: {
                            subscriptionId: release.subscriptionId,
                            status: In([STATUS.DOWNLOADING, STATUS.DOWNLOADED]),
                        }
                    });
                    if (otherActive) {
                        logTaskEvent(`[PT] 跳过删除共享目录（其他 release 仍在使用）: ${localPath}`);
                    } else {
                        for (const f of localFiles) {
                            await fsp.unlink(f.fullPath).catch(() => {});
                        }
                        await this._cleanupEmptyDirs(localPath);
                        logTaskEvent(`[PT] 已删除本地源文件: ${localPath}`);
                    }
                } else {
                    await fsp.unlink(localPath).catch(() => {});
                    await this._cleanupEmptyDirs(path.dirname(localPath));
                    logTaskEvent(`[PT] 已删除本地源文件: ${localPath}`);
                }
            } catch (delErr) {
                logTaskEvent(`[PT] 删除本地源文件失败（不影响整体）: ${delErr.message || delErr}`);
            }
        }
    }

    async _buildPtUploadPlan(subscription, release, localFiles) {
        const config = ConfigService.getConfigValue('pt.strmOrganize', {});
        const organizeEnabled = !!config.enabled && ['regex', 'ai'].includes(config.mode);
        const mediaSuffixes = new Set(
            String(ConfigService.getConfigValue('task.mediaSuffix', '') || '')
                .split(';')
                .map(value => value.trim().toLowerCase())
                .filter(value => value && value !== '.cas')
        );
        const isMedia = file => mediaSuffixes.has(path.extname(file.name || '').toLowerCase());
        const mediaFiles = localFiles.filter(isMedia);
        const releaseFolderName = safeFileName(release.title || `release-${release.id}`);

        if (!organizeEnabled || !mediaFiles.length) {
            return {
                organizeEnabled: false,
                rootRelativePath: releaseFolderName,
                files: localFiles.map(file => ({
                    source: file,
                    isMedia: isMedia(file),
                    fileName: file.name,
                    cloudRelativePath: path.posix.join(releaseFolderName, file.relativePath)
                }))
            };
        }

        let aiBase = null;
        let aiEpisodeMap = new Map();
        let libraryInfo = null;
        if (config.mode === 'ai') {
            try {
                if (!aiService.isEnabled()) {
                    throw new Error('AI 服务未启用');
                }
                const filesForAi = mediaFiles.map(file => ({ id: file.relativePath, name: file.name }));
                const response = await aiService.simpleChatCompletion(
                    release.title || subscription.name || `release-${release.id}`,
                    filesForAi
                );
                if (!response.success) {
                    throw new Error(response.error || 'AI 解析失败');
                }
                const data = response.data || {};
                aiBase = {
                    name: data.name || this._extractRegexSeriesTitle(subscription, release),
                    year: Number(data.year) || 0,
                    type: data.type === 'movie' ? 'movie' : 'tv',
                    season: data.season || ''
                };
                aiEpisodeMap = new Map(
                    (Array.isArray(data.episode) ? data.episode : []).map(item => [String(item.id), item])
                );
                libraryInfo = await this._resolveLibraryInfoByTmdb(aiBase);
                logTaskEvent(`[PT] AI 网盘整理: ${libraryInfo.categoryName}/${libraryInfo.resourceFolderName}`);
            } catch (error) {
                logTaskEvent(`[PT] AI 整理失败，降级正则: ${error.message || error}`);
            }
        }
        if (!libraryInfo) {
            const title = this._extractRegexSeriesTitle(subscription, release)
                || subscription.name
                || release.title;
            libraryInfo = await this._resolveLibraryInfoByTmdb({ name: title, year: 0, type: 'tv' });
        }

        const category = safeFileName(libraryInfo.categoryName || config.categoryFolder || '动漫');
        const resource = safeFileName(libraryInfo.resourceFolderName || subscription.name || releaseFolderName);
        const rootRelativePath = path.posix.join(category, resource);
        const plannedFiles = localFiles.map(file => {
            if (!isMedia(file)) {
                return {
                    source: file,
                    isMedia: false,
                    fileName: file.name,
                    cloudRelativePath: path.posix.join(rootRelativePath, file.relativePath)
                };
            }
            const input = { ...file, id: file.relativePath, originalFileName: file.name };
            const organized = aiBase
                ? ptRenameService.organizePathByAi(
                    subscription,
                    release,
                    input,
                    config,
                    aiBase,
                    aiEpisodeMap.get(String(file.relativePath)) || null,
                    libraryInfo.categoryName,
                    libraryInfo
                )
                : ptRenameService.organizePath(subscription, release, input, config, libraryInfo);
            const dirParts = String(organized.dirName || '').replace(/\\/g, '/').split('/').filter(Boolean);
            const relativeDir = dirParts.slice(2).join('/');
            const extension = path.extname(file.name || '');
            const baseName = String(organized.fileName || '').replace(/\.strm$/i, '')
                || path.basename(file.name, extension);
            const fileName = `${safeFileName(baseName)}${extension}`;
            return {
                source: file,
                isMedia: true,
                fileName,
                cloudRelativePath: path.posix.join(rootRelativePath, relativeDir, fileName)
            };
        });
        return { organizeEnabled: true, rootRelativePath, files: plannedFiles, libraryInfo };
    }

    async _resolvePtUploadDestination(cloud189, folderId, requestedName, hashes, release) {
        const listing = await cloud189.listFiles(folderId);
        const files = listing?.fileListAO?.fileList || [];
        const extension = path.extname(requestedName);
        const stem = path.basename(requestedName, extension);

        for (const fileName of buildPtCollisionCandidates(requestedName, release)) {
            const existing = files.find(file => file.name === fileName);
            if (!existing) {
                return { fileName, existing: false, fileId: '' };
            }
            if (await this._isSamePtCloudFile(cloud189, existing, hashes)) {
                return { fileName, existing: true, fileId: String(existing.id || existing.fileId) };
            }
        }

        let sequence = 2;
        while (sequence < 1000) {
            const fileName = `${stem} [release-${release.id}-${sequence}]${extension}`;
            const existing = files.find(file => file.name === fileName);
            if (!existing) {
                return { fileName, existing: false, fileId: '' };
            }
            if (await this._isSamePtCloudFile(cloud189, existing, hashes)) {
                return { fileName, existing: true, fileId: String(existing.id || existing.fileId) };
            }
            sequence++;
        }
        throw new Error(`无法为同名文件生成可用版本名: ${requestedName}`);
    }

    async _isSamePtCloudFile(cloud189, file, hashes) {
        let size = Number(file.size || file.fileSize || 0);
        let md5 = String(file.md5 || file.fileMd5 || '').toUpperCase();
        if (!md5 || !size) {
            const detail = await cloud189.getFileInfo(file.id || file.fileId).catch(() => null);
            size = size || Number(detail?.size || detail?.fileSize || 0);
            md5 = md5 || String(detail?.md5 || detail?.fileMd5 || '').toUpperCase();
        }
        return size === Number(hashes.size)
            && !!md5
            && md5 === String(hashes.md5 || '').toUpperCase();
    }

    async _resolveReleaseLocalPath(release) {
        const localPath = release.downloadPath || release.savePath || '';
        if (!localPath || !fs.existsSync(localPath)) {
            return localPath;
        }

        const stat = fs.statSync(localPath);
        if (!stat.isDirectory()) {
            return localPath;
        }

        const rootName = String(release.localRootName || '').trim();
        if (!rootName || path.basename(localPath) === rootName) {
            return localPath;
        }

        const rootedPath = path.join(localPath, rootName);
        return fs.existsSync(rootedPath) ? rootedPath : localPath;
    }

    async _rapidUploadWithFallback(cloud189, parentFolderId, casInfo, fileName, localFilePath, enableFamilyTransit, familyTransitFirst) {
        const tryPersonal = async () => {
            const fileId = await this.casService._personalRapidUpload(cloud189, parentFolderId, casInfo, fileName);
            return { fileId, via: 'personal' };
        };

        const tryFamilyTransit = async () => {
            if (!enableFamilyTransit) return null;
            const familyInfo = await cloud189.getFamilyInfo();
            if (!familyInfo?.familyId) return null;
            const familyId = String(familyInfo.familyId);
            const familyFolderId = await cloud189.getFamilyRootFolderId(familyId);
            const familyFileId = await this.casService._familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, fileName);
            try {
                await this.casService._copyFamilyFileToPersonal(cloud189, familyId, familyFileId, parentFolderId, familyFolderId, fileName);
            } catch (copyErr) {
                await this.casService._safeDeleteFamilyFile(cloud189, familyId, familyFileId, fileName);
                throw copyErr;
            }
            // 清理家庭临时文件
            await this.casService._safeDeleteFamilyFile(cloud189, familyId, familyFileId, fileName);
            // 查找拷贝到个人存储后的文件 ID
            const listing = await cloud189.listFiles(parentFolderId);
            const personalFile = (listing?.fileListAO?.fileList || []).find(f => f.name === fileName);
            if (!personalFile?.id) {
                throw new Error('家庭中转完成但未找到个人文件');
            }
            return { fileId: String(personalFile.id), via: 'family-transit' };
        };

        const tryRealUpload = async () => {
            logTaskEvent(`[PT] 秒传全部失败，开始真传: ${fileName}`);
            const result = await this.casService._uploadStreamFile(cloud189, parentFolderId, fileName, localFilePath);
            return { fileId: result.fileId, via: 'real-upload' };
        };

        // 根据秒传配置决定尝试顺序
        const strategies = familyTransitFirst && enableFamilyTransit
            ? [tryFamilyTransit, tryPersonal, tryRealUpload]
            : [tryPersonal, tryFamilyTransit, tryRealUpload];

        let lastErr = null;
        for (const strategy of strategies) {
            if (!strategy) continue;
            try {
                const result = await strategy();
                if (result) return result;
            } catch (err) {
                logTaskEvent(`[PT] 策略失败: ${err.message || err}`);
                lastErr = err;
                // 黑名单直接跳过后续秒传，走真传
                if (err.isBlacklisted) {
                    logTaskEvent(`[PT] 文件被风控黑名单，跳过秒传直接真传`);
                    break;
                }
            }
        }
        throw lastErr || new Error('所有上传策略均失败');
    }

    async _cleanupEmptyDirs(dirPath) {
        const downloadRoot = String(ConfigService.getConfigValue('pt.downloadRoot', '') || '').trim();
        try {
            const entries = await fsp.readdir(dirPath);
            if (entries.length === 0 && dirPath !== downloadRoot) {
                await fsp.rmdir(dirPath);
                const parent = path.dirname(dirPath);
                if (parent !== dirPath) {
                    await this._cleanupEmptyDirs(parent);
                }
            }
        } catch {}
    }

    async _ensureSubFolder(cloud189, parentFolderId, folderName) {
        const safeName = safeFileName(folderName);
        const listing = await cloud189.listFiles(parentFolderId);
        const folders = (listing?.fileListAO?.folderList || []);
        const existing = folders.find((f) => f.name === safeName);
        if (existing?.id) {
            return String(existing.id);
        }
        const created = await cloud189.createFolder(safeName, parentFolderId);
        if (!created?.id) {
            throw new Error(`创建文件夹失败: ${safeName}`);
        }
        return String(created.id);
    }

    async _ensureNestedFolder(cloud189, rootFolderId, relativeDir) {
        if (!relativeDir) {
            return rootFolderId;
        }
        const segments = String(relativeDir).split('/').filter(Boolean);
        let current = rootFolderId;
        for (const seg of segments) {
            current = await this._ensureSubFolder(cloud189, current, seg);
        }
        return current;
    }

    // ==================== STRM 生成 ====================

    async _generateStrmForRelease(account, subscription, release, manifest) {
        if (!account.localStrmPrefix) {
            logTaskEvent(`[PT] 账号未配置 STRM 本地前缀，跳过 STRM 生成`);
            return;
        }

        const strmService = new StrmService();
        const streamProxyService = new StreamProxyService();
        const organizeEnabled = manifest.some(entry => entry.organized === true);
        const files = manifest
            .filter(m => m.cloudFileId && m.isMedia !== false)
            .map(m => {
                const originalFileName = m.cloudFileName || path.basename(m.cloudRelativePath || m.relativePath);
                return {
                    name: originalFileName,
                    relativeDir: path.posix.dirname(m.cloudRelativePath || m.relativePath) === '.'
                        ? ''
                        : path.posix.dirname(m.cloudRelativePath || m.relativePath),
                    id: m.cloudFileId,
                    originalFileName,
                    sourceFileName: m.cloudFileName || originalFileName,
                    sourceRelativeDir: path.posix.dirname(m.cloudRelativePath || m.relativePath) === '.'
                        ? ''
                        : path.posix.dirname(m.cloudRelativePath || m.relativePath)
                };
            });

        if (!files.length) {
            logTaskEvent(`[PT] manifest 中没有已上传的文件，跳过 STRM 生成`);
            return;
        }

        const accountId = Number(account.id);
        const targetFolderId = String(subscription.targetFolderId || '');

        // 确定目标根目录（剥裸 strm 前缀，避免 strm/strm）
        let targetRoot;
        if (organizeEnabled) {
            const firstParts = String(files[0].relativeDir || '').split('/').filter(Boolean);
            targetRoot = joinLocalStrmPath(account.localStrmPrefix, ...firstParts.slice(0, 2));
            for (const file of files) {
                const parts = String(file.relativeDir || '').split('/').filter(Boolean);
                file.relativeDir = parts.slice(2).join('/');
            }
        } else {
            // 原始模式：使用 {normalizedPrefix}/PT/{subName}/{relName}
            const subName = safeFileName(subscription.name || `sub-${subscription.id}`);
            const relName = safeFileName(release.title || `release-${release.id}`);
            targetRoot = joinLocalStrmPath(account.localStrmPrefix, 'PT', subName, relName);
            const releaseFolderName = String(release.cloudFolderName || relName).replace(/\\/g, '/');
            for (const file of files) {
                if (file.relativeDir === releaseFolderName) {
                    file.relativeDir = '';
                    continue;
                }
                if (file.relativeDir.startsWith(`${releaseFolderName}/`)) {
                    file.relativeDir = file.relativeDir.slice(releaseFolderName.length + 1);
                }
            }
        }

        await strmService.generateCustom(
            targetRoot,
            files,
            async (file) => streamProxyService.buildStreamUrl({
                type: 'subscription',
                accountId,
                fileId: file.id,
                fileName: file.sourceFileName || file.name,
                targetFolderId,
                rootName: '',
                relativeDir: file.sourceRelativeDir || '',
                isCas: true,
                originalFileName: file.originalFileName || ''
            }),
            false,
            false,
            'default'
        );

        logTaskEvent(`[PT] STRM 生成完成: ${targetRoot} (共 ${files.length} 个文件)`);
    }

    // ==================== AI/TMDB 媒体库目录 ====================

    /**
     * 按 OrganizerService 的规则，调 TMDB 决定媒体库目录
     * @param {{name:string, year:number, type:'tv'|'movie'}} aiBase
     * @returns {Promise<object>} 媒体库目录信息，失败回退 AI 结果
     */
    async _resolveLibraryInfoByTmdb(aiBase) {
        const organizerService = new OrganizerService(null);
        const resourceInfo = {
            name: aiBase?.name || '',
            year: Number(aiBase?.year) || 0,
            type: aiBase?.type || 'tv'
        };
        try {
            if (!aiBase || !aiBase.name) {
                return organizerService._resolveLibraryInfo({ resourceName: '' }, resourceInfo, null);
            }

            const apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
            if (!apiKey) {
                logTaskEvent(`[PT] TMDB API Key 未配置，按 AI 结果生成媒体库目录`);
                return organizerService._resolveLibraryInfo({ resourceName: aiBase.name }, resourceInfo, null);
            }

            const tmdb = new TMDBService();
            const year = aiBase.year && aiBase.year > 0 ? aiBase.year : '';
            let tmdbInfo;
            if (aiBase.type === 'movie') {
                tmdbInfo = await tmdb.searchMovie(aiBase.name, year);
            } else {
                tmdbInfo = await tmdb.searchTV(aiBase.name, year, 0);
            }

            return organizerService._resolveLibraryInfo({ resourceName: aiBase.name }, resourceInfo, tmdbInfo || null);
        } catch (err) {
            logTaskEvent(`[PT] TMDB 媒体库目录查询失败，按 AI 结果生成目录: ${err.message || err}`);
            return organizerService._resolveLibraryInfo({ resourceName: aiBase?.name || '' }, resourceInfo, null);
        }
    }

    _extractRegexSeriesTitle(subscription, release) {
        const candidates = [
            subscription?.name,
            release?.title
        ];
        for (const candidate of candidates) {
            const title = this._cleanRegexSeriesTitle(candidate);
            if (title) {
                return title;
            }
        }
        return '';
    }

    _cleanRegexSeriesTitle(value = '') {
        let title = String(value || '').trim();
        if (!title) {
            return '';
        }
        title = title
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/【[^】]+】/g, ' ')
            .replace(/（[^）]*(字幕组|字幕|发布|發佈|组|組)[^）]*）/gi, ' ')
            .replace(/\([^)]*(字幕组|字幕|发布|發佈|组|組)[^)]*\)/gi, ' ')
            .replace(/[._]+/g, ' ')
            .replace(/從/g, '从')
            .replace(/異/g, '异')
            .replace(/開始/g, '开始')
            .replace(/第[一二三四五六七八九十百0-9]+[季期部].*$/i, '')
            .replace(/\b\d+(?:st|nd|rd|th)\s+Season.*$/i, '')
            .replace(/\bSeason\s*\d+.*$/i, '')
            .replace(/\bS\d{1,2}\b.*$/i, '')
            .replace(/\s+-\s+\d{1,3}(?:\.\d+)?\b.*$/i, '')
            .replace(/\s+-\s*(ANi|Skymoon.*|天月.*|.*字幕.*|.*发布.*|.*發佈.*)$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        return title;
    }

    // ==================== 清理 ====================

    async runCleanup() {
        if (!ConfigService.getConfigValue('pt.cleanupEnabled', true)) {
            return { skipped: true };
        }
        const releaseRepo = getPtReleaseRepository();
        const completed = await releaseRepo.find({ where: { status: STATUS.COMPLETED } });
        const downloader = getDownloader();
        let removed = 0;
        for (const release of completed) {
            if (release.qbTorrentHash) {
                try {
                    await downloader.deleteTorrent(release.qbTorrentHash, true);
                    removed += 1;
                } catch (err) {
                    logTaskEvent(`[PT] 清理 qb 任务失败 ${release.qbTorrentHash}: ${err.message || err}`);
                }
            }
        }
        return { removed };
    }

    // ==================== 重试 / 删除 release ====================

    async retryRelease(releaseId) {
        const releaseRepo = getPtReleaseRepository();
        const release = await releaseRepo.findOneBy({ id: Number(releaseId) });
        if (!release) {
            throw new Error('release 不存在');
        }
        if ([STATUS.FAILED, STATUS.UPLOAD_FAILED].includes(release.status)) {
            release.status = release.qbTorrentHash ? STATUS.DOWNLOADING : STATUS.PENDING;
        } else if (release.status === STATUS.PENDING) {
            const subscription = await getPtSubscriptionRepository().findOneBy({ id: release.subscriptionId });
            if (subscription) {
                await this._dispatchToDownloader(subscription, release);
            }
        } else {
            // downloaded/uploading 直接重新跑上传
            release.status = STATUS.DOWNLOADED;
        }
        release.lastError = '';
        await releaseRepo.save(release);
        // 立即触发一次处理
        this.runProcessing().catch((err) => logTaskEvent(`[PT] retry 后处理失败: ${err.message || err}`));
        return release;
    }

    // ==================== STRM 重建（不重新下载/上传，仅从已存清单重生成） ====================

    // 重建单个 release 的 STRM
    async rebuildStrm(releaseId) {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM 功能未启用，请先在「媒体设置」开启 STRM 后再重建');
        }
        const release = await getPtReleaseRepository().findOneBy({ id: Number(releaseId) });
        if (!release) {
            throw new Error('release 不存在');
        }
        const result = await this._rebuildStrmForRelease(release);
        if (result.status !== 'ok') {
            // 单个重建：把跳过原因直接抛给前端
            throw new Error(result.reason);
        }
        return result;
    }

    // 批量重建所有已完成 release 的 STRM
    async rebuildAllStrm() {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM 功能未启用，请先在「媒体设置」开启 STRM 后再重建');
        }
        const releases = await getPtReleaseRepository().find({
            where: { status: STATUS.COMPLETED },
            order: { id: 'ASC' }
        });
        const summary = { total: releases.length, ok: 0, skipped: 0, failed: 0, details: [] };
        for (const release of releases) {
            try {
                const r = await this._rebuildStrmForRelease(release);
                summary[r.status === 'ok' ? 'ok' : 'skipped']++;
                summary.details.push({ id: release.id, title: release.title, ...r });
            } catch (err) {
                summary.failed++;
                const reason = String(err.message || err).slice(0, 300);
                summary.details.push({ id: release.id, title: release.title, status: 'failed', reason });
                logTaskEvent(`[PT] 重建 STRM 失败 release ${release.id}: ${reason}`);
            }
        }
        logTaskEvent(`[PT] 批量重建 STRM 完成: 共${summary.total} 成功${summary.ok} 跳过${summary.skipped} 失败${summary.failed}`);
        return summary;
    }

    // 内部复用：从 manifest 重建单个 release 的 STRM。返回 {status:'ok'|'skipped', reason?, files?}；硬错误向上抛
    async _rebuildStrmForRelease(release) {
        if (!release.manifestJson) {
            return { status: 'skipped', reason: '无 manifest（可能从未上传完成）' };
        }
        let manifest;
        try {
            manifest = JSON.parse(release.manifestJson);
        } catch (err) {
            return { status: 'skipped', reason: 'manifest 解析失败' };
        }
        const valid = Array.isArray(manifest) ? manifest.filter(m => m.cloudFileId) : [];
        if (!valid.length) {
            return { status: 'skipped', reason: 'manifest 中无有效云盘文件' };
        }
        const subscription = await getPtSubscriptionRepository().findOneBy({ id: release.subscriptionId });
        if (!subscription) {
            return { status: 'skipped', reason: `找不到订阅 ${release.subscriptionId}` };
        }
        const account = await getAccountRepository().findOneBy({ id: subscription.accountId });
        if (!account) {
            return { status: 'skipped', reason: `找不到账号 ${subscription.accountId}` };
        }
        if (!account.localStrmPrefix) {
            return { status: 'skipped', reason: '账号未配置本地 STRM 前缀' };
        }
        await this._generateStrmForRelease(account, subscription, release, manifest);
        return { status: 'ok', files: valid.length };
    }

    async deleteRelease(releaseId, deleteLocalFiles = true) {
        const releaseRepo = getPtReleaseRepository();
        const release = await releaseRepo.findOneBy({ id: Number(releaseId) });
        if (!release) {
            return;
        }
        if (release.qbTorrentHash) {
            try {
                const downloader = getDownloader();
                await downloader.deleteTorrent(release.qbTorrentHash, deleteLocalFiles);
            } catch (err) {
                logTaskEvent(`[PT] 删除 qb 任务失败: ${err.message || err}`);
            }
        }
        await releaseRepo.delete({ id: release.id });
    }
}

const ptService = new PtService();
module.exports = { PtService, ptService, PT_STATUS: STATUS, buildPtCollisionCandidates };
