import { OUTPUT_DEVICES, POSITION_PRESETS } from "./project.ts";

export const GRADIENT_PRESET_CSS: { name: string; css: string }[] = [
  { name: "Midnight Abyss", css: "linear-gradient(160deg, #0a0a0f 0%, #1a1033 50%, #0d1b2a 100%)" },
  { name: "Obsidian Plum", css: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)" },
  { name: "Carbon Slate", css: "linear-gradient(180deg, #1c1c1e 0%, #2c2c2e 100%)" },
  { name: "Steel Blue", css: "linear-gradient(135deg, #29323c 0%, #485563 100%)" },
  { name: "Neon Horizon", css: "linear-gradient(125deg, #0d0221 0%, #711c91 50%, #0abdc6 100%)" },
  { name: "Electric Surge", css: "linear-gradient(135deg, #1a0533 0%, #5b21b6 50%, #06b6d4 100%)" },
  { name: "Synthwave Dusk", css: "linear-gradient(150deg, #2d1b69 0%, #ff2d78 50%, #ff901f 100%)" },
  { name: "Indigo Rush", css: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  { name: "Northern Lights", css: "linear-gradient(135deg, #172347 0%, #015268 40%, #0ef3c5 100%)" },
  { name: "Deep Forest", css: "linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)" },
  { name: "Emerald Canopy", css: "linear-gradient(145deg, #134e4a 0%, #065f46 50%, #14532d 100%)" },
  { name: "Ocean Pulse", css: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)" },
  { name: "Desert Dusk", css: "linear-gradient(170deg, #c84c28 0%, #d89c60 50%, #bb8a36 100%)" },
  { name: "Ember Glow", css: "linear-gradient(140deg, #7c2d12 0%, #c2410c 50%, #fb923c 100%)" },
  { name: "Mocha Silk", css: "linear-gradient(160deg, #292018 0%, #6b4226 60%, #a07850 100%)" },
  { name: "Golden Hour", css: "linear-gradient(135deg, #f7971e 0%, #ffd200 100%)" },
  { name: "Pacific Sunset", css: "linear-gradient(145deg, #f953c6 0%, #b91d73 50%, #4a1942 100%)" },
  { name: "Volcanic Dawn", css: "linear-gradient(130deg, #f12711 0%, #f5af19 100%)" },
  { name: "Deep Ocean", css: "linear-gradient(180deg, #011627 0%, #003459 50%, #007ea7 100%)" },
  { name: "Reef Lagoon", css: "linear-gradient(135deg, #1a6b7c 0%, #40b3c8 50%, #7de8dc 100%)" },
  { name: "Gold Noir", css: "linear-gradient(135deg, #020b13 0%, #1a1200 50%, #c9a227 100%)" },
  { name: "Velvet Noir", css: "linear-gradient(150deg, #1a0000 0%, #400128 50%, #6b0f1a 100%)" },
  { name: "Morning Mist", css: "linear-gradient(135deg, #e0eafc 0%, #cfdef3 100%)" },
  { name: "Sage Whisper", css: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)" },
  { name: "Royal Navy", css: "linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)" },
];

export function parseCssGradient(css: string): { angle: number; stops: { color: string; position: number }[] } {
  const angle = Number(/(\d+(?:\.\d+)?)deg/.exec(css)?.[1] ?? 180);
  const stops = [...css.matchAll(/(#[0-9a-fA-F]{3,8})\s+(\d+(?:\.\d+)?)%/g)].map((match) => ({
    color: match[1],
    position: Number(match[2]),
  }));
  return { angle, stops };
}

export function gradientPresets(): { name: string; angle: number; stops: { color: string; position: number }[] }[] {
  return GRADIENT_PRESET_CSS.map((preset) => ({ name: preset.name, ...parseCssGradient(preset.css) }));
}

export function findGradientPreset(name: string): { angle: number; stops: { color: string; position: number }[] } | null {
  const wanted = name.trim().toLowerCase();
  const found = gradientPresets().find((preset) => preset.name.toLowerCase() === wanted);
  if (!found) return null;
  return { angle: found.angle, stops: found.stops };
}

export const SYSTEM_FONTS = [
  "SF Pro Display",
  "SF Pro Rounded",
  "Helvetica Neue",
  "Avenir Next",
  "Georgia",
  "Arial",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Trebuchet MS",
];

export const POPULAR_GOOGLE_FONTS = [
  "Inter",
  "Poppins",
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Lato",
  "Raleway",
  "Nunito",
  "Playfair Display",
  "Oswald",
  "Merriweather",
  "Source Sans Pro",
  "PT Sans",
  "Ubuntu",
  "Rubik",
  "Work Sans",
  "Quicksand",
  "Mulish",
  "Barlow",
  "DM Sans",
  "Manrope",
  "Space Grotesk",
  "Plus Jakarta Sans",
  "Outfit",
  "Sora",
  "Lexend",
  "Figtree",
  "Albert Sans",
  "Bebas Neue",
  "Anton",
];

export const FRAME_COLORS_3D = {
  iphone: ["natural", "blue", "white", "black", "desert", "deep-purple", "gold", "red"],
  samsung: ["gray", "black", "silverblue", "whitesilver"],
};

export function describeOptions(): Record<string, unknown> {
  return {
    outputDevices: Object.entries(OUTPUT_DEVICES).map(([id, spec]) => ({
      id,
      label: spec.label,
      width: spec.width,
      height: spec.height,
    })),
    customSize: { device: "custom", min: 100, max: 4000, fields: ["width", "height"] },
    positionPresets: POSITION_PRESETS,
    backgroundTypes: ["gradient", "solid", "image"],
    imageFit: ["cover", "contain", "fill"],
    gradientPresets: gradientPresets(),
    textPositions: ["top", "center", "bottom"],
    fontWeights: ["300", "400", "500", "600", "700", "800", "900"],
    systemFonts: SYSTEM_FONTS,
    popularGoogleFonts: POPULAR_GOOGLE_FONTS,
    fontsNote:
      "font_family plus font_weight (or headlineFont / subheadlineFont) accept any Google Fonts family, including Rubik, or a CSS font-family stack. The hosted app loads the face with FontFace and waits for document.fonts.ready before render-ready.",
    textSpacing: {
      textGap: "number. Gap between headline and subheadline.",
      textGapUnit: ["px", "percent"],
      headlineLetterSpacing: "px",
      subheadlineLetterSpacing: "px",
    },
    backgroundImage: ["imageSrc", "imageFit", "imageOffsetX", "imageOffsetY", "imageScale", "imageBlur", "overlayColor", "overlayOpacity"],
    panoramicBackground: {
      enabled: "boolean",
      src: "data URL of one wide image sliced across screenshots in order",
      overlap: "0 to 0.8, fraction of each slice shared with the next",
      scale: "percent",
      offsetY: "percent of image height",
    },
    deviceFraming: {
      scale: "percent. The editor allows at least 30–200. Values above 100 zoom past the canvas.",
      x: "percent. Below 0 or above 100 moves the device off the sides. Not clamped to the canvas.",
      y: "percent. Below 0 or above 100 moves the device off the top or bottom.",
      rotation: "2D degrees",
      rotation3D: "{ x, y, z } degrees",
    },
    devices3D: ["iphone", "samsung"],
    frameColor3D: FRAME_COLORS_3D,
    shadowFields: ["enabled", "color", "blur", "opacity", "x", "y"],
    frameFields: ["enabled", "color", "width", "opacity"],
    colourNote: "color and colour are both accepted on background, shadow, frame, headlineColor, and subheadlineColor.",
    screenshotFields: [
      "scale",
      "x",
      "y",
      "rotation",
      "perspective",
      "cornerRadius",
      "positionPreset",
      "use3D",
      "device3D",
      "rotation3D",
      "frameColor",
      "shadow",
      "frame",
    ],
    languages: "Any BCP-47-ish code the app already uses (en, de, fr, pt-br, ...). Stored on projectLanguages and localizedImages.",
  };
}

export function backupSchema(): Record<string, unknown> {
  return {
    description:
      "Same JSON the app writes from Export Project Backup and reads with Import Project Backup. IndexedDB object stores become top-level arrays.",
    shape: {
      projects: [
        {
          id: "string",
          formatVersion: 2,
          screenshots: [
            {
              src: "data-url (legacy, current language image)",
              name: "string",
              deviceType: "iPhone | iPad",
              localizedImages: { en: { src: "data-url", name: "string" } },
              background: "see describe_options",
              screenshot: "2D/3D placement, shadow, frame",
              text: "headlines, subheadlines, fonts, weights, sizes, colours, position",
              elements: [],
              popouts: [],
              overrides: {},
            },
          ],
          selectedIndex: 0,
          outputDevice: "iphone-6.9 | iphone-6.7 | iphone-6.5 | iphone-5.5 | ipad-12.9 | ipad-11 | custom | ...",
          customWidth: 1320,
          customHeight: 2868,
          currentLanguage: "en",
          projectLanguages: ["en"],
          defaults: "background, screenshot, text, elements, popouts applied to newly added screenshots",
        },
      ],
      meta: [
        { key: "projects", value: [{ id: "string", name: "string", screenshotCount: 0 }] },
        { key: "currentProject", value: "project id" },
      ],
    },
  };
}
