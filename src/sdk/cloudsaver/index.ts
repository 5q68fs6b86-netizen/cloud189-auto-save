import { Application } from 'express';
import cloudSaverSDK from './sdk';
const { logTaskEvent } = require('../../utils/logUtils');
export function setupCloudSaverRoutes(app: Application) {
    // 搜索接口 (支持 mode=list 返回全部列表)
    app.get('/api/cloudsaver/search', async (req, res) => {
        try {
            const { keyword, fast, mode } = req.query;

            if (!keyword || typeof keyword !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: '请提供搜索关键词'
                });
            }

            const results = mode === 'list'
                ? await cloudSaverSDK.searchList(keyword)
                : await cloudSaverSDK.search(keyword, fast === 'true' || fast === '1');
            res.json({
                success: true,
                data: results
            });
        } catch (error) {
            logTaskEvent('CloudSaver 搜索失败:' +  error);
            res.json({
                success: false,
                error: '搜索失败:' + error
            });
        }
    });

    // 单帖详情接口 (按需提取链接)
    app.get('/api/cloudsaver/detail', async (req, res) => {
        try {
            const { topicId } = req.query;
            if (!topicId || typeof topicId !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: '请提供 topicId'
                });
            }
            const result = await cloudSaverSDK.getDetail(topicId);
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logTaskEvent('CloudSaver 详情获取失败:' + error);
            res.json({
                success: false,
                error: '详情获取失败:' + error
            });
        }
    });
}

export function clearCloudSaverToken() {
    logTaskEvent('CloudSaverSDK 配置已更改, 清除token')
    cloudSaverSDK.setToken('');
}
