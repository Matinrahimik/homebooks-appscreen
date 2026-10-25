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

    var IMAGE_LOAD_ATTEMPTS = 3;

    var CRC_TABLE = (function () {
        var table = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        var c = 0xffffffff;
        for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    function sha256Hex(bytes) {
        return crypto.subtle.digest("SHA-256", bytes).then(function (digest) {
            var view = new Uint8Array(digest);
            var hex = "";
            for (var i = 0; i < view.length; i++) {
                var part = view[i].toString(16);
                hex += part.length === 1 ? "0" + part : part;
            }
            return hex;
        });
    }

    function parseUploads(value) {
        var slots = {};
        String(value || "").split(",").forEach(function (part) {
            var splitAt = part.indexOf(":");
            if (splitAt <= 0) return;
            var index = part.slice(0, splitAt);
            var token = part.slice(splitAt + 1);
            if (!/^\d+$/.test(index) || !/^[a-f0-9]{64}$/i.test(token)) return;
            slots[Number(index)] = token.toLowerCase();
        });
        return slots;
    }

    /** A failed image is retried with a new query so the browser does not reuse a bad response. */
    function assetRetryUrl(src, attempt, now) {
        var value = String(src || "");
        if (!value || value.indexOf("data:") === 0) return value;
        var hash = "";
        var hashAt = value.indexOf("#");
        if (hashAt >= 0) {
            hash = value.slice(hashAt);
            value = value.slice(0, hashAt);
        }
        var query = value.indexOf("?");
        var path = query >= 0 ? value.slice(0, query) : value;
        return path + "?retry=" + attempt + "&t=" + now + hash;
    }

    function nextImageAttempt(img, label, attempt, maxAttempts) {
        var status = imageState(img, label);
        if (status.state === "pending") return { action: "wait" };
        if (status.state === "ok") return { action: "ok" };
        var src = (img && (img.currentSrc || img.src)) || "";
        if (attempt < maxAttempts && src) return { action: "retry", message: status.message };
        return { action: "fail", message: status.message };
    }

    return {
        assetLabel: assetLabel,
        screenshotSource: screenshotSource,
        imageState: imageState,
        pullStillRunning: pullStillRunning,
        IMAGE_LOAD_ATTEMPTS: IMAGE_LOAD_ATTEMPTS,
        crc32: crc32,
        sha256Hex: sha256Hex,
        parseUploads: parseUploads,
        assetRetryUrl: assetRetryUrl,
        nextImageAttempt: nextImageAttempt
    };
});
