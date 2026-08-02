const anitomy = require('anitomy-ng');

const SEASON_EPISODE_PATTERNS = [
    /(?:^|[\s._-])S(\d{1,2})\s*E(\d{1,3})(?=[\s._-]|$)/i,
    /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?=[\s._-]|$)/i,
    /(?:^|[\s._-])S(\d{1,2})(?=[\s._-]|$)/i,
    /(?:^|[\s._-])Season\s*(\d{1,2})(?=[\s._-]|$)/i,
    /(?:^|[\s._-])第\s*(\d{1,2})\s*季(?=[\s._-]|$)/i,
    // 动漫字幕组方括号集号：[08]、【08】（group1 空 → 仅集号，无季号）
    /[\[【]()(\d{1,3})[\]】]/
];

const CN_NUMBER_MAP = new Map([
    ['零', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
    ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10]
]);

function parseChineseNumber(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return null;
    if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
    if (normalized === '十') return 10;
    if (normalized.startsWith('十')) {
        const tail = CN_NUMBER_MAP.get(normalized.slice(1));
        return tail != null ? 10 + tail : null;
    }
    if (normalized.endsWith('十')) {
        const head = CN_NUMBER_MAP.get(normalized.slice(0, -1));
        return head != null ? head * 10 : null;
    }
    const tenIndex = normalized.indexOf('十');
    if (tenIndex > 0) {
        const head = CN_NUMBER_MAP.get(normalized.slice(0, tenIndex));
        const tail = CN_NUMBER_MAP.get(normalized.slice(tenIndex + 1));
        if (head != null && tail != null) {
            return head * 10 + tail;
        }
    }
    return CN_NUMBER_MAP.get(normalized) ?? null;
}

const NOISE_PATTERNS = [
    /\b(?:2160|1080|720|480)p\b/ig,
    /\bweb[\s.-]?dl\b/ig,
    /\bwebrip\b/ig,
    /\bblu[\s.-]?ray\b/ig,
    /\bhdr10\b/ig,
    /\bhdr\b/ig,
    /\bdv\b/ig,
    /\bhevc\b/ig,
    /\bh\s*265\b/ig,
    /\bh\s*264\b/ig,
    /\bx\s*265\b/ig,
    /\bx\s*264\b/ig,
    /\baac\b/ig,
    /\bflac\b/ig,
    /\bddp\b/ig,
    /\batmos\b/ig,
    /\bvivid\b/ig,
    /\b(?:50|60)\s*fps\b/ig,
    /\bhiveweb\b/ig,
    /\bAMZN\b/ig,
    /\bNF\b/ig,
    /\bDSNP\b/ig,
    /\bHMAX\b/ig,
    /\bVPP\b/ig,
    /\b\d+\s*audios?\b/ig,
    /仅秒传/ig
];

function normalizeSpaces(text) {
    return text.replace(/[\s._]+/g, ' ').trim();
}

/**
 * 启发式判断文件名是否为动漫风格（学 MoviePilot 的 is_anime）。
 * 只有明确动漫命名才走 anitomy 专用解析器，标准点分命名走通用正则。
 */
function isAnimeStyle(name) {
    const t = String(name || '');
    // 方括号堆叠：[字幕组] 标题 [01][1080p]
    if ((t.match(/\[[^\]]+\]/g) || []).length >= 2) return true;
    // 【字幕组】标题【01】：要求至少一组是纯数字（集号），
    // 排除资源标题里的【日漫电影】【211.78GB】等非动漫标记
    const cjkGroups = t.match(/【[^】]+】/g) || [];
    if (cjkGroups.length >= 2 && cjkGroups.some((g) => /^【\d{1,3}】$/.test(g))) return true;
    // " - 01 " 集号分隔（动漫常见）
    if (/\s-\s\d{1,3}\s/.test(t)) return true;
    return false;
}

/**
 * 用 anitomy 解析动漫文件名，返回与 parseMediaTitle 相同的结构。
 * anitomy 原生支持 [字幕组]/[集号]/第x话/EP01/集数范围 等动漫专用形态。
 */
function parseAnimeTitle(name) {
    let elements;
    try {
        elements = anitomy.parse(String(name || ''));
    } catch (_) {
        return null;
    }
    if (!Array.isArray(elements)) return null;
    const get = (kind) => elements.filter((e) => e.kind === kind).map((e) => e.value);
    const title = normalizeSpaces(get('title').join(' '));
    const episodeRaw = get('episode'); // 集数范围时可能有多个，取第一个（起始集）
    const episode = episodeRaw.length ? parseInt(episodeRaw[0], 10) : null;
    const seasonRaw = get('season');
    const season = seasonRaw.length ? parseInt(seasonRaw[0], 10) : null;
    const yearRaw = get('year');
    const year = yearRaw.length ? parseInt(yearRaw[0], 10) : null;
    return {
        rawName: name,
        cleanTitle: title,
        year: Number.isFinite(year) ? year : null,
        season: Number.isFinite(season) ? season : null,
        episode: Number.isFinite(episode) ? episode : null,
        aliases: [],
        removedTokens: []
    };
}

