import React, { useState, useEffect, useRef } from 'react';
import { Plus, PlayCircle, RefreshCw, AlertCircle, CheckCircle2, ArrowLeft, Check, GripVertical, ArrowUp, ArrowDown } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import Modal from '../Modal';
import Checkbox from '../ui/Checkbox';
import { useToast } from '../ui/Toast';

interface Account {
  id: number;
  username: string;
  alias?: string;
}

interface AutoSeriesSettings {
  accountId: string;
  targetFolderId: string;
  targetFolder: string;
}

type AutoSeriesMode = 'normal' | 'lazy';

interface CandidateResource {
  id?: string;
  slug?: string;
  messageId?: string;
  title: string;
  shareLink: string;
  score?: number;
  source: 'cloudsaver' | 'hdhive' | 'subscription';
  quality?: string;
  sizeFormatted?: string;
  isUnlocked?: boolean;
  isFree?: boolean;
}

type AutoSeriesSource = 'cloudsaver' | 'hdhive' | 'pt' | 'subscription';
interface SourcePreference { source: AutoSeriesSource; enabled: boolean }

const SOURCE_LABELS: Record<AutoSeriesSource, string> = {
  cloudsaver: 'CloudSaver',
  hdhive: '影巢',
  pt: 'PT',
  subscription: '订阅'
};
const DEFAULT_SOURCES: SourcePreference[] = [
  { source: 'cloudsaver', enabled: true },
  { source: 'hdhive', enabled: true },
  { source: 'pt', enabled: true },
  { source: 'subscription', enabled: true }
];

interface SourcePreferenceRowProps {
  item: SourcePreference;
  index: number;
  total: number;
  onMove: (source: AutoSeriesSource, offset: number) => void;
  onToggle: (source: AutoSeriesSource, enabled: boolean) => void;
  onDragEnd: () => void;
}

const SourcePreferenceRow: React.FC<SourcePreferenceRowProps> = ({ item, index, total, onMove, onToggle, onDragEnd }) => {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={dragControls}
      onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.02, boxShadow: '0 10px 25px rgba(15, 23, 42, 0.14)' }}
      transition={{ type: 'spring', stiffness: 500, damping: 36 }}
      className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-slate-200 bg-white relative z-0"
    >
      <button
        type="button"
        aria-label={`拖动${SOURCE_LABELS[item.source]}调整顺序`}
        title="拖动调整顺序"
        onPointerDown={event => dragControls.start(event)}
        className="-m-2 p-2 text-slate-400 hover:text-slate-700 cursor-grab active:cursor-grabbing touch-none select-none"
      >
        <GripVertical size={17} />
      </button>
      <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-xs font-bold flex items-center justify-center">{index + 1}</span>
      <span className="flex-1 text-sm font-medium text-slate-800">{SOURCE_LABELS[item.source]}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`上移${SOURCE_LABELS[item.source]}`}
          title="上移"
          disabled={index === 0}
          onClick={() => onMove(item.source, -1)}
          className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg disabled:opacity-25 disabled:cursor-not-allowed"
        >
          <ArrowUp size={15} />
        </button>
        <button
          type="button"
          aria-label={`下移${SOURCE_LABELS[item.source]}`}
          title="下移"
          disabled={index === total - 1}
          onClick={() => onMove(item.source, 1)}
          className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg disabled:opacity-25 disabled:cursor-not-allowed"
        >
          <ArrowDown size={15} />
        </button>
      </div>
      <Checkbox checked={item.enabled} onChange={enabled => onToggle(item.source, enabled)} />
    </Reorder.Item>
  );
};

const DEFAULT_AUTO_SERIES_MODE: AutoSeriesMode = 'lazy';

