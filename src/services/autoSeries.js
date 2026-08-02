const ConfigService = require('./ConfigService');
const { TMDBService } = require('./tmdb');
const { AppDataSource } = require('../database');

const AUTO_SERIES_SOURCES = ['cloudsaver', 'hdhive', 'pt', 'subscription'];
const DEFAULT_SOURCE_PREFERENCES = AUTO_SERIES_SOURCES.map(source => ({ source, enabled: true }));

function normalizeSourcePreferences(input) {
    const items = Array.isArray(input) ? input : [];
    const normalized = [];
    const seen = new Set();
    for (const item of items) {
        const source = String(item?.source || '').trim().toLowerCase();
        if (!AUTO_SERIES_SOURCES.includes(source) || seen.has(source)) continue;
        seen.add(source);
        normalized.push({ source, enabled: item?.enabled !== false });
    }
    for (const source of AUTO_SERIES_SOURCES) {
        if (!seen.has(source)) normalized.push({ source, enabled: true });
    }
    return normalized;
}

class AutoSeriesService {
    constructor(taskService, accountRepo, lazyShareStrmService) {
        this.taskService = taskService;
        this.accountRepo = accountRepo;
        this.lazyShareStrmService = lazyShareStrmService;
        this.tmdbService = new TMDBService();
    }

    getSourcePreferences() {
        return normalizeSourcePreferences(
            ConfigService.getConfigValue('task.autoCreate.sourcePreferences', DEFAULT_SOURCE_PREFERENCES)
        );
    }

    saveSourcePreferences(preferences) {
        const normalized = normalizeSourcePreferences(preferences);
        ConfigService.setConfigValue('task.autoCreate.sourcePreferences', normalized);
        return normalized;
    }

    async createByTitle({
        title,
        year = '',
        mode = 'lazy',
        shareLink = '',
        resourceTitle = '',
        resourceSlug = '',
        source = '',
        sources = null,
        keepCasAfterRestore = false
    }) {
        const normalizedTitle = String(title || '').trim();
        const normalizedYear = String(year || '').trim();
        const normalizedMode = this._normalizeMode(mode);
        const manualShareLink = String(shareLink || '').trim();
        const manualResourceTitle = String(resourceTitle || '').trim();
        const shouldKeepCasAfterRestore = Boolean(keepCasAfterRestore);
        if (!normalizedTitle) {
            throw new Error('剧名不能为空');
        }
        if (!['normal', 'lazy'].includes(normalizedMode)) {
            throw new Error('无效的自动追剧模式');
        }

        const autoCreateConfig = ConfigService.getConfigValue('task.autoCreate', {});
        const accountId = parseInt(autoCreateConfig.accountId);
        const targetFolderId = String(autoCreateConfig.targetFolderId || '').trim();
        const targetFolder = String(autoCreateConfig.targetFolder || '').trim();

        if (!accountId) {
            throw new Error('请先在系统设置中配置自动追剧默认账号');
        }
        if (!targetFolderId || !targetFolder) {
            throw new Error('请先在系统设置中配置自动追剧默认保存目录');
        }

        const account = await this.accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('自动追剧默认账号不存在');
        }

        const tmdbInfo = await this._resolveTmdb(normalizedTitle, normalizedYear);
        let selectedShareLink = manualShareLink;
        if (!selectedShareLink && source === 'hdhive' && resourceSlug) {
            const hdhiveSDK = require('../sdk/hdhive/sdk').default;
            const unlocked = await hdhiveSDK.unlockResource(String(resourceSlug));
            if (!unlocked?.success || !unlocked.data?.link) {
                throw new Error(unlocked?.error || '影巢免费资源解锁失败');
            }
            selectedShareLink = unlocked.data.link;
        }
        if (selectedShareLink) {
            return await this._createCloudTask({
                account,
                targetFolderId,
                targetFolder,
                mode: normalizedMode,
                resource: { title: manualResourceTitle || normalizedTitle, cloudLinks: [{ link: selectedShareLink }] },
                taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                tmdbInfo,
                source: AUTO_SERIES_SOURCES.includes(source) ? source : 'manual',
                keepCasAfterRestore: shouldKeepCasAfterRestore
            });
        }

