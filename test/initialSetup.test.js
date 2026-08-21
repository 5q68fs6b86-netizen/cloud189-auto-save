const test = require('node:test');
const assert = require('node:assert/strict');

const {
    authorizeInitialSetup,
    isLoopbackAddress,
    normalizeRemoteAddress
} = require('../src/utils/initialSetup');

const createRequest = (remoteAddress, setupToken = '') => ({
    socket: { remoteAddress },
    headers: {},
    body: setupToken ? { setupToken } : {}
});

test('首次初始化允许 IPv4 与 IPv6 回环地址', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.12.34.56'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(normalizeRemoteAddress('::ffff:192.0.2.1'), '192.0.2.1');
});

test('首次初始化默认拒绝远程客户端', () => {
    const previousToken = process.env.INITIAL_SETUP_TOKEN;
    delete process.env.INITIAL_SETUP_TOKEN;
    try {
        const result = authorizeInitialSetup(createRequest('192.0.2.10'));
        assert.equal(result.allowed, false);
        assert.equal(result.status, 403);
    } finally {
        if (previousToken === undefined) delete process.env.INITIAL_SETUP_TOKEN;
        else process.env.INITIAL_SETUP_TOKEN = previousToken;
    }
});

test('首次初始化令牌允许受控的远程设置', () => {
    const previousToken = process.env.INITIAL_SETUP_TOKEN;
    process.env.INITIAL_SETUP_TOKEN = 'test-only-setup-token';
    try {
        assert.equal(authorizeInitialSetup(createRequest('192.0.2.10')).allowed, false);
        assert.deepEqual(
            authorizeInitialSetup(createRequest('192.0.2.10', 'test-only-setup-token')),
            { allowed: true, mode: 'token' }
        );
    } finally {
        if (previousToken === undefined) delete process.env.INITIAL_SETUP_TOKEN;
        else process.env.INITIAL_SETUP_TOKEN = previousToken;
    }
});
