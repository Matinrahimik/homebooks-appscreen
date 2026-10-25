/**
 * Live project sync and headless render mode.
 *
 * ?project=<id>&key=<editKey> loads the Worker backup JSON (the same shape as
 * Export/Import Project Backup) and debounced-saves edits back.
 * Optional &api=<origin> overrides the Worker origin.
 * &render=<index|all> hides the chrome and exposes window.__appscreen so a
 * headless browser can read the canvas at the real output pixel size.
 *
 * Without those parameters this file does not change editor behaviour.
 */
(function () {
    var DEFAULT_API = 'https://homebooks-appscreen-mcp.matinrahimi.workers.dev';
    var params = new URLSearchParams(location.search);
    var projectId = params.get('project');
    var editKey = params.get('key');
    var renderParam = params.get('render');

    function sanitizeApi(raw) {
        if (!raw) return DEFAULT_API;
        try {
            var url = new URL(raw);
        } catch (e) {
            return DEFAULT_API;
        }
        var host = url.hostname;
        var local = host === 'localhost' || host === '127.0.0.1';
        if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) {
            return url.origin;
        }
        return DEFAULT_API;
    }

    var apiBase = sanitizeApi(params.get('api'));
    var live = Boolean(projectId && editKey);
    var renderTarget = null;
    if (renderParam !== null) {
        if (renderParam === 'all') renderTarget = 'all';
        else if (/^\d+$/.test(renderParam)) renderTarget = Number(renderParam);
        else renderTarget = 'invalid';
    }

    var expectedScreenshots = 0;
    var pullFailed = false;
    var pullDone = false;
    var hydrated = false;
    var acceptPushes = false;
    var latestRecord = null;
    var pushTimer = null;
    var checking = false;

    function isLive() { return live; }
    function isRenderMode() { return renderTarget !== null; }
    function renderIndex() { return renderTarget; }

    function showLiveStatus(text) {
        if (!live || isRenderMode()) return;
        var el = document.getElementById('live-sync-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'live-sync-status';
            el.className = 'live-sync-status';
            var header = document.querySelector('.sidebar .sidebar-header');
            if (header) header.appendChild(el);
            else document.body.appendChild(el);
        }
        el.textContent = text;
    }

    function markError(message) {
        window.__appscreenError = message;
        document.documentElement.dataset.appscreenStatus = 'error';
        document.documentElement.dataset.appscreenError = message;
    }

    function markReady() {
        window.__appscreenReady = true;
        document.documentElement.dataset.appscreenStatus = 'ready';
        if (typeof canvas !== 'undefined' && canvas) {
            document.documentElement.dataset.appscreenWidth = String(canvas.width);
            document.documentElement.dataset.appscreenHeight = String(canvas.height);
        }
    }

    function idbGet(database, storeName, key) {
        return new Promise(function (resolve, reject) {
            var tx = database.transaction(storeName, 'readonly');
            var req = tx.objectStore(storeName).get(key);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbPut(database, storeName, value) {
        return new Promise(function (resolve, reject) {
            var tx = database.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(value);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    }

    function projectNameFromDump(dump, id) {
        var meta = (dump.meta || []).find(function (m) { return m.key === 'projects'; });
        var list = meta && Array.isArray(meta.value) ? meta.value : [];
        var entry = list.find(function (p) { return p.id === id; }) || list[0];
        return (entry && entry.name) || 'Live project';
    }

    async function mergeIntoDb(database, dump, record, id) {
        await idbPut(database, 'projects', record);
        var existing = await idbGet(database, 'meta', 'projects');
        var list = existing && Array.isArray(existing.value) ? existing.value.slice() : [];
        var name = projectNameFromDump(dump, id);
        var count = Array.isArray(record.screenshots) ? record.screenshots.length : 0;
        var entry = { id: id, name: name, screenshotCount: count };
        var idx = list.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) list[idx] = Object.assign({}, list[idx], entry);
        else list.push(entry);
        await idbPut(database, 'meta', { key: 'projects', value: list });
        await idbPut(database, 'meta', { key: 'currentProject', value: id });
    }

    async function pull(database) {
        if (!live) return;
        showLiveStatus('Loading live project…');
        var res;
        try {
            res = await fetch(apiBase + '/api/projects/' + encodeURIComponent(projectId), {
                headers: { 'X-Edit-Key': editKey, 'Accept': 'application/json' }
            });
        } catch (e) {
            pullFailed = true;
            var offline = 'Could not reach the screenshot API';
            showLiveStatus(offline);
            if (isRenderMode()) markError(offline);
            return;
        }
        if (!res.ok) {
            pullFailed = true;
            var failed = 'Live project failed to load (' + res.status + ')';
            showLiveStatus(failed);
            if (isRenderMode()) markError(failed);
            return;
        }
        var dump;
        try {
            dump = await res.json();
        } catch (e) {
            pullFailed = true;
            markError('Live project response was not JSON');
            showLiveStatus('Live project response was not JSON');
            return;
        }
        var record = (dump.projects || []).find(function (p) { return p && p.id === projectId; }) || (dump.projects || [])[0];
        if (!record) {
            pullFailed = true;
            markError('Backup has no project');
            showLiveStatus('Backup has no project');
            return;
        }
        record.id = projectId;
        expectedScreenshots = Array.isArray(record.screenshots) ? record.screenshots.length : 0;
        if (!database) {
            pullFailed = true;
            markError('IndexedDB is unavailable');
            showLiveStatus('IndexedDB is unavailable');
            return;
        }
        await mergeIntoDb(database, dump, record, projectId);
        pullDone = true;
        showLiveStatus('Live');
    }

    function screenshotsReady(record) {
        var shots = record.screenshots || [];
        if (shots.length < expectedScreenshots) return false;
        for (var i = 0; i < expectedScreenshots; i++) {
            if (!shots[i]) return false;
        }
        return true;
    }

    function buildBackup(record) {
        var copy = JSON.parse(JSON.stringify(record));
        copy.id = projectId;
        var metaProject = (typeof projects !== 'undefined' ? projects : []).find(function (p) { return p.id === projectId; });
        var name = metaProject && metaProject.name ? metaProject.name : 'Live project';
        return {
            projects: [copy],
            meta: [
                { key: 'projects', value: [{ id: projectId, name: name, screenshotCount: (copy.screenshots || []).length }] },
                { key: 'currentProject', value: projectId }
            ]
        };
    }

    async function pushNow() {
        if (!latestRecord || !live || pullFailed || isRenderMode()) return;
        if (typeof currentProjectId !== 'undefined' && currentProjectId !== projectId) {
            showLiveStatus('Live sync paused');
            return;
        }
        var body = JSON.stringify(buildBackup(latestRecord));
        showLiveStatus('Saving…');
        try {
            var res = await fetch(apiBase + '/api/projects/' + encodeURIComponent(projectId), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Edit-Key': editKey
                },
                body: body
            });
            if (!res.ok) {
                showLiveStatus('Save failed (' + res.status + ')');
                return;
            }
            showLiveStatus('Live · saved');
        } catch (e) {
            showLiveStatus('Save failed');
        }
    }

    function schedulePush() {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(pushNow, 800);
        showLiveStatus('Saving…');
    }

    function onSaved(record) {
        if (!live || isRenderMode() || pullFailed || !pullDone) return;
        if (typeof currentProjectId !== 'undefined' && currentProjectId !== projectId) {
            showLiveStatus('Live sync paused');
            return;
        }
        if (!screenshotsReady(record)) return;
        latestRecord = record;
        hydrated = true;
        if (!acceptPushes) return;
        schedulePush();
    }

    function shouldSkipPersist(record) {
        return live && pullDone && !pullFailed && !screenshotsReady(record);
    }

    function finishHydration() {
        if (!live || isRenderMode() || pullFailed || !pullDone) return;
        var check = function () {
            if (!hydrated && expectedScreenshots > 0 && !pullFailed) {
                setTimeout(check, 50);
                return;
            }
            setTimeout(function () {
                if (pullFailed) return;
                acceptPushes = true;
                if (latestRecord && screenshotsReady(latestRecord)) schedulePush();
                else showLiveStatus('Live');
            }, 200);
        };
        check();
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function quotedFonts(value) {
        if (!value || typeof value !== 'string') return [];
        var found = [];
        var re = /'([^']+)'/g;
        var match;
        while ((match = re.exec(value))) found.push(match[1]);
        if (found.length === 0 && value.indexOf(',') === -1 && value.indexOf('-apple-') === -1) {
            found.push(value.trim());
        }
        return found;
    }

    async function waitForScreenshots() {
        var deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (pullFailed) throw new Error(window.__appscreenError || 'Project failed to load');
            var count = (state.screenshots || []).filter(Boolean).length;
            if (!live || expectedScreenshots === 0 || count >= expectedScreenshots) {
                var missing = false;
                for (var i = 0; i < (live ? expectedScreenshots : 0); i++) {
                    if (!state.screenshots[i]) missing = true;
                }
                if (!missing) break;
            }
            await sleep(40);
        }
    }

    async function prepareFrame() {
        await waitForScreenshots();
        if (renderTarget !== 'all' && renderTarget !== 'invalid' && typeof renderTarget === 'number') {
            if (state.screenshots.length > renderTarget) state.selectedIndex = renderTarget;
        }
        var shot = state.screenshots[state.selectedIndex];
        function waitImage(img) {
            if (!img || img.complete) return Promise.resolve();
            return new Promise(function (resolve) {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            });
        }
        if (shot && typeof getScreenshotImage === 'function') {
            await waitImage(getScreenshotImage(shot));
        }
        if (shot && shot.background) await waitImage(shot.background.image);
        if (state.panoramicBackground) await waitImage(state.panoramicBackground.image);
        var text = shot && shot.text ? shot.text : (state.defaults && state.defaults.text);
        var fonts = quotedFonts(text && text.headlineFont).concat(quotedFonts(text && text.subheadlineFont));
        var weights = [];
        if (text && text.headlineWeight) weights.push(String(text.headlineWeight));
        if (text && text.subheadlineWeight) weights.push(String(text.subheadlineWeight));
        if (typeof loadGoogleFont === 'function') {
            for (var f = 0; f < fonts.length; f++) {
                try { await loadGoogleFont(fonts[f], weights); } catch (e) { /* fall back to the next available face */ }
            }
        }
        if (document.fonts && document.fonts.load) {
            for (var w = 0; w < fonts.length; w++) {
                var family = fonts[w];
                var faceWeights = weights.length ? weights : ['400'];
                for (var fw = 0; fw < faceWeights.length; fw++) {
                    try { await document.fonts.load(faceWeights[fw] + ' 64px "' + family + '"'); } catch (e) { /* face may be a system font */ }
                }
            }
        }
        if (document.fonts && document.fonts.ready) {
            try { await document.fonts.ready; } catch (e) { /* ignore */ }
        }
        var ss = shot && shot.screenshot;
        if (ss && ss.use3D) {
            if (typeof showThreeJS === 'function') showThreeJS(true);
            if (typeof switchPhoneModel === 'function') switchPhoneModel(ss.device3D || 'iphone');
            var started = Date.now();
            while (typeof phoneModelLoaded !== 'undefined' && !phoneModelLoaded && Date.now() - started < 40000) {
                await sleep(100);
            }
            if (typeof phoneModelLoaded !== 'undefined' && !phoneModelLoaded) {
                throw new Error('3D device model did not finish loading');
            }
        }
        if (typeof updateCanvas === 'function') updateCanvas();
        await new Promise(function (resolve) {
            requestAnimationFrame(function () { requestAnimationFrame(resolve); });
        });
    }

    function snapshot() {
        var dims = typeof getCanvasDimensions === 'function' ? getCanvasDimensions() : { width: canvas.width, height: canvas.height };
        return {
            index: state.selectedIndex,
            width: canvas.width,
            height: canvas.height,
            outputWidth: dims.width,
            outputHeight: dims.height,
            dataUrl: canvas.toDataURL('image/png')
        };
    }

    async function capture(index) {
        if (pullFailed) throw new Error(window.__appscreenError || 'Project failed to load');
        if (typeof index === 'number') {
            if (!state.screenshots[index]) throw new Error('Screenshot index ' + index + ' is not loaded');
            state.selectedIndex = index;
            if (typeof syncUIWithState === 'function') syncUIWithState();
        }
        checking = true;
        try {
            await prepareFrame();
        } finally {
            checking = false;
        }
        return snapshot();
    }

    async function captureAll() {
        await waitForScreenshots();
        var shots = [];
        var total = state.screenshots.length;
        for (var i = 0; i < total; i++) shots.push(await capture(i));
        return shots;
    }

    function afterRender() {
        if (!isRenderMode() || checking || pullFailed || window.__appscreenReady) return;
        checking = true;
        prepareFrame().then(function () {
            checking = false;
            markReady();
        }).catch(function (error) {
            checking = false;
            markError(error && error.message ? error.message : String(error));
        });
    }

    if (isRenderMode()) {
        window.__appscreenReady = false;
        window.__appscreenError = null;
        window.__appscreen = {
            get ready() { return window.__appscreenReady === true; },
            capture: capture,
            captureAll: captureAll,
            getCanvas: function () { return document.getElementById('preview-canvas'); }
        };
        if (renderTarget === 'invalid') markError('render must be a screenshot index or all');
    }

    window.addEventListener('pagehide', function () {
        if (!acceptPushes || !latestRecord || !live) return;
        clearTimeout(pushTimer);
        try {
            fetch(apiBase + '/api/projects/' + encodeURIComponent(projectId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Edit-Key': editKey },
                body: JSON.stringify(buildBackup(latestRecord)),
                keepalive: true
            });
        } catch (e) { /* best-effort flush */ }
    });

    window.AppscreenLive = {
        isLive: isLive,
        isRenderMode: isRenderMode,
        renderTarget: renderIndex,
        pull: pull,
        onSaved: onSaved,
        shouldSkipPersist: shouldSkipPersist,
        finishHydration: finishHydration,
        afterRender: afterRender
    };
})();
