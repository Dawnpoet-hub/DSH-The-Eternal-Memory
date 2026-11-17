// Client 侧：左侧栏「长期记忆」面板。
// 单列纵向布局，专为 280–360px 的侧边栏宽度设计。
// 统计卡不弹窗，点进去是一个独立页面，左上角返回。
window.__ModuleLoader__.load({
  id: '@local/dsh-the-eternal-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useMemo, useRef } = React

    const TYPE_LABEL = {
      relates_to: '关联', part_of: '属于', supersedes: '取代',
      semantic: '语义相近', entity: '共享实体', temporal: '先后出现', causal: '因为',
    }
    const API = '/mem-panel/api'
    const TOKEN = 'mem-panel-local-v1'
    const NS = 'mem-panel'

    const DICTS = {
      zh: {
        panel: '长期记忆',
        title: '长期记忆',
        intro: '这里是 AI 记住的东西。你可以看、可以搜，也可以把它们打包带走。',
        back: '返回',
        overview: '记忆概览',
        overviewSub: '你现在一共存了多少东西，一眼就能看完',
        notes: '记忆条数', notesSub: '你有多少篇笔记，就是多少条记忆',
        points: '关键要点', pointsSub: '每篇里提炼出的单独一句话，一共多少条',
        links: '关联线索', linksSub: '笔记之间互相引用的线，一共多少根',
        updated: '上次整理', updatedSub: '上一次把新内容编进目录是什么时候',
        mover: '搬家',
        moverSub: '把记忆整包带走，换台电脑接着用',
        exportTitle: '导出全部记忆',
        exportSub: '把全部记忆打成一个文件。可以发到另一台电脑，也可以当备份留着。',
        exportBtn: '导出',
        importTitle: '导入记忆包',
        importSub: '把另一台电脑导出的 .zip 记忆包放进来。电脑会先看看里面有什么，不会直接改动你现在的内容。',
        importFormat: '认这种包（.zip，解压后长这样）',
        importChecking: '正在检查这个包…',
        doneOk: '导入成功',
        doneFail: '导入失败',
        importedList: '这次进来的记忆：',
        again: '再来一次',
        project: '项目', allProjects: '全部项目',
        pipelineHint: '整个插件的九个环节，哪一步卡住一眼就能看到',
        stateOk: '正常', stateWarn: '需注意', stateFail: '故障', stateIdle: '待触发',
        overallOk: '一切正常', overallWarn: '{n} 项需注意', overallFail: '{n} 项故障',
        fixHint: '怎么修', clickHint: '点开看细节',
        badgeFresh: '新增',
        badgeConflict: '同名',
        badgeSame: '跳过',
        timeout: '检查超时（30 秒），这个包可能太大',
        importSample: '先看我.txt\n全部记忆.md\nmanifest.json  ← 有它才算记忆包\nmemory/        ← 笔记都在这里',
        importBtn: '选文件',
        previewTitle: '这个包里有 {n} 篇记忆',
        fresh: '你这边没有，会加进来',
        same: '两边完全一样，会跳过',
        conflict: '同名但内容不同，会两份都留着',
        mergeBtn: '把新的加进来（推荐）',
        replaceBtn: '完全换成这个包',
        cancel: '取消',
        backupNote: '导入前会自动备份到 .mem/backups/，随时能找回。',
        searchPlaceholder: '试着问一句：门铃页的提示为什么放下面？',
        searchHint: '不用输入精确的词，说人话也能找到',
        status: '运行状态',
        pointsUnit: '条要点',
        daysAgo: '{n} 天前改过',
        today: '今天改过',
        loading: '加载中…',
        failed: '出错了：{msg}',
        expDone: '已导出 {n} 篇',
        impDone: '导入完成：新增 {w} 篇，跳过 {s} 篇，改名 {r} 篇',
        noteBody: '记住的内容原文',
        lastChanged: '最后修改',
        openNote: '打开全文',
        close: '关闭',
        linksUnit: '条线索',
        memoryUnit: '记忆',
        openTarget: '点击打开被指向的笔记',
        missingTarget: '目标笔记不存在',
        overviewTab: '记忆概览',
        detailsTab: '详细数据',
        detailsSub: '花费、命中率、速度这些数字都在这里',
        costToday: '今天估算花费',
        costSub: '只统计「写回」用掉的大模型调用',
        inputTokens: '输入 token',
        outputTokens: '输出 token',
        hitRate: '召回命中率',
        hitRateSub: '有记忆被用上 vs 判定为不相关',
        writeRuns: '提炼次数',
        writeFacts: '产出事实',
        writeAvg: '单次耗时',
        last7: '最近 7 天',
        last7Sub: '每天召回与提炼的次数',
        estimateNote: '按 ¥2/M 输入、¥8/M 输出估算，与真实账单可能有偏差',
        dupSkipped: '去重跳过',
        backfillFacts: '回填产出',
        fallbackCount: '模型回退',
        never: '还没有',
        dowMon: '一', dowWed: '三', dowFri: '五',
        relCount: '共 {n} 条',
        relListTitle: '线索详情', relListSub: '全部笔记之间的关联，点一条可跳到被指向的笔记',
        legendLine: '连线：', legendNode: '节点：',
        heatTitle: '记忆活跃度',
        heatSub: '过去一年每天写了多少条记忆，颜色越深写得越多',
        heatTotal: '共 {n} 条',
        heatLess: '少',
        heatMore: '多',
        lastDistill: '最近提炼',
        lastDistillSub: '上一次把对话提炼成记忆的时间',
        checkTitle: '健康检查',
        checkRunning: '检查中…',
        checkOk: '没有发现问题',
        checkHint: '点一下检查记忆库有没有格式错误、断掉的链接或漏掉的文件',
        checkIssues: '发现 {n} 处问题',
        checkMore: '还有 {n} 处…',
        catSchema: '格式',
        catOrphans: '断链',
        catUnindexed: '未整理',
        catMissing: '丢失',
        setupTitle: '还差两步就能开始用',
        setupSub: '下面这些东西需要联网下载一次，下好之后就一直可用',
        setupDeps: '安装依赖（约 80MB）',
        setupModel: '下载向量模型（约 90MB）',
        setupPython: '需要先安装 Python 3.11+，装好后刷新本页',
        setupTools: '引擎文件缺失，重启插件会自动补上',
        setupRunning: '正在后台下载，完成后刷新本页',
        refresh: '刷新',
        refreshHint: '重新读取记忆库和运行状态',
        setupPythonLink: '去下载 Python',
        modelsTitle: '模型',
        modelsSub: '现在用的检索模型，可随时切换或开启更准的重排',
        modelsEmbed: '找记忆用的模型',
        modelsRerank: '精确重排（可选）',
        modelUse: '换成这个',
        modelDownload: '下载',
        modelActive: '使用中',
        modelOn: '已开启',
        modelOff: '已关闭',
        modelReady: '模型已就绪',
        modelNotDownloaded: '还没下载',
        modelTurnOn: '开启',
        modelTurnOff: '关闭',
        modelDownloadRerank: '下载重排模型（约 560MB）',
        modelDownloadRerank: 'Download reranker (~560MB)',
        modelQueued: '已开始后台处理，完成后会自动刷新',
        modelSwitching: '正在切换并重建索引，稍等一下',
        modelPreparing: '准备中…',
        modelFailed: '下载失败，点一下重试',

        modelLoading: '正在读取模型信息…',
        modelLoadFail: '读取模型信息失败',

        modelStalled: '已卡住 {n} 秒',

      },
      en: {
        panel: 'Long-term memory',
        title: 'Long-term memory',
        intro: 'Everything the AI remembers. Browse it, search it, or carry it to another computer.',
        back: 'Back',
        overview: 'Overview',
        overviewSub: 'How much is stored right now, at a glance',
        notes: 'Memories', notesSub: 'One note equals one memory',
        points: 'Key points', pointsSub: 'Individual facts distilled from those notes',
        links: 'Links', linksSub: 'References between notes',
        updated: 'Last organised', updatedSub: 'When new content was last folded into the index',
        mover: 'Move',
        moverSub: 'Pack everything up and continue on a new machine',
        exportTitle: 'Export all memories',
        exportSub: 'Pack everything into one file you can copy or keep as a backup.',
        exportBtn: 'Export',
        importTitle: 'Import a memory pack',
        importSub: 'Drop in a .zip pack exported from another computer. Nothing changes until you confirm.',
        importFormat: 'Accepted pack (.zip, contents after unzipping)',
        importChecking: 'Checking this pack…',
        doneOk: 'Import succeeded',
        doneFail: 'Import failed',
        importedList: 'What came in:',
        again: 'Again',
        project: 'Project', allProjects: 'All projects',
        pipelineHint: 'The nine stages of this plugin — see at a glance where it is stuck',
        stateOk: 'OK', stateWarn: 'Needs attention', stateFail: 'Broken', stateIdle: 'Waiting',
        overallOk: 'All good', overallWarn: '{n} need attention', overallFail: '{n} broken',
        fixHint: 'How to fix', clickHint: 'Tap for details',
        badgeFresh: 'new',
        badgeConflict: 'conflict',
        badgeSame: 'skip',
        timeout: 'Timed out after 30s — the pack may be too large.',
        importSample: 'README.txt\nall-memories.md\nmanifest.json  ← required marker\nmemory/        ← the notes live here',
        importBtn: 'Choose file',
        previewTitle: 'This pack has {n} memories',
        fresh: 'not here yet, will be added',
        same: 'identical, will be skipped',
        conflict: 'same name, different content, both kept',
        mergeBtn: 'Add the new ones (recommended)',
        replaceBtn: 'Replace everything',
        cancel: 'Cancel',
        backupNote: 'A backup is saved to .mem/backups/ before any import.',
        searchPlaceholder: 'Try: why is the doorbell tip below the password field?',
        searchHint: 'Plain words work fine',
        status: 'Status',
        pointsUnit: 'points',
        daysAgo: 'edited {n} days ago',
        today: 'edited today',
        loading: 'Loading…',
        failed: 'Something went wrong: {msg}',
        expDone: 'Exported {n} notes',
        impDone: 'Imported: {w} added, {s} skipped, {r} renamed',
        noteBody: 'The stored note',
        lastChanged: 'Last changed',
        openNote: 'Open note',
        close: 'Close',
        linksUnit: 'links',
        memoryUnit: 'Memory',
        openTarget: 'Open the linked note',
        missingTarget: 'Linked note is missing',
        overviewTab: 'Overview',
        detailsTab: 'Detailed data',
        detailsSub: 'Cost, hit rate and speed live here',
        costToday: 'Estimated cost today',
        costSub: 'Only model calls for distillation are counted',
        inputTokens: 'Input tokens',
        outputTokens: 'Output tokens',
        hitRate: 'Recall hit rate',
        hitRateSub: 'Used vs judged irrelevant',
        writeRuns: 'Distill runs',
        writeFacts: 'Facts produced',
        writeAvg: 'Avg duration',
        last7: 'Last 7 days',
        last7Sub: 'Recalls and distillations per day',
        estimateNote: 'Estimated at ¥2/M input and ¥8/M output; the real bill may differ',
        dupSkipped: 'Skipped as duplicate',
        backfillFacts: 'From backfill',
        fallbackCount: 'Model fallbacks',
        never: 'Never',
        dowMon: 'Mon', dowWed: 'Wed', dowFri: 'Fri',
        relCount: '{n} links',
        relListTitle: 'Link details', relListSub: 'All links between notes; tap one to open the target note',
        legendLine: 'Links:', legendNode: 'Nodes:',
        heatTitle: 'Memory activity',
        heatSub: 'Memories written per day over the past year — darker means more',
        heatTotal: '{n} total',
        heatLess: 'Less',
        heatMore: 'More',
        lastDistill: 'Last distilled',
        lastDistillSub: 'When the conversation was last turned into memories',
        checkTitle: 'Health check',
        checkRunning: 'Checking…',
        checkOk: 'No problems found',
        checkHint: 'Tap to check for malformed notes, broken links or missing files',
        checkIssues: '{n} problems found',
        checkMore: '{n} more…',
        catSchema: 'Schema',
        catOrphans: 'Broken links',
        catUnindexed: 'Not indexed',
        catMissing: 'Missing',
        setupTitle: 'Two steps left',
        setupSub: 'These need a one-time download; after that everything works offline',
        setupDeps: 'Install dependencies (~80MB)',
        setupModel: 'Download embedding model (~90MB)',
        setupPython: 'Please install Python 3.11+ first, then reload',
        setupTools: 'Engine files missing; restart the plugin to repair',
        setupRunning: 'Downloading in background — reload when done',
        refresh: 'Refresh',
        refreshHint: 'Reload memory store and status',
        setupPythonLink: 'Get Python',
      },
        modelsTitle: 'Models',
        modelsSub: 'Which retrieval model is in use; switch or enable reranking any time',
        modelsEmbed: 'Model used to find memories',
        modelsRerank: 'Cross-encoder rerank (optional)',
        modelUse: 'Use this',
        modelDownload: 'Download',
        modelActive: 'In use',
        modelOn: 'On',
        modelOff: 'Off',
        modelReady: 'Ready',
        modelNotDownloaded: 'Not downloaded',
        modelTurnOn: 'Enable',
        modelTurnOff: 'Disable',
        modelDownloadRerank: 'Download reranker (~560MB)',
        modelQueued: 'Running in the background; this panel refreshes when done',
        modelSwitching: 'Switching and rebuilding the index, hold on',
        modelPreparing: 'Preparing…',
        modelFailed: 'Download failed — tap to retry',

        modelLoading: 'Loading model info…',
        modelLoadFail: 'Could not load model info',

        modelStalled: 'stalled {n}s',

    }

    // ---------- 样式（跟随宿主主题） ----------
    const S = {
      page: {
        flex: '1 1 auto', minHeight: 0, width: '100%',
        height: '100%', maxHeight: '100%', boxSizing: 'border-box',
        overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch',
        padding: '44px 16px 40px', display: 'flex', flexDirection: 'column', gap: 22,
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
      h1: { fontSize: 17, fontWeight: 600, margin: 0 },
      intro: { fontSize: 12, opacity: 0.65, marginTop: 6, lineHeight: 1.6 },
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      h2: { fontSize: 14, fontWeight: 600, margin: 0 },
      sub: { fontSize: 11.5, opacity: 0.6, marginTop: 2, lineHeight: 1.5 },
      card: {
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
        borderRadius: 10, padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 4,
      },
      statValue: { fontSize: 20, fontWeight: 600, lineHeight: 1.2 },
      statLabel: { fontSize: 12, fontWeight: 500 },
      statSub: { fontSize: 11, opacity: 0.55, lineHeight: 1.5 },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      btn: {
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 500,
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      btnPrimary: {
        border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
        background: 'color-mix(in srgb, currentColor 10%, transparent)',
        borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600,
        color: 'inherit', cursor: 'pointer',
      },
      zoomBar: {
        position: 'absolute', top: 6, right: 6, display: 'flex', alignItems: 'center', gap: 2,
        background: 'color-mix(in srgb, Canvas 88%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
        borderRadius: 8, padding: '2px 4px', backdropFilter: 'blur(6px)',
      },
      zoomBtn: {
        border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
        fontSize: 13, lineHeight: 1, padding: '3px 6px', borderRadius: 5,
      },
      zoomLabel: { fontSize: 11, opacity: 0.55, minWidth: 30, textAlign: 'center' },
      statusChip: (ok) => ({
        display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none',
        fontSize: 11, padding: '3px 9px', borderRadius: 999, cursor: 'pointer',
        border: `1px solid ${ok ? 'rgba(63,155,109,.32)' : 'rgba(208,138,58,.45)'}`,
        background: ok ? 'rgba(63,155,109,.10)' : 'rgba(208,138,58,.12)',
        color: 'inherit', whiteSpace: 'nowrap',
      }),
      infoChip: {
        display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none',
        fontSize: 11, padding: '3px 9px', borderRadius: 999,
        border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
        background: 'color-mix(in srgb, currentColor 5%, transparent)',
        opacity: 0.75, cursor: 'help', whiteSpace: 'nowrap',
      },
      chipPop: {
        position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 236, zIndex: 60,
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        borderRadius: 10, padding: '10px 11px',
        boxShadow: '0 10px 28px rgba(0,0,0,.24)',
        display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left',
      },
      backBtn: {
        alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: 999, padding: '4px 11px 4px 8px', fontSize: 12,
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      input: {
        width: '100%', boxSizing: 'border-box',
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: 8, padding: '8px 10px', fontSize: 12.5,
        background: 'transparent', color: 'inherit',
      },
      item: {
        border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
        borderRadius: 8, padding: '8px 10px', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 3,
        background: 'transparent', color: 'inherit', textAlign: 'left', width: '100%',
      },
      itemTitle: { fontSize: 12.5, fontWeight: 550, lineHeight: 1.45 },
      itemMeta: { fontSize: 11, opacity: 0.55 },
      bars: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 44 },
      bar: { flex: 1, borderRadius: 2, background: 'color-mix(in srgb, currentColor 35%, transparent)' },
      dot: (ok) => ({ width: 8, height: 8, borderRadius: 4, flex: 'none', marginTop: 5,
        background: ok ? '#3f9b6d' : '#d08a3a' }),
      statusRow: { display: 'flex', gap: 8, alignItems: 'flex-start' },
      statusText: { fontSize: 12, lineHeight: 1.55 },
      ok: { fontWeight: 600 },
      dim: { opacity: 0.6 },
      warn: { color: '#d08a3a' },
      pre: { fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        margin: 0, opacity: 0.85, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      moverBtn: {
        display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 550,
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      popover: {
        position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 262, zIndex: 60,
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        borderRadius: 12, padding: 12, boxShadow: '0 10px 28px rgba(0,0,0,.22)',
        display: 'flex', flexDirection: 'column',
      },
      nodeCard: {
        width: '100%', boxSizing: 'border-box',
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 12, padding: '12px 13px', boxShadow: '0 8px 22px rgba(0,0,0,.22)',
        display: 'flex', flexDirection: 'column', gap: 7,
      },
      cardKicker: { fontSize: 11, letterSpacing: 1.1, fontWeight: 700, textTransform: 'uppercase', opacity: 0.95, color: '#8aa9ff' },
      cardKickerDim: { fontSize: 11, letterSpacing: 0.6, opacity: 0.5 },
      cardTitle: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.45 },
      cardRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10,
        borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)', paddingTop: 6 },
      cardLabel: { fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', opacity: 0.62 },
      cardValue: { fontSize: 12, fontWeight: 500 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 5 },
      chip: { fontSize: 11, padding: '2px 7px', borderRadius: 5,
        background: 'color-mix(in srgb, currentColor 9%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 10%, transparent)' },
      cardPath: { fontSize: 11, opacity: 0.35, wordBreak: 'break-all' },
      sample: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10.5, lineHeight: 1.65, whiteSpace: 'pre', opacity: 0.62,
        marginTop: 4, overflowX: 'auto',
        borderLeft: '2px solid color-mix(in srgb, currentColor 18%, transparent)',
        paddingLeft: 8,
      },
      modalWrap: {
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14,
      },
      modal: {
        width: 'min(460px, 94vw)', maxHeight: '84vh', overflowY: 'auto',
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 14, padding: '14px 15px',
        boxShadow: '0 18px 48px rgba(0,0,0,.35)',
        display: 'flex', flexDirection: 'column',
      },
      previewList: {
        display: 'flex', flexDirection: 'column', gap: 2,
        maxHeight: 220, overflowY: 'auto',
        border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
        borderRadius: 8, padding: '6px 8px',
      },
      previewRow: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' },
      previewTitle: { fontSize: 12, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badgeOk: { fontSize: 10.5, flex: 'none', padding: '1px 6px', borderRadius: 4,
        background: 'rgba(63,155,109,.18)', color: '#5fbf8d' },
      badgeWarn: { fontSize: 10.5, flex: 'none', padding: '1px 6px', borderRadius: 4,
        background: 'rgba(208,138,58,.18)', color: '#dba45f' },
      badgeDim: { fontSize: 10.5, flex: 'none', padding: '1px 6px', borderRadius: 4,
        background: 'color-mix(in srgb, currentColor 8%, transparent)', opacity: 0.5 },
      toast: (kind) => ({
        position: 'sticky', top: 0, zIndex: 80,
        margin: '-16px -16px 0', padding: '9px 14px',
        background: kind === 'err' ? 'rgba(208,90,60,.16)' : 'rgba(63,155,109,.16)',
        borderBottom: `1px solid ${kind === 'err' ? 'rgba(208,90,60,.4)' : 'rgba(63,155,109,.4)'}`,
        color: 'inherit', fontSize: 12, lineHeight: 1.5,
        display: 'flex', alignItems: 'flex-start', gap: 6,
        backdropFilter: 'blur(8px)',
      }),
      toastIcon: { fontSize: 12, lineHeight: 1.5, flex: 'none' },
      popErr: {
        marginTop: 8, borderRadius: 8, padding: '8px 10px',
        border: '1px solid rgba(208,90,60,.45)',
        background: 'rgba(208,90,60,.10)',
        display: 'flex', flexDirection: 'column', gap: 3,
      },
      popErrTitle: { fontSize: 12, fontWeight: 600, color: '#e08a72' },
      popErrText: { fontSize: 11, opacity: 0.7, lineHeight: 1.5 },
      popTitle: { fontSize: 13, fontWeight: 600 },
      popSub: { fontSize: 11.5, opacity: 0.6, lineHeight: 1.5, marginTop: 3 },
    }

    async function api(path, opts = {}) {
      const res = await fetch(API + path, {
        ...opts,
        headers: { 'x-mem-token': TOKEN, ...(opts.headers || {}) },
      })
      if (!res.ok) {
        let msg = res.statusText
        try { msg = (await res.json()).error ?? msg } catch { /* ignore */ }
        throw new Error(msg)
      }
      return res
    }
    const getJson = async (p) => (await api(p)).json()

    const fmtAgo = (ts) => {
      const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
      if (sec < 10) return '刚刚'
      if (sec < 60) return `${sec} 秒前`
      if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
      if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
      return `${Math.floor(sec / 86400)} 天前`
    }

    const fmtDays = (ts, t) => {
      if (!ts) return '—'
      const days = Math.floor(Date.now() / 1000 - ts) / 1
      const d = Math.floor(days / 86400)
      return d <= 0 ? t('today') : t('daysAgo', { n: d })
    }

    // ---------- 小组件 ----------
    function Field({ value, label, sub, onClick }) {
      return h('div', {
        style: { ...S.card, cursor: onClick ? 'pointer' : 'default' },
        onClick, role: onClick ? 'button' : undefined, tabIndex: onClick ? 0 : undefined,
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
        h('div', { style: S.statValue }, value),
        onClick ? h('span', { style: { fontSize: 13, opacity: 0.35 } }, '›') : null),
      h('div', { style: S.statLabel }, label),
      h('div', { style: S.statSub }, sub))
    }

    function StatusLine({ ok, title, text, action }) {
      return h('div', { style: S.statusRow },
        h('span', { style: S.dot(ok) }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
          h('div', { style: S.statusText },
            h('span', { style: S.ok }, title), ' · ',
            h('span', { style: ok ? S.dim : S.warn }, text)),
          action))
    }

    // 活动热力图：52 周 × 7 天的小方块，颜色深浅＝当天写入记忆的多少
    function Heatmap({ t }) {
      const [data, setData] = useState(null)
      const [tip, setTip] = useState(null)
      const wrapRef = useRef(null)

      const showTip = (e, d) => {
        try {
          const rect = wrapRef.current.getBoundingClientRect()
          const [, mm, dd] = d.date.split('-')
          setTip({
            x: e.clientX - rect.left, y: e.clientY - rect.top,
            text: d.facts
              ? `${d.facts} 条记忆 · ${Number(mm)}月${Number(dd)}日${d.runs ? `（${d.runs} 次提炼）` : ''}`
              : `${Number(mm)}月${Number(dd)}日 · 这天没有记录`,
          })
        } catch { /* ignore */ }
      }
      useEffect(() => {
        let alive = true
        const load = async () => {
          try { const d = await getJson('/activity'); if (alive) setData(d) } catch { /* ignore */ }
        }
        load()
        const timer = setInterval(load, 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const days = data?.days ?? []
      // 按周切分：每列 7 天（周日在上）
      const weeks = []
      let cur = []
      for (const d of days) {
        cur.push(d)
        if (cur.length === 7) { weeks.push(cur); cur = [] }
      }
      if (cur.length) weeks.push(cur)

      const max = Math.max(1, ...days.map((d) => d.facts))
      const level = (n) => (n === 0 ? 0 : n <= max * 0.25 ? 1 : n <= max * 0.5 ? 2 : n <= max * 0.75 ? 3 : 4)
      const COLORS = ['color-mix(in srgb, currentColor 8%, transparent)',
        'color-mix(in srgb, #3f9b6d 25%, transparent)',
        'color-mix(in srgb, #3f9b6d 45%, transparent)',
        'color-mix(in srgb, #3f9b6d 70%, transparent)', '#3f9b6d']

      return h('div', {
        ref: wrapRef,
        style: { ...S.card, position: 'relative' },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h('div', null,
            h('div', { style: S.statLabel }, t('heatTitle')),
            h('div', { style: S.statSub }, t('heatSub'))),
          h('div', { style: { ...S.statSub, flex: 'none' } }, t('heatTotal', { n: data?.total ?? 0 }))),

        h('div', { style: { display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto', paddingBottom: 2 } },
          // 星期标签列（只标 一/三/五，和参考图一致）
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 18, flex: 'none' } },
            [0, 1, 2, 3, 4, 5, 6].map((i) => h('div', {
              key: i, style: { height: 12, fontSize: 9, opacity: 0.4, lineHeight: '12px' },
            }, i === 1 ? t('dowMon') : i === 3 ? t('dowWed') : i === 5 ? t('dowFri') : ''))),

          h('div', { style: { display: 'flex', gap: 3, flex: 'none' } },
            weeks.map((w, wi) => h('div', { key: wi, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: { height: 15, fontSize: 9, opacity: 0.4, whiteSpace: 'nowrap' } },
                w.some((d) => d.date.endsWith('-01')) ? `${Number(w.find((d) => d.date.endsWith('-01')).date.slice(5, 7))}月` : ''),
              w.map((d) => h('div', {
                key: d.date,
                onMouseEnter: (e) => showTip(e, d),
                onMouseLeave: () => setTip(null),
                style: { width: 12, height: 12, borderRadius: 2, background: COLORS[level(d.facts)] },
              })))))),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, opacity: 0.55 } },
          h('span', null, t('heatLess')),
          [0, 1, 2, 3, 4].map((i) => h('span', { key: i, style: { width: 10, height: 10, borderRadius: 2, background: COLORS[i] } })),
          h('span', null, t('heatMore'))),

        tip ? h('div', {
          style: {
            position: 'absolute', left: tip.x, top: tip.y - 10,
            transform: 'translate(-50%, -100%)', pointerEvents: 'none', zIndex: 40,
            background: '#2b3038', color: '#eef2f7', borderRadius: 6,
            padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap',
            boxShadow: '0 6px 18px rgba(0,0,0,.45)',
          },
        }, tip.text) : null)
    }

    // 关系图：小型力导向布局，纯 SVG，无第三方库
    function Graph({ relations, notes, selected, onSelect, t, size = 1100 }) {
      const [hover, setHover] = useState(null)
      const [view, setView] = useState({ k: 1, x: 0, y: 0 })
      const [panning, setPanning] = useState(false)
      const svgRef = useRef(null)
      const dragRef = useRef(null)
      const W = size, H = Math.round(size * 0.62)

      // 滚轮缩放（以指针为中心）：React 的 onWheel 是被动监听，必须用原生事件
      useEffect(() => {
        const el = svgRef.current
        if (!el) return
        const onWheel = (e) => {
          e.preventDefault()
          const rect = el.getBoundingClientRect()
          const px = ((e.clientX - rect.left) / rect.width) * W
          const py = ((e.clientY - rect.top) / rect.height) * H
          setView((v) => {
            const k = Math.min(4, Math.max(0.5, v.k * (e.deltaY < 0 ? 1.12 : 0.89)))
            const r = k / v.k
            return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      }, [W, H])

      const startPan = (e) => {
        dragRef.current = { cx: e.clientX, cy: e.clientY, x: view.x, y: view.y }
        setPanning(true)
      }
      const movePan = (e) => {
        const d = dragRef.current
        if (!d || !svgRef.current) return
        const rect = svgRef.current.getBoundingClientRect()
        const sx = W / rect.width, sy = H / rect.height
        setView((v) => ({ ...v, x: d.x + (e.clientX - d.cx) * sx, y: d.y + (e.clientY - d.cy) * sy }))
      }
      const endPan = () => { dragRef.current = null; setPanning(false) }
      const zoomBy = (f) => setView((v) => {
        const k = Math.min(4, Math.max(0.5, v.k * f))
        const r = k / v.k
        const cx = W / 2, cy = H / 2
        return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r }
      })

      const { nodes, links, types } = useMemo(() => {
        const byPath = new Map()
        for (const n of notes) byPath.set(n.path, { path: n.path, title: n.title, type: n.type || 'note', degree: 0 })
        const links = []
        const types = new Set()
        for (const r of relations) {
          if (!r.toPath || !byPath.has(r.fromPath) || !byPath.has(r.toPath)) continue
          links.push({ a: r.fromPath, b: r.toPath, type: r.type })
          types.add(r.type)
          byPath.get(r.fromPath).degree++
          byPath.get(r.toPath).degree++
        }
        const nodes = [...byPath.values()]
        const cx = W / 2, cy = H / 2, rad = Math.min(W, H) * 0.30
        nodes.forEach((n, i) => {
          const a = (i / Math.max(1, nodes.length)) * Math.PI * 2
          n.x = cx + Math.cos(a) * rad; n.y = cy + Math.sin(a) * rad
          n.vx = 0; n.vy = 0
        })
        const idx = new Map(nodes.map((n, i) => [n.path, i]))
        for (let it = 0; it < 420; it++) {
          const k = 1 - it / 420
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const a = nodes[i], b = nodes[j]
              let dx = a.x - b.x, dy = a.y - b.y
              const d2 = dx * dx + dy * dy || 0.01
              const f = 3000 / d2 * k
              const d = Math.sqrt(d2)
              dx /= d; dy /= d
              a.vx += dx * f; a.vy += dy * f
              b.vx -= dx * f; b.vy -= dy * f
            }
          }
          for (const l of links) {
            const a = nodes[idx.get(l.a)], b = nodes[idx.get(l.b)]
            let dx = b.x - a.x, dy = b.y - a.y
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01
            const f = (d - 240) * 0.022 * k
            dx /= d; dy /= d
            a.vx += dx * f; a.vy += dy * f
            b.vx -= dx * f; b.vy -= dy * f
          }
          for (const n of nodes) {
            n.vx += (W / 2 - n.x) * 0.0022 * k
            n.vy += (H / 2 - n.y) * 0.0022 * k
            n.x += n.vx; n.y += n.vy
            n.vx *= 0.8; n.vy *= 0.8
            n.x = Math.max(120, Math.min(W - 120, n.x))
            n.y = Math.max(26, Math.min(H - 22, n.y))
          }
        }
        return { nodes, links, types: [...types] }
      }, [relations, notes, W, H])

      // 宿主背景是深还是浅：决定用亮色还是深色调色板，避免浅色主题下彩色点看不见
      const surfaceIsDark = () => {
        try {
          const bg = getComputedStyle(document.body).backgroundColor
          const m = bg.match(/\d+(\.\d+)?/g)
          if (!m) return true
          const [r, g, b] = m.map(Number)
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
        } catch { return true }
      }

      const TYPE_COLOR_DARK = {
        decision: '#ff6b8a', environment: '#3ddc97', principles: '#ffcf33',
        page: '#8f6bff', note: '#8d97a8',
      }
      const TYPE_COLOR_LIGHT = {
        decision: '#c9184a', environment: '#17795e', principles: '#8a6100',
        page: '#5b3bb5', note: '#5b6472',
      }
      const TYPE_COLOR = () => (surfaceIsDark() ? TYPE_COLOR_DARK : TYPE_COLOR_LIGHT)
      const TYPE_LABEL_ZH = { decision: '决定', environment: '环境', principles: '原则', page: '页面', note: '笔记' }
      const nodeColor = (t) => { const c = TYPE_COLOR(); return c[t] ?? c.note }
      const PALETTE_DARK = ['#5b8ff9', '#2ec4a6', '#d9a441', '#9a7bff', '#e0704f', '#5aa9e6']
      const PALETTE_LIGHT = ['#1d4ed8', '#0f766e', '#a16207', '#6d28d9', '#b45309', '#0369a1']
      const palette = surfaceIsDark() ? PALETTE_DARK : PALETTE_LIGHT
      const colorOf = (type) => palette[Math.max(0, types.indexOf(type)) % palette.length]
      const byPath = new Map(nodes.map((n) => [n.path, n]))
      const near = (p) => !hover || p === hover ||
        links.some((l) => (l.a === hover && l.b === p) || (l.b === hover && l.a === p))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { position: 'relative' } },
        h('svg', {
          ref: svgRef, viewBox: `0 0 ${W} ${H}`, width: '100%',
          style: {
            display: 'block', width: '100%', height: 'auto',
            overflow: 'hidden', touchAction: 'none',
            cursor: panning ? 'grabbing' : 'grab',
          },
          onMouseDown: startPan, onMouseMove: movePan, onMouseUp: endPan, onMouseLeave: endPan,
        },
          h('g', {
            transform: `translate(${view.x} ${view.y}) scale(${view.k})`,
            style: { transition: panning ? 'none' : 'transform .16s ease-out' },
          },
          h('defs', null,
            links.map((l, i) => {
              const a = byPath.get(l.a), b = byPath.get(l.b)
              if (!a || !b) return null
              const dim = hover && !(l.a === hover || l.b === hover)
              // 起点浓、终点淡：靠近来源的一头更实，指出去的一头渐隐
              const from = hover ? (dim ? 0.06 : 0.95) : 0.62
              const to = hover ? (dim ? 0.004 : 0.08) : 0.02
              return h('linearGradient', {
                key: `g${i}`, id: `edge-${i}`, gradientUnits: 'userSpaceOnUse',
                x1: a.x, y1: a.y, x2: b.x, y2: b.y,
              },
                h('stop', { offset: '0%', stopColor: colorOf(l.type), stopOpacity: from }),
                h('stop', { offset: '100%', stopColor: colorOf(l.type), stopOpacity: to }))
            }),
            nodes.map((n, i) => h('radialGradient', { key: `ng${i}`, id: `node-${i}` },
              h('stop', { offset: '0%', stopColor: nodeColor(n.type), stopOpacity: 1 }),
              h('stop', { offset: '70%', stopColor: nodeColor(n.type), stopOpacity: 0.78 }),
              h('stop', { offset: '100%', stopColor: nodeColor(n.type), stopOpacity: 0.5 })))),
          links.map((l, i) => {
            const a = byPath.get(l.a), b = byPath.get(l.b)
            if (!a || !b) return null
            const dim = hover && !(l.a === hover || l.b === hover)
            return h('line', {
              key: `l${i}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
              stroke: `url(#edge-${i})`,
              strokeWidth: hover && !dim ? 2 : 1,
            })
          }),
          nodes.map((n, i) => {
            const r0 = 5 + Math.min(6, n.degree * 1.4)
            const r = hover && !near(n.path) ? r0 * 0.7 : r0
            const dim = !near(n.path)
            return h('g', {
              key: n.path, style: { cursor: 'pointer' },
              onMouseDown: (e) => e.stopPropagation(),
              onMouseEnter: () => setHover(n.path), onMouseLeave: () => setHover(null),
              onClick: () => onSelect(n.path, {
                left: Math.max(4, Math.min(96, ((n.x * view.k + view.x) / W) * 100)),
                top: Math.max(6, Math.min(94, ((n.y * view.k + view.y) / H) * 100)),
              }),
            },
            (hover === n.path || selected === n.path) ? h('circle', {
              cx: n.x, cy: n.y, r: r + 6,
              fill: 'currentColor', opacity: 0.12,
            }) : null,
            h('circle', {
              cx: n.x, cy: n.y, r,
              fill: `url(#node-${i})`,
              opacity: dim ? 0.5 : 1,
              stroke: selected === n.path ? '#5b8ff9' : 'CanvasText',
              strokeWidth: selected === n.path ? 2 : 0.6,
              strokeOpacity: selected === n.path ? 1 : 0.25,
            }),
            (hover ? !near(n.path) : view.k < 0.85) ? null : h('text', {
              x: n.x, y: n.y < 40 ? n.y + r + 13 : n.y - r - 6,
              textAnchor: 'middle', fontSize: 11, fill: 'currentColor',
              opacity: dim ? 0.2 : 0.85, style: { pointerEvents: 'none' },
              stroke: 'Canvas', strokeWidth: 3, paintOrder: 'stroke',
            }, n.title.length > 12 ? `${n.title.slice(0, 11)}…` : n.title))
          }))),
        h('div', { style: S.zoomBar },
          h('button', {
            style: S.zoomBtn, onClick: () => zoomBy(1 / 1.25),
            title: '缩小', 'aria-label': '缩小',
          }, '−'),
          h('span', { style: S.zoomLabel }, `${Math.round(view.k * 100)}%`),
          h('button', { style: S.zoomBtn, onClick: () => zoomBy(1.25), title: '放大', 'aria-label': '放大' }, '+'),
          h('button', {
            style: { ...S.zoomBtn, fontSize: 11, padding: '3px 7px' },
            onClick: () => setView({ k: 1, x: 0, y: 0 }), title: '回到 100%', 'aria-label': '回到 100%',
          }, '重置'))),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, opacity: 0.6 } },
          h('span', { style: { opacity: 0.55 } }, t('legendLine')),
          types.map((ty) => h('span', { key: ty, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 4, background: colorOf(ty), display: 'inline-block' } }),
            TYPE_LABEL[ty] ?? ty))),

        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, opacity: 0.55 } },
          h('span', { style: { opacity: 0.55 } }, t('legendNode')),
          [...new Set(nodes.map((n) => n.type))].filter((x) => TYPE_LABEL_ZH[x]).map((ty) =>
            h('span', { key: ty, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', { style: { width: 8, height: 8, borderRadius: 4, background: nodeColor(ty), display: 'inline-block' } }),
              TYPE_LABEL_ZH[ty]))))
    }

    // 图上点节点后浮出的卡片（参考 Hindsight 的观察卡）
    function NodeCard({ info, t, onOpen, onClose }) {
      return h('div', { style: S.nodeCard, onClick: (e) => e.stopPropagation() },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', { style: S.cardKicker }, info.type || t('memoryUnit')),
          h('span', { style: S.cardKickerDim }, `${info.links} ${t('linksUnit')}`)),
        h('div', { style: S.cardTitle }, info.title),
        h('div', { style: S.cardRow },
          h('span', { style: S.cardLabel }, t('lastChanged')),
          h('span', { style: S.cardValue }, info.when)),
        h('div', { style: S.cardRow },
          h('span', { style: S.cardLabel }, t('points')),
          h('span', { style: S.cardValue }, `${info.obs} ${t('pointsUnit')}`)),
        info.tags && info.tags.length
          ? h('div', { style: S.chips }, info.tags.map((tag) => h('span', { key: tag, style: S.chip }, tag)))
          : null,
        h('div', { style: S.cardPath }, info.path),
        h('div', { style: { ...S.row, marginTop: 2 } },
          h('button', { style: { ...S.btnPrimary, padding: '6px 11px', fontSize: 12 },
            onClick: () => onOpen({ path: info.path, title: info.title }) }, t('openNote')),
          h('button', { style: { ...S.btn, padding: '6px 11px', fontSize: 12 }, onClick: onClose }, t('close'))))
    }

    // 状态胶囊：悬停/点击展开完整说明，占一行高度
    function StatusChip({ ok, label, text, detail, action, align = 'left' }) {
      const [show, setShow] = useState(false)
      const timer = useRef(null)
      const open = () => { if (timer.current) clearTimeout(timer.current); setShow(true) }
      const close = () => { timer.current = setTimeout(() => setShow(false), 160) }

      return h('div', {
        style: { position: 'relative', flex: 'none' },
        onMouseEnter: open, onMouseLeave: close,
      },
      h('span', {
        style: S.statusChip(ok), onClick: () => setShow(!show),
        role: 'button', 'aria-expanded': show,
      },
        h('span', {
          style: { width: 6, height: 6, borderRadius: 3, flex: 'none',
            background: ok ? '#3f9b6d' : '#d08a3a' },
        }),
        label),

      show ? h('div', {
        style: { ...S.chipPop, width: 212, ...(align === 'right' ? { right: 0 } : { left: 0 }) },
      },
        h('div', { style: S.popTitle }, label),
        h('div', { style: S.popSub }, text),
        detail ? h('div', { style: S.cardPath, marginTop: 4 }, detail) : null,
        action) : null)
    }


    // 兜底：任何渲染错误都显示成一行文字，而不是整页黑屏
    function makeBoundary() {
      const Base = React.Component
      if (!Base) return null
      return class PanelBoundary extends Base {
        constructor(props) { super(props); this.state = { error: null } }
        static getDerivedStateFromError(error) { return { error } }
        render() {
          if (this.state.error) {
            return h('div', { style: { padding: 24, fontSize: 13, lineHeight: 1.7 } },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '面板渲染出错'),
              h('div', { style: { opacity: 0.75, fontSize: 12 } },
                String(this.state.error && this.state.error.message || this.state.error)),
              h('div', { style: { opacity: 0.62, fontSize: 11, marginTop: 8 } },
                '把这段发给我即可定位；记忆数据本身没有受影响。'))
          }
          return this.props.children
        }
      }
    }


    // 首次使用的引导条：只显示真正缺的东西，联网项给一键按钮
    function SetupBanner({ t }) {
      const [st, setSt] = useState(null)
      const [msg, setMsg] = useState(null)

      const [mod, setMod] = useState(null)
      useEffect(() => {
        let alive = true
        getJson('/setup').then((d) => { if (alive) setSt(d) }).catch(() => {})
        getJson('/models').then((d) => { if (alive) setMod(d) }).catch(() => {})
        return () => { alive = false }
      }, [])

      if (!st || (st.tools && st.python?.ok && st.deps && st.model)) return null

      const act = async (kind) => {
        try {
          const res = await api('/setup', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind }),
          })
          const r = await res.json()
          setMsg(r.ok ? t('setupRunning') : (r.error || '失败'))
        } catch (e) { setMsg(String(e.message)) }
      }

      return h('div', {
        style: {
          ...S.card, borderColor: 'color-mix(in srgb, #d08a3a 45%, transparent)',
          background: 'color-mix(in srgb, #d08a3a 8%, transparent)',
          display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
        h('div', null,
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('setupTitle')),
          h('div', { style: S.statSub }, t('setupSub'))),
        !st.python?.ok ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12 } }, t('setupPython')),
          h('a', {
            href: 'https://www.python.org/downloads/', target: '_blank', rel: 'noreferrer',
            style: { ...S.btn, fontSize: 12, textDecoration: 'none', color: 'inherit' },
          }, t('setupPythonLink'))) : null,
        !st.tools ? h('div', { style: { fontSize: 12 } }, t('setupTools')) : null,
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          st.python?.ok && !st.deps ? h('button', { style: S.btnPrimary, onClick: () => act('deps') }, t('setupDeps')) : null,
          st.python?.ok && st.deps && !st.model ? h('button', { style: S.btn, onClick: () => act('model') }, t('setupModel')) : null,
          st.python?.ok && st.deps && st.model && mod && !mod.rerank?.downloaded
            ? h('button', {
                style: { ...S.btn, opacity: 0.85 },
                onClick: async () => {
                  await api('/models', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'download', kind: 'rerank', model: mod.rerank?.current }),
                  }).catch(() => {})
                  setMsg(t('setupRunning'))
                },
              }, t('modelDownloadRerank'))
            : null),
        msg ? h('div', { style: { fontSize: 11.5, opacity: 0.7 } }, msg) : null)
    }

    // 模型：随时切换向量模型与精确重排
    function ModelDialog({ t, onClose }) {
      const [m, setM] = useState(null)
      const [msg, setMsg] = useState(null)
      const [open, setOpen] = useState(false)

      const [err, setErr] = useState(null)
      const load = async () => {
        try { setM(await getJson('/models')); setErr(null) } catch (e) { setErr(String(e.message || e)) }
      }
      // 弹窗打开期间 2 秒刷新一次：下载进度要能肉眼看到在动
      useEffect(() => {
        load()
        const timer = setInterval(load, 2_000)
        return () => clearInterval(timer)
      }, [])

      const post = async (body) => {
        try {
          const res = await api('/models', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const r = await res.json()
          setMsg(r.ok ? (r.reindexing ? t('modelSwitching') : t('modelQueued')) : (r.error || '失败'))
          setTimeout(load, 1500)
        } catch (e) { setMsg(String(e.message)) }
      }

      if (!m) {
        return h('div', { style: S.modalWrap, onClick: onClose },
          h('div', { style: S.modal, onClick: (e) => e.stopPropagation() },
            h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 } },
              h('div', { style: S.h2 }, t('modelsTitle')),
              h('button', {
                style: { ...S.btn, padding: '2px 9px' }, onClick: onClose,
                title: '关闭', 'aria-label': '关闭',
              }, '✕')),
            h('div', { style: { ...S.statSub, marginTop: 10 } },
              err ? `${t('modelLoadFail')}：${err}` : t('modelLoading'))))
      }

      const fmtSpeed = (bps) => {
        if (!bps || bps < 1024) return '0 KB/s'
        if (bps < 1048576) return `${Math.round(bps / 1024)} KB/s`
        return `${(bps / 1048576).toFixed(1)} MB/s`
      }

      const progressButton = (pct, bytes, stalled, speed) => h('div', {
        style: {
          position: 'relative', overflow: 'hidden', width: 104, boxSizing: 'border-box', textAlign: 'center',
          border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
          borderRadius: 8, padding: '6px 12px', fontSize: 11.5,
        },
      },
        h('div', {
          style: {
            position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`,
            background: 'color-mix(in srgb, #5B8FF9 45%, transparent)',
            transition: 'width .6s ease-out',
          },
        }),
        h('span', { style: { position: 'relative', fontSize: 11 } },
          pct <= 0 ? t('modelPreparing')
            : (stalled && stalled > 30)
              ? `${((bytes || 0) / 1048576).toFixed(0)}MB · ${t('modelStalled', { n: stalled })}`
              : `${Math.round(pct)}% · ${fmtSpeed(speed)}`))

      const embedRows = (m.embed?.options ?? []).map((o) => {
        const dl = m.downloads?.[o.id]
        const action = o.downloaded
          ? (o.active
            ? h('button', {
                disabled: true,
                style: {
                  ...S.btn, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center',
                  opacity: 0.55, cursor: 'default', pointerEvents: 'none',
                },
              }, t('modelActive'))
            : h('button', {
                style: { ...S.btn, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center' },
                onClick: () => post({ action: 'setEmbed', model: o.id }),
              }, t('modelUse')))
          : (dl
            ? (dl.status === 'error'
              ? h('button', {
                  style: { ...S.btn, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center' },
                  title: dl.tail || '',
                  onClick: () => post({ action: 'download', kind: 'embed', model: o.id }),
                }, t('modelFailed'))
              : progressButton(dl.progress, dl.bytes, dl.stalledSec, dl.speed))
            : h('button', {
                style: { ...S.btn, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center' },
                onClick: () => post({ action: 'download', kind: 'embed', model: o.id }),
              }, t('modelDownload')))

        return h('div', {
          key: o.id,
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
        },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: 12.5, fontWeight: o.active ? 600 : 500 } },
              `${o.label}　${o.size}`),
            h('div', { style: { ...S.statSub, marginTop: 2 } }, o.note)),
          h('div', { style: { display: 'flex', gap: 6, flex: 'none' } }, action))
      })

      const rerank = m.rerank ?? {}
      const rerankDl = m.downloads?.[rerank.current]
      const rerankAction = rerank.downloaded
        ? h('button', {
            style: { ...S.btn, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center' },
            onClick: () => post({ action: 'setRerank', enabled: !rerank.enabled }),
          }, rerank.enabled ? t('modelTurnOff') : t('modelTurnOn'))
        : (rerankDl
          ? (rerankDl.status === 'error'
            ? h('button', {
                style: { ...S.btn, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center' },
                title: rerankDl.tail || '',
                onClick: () => post({ action: 'download', kind: 'rerank', model: rerank.current }),
              }, t('modelFailed'))
            : progressButton(rerankDl.progress, rerankDl.bytes, rerankDl.stalledSec, rerankDl.speed))
          : h('button', {
              style: { ...S.btnPrimary, fontSize: 11.5, width: 104, boxSizing: 'border-box', justifyContent: 'center' },
              onClick: () => post({ action: 'download', kind: 'rerank', model: rerank.current }),
            }, t('modelDownloadRerank')))

      return h('div', { style: S.modalWrap, onClick: onClose },
        h('div', { style: S.modal, onClick: (e) => e.stopPropagation() },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: S.h2 }, t('modelsTitle')),
            h('div', { style: S.sub }, t('modelsSub'))),
          h('button', {
            style: { ...S.btn, padding: '2px 9px' }, onClick: onClose,
            title: '关闭', 'aria-label': '关闭',
          }, '✕')),

        h('div', { style: { ...S.card, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 } },
          h('div', null,
            h('div', { style: S.statLabel }, t('modelsEmbed')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 } }, embedRows)),

          h('div', { style: { borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)', paddingTop: 10 } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
              h('div', { style: { minWidth: 0 } },
                h('div', { style: S.statLabel }, t('modelsRerank')),
                h('div', { style: { ...S.statSub, marginTop: 2 } },
                  `${rerank.enabled ? t('modelOn') : t('modelOff')} · ${rerank.downloaded ? t('modelReady') : t('modelNotDownloaded')}`)),
              h('div', { style: { display: 'flex', gap: 6, flex: 'none' } }, rerankAction))),

          msg ? h('div', { style: { ...S.statSub, opacity: 0.75 } }, msg) : null)))
    }

    // 详细数据：花费、命中率、速度、7 天趋势
    function DetailData({ t }) {
      const [m, setM] = useState(null)

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const d = await getJson('/metrics')
            if (alive) setM(d)
          } catch { /* 拉不到就显示占位 */ }
        }
        load()
        const timer = setInterval(load, 30_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const box = (label, value, sub) => h('div', { style: S.card },
        h('div', { style: S.statValue }, value),
        h('div', { style: S.statLabel }, label),
        h('div', { style: S.statSub }, sub))

      const days = m?.days ?? []
      const maxD = Math.max(1, ...days.map((d) => d.inject + d.distill))
      const today = m?.cost?.today
      const cost = today == null ? '—' : `¥${today < 0.01 ? today.toFixed(4) : today.toFixed(2)}`

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 } },
          box(t('costToday'), cost, t('costSub')),
          box(t('hitRate'), m?.recall?.hitRate == null ? '—' : `${m.recall.hitRate}%`, t('hitRateSub')),
          box(t('writeRuns'), String(m?.write?.runs ?? '—'),
            `${t('writeFacts')} ${m?.write?.facts ?? 0} · ${t('writeAvg')} ${m?.write?.avgMs ?? 0}ms`),
          box(t('inputTokens'), (m?.cost?.inputTokens ?? 0).toLocaleString('zh-CN'),
            `${t('outputTokens')} ${(m?.cost?.outputTokens ?? 0).toLocaleString('zh-CN')}`)),

        h('div', { style: S.card },
          h('div', { style: S.statLabel }, t('last7')),
          h('div', { style: S.statSub }, t('last7Sub')),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 8, height: 72, marginTop: 10 } },
            days.map((d) => h('div', {
              key: d.day,
              style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 },
            },
              h('div', {
                title: `${d.day} · 召回 ${d.inject} · 提炼 ${d.distill}`,
                style: { width: '60%', display: 'flex', flexDirection: 'column-reverse', gap: 1, height: 48 },
              },
                h('div', { style: { height: `${(d.inject / maxD) * 48}px`, borderRadius: 2,
                  background: 'color-mix(in srgb, currentColor 30%, transparent)' } }),
                h('div', { style: { height: `${(d.distill / maxD) * 48}px`, borderRadius: 2, background: '#5b8ff9' } })),
              h('span', { style: { fontSize: 10.5, opacity: 0.62 } }, d.day))))),

        h('div', { style: { ...S.statSub, display: 'flex', gap: 12, flexWrap: 'wrap' } },
          h('span', null, `${t('dupSkipped')} ${m?.write?.dup ?? 0}`),
          h('span', null, `${t('backfillFacts')} ${m?.write?.backfillFacts ?? 0}`),
          h('span', null, `${t('fallbackCount')} ${m?.write?.fallbacks ?? 0}`)),
        h('div', { style: { ...S.statSub, opacity: 0.62 } }, t('estimateNote')))
    }

    // 流水线监控：九个环节横向排列，悬停看解释，出问题自动展开原因
    function PipelinePanel({ t }) {
      const [data, setData] = useState(null)
      const [hover, setHover] = useState(null)
      const [pinned, setPinned] = useState(null)
      const [health, setHealth] = useState(null)
      const [hoverPos, setHoverPos] = useState(null)
      const stripRef = useRef(null)
      const [checking, setChecking] = useState(false)

      const runCheck = async () => {
        if (checking) return
        setChecking(true)
        try {
          setHealth(await getJson('/doctor'))
        } catch (e) {
          setHealth({ error: String(e.message) })
        } finally {
          setChecking(false)
        }
      }

      const problems = health && !health.error
        ? ['schema', 'orphans', 'unindexed', 'missing'].flatMap((k) =>
            (health[k] ?? []).map((x) => ({ kind: k, text: x.path ?? x.from ?? '', problem: x.problem ?? x.target ?? '' })))
        : []

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const d = await getJson('/pipeline')
            if (alive) setData(d)
          } catch { /* 不影响面板其它部分 */ }
        }
        load()
        const timer = setInterval(load, 30_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const color = (state) => state === 'fail' ? '#d05a3c'
        : state === 'warn' ? '#d08a3a'
          : state === 'idle' ? 'color-mix(in srgb, currentColor 35%, transparent)'
            : '#3f9b6d'

      const steps = data?.steps ?? []
      const overall = data?.overall ?? 'ok'
      const firstProblem = steps.find((x) => x.state === 'fail') ?? steps.find((x) => x.state === 'warn')
      const activeKey = hover ?? pinned ?? firstProblem?.key ?? null
      const active = steps.find((x) => x.key === activeKey) ?? null

      const label = overall === 'fail'
        ? t('overallFail', { n: data?.bad ?? 0 })
        : overall === 'warn' ? t('overallWarn', { n: data?.warn ?? 0 }) : t('overallOk')

      return h('section', { style: S.section },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: S.h2 }, t('status')),
            h('div', { style: S.sub }, t('pipelineHint'))),
          h('div', { style: { position: 'relative', flex: 'none' } },
            h('button', {
              onClick: runCheck, title: t('checkHint'),
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                fontSize: 11, padding: '4px 10px', borderRadius: 999, color: 'inherit',
                border: `1px solid ${color(overall)}55`, background: `${color(overall)}18`,
              },
            },
              h('span', {
                className: overall === 'idle' ? undefined : 'mem-dot',
                style: { width: 6, height: 6, borderRadius: 3, background: color(overall) },
              }),
              checking ? t('checkRunning') : label,
              h('span', { style: { fontSize: 9, opacity: 0.5 } }, '▾')),

            health
              ? h('div', {
                  style: {
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, width: 340,
                    background: 'Canvas', color: 'CanvasText', textAlign: 'left',
                    border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
                    borderRadius: 10, padding: '10px 12px', boxShadow: '0 10px 28px rgba(0,0,0,.28)',
                    display: 'flex', flexDirection: 'column', gap: 6,
                  },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                    h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, t('checkTitle')),
                    h('span', {
                      style: { fontSize: 11, opacity: 0.62, cursor: 'pointer' },
                      onClick: () => setHealth(null), title: '关闭', 'aria-label': '关闭',
                    }, '✕')),  // aria-label 见下方
                  health.error
                    ? h('div', { style: { fontSize: 11, color: '#d08a3a' } }, health.error)
                    : problems.length === 0
                      ? h('div', { style: { fontSize: 11.5, opacity: 0.7 } }, t('checkOk'))
                      : h('div', null,
                          h('div', { style: { fontSize: 11.5, opacity: 0.85 } },
                            t('checkIssues', { n: problems.length })),
                          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 } },
                            problems.slice(0, 6).map((pr, i) => h('div', {
                              key: i, style: { fontSize: 11, opacity: 0.7, lineHeight: 1.5 },
                            },
                              h('span', { style: { opacity: 0.55 } },
                                `[${t({ schema: 'catSchema', orphans: 'catOrphans', unindexed: 'catUnindexed', missing: 'catMissing' }[pr.kind] ?? 'catSchema')}] `),
                              pr.text, pr.problem ? ` — ${pr.problem}` : ''))),
                          problems.length > 6
                            ? h('div', { style: { fontSize: 11, opacity: 0.62, marginTop: 2 } },
                                t('checkMore', { n: problems.length - 6 }))
                            : null))
              : null)),

        // 横向步骤条：放不下就左右滑动（右侧渐隐提示还有更多）
        h('div', { ref: stripRef, style: { position: 'relative' } },
        h('div', {
          style: { display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 },
          onMouseLeave: () => setHover(null),
        },
          steps.map((st, i) => {
            const isActive = st.key === activeKey
            const isProblem = st.state === 'fail' || st.state === 'warn'
            return h('button', {
              key: st.key,
              onMouseEnter: (e) => {
                setHover(st.key)
                try {
                  const box = stripRef.current.getBoundingClientRect()
                  const card = e.currentTarget.getBoundingClientRect()
                  setHoverPos({ left: card.left - box.left, width: card.width, strip: box.width })
                } catch { setHoverPos(null) }
              },
              onClick: () => setPinned(activeKey === st.key ? null : st.key),
              style: {
                flex: '0 0 auto', whiteSpace: 'nowrap', cursor: 'pointer', color: 'inherit',
                display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start',
                minWidth: 116, padding: '8px 11px', borderRadius: 9,
                border: `1px solid ${isActive ? color(st.state) : 'color-mix(in srgb, currentColor 12%, transparent)'}`,
                background: isActive ? `${color(st.state)}18`
                  : isProblem ? `${color(st.state)}10` : 'transparent',
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
                h('span', { style: { width: 6, height: 6, borderRadius: 3, flex: 'none', background: color(st.state) } }),
                h('span', { style: { fontSize: 12, fontWeight: 550 } }, `${i + 1}. ${st.title}`)),
              h('div', { style: { fontSize: 11, opacity: 0.55, paddingLeft: 11 } }, st.metric ?? ''))
          })),
        h('div', {
          style: {
            position: 'absolute', top: 0, right: 0, width: 36, height: '100%',
            pointerEvents: 'none',
            background: 'linear-gradient(to right, transparent, Canvas)',
          },
        }),



        // 悬停 / 点击后的解释：绝对定位浮层，不占纵向空间
        active ? h('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 6px)', zIndex: 60,
            left: (() => {
              if (!hoverPos) return 0
              const max = Math.max(0, (hoverPos.strip ?? 360) - 344)
              return Math.max(0, Math.min(hoverPos.left, max))
            })(),
            width: 'min(360px, 92%)', pointerEvents: 'none',
            background: 'Canvas', color: 'CanvasText',
            border: `1px solid ${color(active.state)}55`, borderRadius: 10, padding: '10px 12px',
            boxShadow: '0 10px 28px rgba(0,0,0,.28)',
            display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
            h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, active.title),
            h('span', { style: { fontSize: 11, opacity: 0.5 } },
              active.state === 'ok' ? t('stateOk')
                : active.state === 'warn' ? t('stateWarn')
                  : active.state === 'fail' ? t('stateFail') : t('stateIdle'))),
          h('div', { style: { fontSize: 11.5, opacity: 0.65 } }, active.sub),
          h('div', { style: { fontSize: 11, opacity: 0.8, lineHeight: 1.55 } }, active.detail),
          active.fix ? h('div', { style: { fontSize: 11, lineHeight: 1.55 } },
            h('span', { style: { opacity: 0.5 } }, `${t('fixHint')}：`),
            h('span', { style: { color: '#d08a3a' } }, active.fix)) : null)
          : null),

        data ? h('div', { style: { ...S.statSub, textAlign: 'right' } },
          new Date(data.updatedAt).toLocaleTimeString('zh-CN')) : null)
    }

    // 「搬家」对话框：检查 → 预览 → 导入 → 结果，全程同一个窗，不关闭
    function MoverDialog({ t, onRefresh, onClose }) {
      const [step, setStep] = useState('menu')   // menu | checking | preview | result
      const [plan, setPlan] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [fileName, setFileName] = useState('')

      async function pick(file) {
        setFileName(file.name); setStep('checking'); setError(''); setPlan(null); setResult(null)
        const ctrl = new AbortController()
        const cut = setTimeout(() => ctrl.abort(), 30000)
        try {
          const buf = await file.arrayBuffer()
          const res = await fetch(API + '/import/preview', {
            method: 'POST', headers: { 'x-mem-token': TOKEN }, body: buf, signal: ctrl.signal,
          })
          if (!res.ok) {
            let msg = res.statusText
            try { msg = (await res.json()).error ?? msg } catch { /* ignore */ }
            throw new Error(msg)
          }
          setPlan(await res.json())
          setStep('preview')
        } catch (e) {
          setError(e.name === 'AbortError' ? t('timeout') : e.message)
          setStep('result')
        } finally {
          clearTimeout(cut)
        }
      }

      async function commit(mode) {
        setBusy(true)
        try {
          const res = await api('/import/commit', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ importId: plan.importId, mode }),
          })
          const r = await res.json()
          setResult({ ok: true, counts: r })
          setStep('result')
          onRefresh()
        } catch (e) {
          setError(e.message)
          setResult({ ok: false })
          setStep('result')
        } finally {
          setBusy(false)
        }
      }

      async function doExport() {
        setBusy(true); setError(''); setResult(null); setStep('checking')
        try {
          const res = await api('/export')
          const blob = await res.blob()
          const n = res.headers.get('x-note-count') ?? '?'
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `长期记忆-${new Date().toISOString().slice(0, 10)}.zip`
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 4000)
          setResult({ ok: true, exported: n })
          setStep('result')
        } catch (e) {
          setError(e.message); setResult({ ok: false }); setStep('result')
        } finally {
          setBusy(false)
        }
      }

      const badge = (action) => action === 'fresh'
        ? h('span', { style: S.badgeOk }, t('badgeFresh'))
        : action === 'conflict'
          ? h('span', { style: S.badgeWarn }, t('badgeConflict'))
          : h('span', { style: S.badgeDim }, t('badgeSame'))

      const toAdd = (plan?.items ?? []).filter((i) => i.action !== 'same')

      let body = null
      if (step === 'menu') {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: S.card },
            h('div', { style: S.statLabel }, t('exportTitle')),
            h('div', { style: S.statSub }, t('exportSub')),
            h('button', {
              style: { ...S.btnPrimary, marginTop: 8, alignSelf: 'flex-start' },
              onClick: doExport, disabled: busy,
            }, t('exportBtn'))),
          h('div', { style: S.card },
            h('div', { style: S.statLabel }, t('importTitle')),
            h('div', { style: S.statSub }, t('importSub')),
            h('div', { style: { ...S.popSub, marginTop: 6, fontSize: 11 } }, t('importFormat')),
            h('div', { style: S.sample }, t('importSample')),
            h('label', { style: { ...S.btn, marginTop: 8, alignSelf: 'flex-start', display: 'inline-block' } },
              t('importBtn'),
              h('input', {
                type: 'file', accept: '.zip', style: { display: 'none' },
                onChange: (e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = '' },
              })),
            h('div', { style: { ...S.statSub, marginTop: 8 } }, t('backupNote'))))
      } else if (step === 'checking') {
        body = h('div', { style: S.card },
          h('div', { style: S.statLabel }, busy ? t('loading') : t('importChecking')),
          h('div', { style: S.statSub }, fileName || ''))
      } else if (step === 'preview') {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', null,
            h('div', { style: S.statLabel }, t('previewTitle', { n: plan.total })),
            h('div', { style: { ...S.statSub, marginTop: 4 } },
              `✅ ${plan.fresh} ${t('fresh')}`,
              h('br'),
              `⏭️ ${plan.same} ${t('same')}`,
              h('br'),
              `✏️ ${plan.conflict} ${t('conflict')}`)),
          h('div', { style: S.previewList },
            plan.items.map((it, i) => h('div', { key: `${it.path}-${i}`, style: S.previewRow },
              badge(it.action),
              h('span', { style: S.previewTitle, title: it.path }, it.title)))),
          h('div', { style: S.statSub }, t('backupNote')),
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, onClick: () => commit('merge'), disabled: busy }, t('mergeBtn')),
            h('button', { style: S.btn, onClick: () => commit('replace'), disabled: busy }, t('replaceBtn')),
            h('button', {
              style: S.btn, disabled: busy,
              onClick: () => { setStep('menu'); setPlan(null) },
            }, t('cancel'))))
      } else {
        const ok = result?.ok
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', {
            style: { ...S.card, borderColor: ok ? 'rgba(63,155,109,.45)' : 'rgba(208,90,60,.45)' },
          },
            h('div', { style: { ...S.statLabel, color: ok ? '#5fbf8d' : '#e08a72' } },
              ok ? t('doneOk') : t('doneFail')),
            ok
              ? (result.exported
                  ? h('div', { style: S.statSub }, t('expDone', { n: result.exported }))
                  : h('div', { style: S.statSub },
                      t('impDone', {
                        w: result.counts.written, s: result.counts.skipped, r: result.counts.renamed,
                      })))
              : h('div', { style: S.statSub }, error)),
          ok && toAdd.length
            ? h('div', null,
                h('div', { style: S.statSub }, t('importedList')),
                h('div', { style: { ...S.previewList, marginTop: 6, maxHeight: 160 } },
                  toAdd.slice(0, 10).map((it, i) => h('div', { key: i, style: S.previewRow },
                    h('span', { style: S.previewTitle }, it.title)))))
            : null,
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, onClick: onClose }, t('close')),
            h('button', {
              style: S.btn,
              onClick: () => { setStep('menu'); setResult(null); setError(''); setPlan(null) },
            }, t('again'))))
      }

      return h('div', { style: S.modalWrap, onClick: onClose },
        h('div', { style: S.modal, onClick: (e) => e.stopPropagation() },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: S.popTitle }, t('mover')),
            h('button', {
              style: { ...S.btn, padding: '2px 9px' }, onClick: onClose,
              title: '关闭', 'aria-label': '关闭',
            }, '✕')),
          h('div', { style: { ...S.popSub, marginBottom: 10 } }, t('moverSub')),
          body))
    }

    // 明细页：占满面板，左上角返回
    function DetailPage({ view, t, rows, notes, note, busy, onBack, onOpenNote, onOpen }) {
      const [pick, setPick] = useState(null)
      const [pickPos, setPickPos] = useState(null)
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)

      // 笔记页内置语义搜索：说人话也能找到
      useEffect(() => {
        const q = query.trim()
        if (view.name !== 'notes' || !q) { setHits(null); return }
        let alive = true
        const timer = setTimeout(async () => {
          try {
            const res = await api('/search', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ q, limit: 20 }),
            })
            const data = await res.json()
            if (alive) setHits(Array.isArray(data) ? data : [])
          } catch { if (alive) setHits([]) }
        }, 280)
        return () => { alive = false; clearTimeout(timer) }
      }, [query, view.name])
      const meta = {
        notes: [t('notes'), t('notesSub')],
        points: [t('points'), t('pointsSub')],
        relations: [t('links'), t('linksSub')],
        relList: [t('relListTitle'), t('relListSub')],
        recent: [t('updated'), t('updatedSub')],
        note: [view.title ?? '', t('noteBody')],
      }[view.name] ?? ['', '']

      const rowOf = (r) => {
        if (view.name === 'points') {
          return { key: `${r.path}-${r.line}`, title: `[${r.cat}] ${r.text}`, meta: `← ${r.title}`,
                   open: { path: r.path, title: r.title } }
        }
        if (view.name === 'relations' || view.name === 'relList') {
          const target = r.toTitle || r.to
          return { key: `${r.fromPath}-${r.type}-${target}`,
                   title: `${r.from}  ${TYPE_LABEL[r.type] ?? r.type} →  ${target}`,
                   meta: r.toPath ? t('openTarget') : t('missingTarget'),
                   open: r.toPath ? { path: r.toPath, title: target } : null }
        }
        return { key: r.path, title: r.title,
                 meta: `${r.project ?? ''} · ${r.type} · ${r.obs} ${t('pointsUnit')} · ${fmtDays(r.mtime, t)}`,
                 open: { path: r.path, title: r.title } }
      }

      return h('div', { style: S.page },
        h('button', { style: S.backBtn, onClick: onBack },
          h('span', { style: { fontSize: 14, lineHeight: 1 } }, '‹'), t('back')),
        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: S.h1 }, meta[0]),
            view.name === 'relations'
              ? h('button', {
                  onClick: () => onOpen('relList'),
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    border: '1px solid color-mix(in srgb, currentColor 28%, transparent)',
                    background: 'color-mix(in srgb, currentColor 8%, transparent)',
                    borderRadius: 999, padding: '5px 12px', color: 'inherit',
                    fontSize: 12.5, fontWeight: 550,
                  },
                  title: t('relListSub'),
                },
                  h('span', null, t('relCount', { n: rows.length })),
                  h('span', { style: { fontSize: 15, lineHeight: 1, marginTop: -1 } }, '→'))
              : null),
          h('div', { style: S.intro }, meta[1])),

        view.name === 'notes' ? h('div', null,
          h('input', {
            style: S.input, placeholder: t('searchPlaceholder'), value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          h('div', { style: { ...S.statSub, marginTop: 4 } }, t('searchHint'))) : null,

        view.name === 'note'
          ? (busy && !note
              ? h('div', { style: S.card }, h('div', { style: S.statSub }, t('loading')))
              : h('pre', { style: S.pre }, note?.content ?? ''))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              busy ? h('div', { style: S.card }, h('div', { style: S.statSub }, t('loading'))) : null,
              view.name === 'relations' && rows.length
                ? h('div', { style: { position: 'relative' } },
                    h(Graph, {
                      relations: rows, notes, selected: pick, t,
                      onSelect: (p, pos) => { setPick(p === pick ? null : p); setPickPos(pos ?? null) },
                    }),
                    pick ? (() => {
                      const n = (notes ?? []).find((x) => x.path === pick)
                      if (!n) return null
                      const links = rows.filter((r) => r.fromPath === pick || r.toPath === pick).length
                      return h('div', {
                        style: {
                          position: 'absolute', zIndex: 5, width: 260,
                          left: `${pickPos?.left ?? 60}%`, top: `${pickPos?.top ?? 40}%`,
                          transform: 'translate(-12%, 12px)',
                        },
                      }, h(NodeCard, {
                        info: { ...n, links, when: fmtDays(n.mtime, t) },
                        t, onOpen: onOpenNote, onClose: () => { setPick(null); setPickPos(null) },
                      }))
                    })() : null)
                : null,
              (view.name === 'relations') ? null
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                (view.name === 'notes' && query.trim() && hits ? hits : rows).map((r) => {
                  const v = view.name === 'notes' && query.trim() && hits
                    ? { key: `${r.path}-${r.line ?? ''}`, title: r.kind === 'obs' ? `[${r.cat}] ${r.text}` : r.title,
                        meta: r.kind === 'obs' ? `← ${r.title}` : `${r.project ?? ''} · ${r.path}`,
                        open: { path: r.path, title: r.title } }
                    : rowOf(r)
                  return h('button', {
                    key: v.key, style: S.item,
                    onClick: v.open ? () => onOpenNote(v.open) : undefined,
                  },
                    h('div', { style: S.itemTitle }, v.title),
                    h('div', { style: S.itemMeta }, v.meta))
                }))))
    }

    // ---------- 主面板 ----------
    function MemPanel({ t }) {
      const [overview, setOverview] = useState(null)
      const [status, setStatus] = useState(null)
      const [items, setItems] = useState([])
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState([])
      const [searching, setSearching] = useState(false)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const [moverOpen, setMoverOpen] = useState(false)
      const [modelsOpen, setModelsOpen] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const [, forceTick] = useState(0)
      useEffect(() => {
        const timer = setInterval(() => forceTick((n) => n + 1), 20_000)
        return () => clearInterval(timer)
      }, [])
      const [tab, setTab] = useState('overview')
      const [projects, setProjects] = useState([])
      const [project, setProject] = useState('')
      const [stack, setStack] = useState([{ name: 'home' }])
      const [pageRows, setPageRows] = useState([])
      const [pageBusy, setPageBusy] = useState(false)
      const [pageNotes, setPageNotes] = useState([])
      const [pageNote, setPageNote] = useState(null)
      const view = stack[stack.length - 1]
      const back = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st))
      const push = (v) => setStack((st) => [...st, v])

      const refresh = useCallback(async () => {
        try {
          const qs = project ? `?project=${encodeURIComponent(project)}` : ''
          const [ov, st, list, pj] = await Promise.all([
            getJson(`/overview${qs}`), getJson('/status'), getJson(`/list${qs}`), getJson('/projects'),
          ])
          setProjects(Array.isArray(pj) ? pj : [])
          setOverview(ov); setStatus(st); setItems(list); setErr('')
        } catch (e) { setErr(String(e.message)) }
      }, [project])

      useEffect(() => { refresh() }, [refresh])

      useEffect(() => {
        const q = query.trim()
        if (!q) { setHits([]); setSearching(false); return }
        let alive = true
        setSearching(true)
        const timer = setTimeout(async () => {
          try {
            const res = await api('/search', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ q, limit: 20, project: project || undefined }),
            })
            const data = await res.json()
            if (alive) { setHits(Array.isArray(data) ? data : []); setErr('') }
          } catch (e) {
            if (alive) setErr(String(e.message))
          } finally {
            if (alive) setSearching(false)
          }
        }, 260)
        return () => { alive = false; clearTimeout(timer) }
      }, [query, project])

      async function openPage(kind) {
        push({ name: kind })
        setPageBusy(true); setPageRows([]); setPageNotes([]); setErr('')
        try {
          if (kind === 'points') setPageRows(await getJson('/points'))
          else if (kind === 'relations') {
            const [rels, list] = await Promise.all([getJson('/relations'), getJson('/list')])
            setPageRows(rels); setPageNotes(list)
          } else setPageRows(await getJson('/list'))
        } catch (e) { setErr(String(e.message)) } finally { setPageBusy(false) }
      }

      async function openNote(it) {
        push({ name: 'note', path: it.path, title: it.title })
        setPageBusy(true); setPageNote(null)
        try {
          const r = await getJson(`/note?path=${encodeURIComponent(it.path)}`)
          setPageNote({ ...it, content: r.content })
        } catch (e) { setErr(String(e.message)) } finally { setPageBusy(false) }
      }

      if (view.name !== 'home') {
        return h(DetailPage, {
          view, t, rows: pageRows, notes: pageNotes, note: pageNote,
          busy: pageBusy, onBack: back, onOpenNote: openNote,
          onOpen: (kind) => push({ name: kind }),
        })
      }

      return h('div', { style: S.page },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: S.header },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: S.h1 }, t('title')),
              h('button', {
                onClick: () => { refresh(); setReloadKey((n) => n + 1) },
                title: t('refreshHint'), 'aria-label': t('refreshHint'),
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
                  background: 'transparent', color: 'inherit', borderRadius: 999,
                  padding: '3px 9px', fontSize: 11.5, opacity: 0.75,
                },
              }, t('refresh'))),
            h('div', { style: S.intro }, t('intro'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            h('button', {
              style: S.moverBtn, onClick: () => setModelsOpen(true), title: t('modelsSub'),
            },
              h('span', { style: { fontSize: 13, lineHeight: 1 } }, '⚙'),
              h('span', null, t('modelsTitle'))),
            h('button', {
              style: S.moverBtn, onClick: () => setMoverOpen(true), title: t('moverSub'),
            },
              h('span', { style: { fontSize: 13, lineHeight: 1 } }, '⇄'),
              h('span', null, t('mover')))))),

        h(PipelinePanel, { t, key: `pl-${reloadKey}` }),

        projects.length > 1 ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { ...S.statSub, flex: 'none' } }, t('project'))
          , h('select', {
            value: project, onChange: (e) => setProject(e.target.value),
            style: { ...S.input, padding: '5px 8px', fontSize: 12, flex: 1 },
          },
            h('option', { value: '' }, t('allProjects')),
            projects.map((p) => h('option', { key: p.name, value: p.name },
              `${p.title || p.name}（${p.notes} 篇）`)))) : null,

        err ? h('div', { style: { ...S.card, borderColor: '#c0392b88' } },
          h('div', { style: S.statSub }, t('failed', { msg: err }))) : null,
        msg ? h('div', { style: S.card }, h('div', { style: S.statSub }, msg)) : null,

        h('section', { style: S.section },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: S.h2 }, tab === 'overview' ? t('overview') : t('detailsTab')),
              h('div', { style: S.sub }, tab === 'overview' ? t('overviewSub') : t('detailsSub'))),
            h('div', { style: { display: 'flex', gap: 4, flex: 'none' } },
              [['overview', t('overviewTab')], ['details', t('detailsTab')]].map(([key, label]) =>
                h('button', {
                  key, onClick: () => setTab(key),
                  style: {
                    cursor: 'pointer', fontSize: 11.5, padding: '4px 11px', borderRadius: 999,
                    color: 'inherit', border: '1px solid ' + (tab === key
                      ? 'color-mix(in srgb, currentColor 30%, transparent)'
                      : 'color-mix(in srgb, currentColor 12%, transparent)'),
                    background: tab === key ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
                    fontWeight: tab === key ? 600 : 500,
                  },
                }, label)))),

          tab === 'overview' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
            h(Field, {
              value: overview?.notes ?? '—', label: t('notes'), sub: t('notesSub'),
              onClick: () => openPage('notes'),
            }),
            h(Field, {
              value: overview?.obs ?? '—', label: t('points'), sub: t('pointsSub'),
              onClick: () => openPage('points'),
            }),
            h(Field, {
              value: overview?.rel ?? '—', label: t('links'), sub: t('linksSub'),
              onClick: () => openPage('relations'),
            }),
            h(Field, {
              value: overview?.lastDistillAt ? fmtAgo(overview.lastDistillAt) : t('never'),
              label: t('lastDistill'), sub: t('lastDistillSub'),
              onClick: () => openPage('recent'),
            })),
          h(Heatmap, { t }))
          : h(DetailData, { t })),

        modelsOpen ? h(ModelDialog, {
          t, onClose: () => setModelsOpen(false),
        }) : null,

        moverOpen ? h(MoverDialog, {
          t, onClose: () => setMoverOpen(false), onRefresh: refresh,
        }) : null)
    }

    // 侧栏图标：头部剪影 + 脑内关系网（用户提供的图标，viewBox 1024）
    const TAB_ICON_PATHS = [
      'M939.358266 559.445367c-0.599941-0.999902-1.299873-1.899814-2.099795-2.799727-20.797969-23.497705-35.696514-51.394981-48.295284-80.69212-18.298213-42.59584-15.298506-82.091983-15.898447-125.887706-0.499951-34.996582-10.798945-78.592325-22.797774-111.089152-20.198028-54.794649-55.994532-99.290304-99.790255-133.686944C679.483644 40.296065 581.093253 0 472.403867 0 255.625037 0 80.042183 159.884386 80.042183 357.165121c0 13.198711 1.899814 39.396153 1.899815 39.396152 1.399863 85.491651 28.897178 187.281711 106.28962 301.57055 0 0 0 0.09999 0.09999 0.09999 1.199883 2.399766 31.896885 48.995215 14.198614 132.587052-2.199785 10.398984-12.298799 26.997364-25.797481 42.095889-19.498096 21.697881-14.498584 55.794551 10.298994 71.193048 74.492725 46.395469 161.48423 74.992676 254.67513 79.792208l53.594766 0.09999c16.89835-0.799922 33.596719-2.399766 49.995117-4.699541 7.599258-1.099893 13.898643-6.199395 16.498389-13.498682 13.098721-36.996387 49.495166-117.088566 119.888292-117.088565h104.489796c14.298604 0 29.097158-4.799531 33.99668-6.499366 1.299873-0.499951 2.499756-0.999902 3.699639-1.699834 17.09833-10.498975 17.698272-38.29626 14.898545-60.894053-2.199785-17.498291 3.999609-34.796602 16.198418-47.495362 5.499463-5.699443 8.59916-11.598867 8.59916-16.698369v-2.199785c0-10.698955-13.598672-19.898057-33.796699-24.797579-1.299873-0.299971-1.099893-2.299775 0.299971-2.299775 9.999024 0 19.198125-2.699736 25.79748-7.099307 6.599356-4.39957 10.798945-10.498975 10.798946-17.29831V699.931647c0-0.799922-0.09999-1.599844-0.199981-2.399765-1.199883-8.59916-1.399863-17.398301 0.499951-25.997462 5.699443-26.297432 14.798555-67.79338 17.198321-67.99336 75.292647-2.799727 60.094131-35.996485 55.19461-44.095693zM808.771018 365.164339c-3.699639 15.898447-10.598965 30.297041-20.398008 42.695831-16.89835 21.29792-42.29587 36.596426-75.492627 45.295577-22.297822 5.899424-47.995313 8.899131-76.49253 8.89913-9.099111 0-17.398301-0.299971-24.397618-0.699931-12.998731 26.597403-34.296651 46.995411-62.593887 59.794161-28.897178 12.998731-60.094131 15.798457-81.092081 15.798457-3.099697 0-5.999414-0.09999-8.69915-0.099991-4.0996 11.298897-10.598965 34.09667-18.098233 78.292355-6.799336 39.896104-10.898936 76.59252-10.898936 76.992481l-1.299873 11.398887-7.699248 7.999219c-13.498682 13.898643-27.597305 20.997949-41.895908 20.997949-20.997949 0-35.296553-14.898545-41.095987-27.697295l-4.799531-10.598965 2.699736-11.498877 7.599258-31.796895c-6.099404-1.499854-14.398594-2.599746-21.39791-2.799727-46.79543-0.09999-79.292257-14.398594-96.390587-42.395859-8.49917-13.798652-11.598867-28.297237-12.098819-41.295968-14.398594-3.199688-26.197442-9.299092-35.896494-18.398203-20.597988-51.09501-31.396934-101.390099-32.296846-150.485304v-1.799824l-0.099991-1.799825c-0.699932-9.199102-1.799824-26.697393-1.799824-34.696611 0-38.796211 8.39918-76.49253 24.897569-112.089054 16.198418-34.796602 39.396153-66.093546 69.093252-93.190899 30.097061-27.397324 65.293624-48.995215 104.589787-64.093741C383.612538 71.992969 427.308271 63.993751 472.403867 63.993751c45.195586 0 88.991309 8.099209 130.087296 23.997656 38.796211 14.998535 73.592813 36.296455 103.489894 63.393809l1.699834 1.699834 3.399668 2.599746c37.696319 29.497119 64.293721 64.993653 79.192266 105.389708 10.898936 29.6971 18.498194 65.793575 18.798164 89.891222 0 4.0996 0.09999 8.199199 0.09999 12.298799-0.19998 0.599941-0.299971 1.199883-0.399961 1.899814z',
      'M635.487941 197.480715c0 35.596524-28.797188 64.493702-64.493702 64.493702-25.797481 0-47.795332-15.198516-58.194317-36.996388l-133.186994 58.794259c2.799727 5.699443 4.999512 11.698858 6.599356 17.898252l32.096865-0.899912c3.799629-15.198516 17.598281-26.497412 33.996681-26.497412 19.298115 0 34.996582 15.698467 34.996582 34.996582s-15.698467 34.996582-34.996582 34.996582c-16.79836 0-30.796992-11.798848-34.196661-27.497314l-29.097158 0.799921c0.19998 2.499756 0.299971 5.099502 0.29997 7.699249 0 19.898057-6.099404 38.39625-16.298408 53.794746l90.391173 52.194903c5.899424-5.799434 13.798652-9.399082 22.597793-9.399082 17.798262 0 32.196856 14.398594 32.196856 32.196856 0 17.798262-14.398594 32.196856-32.196856 32.196855-17.798262 0-32.096866-14.398594-32.096866-32.196855 0-3.199688 0.899912-5.899424 1.799825-8.899131l-92.990919-53.694757c-17.698272 18.498194-42.29587 30.297041-70.093155 30.297042-53.394786 0-96.690558-43.295772-96.690558-96.690558 0-53.394786 43.295772-96.690558 96.690558-96.690558 32.796797 0 61.493995 16.298408 78.992286 41.195977l136.08671-60.494092c-0.699932-3.899619-1.299873-7.699248-1.299873-11.698857 0-35.596524 28.797188-64.493702 64.493702-64.493702 35.696514 0.09999 64.593692 28.897178 64.593692 64.593692z',
    ]

    function TabIcon() {
      const fill = { fill: 'currentColor' }
      return h('svg', { viewBox: '0 0 1024 1024', width: 18, height: 18, 'aria-hidden': true },
        TAB_ICON_PATHS.map((d, i) => h('path', { key: i, d, ...fill })))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 任何一步失败都要上报，且不能连累后续注册——不然整个入口会消失
        const report = (stage, e) => {
          try {
            fetch(`/mem-panel/api/hello?stage=${stage}&err=${encodeURIComponent(String((e && e.message) || e))}`,
              { headers: { 'x-mem-token': TOKEN } }).catch(() => {})
          } catch { /* ignore */ }
        }
        report('start', '')

        // 键盘焦点可见：宿主默认可能移除了 outline，这里补回一个与主题一致的光环
        try {
          if (typeof document !== 'undefined' && !document.getElementById('mem-panel-focus')) {
            const el = document.createElement('style')
            el.id = 'mem-panel-focus'
            el.textContent = [
              'button:focus-visible,input:focus-visible,[role="button"]:focus-visible{outline:2px solid color-mix(in srgb,currentColor 55%,transparent);outline-offset:2px;border-radius:8px}',
              '@keyframes mem-breathe{0%,100%{transform:scale(1);opacity:0}50%{transform:scale(1.35);opacity:1}}',
              '.mem-dot{display:inline-block;animation:mem-breathe 2.2s ease-in-out infinite}',
              '@media (prefers-reduced-motion: reduce){.mem-dot{animation:none}}',
            ].join('\n')
            document.head.appendChild(el)
          }
        } catch { /* ignore */ }

        // 文案解析：优先用宿主注册的 locale；拿不到就本地兜底，保证永远是中文
        const pickLocale = () => {
          try {
            const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'zh')
            return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
          } catch { return 'zh' }
        }
        const localT = (key, params) => {
          const dict = DICTS[pickLocale()] ?? DICTS.zh
          let v = dict[key] ?? DICTS.zh[key] ?? key
          if (params && typeof v === 'string') {
            v = v.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''))
          }
          return v
        }

        let boundT = null
        try {
          for (const [locale, dict] of Object.entries(DICTS)) {
            ctx.effect(() => ctx.locale.register(NS, locale, dict), `mem-panel:${locale}`)
          }
          boundT = ctx.locale.bind(NS)
          report('locale', '')
        } catch (e) { report('locale_fail', e) }

        const t = (key, params) => {
          if (boundT) {
            try {
              const v = boundT(key, params)
              if (v && v !== key) return v
            } catch { /* 落到本地字典 */ }
          }
          return localT(key, params)
        }

        try {
          const Boundary = makeBoundary()
          const wrap = (node) => (Boundary ? h(Boundary, null, node) : node)
        ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'mem', locale: NS }, () => wrap(h(MemPanel, { t }))))
          report('main', '')
        } catch (e) { report('main_fail', e) }

        try {
          ctx.slots.inject('sidebar.panellist', () => {
            try {
              ctx.slots.register({
                name: 'sidebar.panellist', id: 'mem', order: 20, locale: NS,
                label: () => {
                  try { return (t('panel') || '长期记忆') } catch { return '长期记忆' }
                },
              }, TabIcon)
              report('sidebar', '')
            } catch (e) { report('sidebar_fail', e) }
          })
        } catch (e) { report('sidebar_inject_fail', e) }
      },
    }
  },
})
