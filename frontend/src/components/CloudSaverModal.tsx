import React, { useState } from 'react';
import { Search, ExternalLink, Plus, RefreshCw, Loader2 } from 'lucide-react';
import Modal from './Modal';
import { useToast } from './ui/Toast';

interface CloudLink {
  cloudType?: string;
  link: string;
  accessCode?: string;
}

interface SearchResult {
  messageId: string;
  title: string;
  cloudLinks: CloudLink[];
  topicId?: string;
  hasLinks?: boolean;
  content?: string;
  pubDate?: string;
}

interface CloudSaverModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTransfer: (data: any) => void;
}

const CloudSaverModal: React.FC<CloudSaverModalProps> = ({ isOpen, onClose, onTransfer }) => {
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!keyword.trim() || loading) return;
    setLoading(true);
    setHasSearched(true);
    try {
      const response = await fetch(`/api/cloudsaver/search?keyword=${encodeURIComponent(keyword.trim())}&mode=list`);
      const data = await response.json();
      if (data.success) {
        setResults(data.data || []);
      } else {
        setResults([]);
        toast.error(data.error || '搜索失败');
      }
    } catch (error) {
      console.error('Search failed:', error);
      setResults([]);
      toast.error('搜索失败，请检查网络或 CloudSaver 配置');
    } finally {
      setLoading(false);
    }
  };

  const handleTransfer = async (res: SearchResult) => {
    // 已有链接 → 直接转存
    if (res.cloudLinks?.length) {
      const link = res.cloudLinks[0];
      onTransfer({
        shareLink: link.link,
        accessCode: link.accessCode || '',
        taskName: res.title,
      });
      return;
    }

    // 无链接 → 按需拉详情
    if (!res.topicId) {
      toast.error('该资源无法解析链接');
      return;
    }

    setResolvingId(res.messageId);
    try {
      const response = await fetch(`/api/cloudsaver/detail?topicId=${encodeURIComponent(res.topicId)}`);
      const data = await response.json();
      if (data.success && data.data?.cloudLinks?.length) {
        const link = data.data.cloudLinks[0];
        // 更新列表中该项的链接状态
        setResults(prev => prev.map(item =>
          item.messageId === res.messageId
            ? { ...item, cloudLinks: data.data.cloudLinks, hasLinks: true }
            : item
        ));
        onTransfer({
          shareLink: link.link,
          accessCode: link.accessCode || '',
          taskName: data.data.title || res.title,
        });
      } else {
        toast.error('该帖子没有可用的天翼云盘链接');
      }
    } catch (error) {
      console.error('Detail fetch failed:', error);
      toast.error('获取详情失败');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="CloudSaver 资源搜索"
      footer={null}
    >
      <div className="space-y-6">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="搜索网盘资源..."
              className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 dark:bg-slate-800/60 dark:border-slate-700"
            />
            <Search size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          </div>
          <button
            onClick={handleSearch}
            disabled={loading || !keyword.trim()}
            className="px-6 py-3 bg-[#0b57d0] text-white rounded-2xl text-sm font-medium hover:bg-[#0b57d0]/90 transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? <RefreshCw size={18} className="animate-spin" /> : <Search size={18} />} 搜索
          </button>
        </div>

        <div className="max-h-[400px] overflow-y-auto space-y-3 custom-scrollbar pr-1">
          {loading ? (
            <div className="text-center py-20 text-slate-500">正在搜索优质资源...</div>
          ) : results.length === 0 ? (
            <div className="text-center py-20 text-slate-400">
              {hasSearched ? '未找到相关资源' : '输入关键字开始搜索'}
            </div>
          ) : results.map((res, i) => {
            const isResolving = resolvingId === res.messageId;
            const hasLinks = res.hasLinks || res.cloudLinks?.length > 0;
            return (
              <div
                key={res.messageId || `result-${i}`}
                className="p-4 bg-white border border-slate-200 rounded-2xl hover:border-[#0b57d0]/30 transition-all group dark:bg-slate-900/60 dark:border-slate-700"
              >
                <div className="flex justify-between items-start gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`shrink-0 w-2 h-2 rounded-full ${hasLinks ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                        title={hasLinks ? '摘要含链接' : '需点击解析'}
                      />
                      <h4 className="font-medium text-slate-900 line-clamp-2 leading-snug dark:text-slate-100">{res.title}</h4>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <span>{res.pubDate || '未知日期'}</span>
                      {res.content && (
                        <span className="line-clamp-1 text-slate-400">{res.content.slice(0, 80)}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleTransfer(res)}
                    disabled={isResolving}
                    className="shrink-0 p-2.5 bg-[#c4eed0] text-[#146c2e] rounded-xl hover:bg-[#b2e7c0] transition-colors disabled:opacity-60"
                    title={hasLinks ? '一键转存' : '解析并转存'}
                  >
                    {isResolving ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100 flex items-start gap-3 dark:bg-blue-500/10 dark:border-blue-500/20">
          <ExternalLink size={18} className="text-[#0b57d0] shrink-0 mt-0.5" />
          <p className="text-[10px] text-[#0b57d0] leading-relaxed dark:text-blue-300">
            提示：绿点表示摘要中已含链接，灰点表示需要点击后解析详情。转存前请确保您的账号空间充足。
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default CloudSaverModal;
