/**
 * 统一命名模板渲染器（nunjucks / Jinja2 风格）。
 * 支持条件渲染：{{name}}{% if year %} ({{year}}){% endif %}{{ext}}
 * 兼容旧占位符格式：{name} ({year}){ext} → 自动迁移为 nunjucks 语法。
 */
const nunjucks = require('nunjucks');

const env = new nunjucks.Environment(null, { autoescape: false, trimBlocks: true });

// 旧占位符 → nunjucks 变量映射
const LEGACY_MAP = {
    '{name}': '{{name}}',
    '{year}': '{{year}}',
    '{s}': '{{s}}',
    '{e}': '{{e}}',
    '{sn}': '{{sn}}',
    '{en}': '{{en}}',
    '{ext}': '{{ext}}',
    '{se}': '{{se}}'
};

/**
 * 将旧占位符模板迁移为 nunjucks 语法。
 * " ({year})" 整体迁移为条件渲染，年份为空时连括号和空格一起省掉。
 */
function migrateTemplate(tpl) {
    let result = String(tpl || '');
    // " ({year})" → 条件渲染（含括号和空格）
    result = result.replace(/\s*\(\{year\}\)/g, '{% if year %} ({{year}}){% endif %}');
    // 剩余的裸 {year}（不在括号里、也未被迁移）→ 普通变量
    // 负向断言避免匹配已迁移的 {{year}}
    result = result.replace(/(?<!\{)\{year\}/g, '{{year}}');
    for (const [old, nw] of Object.entries(LEGACY_MAP)) {
        if (old === '{year}') continue; // 已处理
        result = result.split(old).join(nw);
    }
    return result;
}

/**
 * 渲染文件名模板。
 * @param {string} template - nunjucks 模板或旧占位符模板（自动检测迁移）
 * @param {object} vars - { name, year, s, e, sn, en, ext, se }
 * @returns {string} 渲染后的文件名
 */
function renderFileName(template, vars = {}) {
    const raw = String(template || '');
    // 已是 nunjucks 格式（含 {{ 或 {%）直接用；否则是旧占位符，先迁移
    const isNunjucks = /\{\{|\{%/.test(raw);
    const tpl = isNunjucks ? raw : migrateTemplate(raw);
    try {
        return env.renderString(tpl, vars).trim();
    } catch (_) {
        // 模板语法错误时回退到简单拼接
        return [vars.name, vars.year ? `(${vars.year})` : '', vars.ext || ''].join(' ').trim();
    }
}

module.exports = { renderFileName, migrateTemplate };