        const requestedSources = Array.isArray(sources)
            ? new Set(sources.map(item => String(item).trim().toLowerCase()))
            : null;
        const activePreferences = this.getSourcePreferences()
            .filter(item => item.enabled && (!requestedSources || requestedSources.has(item.source)));
        const errors = [];
        for (const preference of activePreferences) {
            try {
                if (preference.source === 'cloudsaver') {
                    const resource = await this._findBestResource(normalizedTitle, normalizedYear, tmdbInfo);
                    if (!resource?.cloudLinks?.[0]?.link) throw new Error('未找到可用资源');
                    return await this._createCloudTask({
                        account,
                        targetFolderId,
                        targetFolder,
                        mode: normalizedMode,
                        resource,
                        taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                        tmdbInfo,
                        source: 'cloudsaver',
                        keepCasAfterRestore: shouldKeepCasAfterRestore
                    });
                }
                if (preference.source === 'hdhive') {
                    const resource = await this._findBestHdhiveResource(normalizedTitle, normalizedYear, tmdbInfo);
                    if (!resource?.cloudLinks?.[0]?.link) throw new Error('未找到免费或已解锁资源');
                    return await this._createCloudTask({
                        account,
                        targetFolderId,
                        targetFolder,
                        mode: normalizedMode,
                        resource,
                        taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                        tmdbInfo,
                        source: 'hdhive',
                        keepCasAfterRestore: shouldKeepCasAfterRestore
                    });
                }
                if (preference.source === 'pt') {
                    const { ptService } = require('./ptService');
                    return await ptService.createAutoSeriesSubscription({
                        title: normalizedTitle,
                        year: normalizedYear,
                        tmdbInfo,
                        accountId: account.id,
                        targetFolderId,
                        targetFolder
                    });
                }
                if (preference.source === 'subscription') {
                    const resource = await this._findBestSubscriptionResource(normalizedTitle, normalizedYear, tmdbInfo);
                    if (!resource?.cloudLinks?.[0]?.link) throw new Error('订阅中未找到匹配资源');
                    return await this._createCloudTask({
                        account,
                        targetFolderId,
                        targetFolder,
                        mode: normalizedMode,
                        resource,
                        taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                        tmdbInfo,
                        source: 'subscription',
                        keepCasAfterRestore: shouldKeepCasAfterRestore
                    });
                }
            } catch (error) {
                errors.push(`${preference.source}: ${error.message || error}`);
            }
        }
        if (!activePreferences.length) {
            throw new Error('请至少启用一个自动追剧来源');
        }
        throw new Error(`所有自动追剧来源均失败：${errors.join('；')}`);
    }

    _buildTaskName(title, tmdbInfo) {
        return tmdbInfo?.title
            ? `${tmdbInfo.title}${tmdbInfo.releaseDate ? ` (${new Date(tmdbInfo.releaseDate).getFullYear()})` : ''}`
            : title;
    }

    async _createCloudTask({ account, targetFolderId, targetFolder, mode, resource, taskName, tmdbInfo, source, keepCasAfterRestore }) {
        const totalEpisodes = Number(tmdbInfo?.totalEpisodes || 0) > 0
            ? Number(tmdbInfo.totalEpisodes)
            : (tmdbInfo?.status === 'Ended'
                ? Number(tmdbInfo?.lastEpisodeToAir?.episode_number || 0)
                : 0);

        if (mode === 'lazy') {
            const result = await this._createLazySeries({
                account,
                targetFolderId,
                resource,
                taskName,
                tmdbInfo,
                keepCasAfterRestore: Boolean(keepCasAfterRestore)
            });
            return { ...result, source };
        }

        const tasks = await this.taskService.createTask({
            accountId: account.id,
            shareLink: resource.cloudLinks[0].link,
            totalEpisodes,
            targetFolderId,
            targetFolder,
            matchPattern: '',
            matchOperator: 'lt',
            matchValue: '',
            overwriteFolder: 0,
            remark: '自动追剧',
            taskGroup: '自动追剧',
            enableCron: false,
            cronExpression: '',
            selectedFolders: [],
            sourceRegex: '',
            targetRegex: '',
            taskName,
            tmdbId: tmdbInfo?.id ? String(tmdbInfo.id) : null,
            enableTaskScraper: true,
            enableLazyStrm: false,
            enableOrganizer: true,
            keepCasAfterRestore: Boolean(keepCasAfterRestore)
        });

        // createTask 内部已异步触发首次执行，这里不再阻塞等待

        return {
            taskCount: tasks?.length || 0,
            resourceTitle: resource.title,
            shareLink: resource.cloudLinks[0].link,
            taskName,
            tmdbId: tmdbInfo?.id || null,
            mode: 'normal',
            source,
            taskIds: (tasks || []).map(task => task.id)
        };
    }

    async _createLazySeries({ account, targetFolderId, resource, taskName, tmdbInfo, keepCasAfterRestore = false }) {
        if (!this.lazyShareStrmService) {
            throw new Error('懒转存服务未初始化');
        }
        if (!account.localStrmPrefix) {
            throw new Error('默认账号未配置本地STRM目录，无法执行懒转存模式');
        }

        const autoCreateConfig = ConfigService.getConfigValue('task.autoCreate', {});
        const targetFolder = String(autoCreateConfig.targetFolder || '').trim();
        const totalEpisodes = Number(tmdbInfo?.totalEpisodes || 0) > 0
            ? Number(tmdbInfo.totalEpisodes)
            : (tmdbInfo?.status === 'Ended'
                ? Number(tmdbInfo?.lastEpisodeToAir?.episode_number || 0)
                : 0);

        const tasks = await this.taskService.createTask({
            accountId: account.id,
            shareLink: resource.cloudLinks[0].link,
            totalEpisodes,
            targetFolderId,
            targetFolder,
            matchPattern: '',
            matchOperator: 'lt',
            matchValue: '',
            overwriteFolder: 0,
            remark: '自动追剧',
            taskGroup: '自动追剧',
            enableCron: false,
            cronExpression: '',
            selectedFolders: [],
            sourceRegex: '',
            targetRegex: '',
            taskName,
            tmdbId: tmdbInfo?.id ? String(tmdbInfo.id) : null,
            enableTaskScraper: false,
            enableLazyStrm: true,
            enableOrganizer: true,
            keepCasAfterRestore: Boolean(keepCasAfterRestore)
        });

        // createTask 内部已异步触发首次执行，这里不再阻塞等待

        return {
            taskCount: tasks?.length || 0,
            resourceTitle: resource.title,
            shareLink: resource.cloudLinks[0].link,
            taskName,
            tmdbId: tmdbInfo?.id || null,
            mode: 'lazy',
            taskIds: (tasks || []).map(task => task.id)
        };
    }

    async _resolveTmdb(title, year) {
        try {
            return await this.tmdbService.searchTV(title, year, 0);
        } catch (error) {
            return null;
        }
    }

    async searchResources({ title, year = '', sources = null }) {
        const normalizedTitle = String(title || '').trim();
        const normalizedYear = String(year || '').trim();
        if (!normalizedTitle) {
            throw new Error('剧名不能为空');
        }

        const tmdbInfo = await this._resolveTmdb(normalizedTitle, normalizedYear);
        const requestedSources = this._normalizeSearchSources(sources);

        const titleCandidates = [
            normalizedTitle,
            tmdbInfo?.title,
            tmdbInfo?.originalTitle
        ].filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = normalizedYear
            || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');

        const resources = [];
        if (requestedSources.includes('cloudsaver')) {
            const cloudResources = await this._fetchResources(normalizedTitle, tmdbInfo).catch(() => []);
            resources.push(...cloudResources
            .map(resource => ({
                messageId: resource.messageId,
                title: resource.title,
                shareLink: resource.cloudLinks?.[0]?.link || '',
                score: this._scoreResource(resource, titleCandidates, targetYear),
                source: 'cloudsaver'
            }))
            .filter(item => item.shareLink));
        }
        if (requestedSources.includes('hdhive')) {
            const hdhiveResources = await this._searchHdhiveResources(titleCandidates, targetYear, tmdbInfo).catch(() => []);
            resources.push(...hdhiveResources);
        }
        if (requestedSources.includes('subscription')) {
            const subscriptionResources = await this._searchSubscriptionResources(titleCandidates, targetYear).catch(() => []);
            resources.push(...subscriptionResources);
        }

        return {
            tmdbInfo: this._pickTmdbBrief(tmdbInfo),
            resources: resources.sort((left, right) => right.score - left.score)
        };
    }

    _normalizeSearchSources(sources) {
        const requested = Array.isArray(sources)
            ? sources
            : String(sources || '').split(',');
        const valid = requested.map(item => String(item).trim().toLowerCase())
            .filter(item => ['cloudsaver', 'hdhive', 'subscription'].includes(item));
        return valid.length ? [...new Set(valid)] : ['cloudsaver', 'hdhive', 'subscription'];
    }

    /**
     * 搜索订阅资源库，返回供手动选择模式展示的候选列表。
     */
    async _searchSubscriptionResources(titleCandidates, targetYear) {
        if (!AppDataSource.isInitialized) {
            return [];
        }
        const resourceRepo = AppDataSource.getRepository('SubscriptionResource');
        const resources = await resourceRepo.find({ where: { verifyStatus: 'valid' } });
        return resources
            .map(resource => ({
                id: String(resource.id),
                title: this._cleanSubscriptionTitle(resource.title),
                shareLink: resource.shareLink || '',
                score: this._scoreSubscriptionResource(resource, titleCandidates, targetYear),
                source: 'subscription'
            }))
            .filter(item => item.shareLink && item.score > 0);
    }

    async _searchHdhiveResources(titleCandidates, targetYear, tmdbInfo) {
        if (!tmdbInfo?.id || !ConfigService.getConfigValue('hdhive.enabled')) return [];
        const hdhiveSDK = require('../sdk/hdhive/sdk').default;
        const result = await hdhiveSDK.getResources('tv', tmdbInfo.id);
        if (!result?.success) return [];
        return (Array.isArray(result.data) ? result.data : [])
            .filter(resource => !resource.expired && (resource.isUnlocked || resource.isFree))
            .map(resource => ({
                id: resource.id,
                slug: resource.slug || resource.id,
                title: resource.title || tmdbInfo.title || '影巢资源',
                shareLink: resource.link || '',
                accessCode: resource.code || '',
                score: this._scoreResource(resource, titleCandidates, targetYear) + this._scoreQuality(resource.title),
                source: 'hdhive',
                quality: resource.quality || '',
                sizeFormatted: resource.sizeFormatted || '',
                isUnlocked: Boolean(resource.isUnlocked),
                isFree: Boolean(resource.isFree),
                points: resource.points
            }));
    }

    async _findBestHdhiveResource(title, year, tmdbInfo) {
        const titleCandidates = [title, tmdbInfo?.title, tmdbInfo?.originalTitle]
            .filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = year || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');
        const candidates = await this._searchHdhiveResources(titleCandidates, targetYear, tmdbInfo);
        for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
            if (candidate.shareLink) {
                return { title: candidate.title, cloudLinks: [{ link: candidate.shareLink }] };
            }
            const hdhiveSDK = require('../sdk/hdhive/sdk').default;
            const unlocked = await hdhiveSDK.unlockResource(candidate.slug);
            if (unlocked?.success && unlocked.data?.link) {
                return { title: candidate.title, cloudLinks: [{ link: unlocked.data.link }] };
            }
        }
        return null;
    }

    _scoreQuality(value) {
        const title = String(value || '').toLowerCase();
        let score = 0;
        if (/2160p|\b4k\b/.test(title)) score += 30;
        else if (/1080p/.test(title)) score += 15;
        if (/dolby[ ._-]?vision|\bdv\b|hdr10|\bhdr\b/.test(title)) score += 8;
        if (/remux|blu[ ._-]?ray/.test(title)) score += 5;
        return score;
    }

    _pickTmdbBrief(tmdbInfo) {
        if (!tmdbInfo) {
            return null;
        }
        return {
            id: tmdbInfo.id || null,
            title: tmdbInfo.title || '',
            originalTitle: tmdbInfo.originalTitle || '',
            releaseDate: tmdbInfo.releaseDate || ''
        };
    }

    async _fetchResources(title, tmdbInfo) {
        const cloudSaverSDK = require('../sdk/cloudsaver/sdk').default;
        const searchKeywords = [];
        if (tmdbInfo?.title) {
            searchKeywords.push(tmdbInfo.title);
        }
        if (title) {
            searchKeywords.push(title);
        }
        if (tmdbInfo?.originalTitle) {
            searchKeywords.push(tmdbInfo.originalTitle);
        }

        const uniqueKeywords = [...new Set(searchKeywords.filter(Boolean))];
        for (const keyword of uniqueKeywords) {
            // 列表模式: 拿全部结果(含无链接的 hide 帖)
            const result = await cloudSaverSDK.searchList(keyword);
            if (result?.length) {
                return result;
            }
        }
        return [];
    }

    async _findBestResource(title, year, tmdbInfo) {
        const resources = await this._fetchResources(title, tmdbInfo);
        if (!resources.length) {
            return null;
        }

        const titleCandidates = [
            title,
            tmdbInfo?.title,
            tmdbInfo?.originalTitle
        ].filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = year || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');

        const scored = resources
            .map(resource => ({
                ...resource,
                _score: this._scoreResource(resource, titleCandidates, targetYear)
            }))
            .sort((left, right) => right._score - left._score);

        // 按评分从高到低: 有链接直接用, 没链接的调 detail 解析 (最多 5 个)
        const cloudSaverSDK = require('../sdk/cloudsaver/sdk').default;
        for (const item of scored.slice(0, 5)) {
            if (item.cloudLinks?.length) {
                return item;
            }
            if (item.topicId) {
                const detail = await cloudSaverSDK.getDetail(item.topicId);
                if (detail?.cloudLinks?.length) {
                    return { ...item, ...detail };
                }
            }
        }
        return null;
    }

    _scoreResource(resource, titleCandidates, targetYear) {
        const title = String(resource.title || '').toLowerCase();
        let score = 0;

        for (const candidate of titleCandidates) {
            if (!candidate) {
                continue;
            }
            if (title === candidate) {
                score += 120;
                continue;
            }
            if (title.includes(candidate)) {
                score += 80;
                continue;
            }
            const normalizedCandidate = candidate.replace(/\s+/g, '');
            const normalizedTitle = title.replace(/\s+/g, '');
            if (normalizedTitle.includes(normalizedCandidate)) {
                score += 60;
            }
        }

        if (targetYear && title.includes(targetYear)) {
            score += 20;
        }
        if (/完结|全集|全\d+集/.test(resource.title || '')) {
            score += 10;
        }
        return score;
    }

    /**
     * 从订阅资源库中按标题匹配最佳资源。
     * 订阅资源标题通常带「首字母+片名(年份)...」格式，匹配时去掉首字母前缀与年份噪音。
     * 仅返回校验通过（verifyStatus=valid）且有分享链接的资源。
     */
    async _findBestSubscriptionResource(title, year, tmdbInfo) {
        if (!AppDataSource.isInitialized) {
            return null;
        }
        const resourceRepo = AppDataSource.getRepository('SubscriptionResource');
        const resources = await resourceRepo.find({
            where: { verifyStatus: 'valid' }
        });
        if (!resources.length) {
            return null;
        }

        const titleCandidates = [
            title,
            tmdbInfo?.title,
            tmdbInfo?.originalTitle
        ].filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = year || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');

        const scored = resources
            .map(resource => ({
                resource,
                _score: this._scoreSubscriptionResource(resource, titleCandidates, targetYear)
            }))
            .filter(item => item._score > 0)
            .sort((left, right) => right._score - left._score);

        const best = scored[0];
        if (!best?.resource?.shareLink) {
            return null;
        }
        return {
            title: this._cleanSubscriptionTitle(best.resource.title),
            cloudLinks: [{ link: best.resource.shareLink }]
        };
    }

    /**
     * 订阅资源标题评分：标题常为「F疯狂动物城2(2025)美国 喜剧...」格式，
     * 首字符可能是分类字母前缀，需剥离后再做包含匹配。
     */
    _scoreSubscriptionResource(resource, titleCandidates, targetYear) {
        const rawTitle = String(resource.title || '');
        const cleaned = this._cleanSubscriptionTitle(rawTitle).toLowerCase();
        const title = rawTitle.toLowerCase();
        let score = 0;

        for (const candidate of titleCandidates) {
            if (!candidate) {
                continue;
            }
            const normalizedCandidate = candidate.replace(/\s+/g, '');
            if (cleaned === candidate || title === candidate) {
                score += 120;
                continue;
            }
            if (cleaned.includes(candidate) || title.includes(candidate)) {
                score += 80;
                continue;
            }
            if (cleaned.replace(/\s+/g, '').includes(normalizedCandidate)) {
                score += 60;
            }
        }

        // 仅在已有标题匹配时叠加年份/完结加分，避免零相关资源仅靠完结标记混入结果
        if (score > 0) {
            if (targetYear && (title.includes(targetYear) || cleaned.includes(targetYear))) {
                score += 20;
            }
            if (/完结|全集|全\d+集|\d+集全/.test(rawTitle)) {
                score += 10;
            }
        }
        return score;
    }

    /**
     * 清理订阅资源标题：去掉首字母分类前缀（如「F疯狂动物城2」的 F）与括号内的年份/标签噪音。
     */
    _cleanSubscriptionTitle(title = '') {
        let cleaned = String(title || '').trim();
        // 去掉「(2025)美国 喜剧...」这类括号及其后的标签描述
        cleaned = cleaned.replace(/[（(].*$/, '').trim();
        // 去掉开头的单个 ASCII 字母分类前缀（紧跟中文字符时）
        cleaned = cleaned.replace(/^[A-Za-z](?=[一-龥])/, '').trim();
        return cleaned || String(title || '').trim();
    }

    _normalizeMode(mode) {
        const normalizedMode = String(mode || 'lazy').trim().toLowerCase();
        return normalizedMode === 'auto' ? 'normal' : normalizedMode;
    }
}

module.exports = {
    AutoSeriesService,
    AUTO_SERIES_SOURCES,
    DEFAULT_SOURCE_PREFERENCES,
    normalizeSourcePreferences
};
