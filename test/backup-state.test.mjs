import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
    serializeBackground,
    applyControlSnapshot,
    applyBackgroundCopy,
    buildProjectRecord,
    panoramicWindow,
} = require('../backup-state.js');

describe('backup serialization', () => {
    it('keeps flushed slider values and stores background images as data URLs', () => {
        const screenshots = [
            {
                name: 'library.png',
                background: {
                    type: 'image',
                    image: { __image: true, src: 'data:image/png;base64,AAA' },
                    imageFit: 'cover',
                    imageBlur: 2,
                    overlayOpacity: 10,
                },
                screenshot: { scale: 70, x: 50, y: 60, rotation: 0, rotation3D: { x: 0, y: 0, z: 0 } },
                text: { textGap: 10, headlineLetterSpacing: 0 },
            },
            {
                name: 'detail.png',
                background: { type: 'gradient', gradient: { angle: 135, stops: [] } },
                screenshot: { scale: 70, x: 50, y: 60 },
                text: {},
            },
        ];

        applyControlSnapshot(screenshots[0], {
            scale: 155,
            x: -40,
            y: 170,
            rotation3D: { x: 12, y: -20, z: 4 },
            imageBlur: 8,
            imageOffsetX: 15,
            imageOffsetY: -10,
            imageScale: 130,
            textGap: 48,
            textGapUnit: 'px',
            headlineLetterSpacing: 3,
            subheadlineLetterSpacing: -1,
        });

        const record = buildProjectRecord({
            id: 'p1',
            selectedIndex: 0,
            outputDevice: 'iphone-6.9',
            screenshots,
            defaults: {
                background: screenshots[0].background,
                screenshot: { scale: 70 },
                text: { headlineFont: "'Rubik', sans-serif" },
                elements: [],
                popouts: [],
            },
            panoramicBackground: { enabled: true, src: 'data:image/png;base64,WIDE', overlap: 0, scale: 100, offsetY: 0 },
        });

        const json = JSON.stringify(record);
        const parsed = JSON.parse(json);
        assert.equal(parsed.screenshots[0].screenshot.scale, 155);
        assert.equal(parsed.screenshots[0].screenshot.x, -40);
        assert.equal(parsed.screenshots[0].screenshot.y, 170);
        assert.deepEqual(parsed.screenshots[0].screenshot.rotation3D, { x: 12, y: -20, z: 4 });
        assert.equal(parsed.screenshots[0].background.image, null);
        assert.equal(parsed.screenshots[0].background.imageSrc, 'data:image/png;base64,AAA');
        assert.equal(parsed.screenshots[0].background.imageBlur, 8);
        assert.equal(parsed.screenshots[0].background.imageOffsetX, 15);
        assert.equal(parsed.screenshots[0].background.imageScale, 130);
        assert.equal(parsed.screenshots[0].text.textGap, 48);
        assert.equal(parsed.screenshots[0].text.headlineLetterSpacing, 3);
        assert.equal(parsed.defaults.background.image, null);
        assert.equal(parsed.defaults.background.imageSrc, 'data:image/png;base64,AAA');
        assert.equal(parsed.defaults.text.headlineFont, "'Rubik', sans-serif");
        assert.equal(parsed.panoramicBackground.src, 'data:image/png;base64,WIDE');
        assert.equal(json.includes('[object HTMLImageElement]'), false);
    });

    it('deep-copies an image background onto every screenshot', () => {
        const screenshots = [
            {
                name: 'one',
                background: {
                    type: 'image',
                    image: { __image: true, src: 'data:image/png;base64,ONE' },
                    imageFit: 'contain',
                    imageBlur: 6,
                    imageOffsetX: 12,
                    imageOffsetY: -4,
                    imageScale: 140,
                    overlayColor: '#112233',
                    overlayOpacity: 25,
                },
            },
            { name: 'two', background: { type: 'solid', solid: '#000' } },
            { name: 'three', background: { type: 'gradient' } },
        ];

        const copied = applyBackgroundCopy(screenshots, 0);
        assert.equal(copied[1].background.imageSrc, 'data:image/png;base64,ONE');
        assert.equal(copied[2].background.imageSrc, 'data:image/png;base64,ONE');
        assert.equal(copied[1].background.type, 'image');
        assert.equal(copied[2].background.imageFit, 'contain');
        assert.equal(copied[2].background.imageBlur, 6);
        assert.equal(copied[2].background.imageOffsetX, 12);
        assert.equal(copied[2].background.imageOffsetY, -4);
        assert.equal(copied[2].background.imageScale, 140);
        assert.equal(copied[2].background.overlayColor, '#112233');
        assert.equal(copied[2].background.overlayOpacity, 25);
        assert.equal(copied[1].background.image, null);
        assert.notEqual(copied[1].background, copied[2].background);
        copied[1].background.imageSrc = 'changed';
        copied[1].background.imageScale = 10;
        assert.equal(copied[2].background.imageSrc, 'data:image/png;base64,ONE');
        assert.equal(copied[0].background.imageScale, 140);
        assert.equal(copied[2].background.imageScale, 140);

        const again = serializeBackground(copied[2].background);
        assert.equal(again.image, null);
        assert.equal(again.imageSrc, 'data:image/png;base64,ONE');
    });

    it('slices a panoramic image by screenshot index', () => {
        const tiled = [0, 1, 2].map((i) => panoramicWindow(300, 3, i, 0));
        assert.equal(tiled[0].sx, 0);
        assert.equal(tiled[0].sw, 100);
        assert.equal(tiled[1].sx, 100);
        assert.equal(tiled[2].sx, 200);
        assert.equal(tiled[2].sw, 100);

        const overlapped = [0, 1].map((i) => panoramicWindow(300, 2, i, 0.5));
        assert.equal(overlapped[0].sx, 0);
        assert.equal(overlapped[0].sw, 200);
        assert.equal(overlapped[1].sx, 100);
        assert.equal(overlapped[1].sw, 200);
    });
});
