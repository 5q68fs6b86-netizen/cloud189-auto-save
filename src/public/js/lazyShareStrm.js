let lazyShareStrmFolderSelector = null;

function initLazyShareStrm() {
    const form = document.getElementById('lazyShareStrmForm');
    if (!form) {
        return;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await submitLazyShareStrm();
    });

    document.getElementById('lazyShareStrmPickFolderBtn').addEventListener('click', () => {
        const accountId = document.getElementById('lazyShareStrmAccountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        ensureLazyShareStrmFolderSelector().show(accountId);
    });

    document.getElementById('lazyShareStrmAccountId').addEventListener('change', handleLazyShareStrmAccountChange);
    updateLazyShareStrmAccountOptions();
}

function ensureLazyShareStrmFolderSelector() {
    if (lazyShareStrmFolderSelector) {
        return lazyShareStrmFolderSelector;
    }
    lazyShareStrmFolderSelector = new FolderSelector({
        title: '选择懒转存目标目录',
        enableFavorites: true,
        favoritesKey: 'lazyShareStrmFavorites',
        onSelect: ({ id, path }) => {
            document.getElementById('lazyShareStrmTargetFolderId').value = id;
            document.getElementById('lazyShareStrmTargetFolder').value = path || '/';
        }
    });
    return lazyShareStrmFolderSelector;
}

function updateLazyShareStrmAccountOptions() {
    const select = document.getElementById('lazyShareStrmAccountId');
    if (!select) {
        return;
    }
    const previousValue = select.value;
    const availableAccounts = (accountsList || []).filter((account) => !account.original_username.startsWith('n_'));
    select.innerHTML = availableAccounts.length
        ? availableAccounts.map((account) => `<option value="${account.id}">${escapeLazyShareStrmHtml(getAccountDisplayName(account))}</option>`).join('')
        : '<option value="">暂无可用账号</option>';

    const targetAccount = availableAccounts.find((account) => String(account.id) === String(previousValue))
        || availableAccounts.find((account) => account.isDefault)
        || availableAccounts[0];
    select.value = targetAccount ? String(targetAccount.id) : '';
    handleLazyShareStrmAccountChange();
}

function handleLazyShareStrmAccountChange() {
    const select = document.getElementById('lazyShareStrmAccountId');
    const account = (accountsList || []).find((item) => String(item.id) === String(select.value));
    const localPathInput = document.getElementById('lazyShareStrmLocalPathPrefix');
    if (account && !localPathInput.value) {
        localPathInput.value = account.localStrmPrefix || '';
    }
    document.getElementById('lazyShareStrmTargetFolderId').value = '';
    document.getElementById('lazyShareStrmTargetFolder').value = '';
}

async function submitLazyShareStrm() {
    const payload = {
        accountId: document.getElementById('lazyShareStrmAccountId').value,
        targetFolderId: document.getElementById('lazyShareStrmTargetFolderId').value,
        localPathPrefix: document.getElementById('lazyShareStrmLocalPathPrefix').value.trim(),
        shareLink: document.getElementById('lazyShareStrmShareLink').value.trim(),
        accessCode: document.getElementById('lazyShareStrmAccessCode').value.trim(),
        overwriteExisting: document.getElementById('lazyShareStrmOverwriteExisting').checked
    };

    if (!payload.accountId) {
        message.warning('请选择账号');
        return;
    }
    if (!payload.targetFolderId) {
        message.warning('请选择目标目录');
        return;
    }
    if (!payload.localPathPrefix) {
        message.warning('请填写本地STRM目录');
        return;
    }
    if (!payload.shareLink) {
        message.warning('请填写分享链接');
        return;
    }

    loading.show();
    try {
        const response = await fetch('/api/strm/lazy-share/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '生成失败');
        }
        message.success(data.data.message || '生成成功');
        document.getElementById('lazyShareStrmShareLink').value = '';
        document.getElementById('lazyShareStrmAccessCode').value = '';
        document.getElementById('lazyShareStrmOverwriteExisting').checked = false;
        openStrmBrowser(payload.localPathPrefix);
    } catch (error) {
        message.warning('生成失败: ' + error.message);
    } finally {
        loading.hide();
    }
}

function escapeLazyShareStrmHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
