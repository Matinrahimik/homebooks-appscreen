/**
 * Pure checks for headless render mode. A screenshot is ready only after its
 * image has decoded. `img.complete` is also true for an empty or failed image,
 * and that used to let export and render_preview capture a gradient with no device.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.AppscreenReady = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    function assetLabel(src) {
        var value = src || "";
        var match = /\/assets\/([a-f0-9]{64})/i.exec(value);
        if (match) return "asset " + match[1];
        match = /^asset:([a-f0-9]{64})$/i.exec(value);
        if (match) return "asset " + match[1];
        if (value.indexOf("data:image/") === 0) return "inlined image";
        return value || "image";
    }

    function screenshotSource(shot, lang) {
        if (!shot) return "";
        var localized = shot.localizedImages || {};
        var order = [];
        if (lang) order.push(lang);
        if (lang !== "en") order.push("en");
        var keys = Object.keys(localized);
        for (var i = 0; i < keys.length; i++) {
            if (order.indexOf(keys[i]) === -1) order.push(keys[i]);
        }
        for (var j = 0; j < order.length; j++) {
            var entry = localized[order[j]];
            if (entry && entry.src) return entry.src;
        }
        return shot.src || "";
    }

    /**
     * ok: decoded. pending: still loading. error: missing, empty, or failed.
     * A failed fetch sets complete and leaves naturalWidth at 0.
     */
    function imageState(img, label) {
        var name = label || "Image";
        if (!img) return { state: "error", message: name + " was not created" };
        var src = img.currentSrc || img.src || "";
        var named = name + " (" + assetLabel(src) + ")";
        if (!src) return { state: "error", message: named + " has no src" };
        if (img.complete && img.naturalWidth > 0) return { state: "ok", message: "" };
        if (img.complete) return { state: "error", message: named + " failed to load" };
        return { state: "pending", message: "" };
    }

    function pullStillRunning(live, pullDone, pullFailed) {
        return Boolean(live && !pullDone && !pullFailed);
    }

    return {
        assetLabel: assetLabel,
        screenshotSource: screenshotSource,
        imageState: imageState,
        pullStillRunning: pullStillRunning
    };
});
