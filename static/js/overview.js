// ==========================================
//      题库总览工作台 (购物式列表 + 题目详情)
// ==========================================
(function () {
    'use strict';

    let overviewQuestions = [];

    function el(id) {
        return document.getElementById(id);
    }

    // 进入工作台: 加载全部题目并渲染列表
    window.enterOverviewWorkspace = function () {
        const list = el('overviewList');
        const detail = el('overviewDetail');
        if (list) list.innerHTML = '<div class="p-6 text-center text-slate-500 dark:text-slate-400 text-sm"><i class="fa-solid fa-circle-notch animate-spin mb-2 text-brand-500"></i><p>正在加载题库...</p></div>';
        if (detail) detail.classList.add('hidden');
        const backBtn = el('overviewBackBtn');
        if (backBtn) backBtn.classList.add('hidden');
        const search = el('overviewSearch');
        if (search) search.value = '';

        fetch('/api/questions')
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(questions => {
                overviewQuestions = questions || [];
                renderOverviewList('');
            })
            .catch(err => {
                console.error('加载题库总览失败:', err);
                if (list) {
                    list.innerHTML = `
                        <div class="p-6 text-center text-red-500 text-xs">
                            <i class="fa-solid fa-triangle-exclamation text-2xl mb-1"></i>
                            <p class="font-semibold">加载题库失败</p>
                            <button onclick="enterOverviewWorkspace()" class="mt-2 px-3.5 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 font-bold rounded-xl transition-all border border-red-200 text-[10px]">
                                <i class="fa-solid fa-arrows-rotate mr-1"></i>重新加载
                            </button>
                        </div>`;
                }
            });
    };

    // 渲染列表行(购物软件风格: 一行一条, 点击进详情)
    function renderOverviewList(filter) {
        const container = el('overviewList');
        if (!container) return;
        const kw = (filter || '').trim().toLowerCase();
        const items = overviewQuestions.filter(q => {
            if (!kw) return true;
            return (q.content || '').toLowerCase().includes(kw) ||
                (q.source || '').toLowerCase().includes(kw) ||
                (q.tags || '').toLowerCase().includes(kw) ||
                (q.category_knowledge || '').toLowerCase().includes(kw) ||
                (q.category_chapter || '').toLowerCase().includes(kw);
        });

        const count = el('overviewCount');
        if (count) count.textContent = `共 ${overviewQuestions.length} 题${kw ? ` · 匹配 ${items.length} 题` : ''}`;

        if (items.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-slate-400 text-xs">
                    <i class="fa-solid fa-box-open text-2xl mb-1"></i>
                    <p>没有匹配的题目</p>
                </div>`;
            return;
        }

        container.innerHTML = '';
        items.forEach(q => {
            const row = document.createElement('div');
            row.className = 'glass-panel rounded-xl px-4 py-2.5 flex items-center gap-3 cursor-pointer transition-all hover:shadow-md active:scale-[0.995]';
            const summary = (q.content || '')
                .replace(/\\[a-zA-Z]+/g, '')
                .replace(/\$+/g, '')
                .replace(/[{}]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            const typeText = getTypeText(q.question_type);
            const diffBadge = getDifficultyBadge(q.difficulty);
            row.innerHTML = `
                <span class="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-brand-50 text-brand-600 shrink-0">#${q.seq_num || q.id}</span>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300 shrink-0">${typeText}</span>
                <span class="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 truncate">${summary || '[空白题干]'}</span>
                <span class="hidden md:inline text-[10px] text-slate-500 dark:text-slate-400 truncate max-w-[140px] shrink-0">${q.category_knowledge || q.category_chapter || ''}</span>
                ${diffBadge}
                <i class="fa-solid fa-chevron-right text-[10px] text-slate-300 dark:text-slate-600 shrink-0"></i>
            `;
            row.onclick = () => openOverviewDetail(q.id);
            container.appendChild(row);
        });
    }

    // 打开详情
    function openOverviewDetail(qid) {
        const list = el('overviewList');
        const detail = el('overviewDetail');
        const backBtn = el('overviewBackBtn');
        if (list) list.classList.add('hidden');
        if (detail) {
            detail.classList.remove('hidden');
            detail.innerHTML = '<div class="p-6 text-center text-slate-500 dark:text-slate-400 text-sm"><i class="fa-solid fa-circle-notch animate-spin mb-2 text-brand-500"></i><p>正在加载题目详情...</p></div>';
        }
        if (backBtn) backBtn.classList.remove('hidden');
        fetch(`/api/questions/${qid}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(q => renderOverviewDetail(q))
            .catch(err => {
                console.error('加载题目详情失败:', err);
                if (detail) detail.innerHTML = '<div class="p-6 text-center text-red-500 text-xs">加载详情失败，请重试</div>';
            });
    }

    function renderOverviewDetail(q) {
        const detail = el('overviewDetail');
        if (!detail) return;

        let contentHtml = '';
        try {
            contentHtml = parseMarkdownWithMath(q.content || '');
        } catch (e) {
            contentHtml = '<p class="text-red-500 text-xs">题干渲染失败</p>';
        }
        let answerHtml = '';
        if (q.answer_markdown && q.answer_markdown.trim()) {
            try {
                answerHtml = parseMarkdownWithMath(q.answer_markdown);
            } catch (e) {
                answerHtml = '<p class="text-red-500 text-xs">答案渲染失败</p>';
            }
        }
        const images = q.image_paths || [];
        const imagesHtml = images.length > 0
            ? images.map(p => `
                <div class="flex justify-center">
                    <img src="${p}" alt="插图" class="max-w-full max-h-96 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm object-contain bg-white" loading="lazy">
                </div>`).join('')
            : '';
        const diffBadge = getDifficultyBadge(q.difficulty);
        const inBook = wrongQuestionIds.has(q.id);

        detail.innerHTML = `
            <div class="max-w-3xl mx-auto space-y-4 pb-8">
                <div class="glass-panel rounded-2xl p-5 sm:p-6 space-y-3">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-brand-50 text-brand-600">#${q.seq_num || q.id}</span>
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300">${getTypeText(q.question_type)}</span>
                        ${diffBadge}
                        ${q.source ? `<span class="text-[10px] text-slate-500 dark:text-slate-400">${q.source}</span>` : ''}
                        <button onclick="overviewToggleWrongBook(${q.id})" id="overviewWrongBookBtn" class="ml-auto text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all active:scale-95 ${inBook ? 'text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30' : 'text-amber-700 bg-amber-50 border border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/30'}">
                            ${inBook ? '<i class="fa-solid fa-book-bookmark mr-0.5"></i>已在错题本' : '<i class="fa-solid fa-book-medical mr-0.5"></i>加入错题本'}
                        </button>
                    </div>
                    <div class="text-sm leading-relaxed text-slate-800 dark:text-slate-100 formula-render">${contentHtml}</div>
                    ${imagesHtml}
                </div>
                ${q.answer_markdown && q.answer_markdown.trim() ? `
                <div class="glass-panel rounded-2xl p-5 sm:p-6">
                    <div class="text-xs font-bold text-slate-500 dark:text-slate-400 mb-2.5 flex items-center space-x-1.5">
                        <i class="fa-solid fa-lightbulb text-amber-400"></i><span>答案与解析</span>
                    </div>
                    <div class="text-sm leading-relaxed text-slate-700 dark:text-slate-200 formula-render">${answerHtml}</div>
                </div>` : ''}
                ${q.review && q.review.trim() ? `
                <div class="glass-panel rounded-2xl p-5 sm:p-6">
                    <div class="text-xs font-bold text-slate-500 dark:text-slate-400 mb-2.5 flex items-center space-x-1.5">
                        <i class="fa-solid fa-comment text-slate-400"></i><span>评述</span>
                    </div>
                    <div class="text-sm leading-relaxed text-slate-700 dark:text-slate-200 formula-render">${q.review}</div>
                </div>` : ''}
                <div class="glass-panel rounded-2xl px-5 py-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
                    <span><i class="fa-solid fa-folder-open mr-0.5"></i>${q.category_compulsory || '未分类'}${q.category_chapter ? ' / ' + q.category_chapter : ''}${q.category_knowledge ? ' / ' + q.category_knowledge : ''}</span>
                    ${q.tags ? `<span><i class="fa-solid fa-tag mr-0.5"></i>${q.tags}</span>` : ''}
                    <span><i class="fa-regular fa-clock mr-0.5"></i>${formatChineseDate(q.created_at)}</span>
                </div>
            </div>`;

        try {
            renderMathInElement(detail, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ],
                throwOnError: false
            });
        } catch (e) {
            console.error('KaTeX overview rendering error: ', e);
        }
    }

    // 返回列表
    window.overviewBackToList = function () {
        const list = el('overviewList');
        const detail = el('overviewDetail');
        const backBtn = el('overviewBackBtn');
        if (list) list.classList.remove('hidden');
        if (detail) detail.classList.add('hidden');
        if (backBtn) backBtn.classList.add('hidden');
    };

    // 详情页 加入/移出错题本
    window.overviewToggleWrongBook = function (qid) {
        const btn = el('overviewWrongBookBtn');
        const markIn = () => {
            if (btn) {
                btn.className = 'ml-auto text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all active:scale-95 text-emerald-700 bg-emerald-50 border border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30';
                btn.innerHTML = '<i class="fa-solid fa-book-bookmark mr-0.5"></i>已在错题本';
            }
        };
        const markOut = () => {
            if (btn) {
                btn.className = 'ml-auto text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all active:scale-95 text-amber-700 bg-amber-50 border border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/30';
                btn.innerHTML = '<i class="fa-solid fa-book-medical mr-0.5"></i>加入错题本';
            }
        };

        if (wrongQuestionIds.has(qid)) {
            fetch(`/api/wrong-questions/${qid}`, { method: 'DELETE' })
                .then(r => r.json())
                .then(res => {
                    if (res.status === 'ok') {
                        wrongQuestionIds.delete(qid);
                        markOut();
                        refreshWrongBadge();
                        showToast('已移出错题本', 'info');
                    } else {
                        showToast(res.message || '移出错题本失败', 'error');
                    }
                })
                .catch(() => showToast('移出错题本失败，请检查后台服务', 'error'));
        } else {
            fetch('/api/wrong-questions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question_id: qid })
            })
                .then(r => r.json())
                .then(res => {
                    if (res.status === 'ok' && res.record) {
                        wrongQuestionIds.add(qid);
                        markIn();
                        refreshWrongBadge();
                        showToast('已加入错题本，按艾宾浩斯曲线从明天开始第 1 次重做');
                    } else {
                        showToast(res.message || '加入错题本失败', 'error');
                    }
                })
                .catch(() => showToast('加入错题本失败，请检查后台服务', 'error'));
        }
    };

    // 搜索(本地过滤 + debounce)
    document.addEventListener('DOMContentLoaded', () => {
        const search = el('overviewSearch');
        if (search) {
            search.addEventListener('input', debounce(() => renderOverviewList(search.value), 250));
        }
    });

})();