function parseMediaTitle(source) {
    // 动漫风格走 anitomy 专用解析器；解析失败（空标题）回退到通用正则
    if (isAnimeStyle(source)) {
        const animeResult = parseAnimeTitle(source);
        if (animeResult && animeResult.cleanTitle) {
            return animeResult;
        }
    }

    let text = source || '';

    // 1. 先把所有点号、下划线转换为空格，方便后续匹配
    text = text.replace(/[._]/g, ' ');

    // 1.5 去掉开头的字幕组/标签方括号（如 [MAI]、[Nekomoe kissaten]），
    // 但保留纯数字方括号（如 [08]，那是集号）
    text = text.replace(/^(?:\[[^\]\d][^\]]*\]\s*)+/i, '');
    const textForSeasonEpisode = text;

    // 2. 暴力截断：遇到常见的元数据起始符，直接砍掉后面所有内容
    // 增加对不带空格的 + 的处理
    const TRUNCATE_KEYWORDS = [
        ' + ', ' | ', ' - ', ' [', '(', 
        '2160p', '1080p', '720p', 
        'AMZN', 'WEB-DL', 'WEBRip', 'BluRay'
    ];
    
    for (const kw of TRUNCATE_KEYWORDS) {
        const idx = text.toLowerCase().indexOf(kw.toLowerCase());
        if (idx !== -1) {
            text = text.substring(0, idx);
        }
    }

    // 3. 再次处理一些粘连的垃圾后缀（如 HDR10+, MULTi）
    text = text.replace(/\+/g, ' ')
               .replace(/\b(MULTi|HDR10|DV|HDR|HEVC|H264|H265|x264|x265)\b/ig, ' ');

    let year = null, season = null, episode = null;
    const removedTokens = [];

    // 4. 提取年份 (通常是 4 位数字)
    const yearMatch = textForSeasonEpisode.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
        year = parseInt(yearMatch[1]);
        // 提取完年份后，如果是作为后缀的年份，可以考虑截断
    }

    // 5. 提取季度和集数
    for (const pattern of SEASON_EPISODE_PATTERNS) {
        const match = textForSeasonEpisode.match(pattern);
        if (match) {
            if (match[1]) season = parseInt(match[1]);
            if (match[2]) episode = parseInt(match[2]);
            removedTokens.push(match[0]);
            break;
        }
    }

    if (season == null) {
        const chineseSeasonMatch = textForSeasonEpisode.match(/第\s*([零一二两三四五六七八九十百\d]{1,4})\s*季/i);
        if (chineseSeasonMatch?.[1]) {
            const parsedSeason = parseChineseNumber(chineseSeasonMatch[1]);
            if (parsedSeason != null) {
                season = parsedSeason;
                removedTokens.push(chineseSeasonMatch[0]);
            }
        }
    }

    // 6. 执行常规噪声清理 (仅保留看起来像名称的部分)
    for (const pattern of NOISE_PATTERNS) {
        const matches = text.match(pattern);
        if (matches) {
            removedTokens.push(...matches);
            text = text.replace(pattern, ' ');
        }
    }

    // 7. 最后的精细清理：去掉末尾的纯数字（如果它看起来像集数而非标题的一部分）
    // 注意：Crime 101 的 101 应该保留，所以我们只去删掉孤立的、超过 3 位的或者前面有 E/S 的
    text = text
        .replace(/(?:^|\s)S\d{1,2}\s*E\d{1,3}(?=\s|$)/ig, ' ')
        .replace(/(?:^|\s)S\d{1,2}(?=\s|$)/ig, ' ')
        .replace(/(?:^|\s)Season\s*\d{1,2}(?=\s|$)/ig, ' ')
        .replace(/第\s*(?:[零一二两三四五六七八九十百\d]{1,4})\s*季/ig, ' ')
        .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
        .replace(/[\s-+;|]+$/g, ' ');

    const cleanTitle = normalizeSpaces(text);

    return {
        rawName: source,
        cleanTitle,
        year,
        season,
        episode,
        aliases: [],
        removedTokens
    };
}

// 电影合集检测：多部独立电影打包成一个资源（如"名侦探柯南剧场版01-26合集"）。
// 这类资源文件数 > 1，若按"多文件即剧集"的启发式会被误判为电视剧。
// 标题强信号（剧场版/电影/Movie）直接判定；弱信号（合集/收藏版）需文件级证据配合。
// 注意：模式用子串匹配而非 \b 边界——"Movie10" 这类粘连写法在 e/1 之间没有词边界。
const MOVIE_TITLE_PATTERN = /剧场版|大电影|电影|影片|movie|film|theatrical/i;
const COLLECTION_TITLE_PATTERN = /合集|收藏版|系列全|collection|complete|all[\s._-]?in[\s._-]?one/i;
const MOVIE_FILE_PATTERN = /movie|剧场版|大电影/i;

