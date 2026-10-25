/**
 * Serializable project snapshots shared by the editor and the regression tests.
 *
 * Background images are HTMLImageElement objects at runtime. IndexedDB cannot
 * structured-clone those, and JSON turns them into {}. Persisted backgrounds
 * keep the pixels in imageSrc (a data URL) and set image to null.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) root.BackupState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function imageSource(image) {
        if (!image) return '';
        if (typeof image === 'string') return image;
        if (typeof image.src === 'string' && image.src && !image.src.startsWith('data:,')) return image.src;
        return '';
    }

    function isImageLike(value) {
        if (!value || typeof value !== 'object') return false;
        if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return true;
        return value.__image === true || value.nodeName === 'IMG';
    }

    function jsonClone(value) {
        if (value == null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function serializeBackground(bg) {
        const source = bg || {};
        const out = {};
        Object.keys(source).forEach((key) => {
            if (key === 'image') return;
            const value = source[key];
            if (isImageLike(value)) return;
            if (value && typeof value === 'object') {
                try {
                    out[key] = jsonClone(value);
                } catch (e) {
                    /* skip values that cannot be cloned */
                }
            } else {
                out[key] = value;
            }
        });
        out.image = null;
        out.imageSrc = source.imageSrc || imageSource(source.image) || '';
        if (out.imageFit == null) out.imageFit = 'cover';
        if (out.imageOffsetX == null) out.imageOffsetX = 0;
        if (out.imageOffsetY == null) out.imageOffsetY = 0;
        if (out.imageScale == null) out.imageScale = 100;
        return out;
    }

    function serializePanoramic(pano) {
        const source = pano || {};
        return {
            enabled: !!source.enabled,
            src: source.src || imageSource(source.image) || '',
            overlap: typeof source.overlap === 'number' ? source.overlap : 0,
            scale: typeof source.scale === 'number' ? source.scale : 100,
            offsetY: typeof source.offsetY === 'number' ? source.offsetY : 0,
        };
    }

    function serializeLocalized(localized) {
        const out = {};
        if (!localized) return out;
        Object.keys(localized).forEach((lang) => {
            const langData = localized[lang];
            if (!langData) return;
            const src = langData.src || imageSource(langData.image);
            if (!src) return;
            out[lang] = { src: src, name: langData.name };
        });
        return out;
    }

    function applyControlSnapshot(screenshot, controls) {
        if (!screenshot || !controls) return screenshot;
        const shot = screenshot.screenshot || (screenshot.screenshot = {});
        const bg = screenshot.background || (screenshot.background = {});
        const text = screenshot.text || (screenshot.text = {});
        if (controls.scale != null) shot.scale = controls.scale;
        if (controls.x != null) shot.x = controls.x;
        if (controls.y != null) shot.y = controls.y;
        if (controls.rotation != null) shot.rotation = controls.rotation;
        if (controls.rotation3D) {
            shot.rotation3D = Object.assign({}, shot.rotation3D || { x: 0, y: 0, z: 0 }, controls.rotation3D);
        }
        if (controls.imageBlur != null) bg.imageBlur = controls.imageBlur;
        if (controls.imageOffsetX != null) bg.imageOffsetX = controls.imageOffsetX;
        if (controls.imageOffsetY != null) bg.imageOffsetY = controls.imageOffsetY;
        if (controls.imageScale != null) bg.imageScale = controls.imageScale;
        if (controls.textGap != null) text.textGap = controls.textGap;
        if (controls.textGapUnit != null) text.textGapUnit = controls.textGapUnit;
        if (controls.headlineLetterSpacing != null) text.headlineLetterSpacing = controls.headlineLetterSpacing;
        if (controls.subheadlineLetterSpacing != null) text.subheadlineLetterSpacing = controls.subheadlineLetterSpacing;
        return screenshot;
    }

    /**
     * Deep-copy background image settings onto every screenshot.
     * Each target gets its own object so later edits do not alias screenshot 1.
     */
    function applyBackgroundCopy(screenshots, sourceIndex) {
        const source = screenshots[sourceIndex];
        if (!source) return screenshots.map((shot) => shot);
        const copied = serializeBackground(source.background);
        return screenshots.map((shot, index) => {
            const background = jsonClone(index === sourceIndex ? serializeBackground(shot.background) : copied);
            return Object.assign({}, shot, { background: background });
        });
    }

    function buildProjectRecord(input) {
        const screenshots = (input.screenshots || []).map((s) => ({
            src: (s.localizedImages && Object.values(s.localizedImages)[0] && Object.values(s.localizedImages)[0].src) || s.src || imageSource(s.image) || '',
            name: s.name,
            deviceType: s.deviceType,
            localizedImages: serializeLocalized(s.localizedImages),
            background: serializeBackground(s.background),
            screenshot: jsonClone(s.screenshot || {}),
            text: jsonClone(s.text || {}),
            elements: (s.elements || []).map((el) => {
                const copy = jsonClone(Object.assign({}, el, { image: undefined }));
                delete copy.image;
                return copy;
            }),
            popouts: jsonClone(s.popouts || []),
            overrides: jsonClone(s.overrides || {}),
        }));
        const defaults = input.defaults || {};
        return {
            id: input.id,
            formatVersion: 2,
            screenshots: screenshots,
            selectedIndex: input.selectedIndex || 0,
            outputDevice: input.outputDevice,
            customWidth: input.customWidth,
            customHeight: input.customHeight,
            currentLanguage: input.currentLanguage,
            projectLanguages: input.projectLanguages,
            defaults: {
                background: serializeBackground(defaults.background),
                screenshot: jsonClone(defaults.screenshot || {}),
                text: jsonClone(defaults.text || {}),
                elements: jsonClone(defaults.elements || []),
                popouts: jsonClone(defaults.popouts || []),
            },
            panoramicBackground: serializePanoramic(input.panoramicBackground),
        };
    }

    /**
     * Horizontal window of a wide image for screenshot `index` of `count`.
     * overlap is the fraction of a window shared with the next screenshot (0–0.8).
     */
    function panoramicWindow(imageWidth, count, index, overlap) {
        const n = Math.max(1, count | 0);
        const i = Math.max(0, Math.min(n - 1, index | 0));
        const ov = Math.max(0, Math.min(0.8, Number(overlap) || 0));
        const span = n - (n - 1) * ov;
        const windowFrac = 1 / span;
        const startFrac = i * windowFrac * (1 - ov);
        return {
            sx: imageWidth * startFrac,
            sw: imageWidth * windowFrac,
            index: i,
            count: n,
            overlap: ov,
        };
    }

    return {
        imageSource: imageSource,
        serializeBackground: serializeBackground,
        serializePanoramic: serializePanoramic,
        applyControlSnapshot: applyControlSnapshot,
        applyBackgroundCopy: applyBackgroundCopy,
        buildProjectRecord: buildProjectRecord,
        panoramicWindow: panoramicWindow,
    };
});
