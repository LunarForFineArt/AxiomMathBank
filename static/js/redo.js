// ==========================================
//      错题重做工作台 (独立刷题页 · 艾宾浩斯遗忘曲线)
//      模式：每日重做 / 筛选复习(教材+标签) / 再战区(答错过)
// ==========================================
(function () {
    'use strict';

    // ---- 模式定义 ----
    const REDO_MODES = {
        daily: { label: '每日重做', badgeCls: 'bg-brand-50 text-brand-600 border-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/30' },
        custom: { label: '筛选复习', badgeCls: 'bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/30' },
        rematch: { label: '再战区', badgeCls: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30' }
    };

    // ---- 内部状态 ----
    let redoQueue = [];                 // 本次刷题队列
    let redoIndex = 0;                  // 当前题目索引
    let redoSubmitting = false;         // 防止重复提交的锁
    let redoStats = { correct: 0, wrong: 0 }; // 本次会话统计
    let redoRemaining = [];             // 其余未到期（未掌握）的错题，用于完成页提示
    let redoMode = 'daily';             // daily | custom | rematch
    let redoAllRecords = [];            // 弹窗加载的全部在册错题（用于筛选/再战）
    let redoAllTags = [];               // 错题本聚合标签
    let redoSelectedTags = new Set();   // 弹窗中选中的标签
    let redoCatTree = {};               // 分类树（教材级联）
    let redoCatBound = false;           // 级联下拉是否已绑定事件
    let redoListLoaded = false;         // 全部错题是否已加载（缓存，答题后同步更新）
    let redoCatLoaded = false;          // 分类树是否已加载（缓存）

    // ---- 工具 ----
    function el(id) {
        return document.getElementById(id);
    }

    function renderRedoMath(container) {
        if (!container || typeof renderMathInElement !== 'function') return;
        try {
            renderMathInElement(container, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ],
                throwOnError: false
            });
        } catch (e) {
            console.error('KaTeX redo rendering error: ', e);
        }
    }

    function setRedoButtonsDisabled(disabled) {
        ['redoWrongBtn', 'redoAnswerBtn', 'redoCorrectBtn'].forEach(id => {
            const btn = el(id);
            if (btn) btn.disabled = disabled;
        });
    }

    // fetch 超时保护：网络卡住时走 catch，显示明确的重试提示而非无限 loading
    function fetchRedo(url, opts, timeoutMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
        return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
            .finally(() => clearTimeout(timer));
    }

    // ---- 模式徽章 ----
    function updateRedoModeBadge() {
        const badge = el('redoModeBadge');
        if (!badge) return;
        const meta = REDO_MODES[redoMode] || REDO_MODES.daily;
        badge.textContent = meta.label;
        badge.className = `text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${meta.badgeCls}`;
        badge.classList.remove('hidden');
    }

    // ---- 队列排序 ----
    // daily: 今日待重做（due 且未掌握）
    // custom: 按筛选条件过滤（不限 due），due 优先 → next_review_at 升序 → wrong_count 降序
    // rematch: 答错过（wrong_count>0），wrong_count 降序 → due 优先
    function buildRedoQueue(records, mode) {
        if (mode === 'daily') {
            return records
                .filter(r => r.due && !r.mastered)
                .sort((a, b) => {
                    const ta = a.next_review_at ? new Date(a.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
                    const tb = b.next_review_at ? new Date(b.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
                    return ta - tb;
                });
        }
        if (mode === 'rematch') {
            return records
                .filter(r => (r.wrong_count || 0) > 0)
                .sort((a, b) => {
                    const wa = a.wrong_count || 0, wb = b.wrong_count || 0;
                    if (wa !== wb) return wb - wa;
                    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
                    const ta = a.next_review_at ? new Date(a.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
                    const tb = b.next_review_at ? new Date(b.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
                    return ta - tb;
                });
        }
        // custom
        return records
            .filter(r => {
                const q = r.question || {};
                const comp = el('redoFilterCompulsory').value;
                const chap = el('redoFilterChapter').value;
                const know = el('redoFilterKnowledge').value;
                if (comp && q.category_compulsory !== comp) return false;
                if (chap && q.category_chapter !== chap) return false;
                if (know && q.category_knowledge !== know) return false;
                if (redoSelectedTags.size > 0) {
                    const qTags = (q.tags || '').split(/[,，]+/).map(t => t.trim()).filter(Boolean);
                    if (![...redoSelectedTags].some(t => qTags.includes(t))) return false;
                }
                return true;
            })
            .sort((a, b) => {
                if (!!a.due !== !!b.due) return a.due ? -1 : 1;
                const ta = a.next_review_at ? new Date(a.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
                const tb = b.next_review_at ? new Date(b.next_review_at).getTime() : Number.MAX_SAFE_INTEGER;
                if (ta !== tb) return ta - tb;
                return (b.wrong_count || 0) - (a.wrong_count || 0);
            });
    }

    // 沉浸刷题: 自动收起左侧面板(仅进入队列时)
    function autoCollapseRedoPanel() {
        const panel = el('redoPanel');
        if (panel && !panel.classList.contains('hidden')) {
            window.toggleRedoPanel();
        }
    }
    // 进入刷题队列（通用）
    function startRedoQueue(records, mode, emptyMode) {
        redoMode = mode;
        redoQueue = records;
        redoIndex = 0;
        redoStats = { correct: 0, wrong: 0 };
        redoSessionResults = [];
        redoRemaining = redoAllRecords.filter(r => !r.due && !r.mastered);
        updateRedoModeBadge();
        updateRedoPanelCounts();
        refreshWrongBadge();
        // 沉浸刷题: 自动收起左侧面板
        if (records.length > 0) autoCollapseRedoPanel();
        if (redoQueue.length === 0) {
            renderRedoEmpty(emptyMode || 'noresult');
        } else {
            renderRedoQuestion();
        }
    }

    // ---- 每日重做（默认模式） ----
    window.enterRedoWorkspace = function () {
        const content = el('redoContent');
        const badges = el('redoBadges');
        const answerWrapper = el('redoAnswerWrapper');
        const images = el('redoImages');
        if (content) content.innerHTML = '<p class="text-slate-600 dark:text-slate-400 text-sm"><i class="fa-solid fa-circle-notch animate-spin mr-2 text-brand-500"></i>正在加载错题队列...</p>';
        if (badges) badges.innerHTML = '';
        if (answerWrapper) answerWrapper.classList.add('hidden');
        if (images) images.innerHTML = '';
        if (el('redoAnswerBtn')) el('redoAnswerBtn').innerHTML = '<i class="fa-solid fa-eye mr-1"></i>查看答案';
        setRedoButtonsDisabled(false);
        redoSubmitting = false;

        fetchRedo('/api/wrong-questions?filter=all')
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(list => {
                // 同步全局错题集合，保持编辑区"加入错题本"按钮状态一致
                wrongQuestionsLoaded = true;
                wrongQuestionIds = new Set((list || []).map(w => w.question_id));

                redoAllRecords = list || [];
                redoListLoaded = true;
                redoRemaining = redoAllRecords.filter(r => !r.due && !r.mastered);
                redoMode = 'daily';
                redoQueue = buildRedoQueue(redoAllRecords, 'daily');
                redoIndex = 0;
                redoStats = { correct: 0, wrong: 0 };
                redoSessionResults = [];
                updateRedoModeBadge();
                updateRedoModeButtons();
                updateRedoPanelCounts();
                refreshWrongBadge();
                // 面板分类树/标签尚未加载时补加载（列表已复用缓存）
                if (!redoCatLoaded) loadRedoPanelData();
                // 进入工作台保持面板可见(自定义复习/曲线一目了然);
                // 仅在实际开始刷题(进入队列)时由 startRedoQueue 自动收起

                if (redoQueue.length === 0) {
                    renderRedoEmpty(redoAllRecords.length === 0 ? 'empty' : 'done');
                } else {
                    renderRedoQuestion();
                }
            })
            .catch(err => {
                console.error('加载错题队列失败:', err);
                if (content) {
                    content.innerHTML = `
                        <div class="flex flex-col items-center justify-center py-14 text-center">
                            <i class="fa-solid fa-triangle-exclamation text-3xl text-red-400 mb-3"></i>
                            <p class="text-sm font-semibold text-red-500">错题队列加载失败</p>
                            <p class="text-[10px] text-slate-600 dark:text-slate-400 mt-1 mb-4">后台服务正在启动或连接超时</p>
                            <button onclick="enterRedoWorkspace()" class="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 font-bold rounded-xl transition-all border border-red-200 text-xs">
                                <i class="fa-solid fa-arrows-rotate mr-1"></i>重新加载
                            </button>
                        </div>`;
                }
                if (badges) badges.innerHTML = '';
                if (el('redoProgressText')) el('redoProgressText').textContent = '加载失败';
                if (el('redoProgressBar')) el('redoProgressBar').style.width = '0%';
            });
    };

    // ---- 空状态 / 完成状态 / 无结果 ----
    // mode: 'empty'(错题本空) | 'done'(队列刷完) | 'noresult'(筛选/再战无结果)
    function renderRedoEmpty(mode) {
        const content = el('redoContent');
        const badges = el('redoBadges');
        const images = el('redoImages');
        const answerWrapper = el('redoAnswerWrapper');
        if (badges) badges.innerHTML = '';
        if (images) images.innerHTML = '';
        if (answerWrapper) answerWrapper.classList.add('hidden');
        if (el('redoAnswerBtn')) el('redoAnswerBtn').innerHTML = '<i class="fa-solid fa-eye mr-1"></i>查看答案';

        const queueLen = redoQueue.length;
        if (el('redoProgressText')) el('redoProgressText').textContent = '今日待重做 0 道';
        if (el('redoProgressBar')) el('redoProgressBar').style.width = queueLen > 0 ? '100%' : '0%';
        updateRedoQueueStats();

        if (!content) return;

        const hasSession = redoStats.correct > 0 || redoStats.wrong > 0;
        const isDaily = redoMode === 'daily';

        let title, desc, statHtml = '', extraHtml = '', btnHtml = '';

        if (mode === 'empty' && !hasSession) {
            title = '错题本还是空的';
            desc = '在「题库研讨工作台」打开任意题目，点击右上角「加入错题本」，系统将按艾宾浩斯遗忘曲线自动安排重做时间';
        } else if (mode === 'noresult' && !hasSession) {
            if (redoMode === 'rematch') {
                title = '再战区暂无题目';
                desc = '还没有在每日重做中再次答错的题目，继续加油！';
            } else {
                title = '没有符合条件的错题';
                desc = '试试调整教材筛选条件，或清空标签后重试';
            }
            btnHtml = `<button onclick="switchRedoMode('custom')" class="mt-6 px-5 py-2.5 bg-brand-500 hover:bg-brand-600 text-white font-bold rounded-xl transition-all text-sm">
                            <i class="fa-solid fa-sliders mr-1"></i>重新筛选
                        </button>`;
        } else {
            // 完成页(结算画面)
            if (redoMode === 'custom') {
                title = '本次筛选复习完成！';
            } else if (redoMode === 'rematch') {
                title = '再战完成！';
            } else {
                title = '今日待重做已全部完成！';
            }
            desc = '下次重做时间已按艾宾浩斯遗忘曲线自动安排';
            // 总用时
            const totalSec = redoSessionResults.reduce((sum, r) => sum + (r.seconds || 0), 0);
            const totalTimeStr = totalSec >= 3600
                ? `${Math.floor(totalSec / 3600)}小时${Math.floor((totalSec % 3600) / 60)}分${totalSec % 60}秒`
                : totalSec >= 60
                    ? `${Math.floor(totalSec / 60)}分${totalSec % 60}秒`
                    : `${totalSec}秒`;
            statHtml = `
                <p class="text-xs text-slate-600 dark:text-slate-400 mt-2">
                    本次答对 <span class="text-emerald-600 font-bold">${redoStats.correct}</span> 道 · 答错 <span class="text-red-500 font-bold">${redoStats.wrong}</span> 道 · 总用时 <span class="text-brand-600 font-bold">${totalTimeStr}</span>
                </p>`;
            if (isDaily && redoRemaining.length > 0) {
                const nextRecord = redoRemaining
                    .filter(r => r.next_review_at)
                    .sort((a, b) => new Date(a.next_review_at) - new Date(b.next_review_at))[0];
                const nextTime = nextRecord ? formatRedoDateTime(nextRecord.next_review_at) : '';
                extraHtml = `
                    <p class="text-[10px] text-slate-600 dark:text-slate-400 mt-1.5">
                        其余 <span class="font-bold text-slate-500">${redoRemaining.length}</span> 道错题按艾宾浩斯曲线安排在后续日期${nextTime ? `（最早 ${nextTime}）` : ''}
                    </p>`;
            }
            if (!isDaily) {
                btnHtml = `<button onclick="enterRedoWorkspace()" class="mt-6 px-5 py-2.5 bg-brand-500 hover:bg-brand-600 text-white font-bold rounded-xl transition-all text-sm">
                                <i class="fa-solid fa-rotate-left mr-1"></i>返回每日重做
                            </button>`;
            } else {
                btnHtml = `<button onclick="enterRedoWorkspace()" class="mt-6 px-5 py-2.5 bg-brand-500 hover:bg-brand-600 text-white font-bold rounded-xl transition-all text-sm">
                                <i class="fa-solid fa-arrows-rotate mr-1"></i>刷新队列
                            </button>`;
            }
        }

        // 结算明细(每题: 对错/用时/几天后复习)
        const resultsHtml = (mode === 'done' || (mode !== 'empty' && hasSession))
            ? renderRedoResultsHtml()
            : '';

        content.innerHTML = `
            <div class="flex flex-col items-center justify-center py-10 text-center">
                <div class="h-16 w-16 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mb-4">
                    <i class="fa-solid fa-flag-checkered text-2xl text-emerald-500"></i>
                </div>
                <p class="text-lg font-bold text-slate-700">${title}</p>
                ${statHtml}
                <p class="text-xs text-slate-600 dark:text-slate-400 mt-2 max-w-xs leading-relaxed">${desc}</p>
                ${extraHtml}
                ${resultsHtml}
                ${btnHtml}
            </div>`;
    }

    // UTC ISO → 本地时间（月-日 时:分）
    function formatRedoDateTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return '';
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const h = String(d.getHours()).padStart(2, '0');
            const min = String(d.getMinutes()).padStart(2, '0');
            return `${m}月${day}日 ${h}:${min}`;
        } catch (e) {
            return '';
        }
    }

    // 顶部统计文案（按模式）
    function updateRedoQueueStats() {
        const stats = el('redoQueueStats');
        if (!stats) return;
        if (redoMode === 'custom') {
            stats.textContent = `筛选 ${redoQueue.length} 道`;
        } else if (redoMode === 'rematch') {
            stats.textContent = `再战 ${redoQueue.length} 道`;
        } else {
            const dueCount = redoAllRecords.filter(r => !!r.due && !r.mastered).length;
            stats.textContent = `今日待重做 ${dueCount} 道`;
        }
    }

    // ---- 渲染当前题目 ----
    function renderRedoQuestion() {
        const record = redoQueue[redoIndex];
        if (!record) {
            renderRedoEmpty('done');
            return;
        }
        const q = record.question || {};
        const qid = q.id;
        if (!qid) {
            // 题目数据异常，跳过
            redoQueue.splice(redoIndex, 1);
            renderRedoQuestion();
            return;
        }

        // 进度
        if (el('redoProgressText')) el('redoProgressText').textContent = `第 ${redoIndex + 1} / ${redoQueue.length} 题`;
        if (el('redoProgressBar')) el('redoProgressBar').style.width = `${Math.round(((redoIndex + 1) / redoQueue.length) * 100)}%`;
        updateRedoQueueStats();

        // 徽章
        const badges = el('redoBadges');
        if (badges) {
            const typeText = getTypeText(q.question_type);
            const diffBadge = getDifficultyBadge(q.difficulty);
            badges.innerHTML = `
                <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-500">${typeText}</span>
                ${diffBadge}
                <span class="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-brand-50 text-brand-600">#${record.seq_num || qid}</span>
                ${record.due ? '<span class="text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full"><i class="fa-solid fa-bell mr-0.5"></i>今日待重做</span>' : ''}
                ${(record.wrong_count || 0) > 0 ? `<span class="text-[10px] font-bold text-orange-600 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full"><i class="fa-solid fa-bolt mr-0.5"></i>再战 ${record.wrong_count} 次</span>` : ''}
                ${record.mastered ? '<span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full"><i class="fa-solid fa-circle-check mr-0.5"></i>已掌握</span>' : ''}
                ${q.source ? `<span class="text-[10px] text-slate-600 dark:text-slate-400 font-medium">${q.source}</span>` : ''}
            `;
        }

        // 题干
        const content = el('redoContent');
        if (content) {
            let html = '';
            try {
                html = parseMarkdownWithMath(q.content || '');
            } catch (e) {
                console.error('题干解析失败:', e);
                html = '<p class="text-red-500 text-sm">题干渲染失败</p>';
            }
            content.innerHTML = html || '<p class="text-slate-600 dark:text-slate-400 text-sm">[空白题干]</p>';
            // 仅当包含公式时才调用 KaTeX, 避免无谓开销
            if (/\$|\\\(|\\\[/.test(q.content || '')) renderRedoMath(content);
        }

        // 题干插图（题干 markdown 未引用的图片单独展示）
        const images = el('redoImages');
        if (images) {
            const usedSrcs = [];
            if (content) {
                content.querySelectorAll('img').forEach(img => usedSrcs.push(img.getAttribute('src') || ''));
            }
            const extras = (q.image_paths || []).filter(p => p && usedSrcs.indexOf(p) === -1);
            if (extras.length > 0) {
                images.innerHTML = extras.map(p => `
                    <div class="flex justify-center">
                        <img src="${p}" alt="题干插图" class="max-w-full max-h-80 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm object-contain bg-white" loading="lazy">
                    </div>`).join('');
            } else {
                images.innerHTML = '';
            }
        }

        // 答案区收起，按钮复位
        const answerWrapper = el('redoAnswerWrapper');
        if (answerWrapper) answerWrapper.classList.add('hidden');
        if (el('redoAnswerBtn')) el('redoAnswerBtn').innerHTML = '<i class="fa-solid fa-eye mr-1"></i>查看答案';

        setRedoButtonsDisabled(false);
        redoSubmitting = false;
        // 渲染新题后自动开始本题计时
        startRedoTimerForQuestion();
    }

    // ---- 查看答案（按需加载完整题目详情） ----
    window.redoShowAnswer = function () {
        const record = redoQueue[redoIndex];
        if (!record || redoSubmitting) return;
        const q = record.question || {};
        const wrapper = el('redoAnswerWrapper');
        if (!wrapper) return;
        const btn = el('redoAnswerBtn');

        if (!wrapper.classList.contains('hidden')) {
            // 收起
            wrapper.classList.add('hidden');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-eye mr-1"></i>查看答案';
            return;
        }

        // 展开
        wrapper.classList.remove('hidden');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-eye-slash mr-1"></i>收起答案';

        const answerEl = el('redoAnswer');
        if (!answerEl) return;

        if (record._fullQuestion && record._fullQuestion.answer_markdown !== undefined) {
            renderRedoAnswerContent(record._fullQuestion.answer_markdown || '');
            return;
        }

        answerEl.innerHTML = '<p class="text-slate-600 dark:text-slate-400 italic text-xs"><i class="fa-solid fa-circle-notch animate-spin mr-1"></i>正在加载答案...</p>';
        fetchRedo(`/api/questions/${q.id}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(full => {
                record._fullQuestion = full;
                renderRedoAnswerContent(full.answer_markdown || '');
            })
            .catch(err => {
                console.error('加载答案失败:', err);
                answerEl.innerHTML = '<p class="text-red-500 text-xs">答案加载失败，请重试</p>';
            });
    };

    function renderRedoAnswerContent(markdown) {
        const answerEl = el('redoAnswer');
        if (!answerEl) return;
        if (!markdown || !markdown.trim()) {
            answerEl.innerHTML = '<p class="text-slate-600 dark:text-slate-400 italic text-xs">暂无答案与解析</p>';
            return;
        }
        try {
            answerEl.innerHTML = parseMarkdownWithMath(markdown);
        } catch (e) {
            console.error('答案解析失败:', e);
            answerEl.innerHTML = '<p class="text-red-500 text-xs">答案渲染失败</p>';
            return;
        }
        // 仅当包含公式时才调用 KaTeX
        if (/\$|\\\(|\\\[/.test(markdown || '')) renderRedoMath(answerEl);
    }

    // ---- 提交结果：答对 / 答错 ----
    window.redoAnswer = function (correct) {
        if (redoSubmitting) return;
        const record = redoQueue[redoIndex];
        if (!record) return;
        const qid = record.question ? record.question.id : null;
        if (!qid) return;

        redoSubmitting = true;
        setRedoButtonsDisabled(true);

        fetchRedo(`/api/wrong-questions/${qid}/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correct: correct })
        })
            .then(r => {
                if (!r.ok) return r.json().then(e => Promise.reject(new Error(e.detail || '提交失败')));
                return r.json();
            })
            .then(res => {
                if (correct) redoStats.correct++; else redoStats.wrong++;
                // 记录本题结果(计时/对错), 用于结算
                recordRedoResult(record, qid, correct);
                // 补充下次复习时间(答对按艾宾浩斯推后, 答错重置为明天)
                const lastResult = redoSessionResults[redoSessionResults.length - 1];
                if (lastResult) {
                    const nra = res.record && res.record.next_review_at ? res.record.next_review_at : null;
                    lastResult.nextReviewAt = nra;
                    if (nra) {
                        const days = Math.max(0, Math.round((new Date(nra).getTime() - Date.now()) / 86400000));
                        lastResult.nextReviewDays = days;
                    }
                }
                // 该题今天已刷完：从队列移除，自动进入下一题
                redoQueue.splice(redoIndex, 1);
                // 同步弹窗缓存（wrong_count/阶段等），保证再战区与筛选数据最新
                const idx = redoAllRecords.findIndex(r => r.question && r.question.id === qid);
                if (idx > -1) {
                    const merged = Object.assign({}, redoAllRecords[idx], res.record);
                    merged.due = !!(!merged.mastered && merged.next_review_at && new Date(merged.next_review_at).getTime() <= Date.now());
                    redoAllRecords[idx] = merged;
                }
                redoRemaining = redoAllRecords.filter(r => !r.due && !r.mastered);
                updateRedoPanelCounts();
                refreshWrongBadge();
                showToast(res.message || (correct ? '答对了！' : '记下了，明天再重做'));
                renderRedoQuestion();
            })
            .catch(err => {
                console.error('提交重做结果失败:', err);
                showToast(err.message || '提交重做结果失败', 'error');
                redoSubmitting = false;
                setRedoButtonsDisabled(false);
            });
    };

    // ==========================================
    //      自定义复习面板（常驻展开 · 筛选复习 + 再战区）
    // ==========================================

    // 加载面板数据：优先使用缓存（本次会话已加载），否则拉取分类树 + 全部错题
    window.loadRedoPanelData = function () {
        if (redoListLoaded && redoCatLoaded) {
            // 缓存命中，同步填充，无等待
            applyRedoPanelData();
            if (pendingRedoMode) {
                const m = pendingRedoMode;
                pendingRedoMode = null;
                executeRedoMode(m);
            }
            return;
        }

        // 部分命中时只拉取缺失数据
        const catPromise = redoCatLoaded
            ? Promise.resolve(redoCatTree)
            : fetchRedo('/api/categories').then(r => r.json()).catch(() => ({}));
        const listPromise = redoListLoaded
            ? Promise.resolve(redoAllRecords)
            : fetchRedo('/api/wrong-questions?filter=all').then(r => r.json()).catch(() => []);

        Promise.all([catPromise, listPromise]).then(([catTree, list]) => {
            redoCatTree = catTree || {};
            redoAllRecords = list || [];
            redoListLoaded = true;
            redoCatLoaded = true;
            wrongQuestionsLoaded = true;
            wrongQuestionIds = new Set(redoAllRecords.map(w => w.question_id));
            applyRedoPanelData();
            if (pendingRedoMode) {
                const m = pendingRedoMode;
                pendingRedoMode = null;
                executeRedoMode(m);
            }
        });
    };

    // 用缓存数据填充弹窗（分类级联 + 标签 + 再战区数量）
    function applyRedoPanelData() {
        // 分类级联下拉
        populateRedoCategoryDropdowns();

        // 聚合标签
        const tagSet = new Set();
        redoAllRecords.forEach(r => {
            const tags = (r.question && r.question.tags || '').split(/[,，]+/).map(t => t.trim()).filter(Boolean);
            tags.forEach(t => tagSet.add(t));
        });
        redoAllTags = [...tagSet].sort();
        renderRedoFilterTags();

        // 再战区数量
        const rematchCount = redoAllRecords.filter(r => (r.wrong_count || 0) > 0).length;
        const rc = el('redoRematchCount');
        if (rc) {
            rc.textContent = `再战 ${rematchCount} 道`;
            rc.classList.toggle('hidden', rematchCount === 0);
        }
        // 艾宾浩斯遗忘曲线可视化
        renderEbbinghausChart();
        updateEbbinghausStats();
    }

    // 填充教材级联下拉（学段 → 章节 → 知识点）
    function populateRedoCategoryDropdowns() {
        const comp = el('redoFilterCompulsory');
        const chap = el('redoFilterChapter');
        const know = el('redoFilterKnowledge');
        if (!comp || !chap || !know) return;

        const prevComp = comp.value;
        comp.innerHTML = '<option value="">所有学段</option>';
        Object.keys(redoCatTree).forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            comp.appendChild(opt);
        });
        if (prevComp && redoCatTree[prevComp]) comp.value = prevComp;

        if (!redoCatBound) {
            redoCatBound = true;
            comp.onchange = () => {
                const c = comp.value;
                chap.innerHTML = '<option value="">所有章节</option>';
                know.innerHTML = '<option value="">所有知识点</option>';
                chap.disabled = !c;
                know.disabled = true;
                if (c && redoCatTree[c]) {
                    Object.keys(redoCatTree[c]).forEach(ch => {
                        const opt = document.createElement('option');
                        opt.value = ch;
                        opt.textContent = ch;
                        chap.appendChild(opt);
                    });
                }
            };
            chap.onchange = () => {
                const c = comp.value;
                const ch = chap.value;
                know.innerHTML = '<option value="">所有知识点</option>';
                know.disabled = !ch;
                if (ch && redoCatTree[c] && redoCatTree[c][ch]) {
                    (redoCatTree[c][ch] || []).forEach(k => {
                        const opt = document.createElement('option');
                        opt.value = k;
                        opt.textContent = k;
                        know.appendChild(opt);
                    });
                }
            };
        } else {
            // 重新填充后恢复级联状态
            if (comp.value) comp.onchange();
        }
        chap.disabled = !comp.value;
        know.disabled = true;
    }

    // 标签 chips 渲染
    function renderRedoFilterTags() {
        const container = el('redoFilterTags');
        const clearBtn = el('redoClearTagsBtn');
        if (!container) return;
        if (redoAllTags.length === 0) {
            container.innerHTML = '<span class="text-[10px] text-slate-600 dark:text-slate-400">错题本暂无标签</span>';
            if (clearBtn) clearBtn.classList.add('hidden');
            return;
        }
        container.innerHTML = '';
        redoAllTags.forEach(tag => {
            const chip = document.createElement('button');
            chip.type = 'button';
            const selected = redoSelectedTags.has(tag);
            chip.className = selected
                ? 'text-[10px] font-bold text-brand-600 bg-brand-50 border border-brand-300 px-2 py-0.5 rounded-full transition-all active:scale-95'
                : 'text-[10px] font-medium text-slate-500 bg-white border border-slate-200 hover:border-brand-300 hover:text-brand-600 px-2 py-0.5 rounded-full transition-all active:scale-95';
            chip.textContent = tag;
            chip.onclick = () => {
                if (redoSelectedTags.has(tag)) {
                    redoSelectedTags.delete(tag);
                } else {
                    redoSelectedTags.add(tag);
                }
                renderRedoFilterTags();
            };
            container.appendChild(chip);
        });
        if (clearBtn) clearBtn.classList.toggle('hidden', redoSelectedTags.size === 0);
    }

    window.clearRedoFilterTags = function () {
        redoSelectedTags = new Set();
        renderRedoFilterTags();
    };

    window.resetRedoFilter = function () {
        redoSelectedTags = new Set();
        const comp = el('redoFilterCompulsory');
        const chap = el('redoFilterChapter');
        const know = el('redoFilterKnowledge');
        if (comp) comp.value = '';
        if (chap) { chap.innerHTML = '<option value="">所有章节</option>'; chap.disabled = true; }
        if (know) { know.innerHTML = '<option value="">所有知识点</option>'; know.disabled = true; }
        renderRedoFilterTags();
    };

    // 筛选复习：按当前条件构建队列并直接进入刷题
    window.startRedoCustom = function () {
        if (!redoListLoaded || !redoCatLoaded) {
            pendingRedoMode = 'custom';
            loadRedoPanelData();
            return;
        }
        const records = buildRedoQueue(redoAllRecords, 'custom');
        startRedoQueue(records, 'custom', 'noresult');
        updateRedoModeButtons();
    };

    // 再战区：答错过的题目
    window.startRedoRematch = function () {
        if (!redoListLoaded || !redoCatLoaded) {
            pendingRedoMode = 'rematch';
            loadRedoPanelData();
            return;
        }
        const records = buildRedoQueue(redoAllRecords, 'rematch');
        startRedoQueue(records, 'rematch', 'noresult');
        updateRedoModeButtons();
    };


    // ==========================================
    //      复习模式切换（面板常驻）
    // ==========================================
    let pendingRedoMode = null;         // 数据未就绪时暂存用户选择的模式

    // 模式按钮高亮同步
    function updateRedoModeButtons() {
        ['daily', 'custom', 'rematch'].forEach(mode => {
            const btn = el(`redoModeBtn-${mode}`);
            if (!btn) return;
            const active = redoMode === mode;
            btn.classList.toggle('bg-brand-50', active);
            btn.classList.toggle('text-brand-600', active);
            btn.classList.toggle('border', active);
            btn.classList.toggle('border-brand-200', active);
            btn.classList.toggle('dark:bg-brand-500/10', active);
            btn.classList.toggle('dark:text-brand-300', active);
            btn.classList.toggle('dark:border-brand-500/30', active);
            btn.classList.toggle('text-slate-600', !active);
            btn.classList.toggle('hover:bg-slate-100', !active);
            btn.classList.toggle('dark:text-slate-300', !active);
            btn.classList.toggle('dark:hover:bg-slate-800', !active);
        });
    }

    // 执行指定模式（前提：面板数据已就绪）
    function executeRedoMode(mode) {
        if (mode === 'daily') {
            enterRedoWorkspace();
        } else if (mode === 'custom') {
            const records = buildRedoQueue(redoAllRecords, 'custom');
            startRedoQueue(records, 'custom', 'noresult');
        } else if (mode === 'rematch') {
            const records = buildRedoQueue(redoAllRecords, 'rematch');
            startRedoQueue(records, 'rematch', 'noresult');
        }
        updateRedoModeButtons();
    }

    // 切换复习模式（面板按钮）
    window.switchRedoMode = function (mode) {
        if (!redoListLoaded || !redoCatLoaded) {
            pendingRedoMode = mode;
            loadRedoPanelData();
            return;
        }
        executeRedoMode(mode);
    };

    // 刷新面板计数（每日待重做 / 再战区数量）
    function updateRedoPanelCounts() {
        const dueCount = redoAllRecords.filter(r => !!r.due && !r.mastered).length;
        const rematchCount = redoAllRecords.filter(r => (r.wrong_count || 0) > 0).length;
        const dailyBadge = el('redoModeCount-daily');
        if (dailyBadge) {
            dailyBadge.textContent = dueCount;
            dailyBadge.classList.toggle('hidden', dueCount === 0);
        }
        const rematchBadge = el('redoModeCount-rematch');
        if (rematchBadge) {
            rematchBadge.textContent = rematchCount;
            rematchBadge.classList.toggle('hidden', rematchCount === 0);
        }
        const rc = el('redoRematchCount');
        if (rc) {
            rc.textContent = `再战 ${rematchCount} 道`;
            rc.classList.toggle('hidden', rematchCount === 0);
        }
        updateEbbinghausStats();
    }

    // ==========================================
    //      艾宾浩斯遗忘曲线可视化
    // ==========================================

    // 复习间隔（天）与每段衰减终点保持率（复习越多，遗忘越慢）
    const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30];
    const EBBINGHAUS_KEEP = [0.40, 0.50, 0.58, 0.64, 0.68, 0.70];

    // 生成遗忘曲线 SVG（锯齿状：每次重做后保持率回升）
    function renderEbbinghausChart() {
        const container = el('redoEbbinghausChart');
        if (!container) return;

        const W = 300, H = 150;
        const padL = 20, padR = 20, padT = 16, padB = 32;
        const top = padT, bottom = H - padB;
        // 节点数 = 初始 + 6 次复习 = 7
        const N = EBBINGHAUS_INTERVALS.length + 1;
        const step = (W - padL - padR) / (N - 1);

        const xs = Array.from({ length: N }, (_, i) => padL + i * step);
        const ys = EBBINGHAUS_KEEP.map(k => top + (1 - k) * (bottom - top));

        const gridColor = 'rgba(148,163,184,0.35)';
        const curveColor = '#8b5cf6';
        const riseColor = '#10b981';
        const textColor = '#64748b';

        let svg = `<svg viewBox="0 0 ${W} ${H}" class="w-full" xmlns="http://www.w3.org/2000/svg">`;

        // 网格线（25% / 50% / 75% / 100%）
        [0.25, 0.5, 0.75].forEach(k => {
            const y = top + k * (bottom - top);
            svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${gridColor}" stroke-width="0.6" stroke-dasharray="3 3"/>`;
        });
        svg += `<line x1="${padL}" y1="${top}" x2="${W - padR}" y2="${top}" stroke="${gridColor}" stroke-width="0.8"/>`;
        // Y 轴标注
        svg += `<text x="2" y="${top + 3}" font-size="7" fill="${textColor}">100%</text>`;
        svg += `<text x="8" y="${bottom + 3}" font-size="7" fill="${textColor}">0%</text>`;

        // 每段衰减曲线 + 复习回升线
        for (let i = 0; i < N; i++) {
            const x0 = xs[i];
            if (i < N - 1) {
                const y1 = ys[i];
                // 遗忘段: 从 (x0, top) 平滑衰减到 (x1, y1)（先快后慢）
                const x1 = xs[i + 1];
                const c1x = x0 + step * 0.35, c2x = x1 - step * 0.45;
                svg += `<path d="M ${x0} ${top} C ${c1x} ${top}, ${c2x} ${y1}, ${x1} ${y1}" fill="none" stroke="${curveColor}" stroke-width="1.8" stroke-linecap="round"/>`;
                // 复习回升线（虚线）：从衰减终点回到 100%
                svg += `<line x1="${x1}" y1="${y1}" x2="${x1}" y2="${top}" stroke="${riseColor}" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.85"/>`;
            }
            // 复习节点圆点
            svg += `<circle cx="${x0}" cy="${top}" r="3" fill="${curveColor}"/>`;
            // 底部节点标签
            let label = '初始';
            if (i > 0) {
                label = `第${i}次·${EBBINGHAUS_INTERVALS[i - 1]}天`;
            }
            svg += `<text x="${x0}" y="${H - 14}" font-size="7.5" fill="${textColor}" text-anchor="middle">${label}</text>`;
            if (i === N - 1) {
                svg += `<text x="${x0}" y="${H - 3}" font-size="7" fill="${textColor}" text-anchor="middle">✓ 已掌握</text>`;
            }
        }

        svg += '</svg>';
        container.innerHTML = svg;
    }

    // 阶段分布柱状图 + 摘要（从 redoAllRecords 统计）
    function updateEbbinghausStats() {
        const stages = el('redoEbbinghausStages');
        const summary = el('redoEbbinghausSummary');
        if (!stages || !summary) return;

        const total = redoAllRecords.length;
        const mastered = redoAllRecords.filter(r => !!r.mastered).length;
        const counts = EBBINGHAUS_INTERVALS.map((_, idx) =>
            redoAllRecords.filter(r => !r.mastered && (r.stage || 0) === idx).length
        );
        const maxCount = Math.max(1, ...counts, mastered);

        summary.textContent = `共 ${total} 道 · 已掌握 ${mastered} 道`;

        const barColors = ['bg-violet-200', 'bg-violet-300', 'bg-violet-400', 'bg-violet-500', 'bg-violet-600', 'bg-violet-700'];
        stages.innerHTML = '';
        for (let i = 0; i < EBBINGHAUS_INTERVALS.length; i++) {
            const count = counts[i];
            const h = count > 0 ? Math.max(6, Math.round((count / maxCount) * 52)) : 3;
            stages.innerHTML += `
                <div class="flex-1 flex flex-col items-center justify-end gap-0.5 min-w-0" title="第 ${i + 1} 次复习阶段：${count} 道">
                    <span class="text-[8px] font-bold ${count > 0 ? 'text-slate-700 dark:text-slate-300' : 'text-slate-300 dark:text-slate-600'}">${count}</span>
                    <div class="w-full rounded-t ${barColors[i]} ${count === 0 ? 'opacity-25' : ''}" style="height: ${h}px"></div>
                    <span class="text-[8px] text-slate-500 dark:text-slate-500">第${i + 1}次</span>
                </div>`;
        }
        const mh = mastered > 0 ? Math.max(6, Math.round((mastered / maxCount) * 52)) : 3;
        stages.innerHTML += `
            <div class="flex-1 flex flex-col items-center justify-end gap-0.5 min-w-0" title="已掌握：${mastered} 道">
                <span class="text-[8px] font-bold ${mastered > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-300 dark:text-slate-600'}">${mastered}</span>
                <div class="w-full rounded-t bg-emerald-500 ${mastered === 0 ? 'opacity-25' : ''}" style="height: ${mh}px"></div>
                <span class="text-[8px] text-slate-500 dark:text-slate-500">✓掌握</span>
            </div>`;
    }

    // ==========================================
    //      刷题计时(按题自动计时) + 左侧面板折叠
    // ==========================================
    let redoQuestionStartMs = 0;     // 当前题开始时刻(performance.now)
    let redoPausedTotalMs = 0;       // 累计暂停毫秒
    let redoPausedStartMs = null;    // 暂停起始时刻(null=未暂停)
    let redoTimerInterval = null;    // 显示刷新 interval
    let redoSessionResults = [];     // 本次刷题每题结果(结算用)

    function formatRedoTimer(sec) {
        const h = String(Math.floor(sec / 3600)).padStart(2, '0');
        const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    // 当前题已用秒数(暂停期间不计)
    function currentRedoSeconds() {
        let ms = performance.now() - redoQuestionStartMs - redoPausedTotalMs;
        if (redoPausedStartMs !== null) {
            ms -= (performance.now() - redoPausedStartMs);
        }
        return Math.max(0, Math.floor(ms / 1000));
    }

    function updateRedoTimerText() {
        const t = el('redoTimerText');
        if (t) t.textContent = formatRedoTimer(currentRedoSeconds());
    }

    function setRedoTimerPausedUI(paused) {
        const btn = el('redoTimerToggleBtn');
        if (!btn) return;
        btn.title = paused ? '继续计时' : '暂停计时';
        btn.innerHTML = paused
            ? '<i class="fa-solid fa-play text-[9px]"></i>'
            : '<i class="fa-solid fa-pause text-[9px]"></i>';
    }

    // 自动开始当前题计时(渲染题目时调用)
    function startRedoTimerForQuestion() {
        redoQuestionStartMs = performance.now();
        redoPausedTotalMs = 0;
        redoPausedStartMs = null;
        if (!redoTimerInterval) {
            redoTimerInterval = setInterval(updateRedoTimerText, 1000);
        }
        updateRedoTimerText();
        setRedoTimerPausedUI(false);
    }

    // 暂停/继续当前题计时
    window.redoStartPause = function () {
        if (redoPausedStartMs !== null) {
            // 继续
            redoPausedTotalMs += performance.now() - redoPausedStartMs;
            redoPausedStartMs = null;
            setRedoTimerPausedUI(false);
        } else {
            // 暂停
            redoPausedStartMs = performance.now();
            setRedoTimerPausedUI(true);
        }
        updateRedoTimerText();
    };

    // 重置当前题计时
    window.redoResetTimer = function () {
        redoQuestionStartMs = performance.now();
        redoPausedTotalMs = 0;
        redoPausedStartMs = null;
        updateRedoTimerText();
        setRedoTimerPausedUI(false);
    };

    // 记录本题结果(答对/答错后调用, 用于结算)
    function recordRedoResult(record, qid, correct) {
        const q = record.question || {};
        // 题干摘要(去公式符号)
        const title = (q.content || '')
            .replace(/\\[a-zA-Z]+/g, '')
            .replace(/\$+/g, '')
            .replace(/[{}]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
        redoSessionResults.push({
            qid: qid,
            seq: record.seq_num || qid,
            title: title || '[空白题干]',
            correct: !!correct,
            seconds: currentRedoSeconds(),
            nextReviewAt: null,
            nextReviewDays: null
        });
    }

    // 结算明细 HTML(每题: 对错/用时/复习时间)
    function renderRedoResultsHtml() {
        if (!redoSessionResults.length) return '';
        const rows = redoSessionResults.map(r => {
            const icon = r.correct
                ? '<span class="text-emerald-600 shrink-0"><i class="fa-solid fa-circle-check"></i></span>'
                : '<span class="text-red-500 shrink-0"><i class="fa-solid fa-circle-xmark"></i></span>';
            const timeStr = r.seconds >= 60
                ? `${Math.floor(r.seconds / 60)}分${r.seconds % 60}秒`
                : `${r.seconds}秒`;
            const reviewStr = r.correct
                ? (r.nextReviewDays !== null && r.nextReviewDays !== undefined ? `${r.nextReviewDays} 天后` : '已掌握')
                : '明天重做';
            return `
                <div class="flex items-center gap-2 py-1.5 border-b border-slate-100/60 dark:border-slate-700/40 last:border-0">
                    ${icon}
                    <span class="text-[10px] font-bold text-slate-500 dark:text-slate-400 shrink-0">#${r.seq}</span>
                    <span class="flex-1 text-[10px] text-slate-700 dark:text-slate-300 truncate min-w-0">${r.title}</span>
                    <span class="text-[10px] text-slate-500 dark:text-slate-400 shrink-0">${timeStr}</span>
                    <span class="text-[10px] font-bold ${r.correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'} shrink-0">${reviewStr}</span>
                </div>`;
        }).join('');
        return `
            <div class="mt-5 w-full max-h-72 overflow-y-auto custom-scrollbar rounded-xl border border-slate-200/70 bg-white/50 dark:border-slate-700/60 dark:bg-slate-800/40 p-2.5 text-left">
                <div class="text-[10px] font-bold text-slate-500 dark:text-slate-400 mb-1.5 flex items-center space-x-1">
                    <i class="fa-solid fa-list-check text-[9px]"></i><span>本次明细（${redoSessionResults.length} 题）</span>
                </div>
                ${rows}
            </div>`;
    }

    // 折叠/展开左侧面板（自定义复习面板），状态记忆
    function updateRedoPanelBtnUI(hidden) {
        const btn = el('redoPanelToggleBtn');
        const icon = el('redoPanelToggleIcon');
        const text = el('redoPanelToggleText');
        if (!btn) return;
        btn.title = hidden ? '展开自定义复习（筛选/再战区/艾宾浩斯曲线）' : '收起自定义复习面板';
        if (icon) icon.className = 'fa-solid fa-sliders text-[11px]';
        if (text) text.textContent = hidden ? '自定义复习' : '收起面板';
        if (hidden) {
            // 收起态: 实心品牌色(醒目入口)
            btn.className = 'text-xs font-bold px-3.5 py-2 rounded-lg flex items-center space-x-1.5 transition-all active:scale-95 text-white bg-brand-500 hover:bg-brand-600 shadow-sm dark:bg-brand-600 dark:hover:bg-brand-500';
        } else {
            // 展开态: 低调描边
            btn.className = 'text-xs font-bold px-3.5 py-2 rounded-lg flex items-center space-x-1.5 transition-all active:scale-95 text-brand-600 bg-brand-50 border border-brand-200 hover:bg-brand-100 dark:text-brand-300 dark:bg-brand-500/10 dark:border-brand-500/30';
        }
    }

    window.toggleRedoPanel = function () {
        const panel = el('redoPanel');
        if (!panel) return;
        const hidden = panel.classList.toggle('hidden');
        updateRedoPanelBtnUI(hidden);
        try {
            localStorage.setItem('mathbank_redo_panel_hidden', hidden ? '1' : '0');
        } catch (e) {}
    };

    // 页面加载时恢复面板折叠状态
    (function restoreRedoPanelState() {
        try {
            if (localStorage.getItem('mathbank_redo_panel_hidden') === '1') {
                const panel = el('redoPanel');
                if (panel) panel.classList.add('hidden');
                updateRedoPanelBtnUI(true);
            } else {
                updateRedoPanelBtnUI(false);
            }
        } catch (e) {}
    })();


})();