const AutoSeriesTab: React.FC = () => {
  const toast = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [defaults, setDefaults] = useState<AutoSeriesSettings | null>(null);
  const [form, setForm] = useState<{
    title: string;
    year: string;
    mode: AutoSeriesMode;
    manualSelect: boolean;
    keepCasAfterRestore: boolean;
  }>({
    title: '',
    year: '',
    mode: DEFAULT_AUTO_SERIES_MODE,
    manualSelect: false,
    keepCasAfterRestore: false
  });
  const [candidates, setCandidates] = useState<CandidateResource[]>([]);
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0);
  const [sourcePreferences, setSourcePreferences] = useState<SourcePreference[]>(DEFAULT_SOURCES);
  const sourcePreferencesRef = useRef(sourcePreferences);
  const [step, setStep] = useState<'form' | 'select'>('form');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const loadJson = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} 请求失败: ${response.status}`);
      return response.json();
    };
    const [accountsResult, settingsResult, sourcesResult] = await Promise.allSettled([
      loadJson('/api/accounts'),
      loadJson('/api/settings'),
      loadJson('/api/auto-series/sources')
    ]);

    if (accountsResult.status === 'fulfilled' && accountsResult.value.success) {
      setAccounts(accountsResult.value.data);
    } else if (accountsResult.status === 'rejected') {
      console.error('Failed to fetch accounts:', accountsResult.reason);
    }
    if (settingsResult.status === 'fulfilled' && settingsResult.value.success) {
      setDefaults(settingsResult.value.data.task.autoCreate);
    } else if (settingsResult.status === 'rejected') {
      console.error('Failed to fetch settings:', settingsResult.reason);
    }
    if (sourcesResult.status === 'fulfilled' && sourcesResult.value.success && Array.isArray(sourcesResult.value.data)) {
      setSourcePreferences(sourcesResult.value.data);
    } else if (sourcesResult.status === 'rejected') {
      console.warn('Failed to fetch auto-series sources, using defaults:', sourcesResult.reason);
    }
  };

  const resetModal = () => {
    setIsModalOpen(false);
    setForm({ title: '', year: '', mode: DEFAULT_AUTO_SERIES_MODE, manualSelect: false, keepCasAfterRestore: false });
    setCandidates([]);
    setSelectedCandidateIndex(0);
    setStep('form');
  };

  const createTask = async (shareLink?: string, resourceTitle?: string, sources?: AutoSeriesSource[]) => {
    setLoading(true);
    try {
      const response = await fetch('/api/auto-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          year: form.year,
          mode: form.mode,
          keepCasAfterRestore: form.keepCasAfterRestore,
          ...(sources ? { sources } : {}),
          ...(shareLink ? { shareLink, resourceTitle: resourceTitle || '' } : {})
        })
      });
      const data = await response.json();
      if (data.success) {
        if (data.data?.source === 'pt') {
          toast.success(`${data.data.reused ? '已复用' : '已创建'} PT 订阅：${data.data.taskName}（${data.data.selectionReason || data.data.preset}）`);
          resetModal();
          return;
        }
        const resultMode: AutoSeriesMode = data.data?.mode === 'normal' ? 'normal' : form.mode;
        toast.success(data.data?.taskCount > 0
          ? `已创建${resultMode === 'lazy' ? '懒转存' : '自动'}任务：${data.data.taskName}`
          : `已生成懒转存STRM：${data.data.taskName}`);
        resetModal();
      } else {
        toast.error('自动追剧失败: ' + data.error);
      }
    } catch (error) {
      toast.error('自动追剧失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveSourcePreferences = async (next: SourcePreference[]) => {
    sourcePreferencesRef.current = next;
    setSourcePreferences(next);
    try {
      const response = await fetch('/api/auto-series/sources', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: next })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || '保存失败');
      sourcePreferencesRef.current = data.data;
      setSourcePreferences(data.data);
    } catch (error) {
      toast.error('来源偏好保存失败: ' + (error as Error).message);
      await fetchData();
    }
  };

  const toggleSource = (source: AutoSeriesSource, enabled: boolean) => {
    void saveSourcePreferences(sourcePreferences.map(item => item.source === source ? { ...item, enabled } : item));
  };

  const reorderSource = (items: SourcePreference[], source: AutoSeriesSource, target: AutoSeriesSource) => {
    if (source === target) return items;
    const next = [...items];
    const from = next.findIndex(item => item.source === source);
    const to = next.findIndex(item => item.source === target);
    if (from < 0 || to < 0) return items;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  const moveSourceBy = (source: AutoSeriesSource, offset: number) => {
    const from = sourcePreferences.findIndex(item => item.source === source);
    const target = sourcePreferences[from + offset];
    if (!target) return;
    void saveSourcePreferences(reorderSource(sourcePreferences, source, target.source));
  };

  const handleSourceReorder = (next: SourcePreference[]) => {
    sourcePreferencesRef.current = next;
    setSourcePreferences(next);
  };

  const handleSourceDragEnd = () => {
    void saveSourcePreferences(sourcePreferencesRef.current);
  };

  const handleSearch = async () => {
    if (!form.title.trim()) {
      toast.warning('剧名不能为空');
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ title: form.title.trim() });
      if (form.year.trim()) params.append('year', form.year.trim());
      params.append('sources', sourcePreferences.filter(item => item.enabled && item.source !== 'pt').map(item => item.source).join(','));
      const response = await fetch(`/api/auto-series/search?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        const list: CandidateResource[] = data.data?.resources || [];
        if (!list.length) {
          const ptEnabled = sourcePreferences.some(item => item.enabled && item.source === 'pt');
          if (ptEnabled) {
            toast.info('网盘来源未找到候选，正在回退 PT');
            await createTask(undefined, undefined, ['pt']);
          } else {
            toast.info('未搜索到可用资源');
          }
          return;
        }
        setCandidates(list);
        setSelectedCandidateIndex(0);
        setStep('select');
      } else {
        toast.error('资源搜索失败: ' + data.error);
      }
    } catch (error) {
      toast.error('资源搜索失败: ' + (error as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.warning('剧名不能为空');
      return;
    }
    if (!sourcePreferences.some(item => item.enabled)) {
      toast.warning('请至少启用一个资源来源');
      return;
    }
    if (form.manualSelect) {
      const hasCloudSource = sourcePreferences.some(item => item.enabled && item.source !== 'pt');
      if (hasCloudSource) {
        await handleSearch();
      } else {
        await createTask(undefined, undefined, ['pt']);
      }
      return;
    }
    await createTask();
  };

  const handleConfirmSelection = async () => {
    const picked = candidates[selectedCandidateIndex];
    if (!picked || (!picked.shareLink && !picked.slug)) {
      toast.warning('请选择一个资源');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/auto-series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          year: form.year,
          mode: form.mode,
          keepCasAfterRestore: form.keepCasAfterRestore,
          source: picked.source,
          shareLink: picked.shareLink,
          resourceSlug: picked.slug,
          resourceTitle: picked.title
        })
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || '创建失败');
      toast.success(`已从${SOURCE_LABELS[picked.source]}创建任务：${data.data.taskName}`);
      resetModal();
    } catch (error) {
      toast.error('自动追剧失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const getAccountName = (id: string) => {
    const account = accounts.find(a => String(a.id) === id);
    return account ? (account.alias || account.username) : id;
  };

  const isConfigured = Boolean(defaults?.accountId && defaults?.targetFolderId);

  return (
    <div className="space-y-8">
      {/* Configuration Status Card */}
      <div className={`p-6 rounded-3xl border ${isConfigured ? 'bg-white border-slate-200/60' : 'bg-red-50 border-red-100'} shadow-sm`}>
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-2xl ${isConfigured ? 'bg-[#d3e3fd] text-[#0b57d0]' : 'bg-red-100 text-red-600'}`}>
            {isConfigured ? <CheckCircle2 size={24} /> : <AlertCircle size={24} />}
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-slate-900">自动追剧配置状态</h3>
            {isConfigured ? (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="text-slate-500 font-medium uppercase tracking-wider text-[10px]">默认账号</p>
                  <p className="text-slate-900 font-medium">{getAccountName(defaults.accountId)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-slate-500 font-medium uppercase tracking-wider text-[10px]">默认保存目录</p>
                  <p className="text-slate-900 font-medium truncate" title={defaults.targetFolder}>{defaults.targetFolder}</p>
                </div>
              </div>
            ) : (
              <p className="text-red-600 text-sm mt-1">
                请先到「系统 → 任务设置」配置自动追剧默认账号和默认保存目录。
              </p>
            )}
          </div>
          <button
            onClick={fetchData}
            className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <button
          onClick={() => setIsModalOpen(true)}
          disabled={!isConfigured}
          className="bg-[#0b57d0] text-white px-8 py-3 rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all shadow-lg hover:shadow-xl flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={20} /> 添加追剧
        </button>
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <AlertCircle size={16} className="shrink-0 text-slate-400" />
          本页仅提供快速创建入口；已创建的任务请到「任务」页管理。
        </p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200/60 p-8 shadow-sm">
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-2xl bg-[#d3e3fd] flex items-center justify-center text-[#0b57d0] shrink-0">
            <PlayCircle size={28} />
          </div>
          <div className="min-w-0 space-y-2">
            <h3 className="font-bold text-slate-900 text-lg">如何自动追剧</h3>
            <ol className="text-sm text-slate-600 space-y-1.5 list-decimal list-inside leading-relaxed">
              <li>在「系统 → 任务设置」填好默认账号与保存目录</li>
              <li>点击上方「添加追剧」，搜索并选定资源</li>
              <li>确认后会创建转存任务，后续追更在「任务」页查看</li>
            </ol>
          </div>
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={resetModal}
        title={step === 'select' ? '选择资源' : '添加自动追剧'}
        footer={null}
      >
        {step === 'form' ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">剧集名称</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                placeholder="例如: 庆余年 第二季"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">年份 (可选)</label>
                <input
                  type="text"
                  value={form.year}
                  onChange={e => setForm({ ...form, year: e.target.value })}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                  placeholder="2024"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">模式</label>
                <select
                  value={form.mode}
                  onChange={e => setForm({ ...form, mode: e.target.value as AutoSeriesMode })}
                  className="w-full px-5 py-3 bg-slate-50 border border-slate-300 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20"
                >
                  <option value="lazy">懒转存 (生成STRM)</option>
                  <option value="normal">自动转存 (下载文件)</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700">资源来源与回退顺序</label>
                <span className="text-[11px] text-slate-400">拖拽排序，自动保存</span>
              </div>
              <Reorder.Group axis="y" values={sourcePreferences} onReorder={handleSourceReorder} className="space-y-2">
                {sourcePreferences.map((item, index) => (
                  <SourcePreferenceRow
                    key={item.source}
                    item={item}
                    index={index}
                    total={sourcePreferences.length}
                    onMove={moveSourceBy}
                    onToggle={toggleSource}
                    onDragEnd={handleSourceDragEnd}
                  />
                ))}
              </Reorder.Group>
              {!sourcePreferences.some(item => item.enabled) && <p className="text-xs text-red-600">请至少启用一个来源。</p>}
            </div>

            {/* 手动选择资源开关 —— 默认关闭 */}
            <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl hover:bg-slate-100/70 transition-colors">
              <Checkbox
                align="start"
                checked={form.manualSelect}
                onChange={(v) => setForm({ ...form, manualSelect: v })}
                label={<span className="text-sm font-medium text-slate-800">手动选择资源</span>}
                description="开启后将先展示候选资源列表，由你确认后再创建任务；关闭则自动挑选最匹配的资源。"
              />
            </div>

            <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl hover:bg-slate-100/70 transition-colors">
              <Checkbox
                align="start"
                checked={form.keepCasAfterRestore}
                onChange={(v) => setForm({ ...form, keepCasAfterRestore: v })}
                label={<span className="text-sm font-medium text-slate-800">归档保留 CAS 存根</span>}
                description="开启后，恢复成功的 .cas 会移动到所选网盘目录下的 _cas 镜像路径；关闭则恢复后自动删除。"
              />
            </div>

            <div className="bg-[#f8fafd] p-4 rounded-2xl border border-slate-100">
              <p className="text-xs text-slate-500 leading-relaxed">
                <span className="font-bold text-[#0b57d0]">说明：</span>
                系统将根据剧名在网盘资源中搜索并自动创建转存任务。如果选择“懒转存”，则优先生成 STRM 文件而不占用网盘空间。
              </p>
            </div>

            <div className="flex gap-4 pt-4">
              <button
                type="button"
                onClick={resetModal}
                className="flex-1 px-6 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={loading || searching}
                className="flex-1 px-6 py-3 bg-[#0b57d0] text-white rounded-full font-medium hover:bg-[#0b57d0]/90 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {(loading || searching) && <RefreshCw size={18} className="animate-spin" />}
                {form.manualSelect ? '搜索网盘资源' : '按顺序开始追剧'}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="text-xs text-slate-500">
              共找到 <span className="font-semibold text-slate-800">{candidates.length}</span> 条候选资源，默认选中匹配度最高的一项。
            </div>
            <div className="max-h-[360px] overflow-y-auto space-y-2 pr-1">
              {candidates.map((item, index) => {
                const active = index === selectedCandidateIndex;
                return (
                  <button
                    key={item.shareLink || index}
                    type="button"
                    onClick={() => {
                      setSelectedCandidateIndex(index);
                    }}
                    className={`w-full text-left p-4 rounded-2xl border transition-all flex items-start gap-3 ${
                      active
                        ? 'border-[#0b57d0] bg-[#eef4fe] shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div
                      className={`mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        active ? 'border-[#0b57d0] bg-[#0b57d0] text-white' : 'border-slate-300'
                      }`}
                    >
                      {active && <Check size={12} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 line-clamp-2 leading-snug">{item.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded-md">{SOURCE_LABELS[item.source]}</span>
                        {typeof item.score === 'number' && (
                          <span className="px-1.5 py-0.5 bg-slate-100 rounded-md">匹配度 {item.score}</span>
                        )}
                        {item.quality && <span>{item.quality}</span>}
                        {item.sizeFormatted && <span>{item.sizeFormatted}</span>}
                        {item.source === 'hdhive' && <span>{item.isUnlocked ? '已解锁' : '免费可解锁'}</span>}
                        <span className="truncate" title={item.shareLink}>{item.shareLink || '创建时解锁'}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setStep('form')}
                className="px-5 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all flex items-center gap-2"
              >
                <ArrowLeft size={16} /> 返回
              </button>
              <button
                type="button"
                onClick={resetModal}
                className="px-5 py-3 border border-slate-300 text-slate-700 rounded-full font-medium hover:bg-slate-50 transition-all"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmSelection}
                disabled={loading || !candidates[selectedCandidateIndex]}
                className="flex-1 px-6 py-3 bg-[#0b57d0] text-white rounded-full font-medium hover:bg-[#0b57d0]/90 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {loading && <RefreshCw size={18} className="animate-spin" />}
                使用该资源创建任务
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default AutoSeriesTab;