/**
 * 判断一个多文件资源是否为"电影合集"，并给出每个文件独立解析出的标题/年份。
 * @param {string} resourceName 资源/分享标题
 * @param {Array<{name?:string, restoreName?:string}>} files 文件列表
 * @returns {{isMovieCollection:boolean, perFileNames:Map<string,{title:string,year:number|null}>}}
 */
function detectMovieCollection(resourceName = '', files = []) {
    const title = String(resourceName || '');
    const titleParsed = parseMediaTitle(title);
    const hasSeasonHintInTitle = titleParsed.season != null || titleParsed.episode != null;

    const perFileNames = new Map();
    let movieFileHits = 0;
    let filesWithYear = 0;
    let filesWithSeasonHint = 0;
    const distinctYears = new Set();

    for (const file of files) {
        const name = file.name || file.restoreName || '';
        const parsed = parseMediaTitle(name);
        perFileNames.set(name, { title: parsed.cleanTitle, year: parsed.year });
        if (MOVIE_FILE_PATTERN.test(name)) movieFileHits += 1;
        if (parsed.season != null || parsed.episode != null) filesWithSeasonHint += 1;
        if (parsed.year != null) {
            filesWithYear += 1;
            distinctYears.add(parsed.year);
        }
    }

    const total = files.length;
    // 过半文件带 SxxExx/第x季 等季集线索 → 是剧集而非电影合集（如"电影少女"这类含"电影"字样的剧集）
    const filesLookEpisodic = total > 0 && filesWithSeasonHint / total >= 0.5;
    // 文件级证据：过半文件带 Movie/剧场版 字样，或过半文件带各自不同的年份
    const filesLookLikeMovies = total > 0 && (
        movieFileHits / total >= 0.5 ||
        (filesWithYear / total >= 0.5 && distinctYears.size >= Math.min(2, total))
    );

    let isMovieCollection = false;
    if (total > 1 && !hasSeasonHintInTitle && !filesLookEpisodic) {
        // 强信号（标题含剧场版/电影/Movie）也要求文件级佐证，防止"电影少女"这类
        // 标题含"电影"但实为剧集的误判——文件须表现为多部独立电影（年份分散或含 Movie 字样）。
        if (MOVIE_TITLE_PATTERN.test(title) && filesLookLikeMovies) {
            isMovieCollection = true;
        } else if (filesLookLikeMovies && (COLLECTION_TITLE_PATTERN.test(title) || movieFileHits / total >= 0.5)) {
            // 标题仅说"合集"或无信号：需要文件级证据佐证
            isMovieCollection = true;
        }
    }

    return { isMovieCollection, perFileNames };
}

/**
 * 层级补全：合并文件名、选中目录名、父级标题三个来源。
 * - title：优先中文标题（目录名/父级名通常是中文，适合做文件夹名）；
 *          无中文来源时回退到文件解析标题（如纯英文电影）。
 * - year/season/episode：按 文件名 → 目录名 → 父级 优先级取第一个非空值（文件名最精确）。
 * 返回统一的 { title, year, season, episode } 对象。
 */
function resolveTitleMeta(task = {}, files = []) {
    const fileName = files[0]?.name || files[0]?.restoreName || '';
    const dirName = task.shareFolderName || '';
    const parentTitle = task.resourceName || '';

    const fileParsed = fileName ? parseMediaTitle(fileName) : null;
    const dirParsed = dirName ? parseMediaTitle(dirName) : null;
    const parentParsed = parentTitle ? parseMediaTitle(parentTitle) : null;

    // title：优先中文来源（目录名 → 父级名），回退文件标题
    const hasCJK = (s) => /[一-鿿]/.test(s || '');
    let title = '';
    if (dirParsed?.cleanTitle && hasCJK(dirParsed.cleanTitle)) title = dirParsed.cleanTitle;
    else if (parentParsed?.cleanTitle && hasCJK(parentParsed.cleanTitle)) title = parentParsed.cleanTitle;
    else title = fileParsed?.cleanTitle || dirParsed?.cleanTitle || parentParsed?.cleanTitle || '';

    // year/season/episode：文件名最精确，依次回退
    const pick = (field) => {
        for (const p of [fileParsed, dirParsed, parentParsed]) {
            if (p && p[field] != null) return p[field];
        }
        return null;
    };

    return {
        title,
        year: pick('year'),
        season: pick('season'),
        episode: pick('episode')
    };
}

module.exports = { parseMediaTitle, detectMovieCollection, resolveTitleMeta, isAnimeStyle };
