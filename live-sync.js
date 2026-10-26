/**
 * Live project sync and headless render mode.
 *
 * ?project=<id>&key=<editKey> loads the Worker backup JSON (the same shape as
 * Export/Import Project Backup) and debounced-saves edits back.
 * Optional &api=<origin> overrides the Worker origin.
 * &render=<index|all> hides the chrome. &uploads=<index:token,...> tells render
 * mode to encode each canvas with toBlob and PUT it to the Worker. The headless
 * browser only watches for status "done".
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
        window.__appscreenFinished = true;
        window.__appscreenError = message;
        document.documentElement.dataset.appscreenStatus = 'error';
        document.documentElement.dataset.appscreenError = message;
    }

    function markReady() {
        window.__appscreenFinished = true;
        window.__appscreenReady = true;
        document.documentElement.dataset.appscreenStatus = 'ready';
        if (typeof canvas !== 'undefined' && canvas) {
            document.documentElement.dataset.appscreenWidth = String(canvas.width);
            document.documentElement.dataset.appscreenHeight = String(canvas.height);
        }
    }

    function markDone(shots) {
        window.__appscreenFinished = true;
        window.__appscreenResult = { shots: shots };
        document.documentElement.dataset.appscreenStatus = 'done';
        document.documentElement.dataset.appscreenResult = JSON.stringify({ shots: shots });
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
        if (isRenderMode() && database) await clearProjectStores(database);
        var projectUrl = apiBase + '/api/projects/' + encodeURIComponent(projectId);
        try {
            // cache: 'no-store' is the fetch cache mode. Do not also set the
            // Cache-Control request header: it is not CORS-safelisted, so the
            // preflight asks to allow it and the browser drops the GET when
            // the response does not list it.
            res = await fetch(projectUrl + '?cb=' + Date.now(), {
                cache: 'no-store',
                headers: { 'X-Edit-Key': editKey, 'Accept': 'application/json' }
            });
        } catch (e) {
            pullFailed = true;
            var detail = (e && e.message) ? e.message : 'network error';
            var offline = 'Could not reach the screenshot API: GET ' + projectUrl + ' (' + detail + ')';
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

    function clearProjectStores(database) {
        return new Promise(function (resolve) {
            try {
                var tx = database.transaction(['projects', 'meta'], 'readwrite');
                tx.objectStore('projects').clear();
                tx.objectStore('meta').clear();
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { resolve(); };
                tx.onabort = function () { resolve(); };
            } catch (e) {
                resolve();
            }
        });
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

    function readyApi() {
        return window.AppscreenReady;
    }

    async function waitForScreenshots() {
        var deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (pullFailed) throw new Error(window.__appscreenError || 'Project failed to load');
            var api = readyApi();
            if (api && api.pullStillRunning(live, pullDone, pullFailed)) {
                await sleep(40);
                continue;
            }
            if (live && !pullDone) {
                await sleep(40);
                continue;
            }
            var count = (state.screenshots || []).filter(Boolean).length;
            var expected = live ? expectedScreenshots : (state.screenshots || []).length;
            if (expected === 0 || count >= expected) {
                var missing = false;
                for (var i = 0; i < expected; i++) {
                    if (!state.screenshots[i]) missing = true;
                }
                if (!missing) return;
            }
            await sleep(40);
        }
        throw new Error('Screenshots did not finish loading');
    }

    function reloadImage(img, src) {
        return new Promise(function (resolve) {
            var timer = setTimeout(finish, 10000);
            function finish() {
                clearTimeout(timer);
                img.removeEventListener('load', finish);
                img.removeEventListener('error', finish);
                resolve();
            }
            try { img.removeAttribute('src'); } catch (e) { /* ignore */ }
            img.addEventListener('load', finish);
            img.addEventListener('error', finish);
            try { img.crossOrigin = 'anonymous'; } catch (e2) { /* ignore */ }
            img.src = src;
        });
    }

    async function waitImage(img, label) {
        var api = readyApi();
        var attempts = api && api.IMAGE_LOAD_ATTEMPTS ? api.IMAGE_LOAD_ATTEMPTS : 3;
        var lastMessage = label + ' failed to load';
        for (var attempt = 1; attempt <= attempts; attempt++) {
            var deadline = Date.now() + 10000;
            var retrySrc = '';
            while (Date.now() < deadline) {
                var decision = api
                    ? api.nextImageAttempt(img, label, attempt, attempts)
                    : { action: 'fail', message: lastMessage };
                if (decision.action === 'wait') {
                    await sleep(40);
                    continue;
                }
                if (decision.action === 'fail') throw new Error(decision.message);
                if (decision.action === 'retry') {
                    lastMessage = decision.message;
                    var current = (img && (img.currentSrc || img.src)) || '';
                    retrySrc = api.assetRetryUrl(current, attempt + 1, Date.now());
                    break;
                }
                try {
                    if (img.decode) await img.decode();
                } catch (e) {
                    var src = (img && (img.currentSrc || img.src)) || '';
                    var named = api ? api.assetLabel(src) : src;
                    lastMessage = label + ' (' + named + ') failed to decode';
                    if (attempt >= attempts) throw new Error(lastMessage);
                    retrySrc = api.assetRetryUrl(src, attempt + 1, Date.now());
                    break;
                }
                if (!(img.naturalWidth > 0)) {
                    var decodedSrc = (img && (img.currentSrc || img.src)) || '';
                    var decodedName = api ? api.assetLabel(decodedSrc) : decodedSrc;
                    throw new Error(label + ' (' + decodedName + ') failed to decode');
                }
                return;
            }
            if (!retrySrc) {
                var lateSrc = (img && (img.currentSrc || img.src)) || '';
                var lateName = api ? api.assetLabel(lateSrc) : (lateSrc || 'image');
                lastMessage = label + ' (' + lateName + ') did not load in time';
                if (attempt >= attempts) throw new Error(lastMessage);
                retrySrc = api ? api.assetRetryUrl(lateSrc, attempt + 1, Date.now()) : lateSrc;
            }
            if (retrySrc) await reloadImage(img, retrySrc);
        }
        throw new Error(lastMessage);
    }

    function frameImages(index) {
        var shot = state.screenshots[index];
        if (!shot) throw new Error('Screenshot index ' + index + ' is not loaded');
        var api = readyApi();
        var images = [];
        var src = api ? api.screenshotSource(shot, state.currentLanguage) : (shot.src || '');
        if (src) {
            var photo = typeof getScreenshotImage === 'function' ? getScreenshotImage(shot) : shot.image;
            images.push({ img: photo, label: 'Screenshot ' + index });
        }
        var bg = shot.background;
        if (bg && (bg.type === 'image' || bg.imageSrc)) {
            images.push({ img: bg.image, label: 'Background image for screenshot ' + index });
        }
        var pano = state.panoramicBackground;
        if (pano && pano.enabled && pano.src) {
            images.push({ img: pano.image, label: 'Panoramic background' });
        }
        return images;
    }

    async function waitForFonts(shot) {
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
    }

    async function waitForDevice(shot, index) {
        var ss = shot && shot.screenshot;
        if (!ss || !ss.use3D) return;
        if (typeof showThreeJS === 'function') showThreeJS(true);
        if (typeof switchPhoneModel === 'function') switchPhoneModel(ss.device3D || 'iphone');
        var started = Date.now();
        while (typeof phoneModelLoaded !== 'undefined' && !phoneModelLoaded && Date.now() - started < 40000) {
            await sleep(100);
        }
        if (typeof phoneModelLoaded !== 'undefined' && !phoneModelLoaded) {
            throw new Error('3D device model did not finish loading for screenshot ' + index);
        }
    }

    function assertTexture(shot, index) {
        var ss = shot && shot.screenshot;
        if (!ss || !ss.use3D) return;
        var api = readyApi();
        var src = api ? api.screenshotSource(shot, state.currentLanguage) : '';
        var named = api ? api.assetLabel(src) : (src || 'image');
        if (typeof screenTexture === 'undefined' || !screenTexture || !screenTexture.image || !(screenTexture.image.width > 0)) {
            throw new Error('3D screen texture did not load for screenshot ' + index + ' (' + named + ')');
        }
    }

    async function paintIndex(index) {
        if (!state.screenshots[index]) throw new Error('Screenshot index ' + index + ' is not loaded');
        state.selectedIndex = index;
        if (typeof syncUIWithState === 'function') syncUIWithState();
        var images = frameImages(index);
        for (var i = 0; i < images.length; i++) await waitImage(images[i].img, images[i].label);
        var shot = state.screenshots[index];
        await waitForFonts(shot);
        await waitForDevice(shot, index);
        if (typeof updateCanvas === 'function') updateCanvas();
        await new Promise(function (resolve) {
            requestAnimationFrame(function () { requestAnimationFrame(resolve); });
        });
        assertTexture(shot, index);
    }

    async function prepareFrame(onlyIndex) {
        await waitForScreenshots();
        var indexes = [];
        if (typeof onlyIndex === 'number') indexes = [onlyIndex];
        else if (renderTarget === 'all') {
            for (var i = 0; i < state.screenshots.length; i++) indexes.push(i);
        } else if (typeof renderTarget === 'number') indexes = [renderTarget];
        else indexes = [state.selectedIndex || 0];
        if (live && indexes.length === 0) throw new Error('Project has no screenshots to render');
        for (var n = 0; n < indexes.length; n++) await paintIndex(indexes[n]);
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
            await prepareFrame(typeof index === 'number' ? index : undefined);
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

    function uploadSlots() {
        var api = readyApi();
        if (!api || !api.parseUploads) return {};
        return api.parseUploads(params.get('uploads'));
    }

    function indexesToRender() {
        if (renderTarget === 'all') {
            var list = [];
            for (var i = 0; i < (state.screenshots || []).length; i++) list.push(i);
            return list;
        }
        if (typeof renderTarget === 'number') return [renderTarget];
        return [state.selectedIndex || 0];
    }

    async function uploadIndex(index) {
        var api = readyApi();
        var token = uploadSlots()[index];
        if (!token) throw new Error('Screenshot ' + index + ' has no upload token');
        var canvasEl = (typeof canvas !== 'undefined' && canvas) ? canvas : document.getElementById('preview-canvas');
        if (!canvasEl || !canvasEl.toBlob) throw new Error('Preview canvas is missing');
        var blob = await new Promise(function (resolve, reject) {
            canvasEl.toBlob(function (value) {
                if (!value) reject(new Error('Screenshot ' + index + ' did not encode a PNG'));
                else resolve(value);
            }, 'image/png');
        });
        var bytes = new Uint8Array(await blob.arrayBuffer());
        if (!bytes.byteLength) throw new Error('Screenshot ' + index + ' encoded an empty PNG');
        var sum = api.crc32(bytes);
        var sha = await api.sha256Hex(bytes);
        var headers = {
            'Content-Type': 'image/png',
            'X-Appscreen-Crc': String(sum),
            'X-Appscreen-Width': String(canvasEl.width),
            'X-Appscreen-Height': String(canvasEl.height),
            'X-Appscreen-Sha256': sha,
            'X-Appscreen-Index': String(index)
        };
        var lastError = null;
        for (var attempt = 1; attempt <= 3; attempt++) {
            try {
                var response = await fetch(apiBase + '/renders/' + token, {
                    method: 'PUT',
                    headers: headers,
                    body: new Blob([bytes], { type: 'image/png' }),
                    cache: 'no-store'
                });
                if (!response.ok) {
                    var detail = '';
                    try { detail = (await response.text()).slice(0, 180); } catch (e) { detail = ''; }
                    var failed = new Error('Screenshot ' + index + ' upload failed with HTTP ' + response.status + (detail ? ' ' + detail : ''));
                    if (response.status === 400 || response.status === 401 || response.status === 404 || response.status === 413) throw failed;
                    lastError = failed;
                } else {
                    var payload = await response.json();
                    if (!payload || payload.ok !== true) throw new Error('Screenshot ' + index + ' upload was not stored');
                    return {
                        index: index,
                        token: token,
                        width: canvasEl.width,
                        height: canvasEl.height,
                        bytes: bytes.byteLength,
                        sha256: sha,
                        crc: sum
                    };
                }
            } catch (error) {
                if (error && /HTTP (400|401|404|413)/.test(String(error.message || ''))) throw error;
                lastError = error;
            }
            if (attempt < 3) await sleep(200 * attempt);
        }
        throw lastError || new Error('Screenshot ' + index + ' upload failed');
    }

    async function renderAndUpload() {
        if (params.get('uploads') && !readyApi()) throw new Error('Render helpers did not load');
        var uploading = Object.keys(uploadSlots()).length > 0;
        if (params.get('uploads') && !uploading) throw new Error('Upload tokens were not understood');
        await waitForScreenshots();
        var indexes = indexesToRender();
        if (live && indexes.length === 0) throw new Error('Project has no screenshots to render');
        var shots = [];
        for (var n = 0; n < indexes.length; n++) {
            await paintIndex(indexes[n]);
            if (uploading) shots.push(await uploadIndex(indexes[n]));
        }
        if (uploading) markDone(shots);
        else markReady();
    }

    function afterRender() {
        if (!isRenderMode() || checking || pullFailed || window.__appscreenFinished) return;
        checking = true;
        renderAndUpload().then(function () {
            checking = false;
        }).catch(function (error) {
            checking = false;
            console.error(error);
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
