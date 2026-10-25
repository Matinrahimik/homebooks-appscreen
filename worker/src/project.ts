/**
 * Mutations on the App Store Screenshot Generator backup JSON.
 *
 * The in-app Export/Import Project Backup buttons dump IndexedDB:
 *   { projects: ProjectRecord[], meta: MetaRecord[] }
 * `projects` records use keyPath `id`. `meta` records use keyPath `key`
 * (`projects` list + `currentProject`). Screenshot images are data URLs on
 * `localizedImages[lang].src` (and the legacy `src` field).
 */

export const FORMAT_VERSION = 2;

export const OUTPUT_DEVICES: Record<string, { width: number; height: number; label: string }> = {
  "iphone-6.9": { width: 1320, height: 2868, label: 'iPhone 6.9"' },
  "iphone-6.7": { width: 1290, height: 2796, label: 'iPhone 6.7"' },
  "iphone-6.5": { width: 1284, height: 2778, label: 'iPhone 6.5"' },
  "iphone-5.5": { width: 1242, height: 2208, label: 'iPhone 5.5"' },
  "ipad-12.9": { width: 2048, height: 2732, label: 'iPad 12.9"' },
  "ipad-11": { width: 1668, height: 2388, label: 'iPad 11"' },
  "android-phone": { width: 1080, height: 1920, label: "Android Phone" },
  "android-phone-hd": { width: 1440, height: 2560, label: "Android Phone HD" },
  "android-tablet-7": { width: 1200, height: 1920, label: 'Android Tablet 7"' },
  "android-tablet-10": { width: 1600, height: 2560, label: 'Android Tablet 10"' },
  "web-og": { width: 1200, height: 630, label: "Open Graph" },
  "web-twitter": { width: 1200, height: 675, label: "Twitter/X Card" },
  "web-hero": { width: 1920, height: 1080, label: "Website Hero" },
  "web-feature": { width: 1024, height: 500, label: "Feature Graphic" },
};

/** Same numbers as applyPositionPreset() in app.js. */
export const POSITION_PRESETS: Record<string, { scale: number; x: number; y: number; rotation: number; perspective: number }> = {
  centered: { scale: 70, x: 50, y: 50, rotation: 0, perspective: 0 },
  "bleed-bottom": { scale: 85, x: 50, y: 120, rotation: 0, perspective: 0 },
  "bleed-top": { scale: 85, x: 50, y: -20, rotation: 0, perspective: 0 },
  "float-center": { scale: 60, x: 50, y: 50, rotation: 0, perspective: 0 },
  "tilt-left": { scale: 65, x: 50, y: 60, rotation: -8, perspective: 0 },
  "tilt-right": { scale: 65, x: 50, y: 60, rotation: 8, perspective: 0 },
  perspective: { scale: 65, x: 50, y: 50, rotation: 0, perspective: 15 },
  "float-bottom": { scale: 55, x: 50, y: 70, rotation: 0, perspective: 0 },
};

export const DEVICES_3D = ["iphone", "samsung"] as const;

export interface GradientStop {
  color: string;
  position: number;
}

export interface BackupDump {
  projects: ProjectRecord[];
  meta: MetaRecord[];
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export interface ProjectListEntry {
  id: string;
  name: string;
  screenshotCount: number;
}

export interface ProjectRecord {
  id: string;
  formatVersion: number;
  screenshots: ScreenshotRecord[];
  selectedIndex: number;
  outputDevice: string;
  customWidth: number;
  customHeight: number;
  currentLanguage: string;
  projectLanguages: string[];
  defaults: Defaults;
  [extra: string]: unknown;
}

export interface ScreenshotRecord {
  src: string;
  name: string;
  deviceType?: string;
  localizedImages: Record<string, { src: string; name?: string }>;
  background: Record<string, unknown>;
  screenshot: Record<string, unknown>;
  text: Record<string, unknown>;
  elements: unknown[];
  popouts: unknown[];
  overrides: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface Defaults {
  background: Record<string, unknown>;
  screenshot: Record<string, unknown>;
  text: Record<string, unknown>;
  elements: unknown[];
  popouts: unknown[];
}

export class ProjectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}

export function defaultBackground(): Record<string, unknown> {
  return {
    type: "gradient",
    gradient: {
      angle: 135,
      stops: [
        { color: "#667eea", position: 0 },
        { color: "#764ba2", position: 100 },
      ],
    },
    solid: "#1a1a2e",
    image: null,
    imageSrc: "",
    imageFit: "cover",
    imageBlur: 0,
    imageOffsetX: 0,
    imageOffsetY: 0,
    imageScale: 100,
    overlayColor: "#000000",
    overlayOpacity: 0,
    noise: false,
    noiseIntensity: 10,
  };
}

export function defaultScreenshotSettings(): Record<string, unknown> {
  return {
    scale: 70,
    // 100 keeps a scale-70 device below a two-line headline and the subheadline.
    // At this scale the device top is (y / 100) * 30% of the canvas height.
    y: 100,
    x: 50,
    rotation: 0,
    perspective: 0,
    cornerRadius: 24,
    use3D: false,
    device3D: "iphone",
    rotation3D: { x: 0, y: 0, z: 0 },
    shadow: { enabled: true, color: "#000000", blur: 40, opacity: 30, x: 0, y: 20 },
    frame: { enabled: false, color: "#1d1d1f", width: 12, opacity: 100 },
  };
}

export function defaultText(): Record<string, unknown> {
  return {
    headlineEnabled: true,
    headlines: { en: "" },
    headlineLanguages: ["en"],
    currentHeadlineLang: "en",
    headlineFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
    headlineSize: 100,
    headlineWeight: "600",
    headlineItalic: false,
    headlineUnderline: false,
    headlineStrikethrough: false,
    headlineColor: "#ffffff",
    perLanguageLayout: false,
    languageSettings: {
      en: { headlineSize: 100, subheadlineSize: 50, position: "top", offsetY: 12, lineHeight: 110 },
    },
    currentLayoutLang: "en",
    position: "top",
    offsetY: 12,
    lineHeight: 110,
    textGap: 10,
    textGapUnit: "px",
    headlineLetterSpacing: 0,
    subheadlineLetterSpacing: 0,
    headlineTextWrap: "wrap",
    subheadlineTextWrap: "wrap",
    subheadlineEnabled: false,
    subheadlines: { en: "" },
    subheadlineLanguages: ["en"],
    currentSubheadlineLang: "en",
    subheadlineFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
    subheadlineSize: 50,
    subheadlineWeight: "400",
    subheadlineItalic: false,
    subheadlineUnderline: false,
    subheadlineStrikethrough: false,
    subheadlineColor: "#ffffff",
    subheadlineOpacity: 70,
  };
}

export function defaultDefaults(): Defaults {
  return {
    background: defaultBackground(),
    screenshot: defaultScreenshotSettings(),
    text: defaultText(),
    elements: [],
    popouts: [],
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createBackup(id: string, name: string): BackupDump {
  const project: ProjectRecord = {
    id,
    formatVersion: FORMAT_VERSION,
    screenshots: [],
    selectedIndex: 0,
    outputDevice: "iphone-6.9",
    customWidth: 1320,
    customHeight: 2868,
    currentLanguage: "en",
    projectLanguages: ["en"],
    defaults: defaultDefaults(),
  };
  const entry: ProjectListEntry = { id, name, screenshotCount: 0 };
  return {
    projects: [project],
    meta: [
      { key: "projects", value: [entry] },
      { key: "currentProject", value: id },
    ],
  };
}

export function assertBackup(value: unknown): BackupDump {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectError("invalid_backup", "Backup must be a JSON object with projects and meta arrays.");
  }
  const dump = value as BackupDump;
  if (!Array.isArray(dump.projects) || !Array.isArray(dump.meta)) {
    throw new ProjectError(
      "invalid_backup",
      "Backup must match the app export format: { projects: [...], meta: [...] }.",
    );
  }
  if (dump.projects.length === 0) {
    throw new ProjectError("invalid_backup", "Backup projects array is empty.");
  }
  return dump;
}

export function primaryProject(dump: BackupDump): ProjectRecord {
  const current = dump.meta.find((m) => m.key === "currentProject")?.value;
  const id = typeof current === "string" ? current : dump.projects[0]?.id;
  const project = dump.projects.find((p) => p && p.id === id) || dump.projects[0];
  if (!project || typeof project !== "object") {
    throw new ProjectError("invalid_backup", "Backup has no project record.");
  }
  if (!Array.isArray(project.screenshots)) project.screenshots = [];
  if (!project.defaults) project.defaults = defaultDefaults();
  if (!project.projectLanguages) project.projectLanguages = ["en"];
  if (!project.currentLanguage) project.currentLanguage = "en";
  if (!project.outputDevice) project.outputDevice = "iphone-6.9";
  project.formatVersion = project.formatVersion || FORMAT_VERSION;
  return project;
}

export function projectName(dump: BackupDump, id?: string): string {
  const project = id ? dump.projects.find((p) => p.id === id) || primaryProject(dump) : primaryProject(dump);
  const meta = dump.meta.find((m) => m.key === "projects");
  const list = Array.isArray(meta?.value) ? (meta.value as ProjectListEntry[]) : [];
  const entry = list.find((p) => p.id === project.id) || list[0];
  return entry?.name || "Untitled";
}

export function setProjectName(dump: BackupDump, name: string): void {
  const project = primaryProject(dump);
  const meta = dump.meta.find((m) => m.key === "projects");
  const list: ProjectListEntry[] = meta && Array.isArray(meta.value) ? (meta.value as ProjectListEntry[]) : [];
  let entry = list.find((p) => p.id === project.id);
  if (!entry) {
    entry = { id: project.id, name, screenshotCount: project.screenshots.length };
    list.push(entry);
    if (meta) meta.value = list;
    else dump.meta.push({ key: "projects", value: list });
  }
  entry.name = name;
  entry.screenshotCount = project.screenshots.length;
  const current = dump.meta.find((m) => m.key === "currentProject");
  if (current) current.value = project.id;
  else dump.meta.push({ key: "currentProject", value: project.id });
}

function touchCounts(dump: BackupDump): void {
  const project = primaryProject(dump);
  const meta = dump.meta.find((m) => m.key === "projects");
  const list = meta && Array.isArray(meta.value) ? (meta.value as ProjectListEntry[]) : [];
  const entry = list.find((p) => p.id === project.id);
  if (entry) entry.screenshotCount = project.screenshots.length;
  if (project.selectedIndex >= project.screenshots.length) {
    project.selectedIndex = Math.max(0, project.screenshots.length - 1);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(isPlainObject(base) ? (base as Record<string, unknown>) : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out as T;
}

const COLOUR_KEYS: Record<string, string> = {
  colour: "color",
  headlineColour: "headlineColor",
  subheadlineColour: "subheadlineColor",
  overlayColour: "overlayColor",
};

function renameColourKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameColourKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const renamed = COLOUR_KEYS[key] || key;
    out[renamed] = renameColourKeys(child);
  }
  return out;
}

function blankScreenshot(project: ProjectRecord, name: string, deviceType: string): ScreenshotRecord {
  return {
    src: "",
    name: name || "Screenshot",
    deviceType,
    localizedImages: {},
    background: clone(project.defaults.background),
    screenshot: clone(project.defaults.screenshot),
    text: clone(project.defaults.text),
    elements: clone(project.defaults.elements || []),
    popouts: [],
    overrides: {},
  };
}

function ensureLanguage(project: ProjectRecord, lang: string): void {
  if (!project.projectLanguages.includes(lang)) project.projectLanguages.push(lang);
  const text = project.defaults.text;
  const headlines = (text.headlines as Record<string, string>) || {};
  if (!(lang in headlines)) headlines[lang] = "";
  text.headlines = headlines;
  const headlineLanguages = (text.headlineLanguages as string[]) || ["en"];
  if (!headlineLanguages.includes(lang)) headlineLanguages.push(lang);
  text.headlineLanguages = headlineLanguages;
}

export interface ImagePayload {
  dataUrl: string;
  name?: string;
  language?: string;
  deviceType?: string;
}

export function addScreenshot(dump: BackupDump, image: ImagePayload, index?: number): number {
  const project = primaryProject(dump);
  const lang = (image.language || project.currentLanguage || "en").toLowerCase();
  const shot = blankScreenshot(project, image.name || "Screenshot", image.deviceType || "iPhone");
  shot.src = image.dataUrl;
  shot.localizedImages[lang] = { src: image.dataUrl, name: image.name || shot.name };
  ensureLanguage(project, lang);
  if (index === undefined || index < 0 || index > project.screenshots.length) {
    project.screenshots.push(shot);
    index = project.screenshots.length - 1;
  } else {
    project.screenshots.splice(index, 0, shot);
  }
  project.selectedIndex = index;
  touchCounts(dump);
  return index;
}

export function replaceScreenshot(dump: BackupDump, index: number, image: ImagePayload): void {
  const project = primaryProject(dump);
  const shot = screenshotAt(project, index);
  const lang = (image.language || project.currentLanguage || "en").toLowerCase();
  if (!shot.localizedImages || typeof shot.localizedImages !== "object") shot.localizedImages = {};
  shot.localizedImages[lang] = { src: image.dataUrl, name: image.name || shot.name };
  shot.src = image.dataUrl;
  if (image.name) shot.name = image.name;
  if (image.deviceType) shot.deviceType = image.deviceType;
  ensureLanguage(project, lang);
  touchCounts(dump);
}

export function removeScreenshot(dump: BackupDump, index: number): void {
  const project = primaryProject(dump);
  screenshotAt(project, index);
  project.screenshots.splice(index, 1);
  touchCounts(dump);
}

export function reorderScreenshots(dump: BackupDump, order: number[]): void {
  const project = primaryProject(dump);
  if (!Array.isArray(order) || order.length !== project.screenshots.length) {
    throw new ProjectError(
      "invalid_order",
      `order must be a permutation of ${project.screenshots.length} indexes (received ${order?.length ?? 0}).`,
    );
  }
  const seen = new Set<number>();
  for (const n of order) {
    if (!Number.isInteger(n) || n < 0 || n >= project.screenshots.length || seen.has(n)) {
      throw new ProjectError("invalid_order", `order is not a permutation of 0..${project.screenshots.length - 1}.`);
    }
    seen.add(n);
  }
  const previous = project.selectedIndex;
  project.screenshots = order.map((i) => project.screenshots[i]);
  const newSelected = order.indexOf(previous);
  project.selectedIndex = newSelected === -1 ? 0 : newSelected;
  touchCounts(dump);
}

export function screenshotAt(project: ProjectRecord, index: number): ScreenshotRecord {
  if (!Number.isInteger(index) || index < 0 || index >= project.screenshots.length) {
    throw new ProjectError(
      "invalid_index",
      `Screenshot index ${index} is out of range (project has ${project.screenshots.length}).`,
    );
  }
  return project.screenshots[index];
}

function normalizeStoredBackground(bg: Record<string, unknown>): void {
  if (typeof bg.image === "string" && bg.image) {
    if (!bg.imageSrc) bg.imageSrc = bg.image;
    bg.image = null;
  } else if (bg.image && typeof bg.image === "object") {
    bg.image = null;
  }
  if (bg.imageOffsetX == null) bg.imageOffsetX = 0;
  if (bg.imageOffsetY == null) bg.imageOffsetY = 0;
  if (bg.imageScale == null) bg.imageScale = 100;
}

export function setPanoramicBackground(
  dump: BackupDump,
  input: { src?: string; enabled?: boolean; overlap?: number; scale?: number; offsetY?: number },
): Record<string, unknown> {
  const project = primaryProject(dump);
  const current = isPlainObject(project.panoramicBackground)
    ? (project.panoramicBackground as Record<string, unknown>)
    : {};
  const next: Record<string, unknown> = {
    enabled: current.enabled === true,
    src: typeof current.src === "string" ? current.src : "",
    overlap: typeof current.overlap === "number" ? current.overlap : 0,
    scale: typeof current.scale === "number" ? current.scale : 100,
    offsetY: typeof current.offsetY === "number" ? current.offsetY : 0,
  };
  if (typeof input.src === "string") next.src = input.src;
  if (typeof input.enabled === "boolean") next.enabled = input.enabled;
  else if (typeof input.src === "string" && input.src) next.enabled = true;
  if (typeof input.overlap === "number" && Number.isFinite(input.overlap)) {
    next.overlap = Math.max(0, Math.min(0.8, input.overlap));
  }
  if (typeof input.scale === "number" && Number.isFinite(input.scale)) next.scale = input.scale;
  if (typeof input.offsetY === "number" && Number.isFinite(input.offsetY)) next.offsetY = input.offsetY;
  project.panoramicBackground = next;
  return next;
}

function applyPositionPreset(target: Record<string, unknown>, preset: string): void {
  const values = POSITION_PRESETS[preset];
  if (!values) {
    throw new ProjectError(
      "invalid_preset",
      `Unknown position preset "${preset}". Use one of: ${Object.keys(POSITION_PRESETS).join(", ")}.`,
    );
  }
  Object.assign(target, values);
}

const TEXT_SHORTCUTS = [
  "headline",
  "subheadline",
  "headlineFont",
  "headlineWeight",
  "headlineSize",
  "headlineColor",
  "headlineItalic",
  "headlineUnderline",
  "headlineStrikethrough",
  "headlineEnabled",
  "subheadlineFont",
  "subheadlineWeight",
  "subheadlineSize",
  "subheadlineColor",
  "subheadlineOpacity",
  "subheadlineItalic",
  "subheadlineUnderline",
  "subheadlineStrikethrough",
  "subheadlineEnabled",
  "position",
  "offsetY",
  "lineHeight",
  "textGap",
  "textGapUnit",
  "headlineLetterSpacing",
  "subheadlineLetterSpacing",
  "headlineTextWrap",
  "subheadlineTextWrap",
  "perLanguageLayout",
  "languageSettings",
  "headlines",
  "subheadlines",
] as const;

const LAYOUT_WRITE_KEYS = ["headlineSize", "subheadlineSize", "position", "offsetY", "lineHeight"] as const;

/** A plain headlineSize (and the other layout fields) also updates languageSettings, which otherwise overrides the global size. */
function applyEffectiveLayout(text: Record<string, unknown>, settings: Record<string, unknown>, lang: string): void {
  const patch: Record<string, unknown> = {};
  for (const key of LAYOUT_WRITE_KEYS) {
    if (settings[key] !== undefined) patch[key] = settings[key];
  }
  if (Object.keys(patch).length === 0) return;
  const active = lang || "en";
  const current: Record<string, unknown> = isPlainObject(text.languageSettings)
    ? { ...(text.languageSettings as Record<string, unknown>) }
    : {};
  const write = (code: string) => {
    const prev = isPlainObject(current[code]) ? { ...(current[code] as Record<string, unknown>) } : {};
    current[code] = { ...prev, ...patch };
  };
  write(active);
  if (text.perLanguageLayout !== true) {
    for (const code of Object.keys(current)) write(code);
  }
  text.languageSettings = current;
}

function hasVisibleCopy(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.values(value).some((item) => typeof item === "string" && item.trim() !== "");
}

function applyTextShortcuts(text: Record<string, unknown>, settings: Record<string, unknown>, lang: string): void {
  if (typeof settings.headline === "string") {
    const headlines = { ...((text.headlines as Record<string, string>) || {}) };
    headlines[lang] = settings.headline;
    text.headlines = headlines;
    text.headlineEnabled = true;
    const langs = new Set([...(text.headlineLanguages as string[]) || [], lang]);
    text.headlineLanguages = [...langs];
    text.currentHeadlineLang = lang;
  }
  if (typeof settings.subheadline === "string") {
    const sub = { ...((text.subheadlines as Record<string, string>) || {}) };
    sub[lang] = settings.subheadline;
    text.subheadlines = sub;
    text.subheadlineEnabled = true;
    const langs = new Set([...(text.subheadlineLanguages as string[]) || [], lang]);
    text.subheadlineLanguages = [...langs];
    text.currentSubheadlineLang = lang;
  }
  if (isPlainObject(settings.headlines)) {
    text.headlines = { ...(text.headlines as object), ...settings.headlines };
    if (hasVisibleCopy(settings.headlines)) text.headlineEnabled = true;
  }
  if (isPlainObject(settings.subheadlines)) {
    text.subheadlines = { ...(text.subheadlines as object), ...settings.subheadlines };
    if (hasVisibleCopy(settings.subheadlines)) text.subheadlineEnabled = true;
  }
  for (const key of TEXT_SHORTCUTS) {
    if (key === "headline" || key === "subheadline" || key === "headlines" || key === "subheadlines") continue;
    if (key === "languageSettings") continue;
    if (FONT_ALIAS_KEYS.has(key)) continue;
    if (settings[key] !== undefined) text[key] = settings[key];
  }
  if (isPlainObject(settings.languageSettings)) {
    text.languageSettings = deepMerge(text.languageSettings || {}, settings.languageSettings);
  }
  applyEffectiveLayout(text, settings, lang);
  if (typeof settings.font === "string" && settings.headlineFont === undefined) {
    text.headlineFont = fontValue(settings.font);
  }
  if (typeof settings.headlineFont === "string") text.headlineFont = fontValue(settings.headlineFont);
  if (typeof settings.subheadlineFont === "string") text.subheadlineFont = fontValue(settings.subheadlineFont);
  const family = stringSetting(settings, ["font_family", "fontFamily"]);
  if (family && settings.headlineFont === undefined && settings.headline_font_family === undefined) {
    text.headlineFont = fontValue(family);
  }
  if (family && settings.subheadlineFont === undefined && settings.subheadline_font_family === undefined) {
    text.subheadlineFont = fontValue(family);
  }
  const headlineFamily = stringSetting(settings, ["headline_font_family", "headlineFontFamily"]);
  if (headlineFamily) text.headlineFont = fontValue(headlineFamily);
  const subFamily = stringSetting(settings, ["subheadline_font_family", "subheadlineFontFamily"]);
  if (subFamily) text.subheadlineFont = fontValue(subFamily);
  const bothWeight = settings.font_weight ?? settings.fontWeight;
  if (bothWeight != null && bothWeight !== "" && settings.headlineWeight === undefined && settings.headline_weight === undefined) {
    text.headlineWeight = String(bothWeight);
    text.subheadlineWeight = String(bothWeight);
  }
  if (settings.headline_weight != null && settings.headline_weight !== "") text.headlineWeight = String(settings.headline_weight);
  if (settings.subheadline_weight != null && settings.subheadline_weight !== "") {
    text.subheadlineWeight = String(settings.subheadline_weight);
  }
}

function stringSetting(settings: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof settings[key] === "string" && settings[key]) return settings[key] as string;
  }
  return undefined;
}

const FONT_ALIAS_KEYS = new Set([
  "font",
  "font_family",
  "fontFamily",
  "font_weight",
  "fontWeight",
  "headline_font_family",
  "headlineFontFamily",
  "subheadline_font_family",
  "subheadlineFontFamily",
  "headline_weight",
  "subheadline_weight",
]);

/** Accept a Google font family name or a full CSS font-family stack. */
export function fontValue(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(",") || trimmed.startsWith("-") || trimmed.includes(" ")) {
    if (trimmed.includes(",")) return trimmed;
  }
  const system: Record<string, string> = {
    "SF Pro Display": "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
    "SF Pro Rounded": "'SF Pro Rounded', -apple-system",
    "Helvetica Neue": "'Helvetica Neue', Helvetica",
    "Avenir Next": "'Avenir Next', Avenir",
    Georgia: "Georgia, serif",
    Arial: "Arial, sans-serif",
    "Times New Roman": "'Times New Roman', serif",
    "Courier New": "'Courier New', monospace",
    Verdana: "Verdana, sans-serif",
    "Trebuchet MS": "'Trebuchet MS', sans-serif",
  };
  if (system[trimmed]) return system[trimmed];
  if (trimmed.includes(",")) return trimmed;
  const family = trimmed.replace(/^['"]|['"]$/g, "");
  return `'${family}', sans-serif`;
}

function applyLayerSettings(
  layer: { background: Record<string, unknown>; screenshot: Record<string, unknown>; text: Record<string, unknown> },
  settings: Record<string, unknown>,
  lang: string,
): void {
  const normalized = renameColourKeys(settings) as Record<string, unknown>;
  if (isPlainObject(normalized.background)) {
    const background = { ...normalized.background };
    if (typeof background.gradientPreset === "string") {
      /* resolved by the caller via schema presets if present; stored as gradient if object provided */
    }
    delete background.image_base64;
    delete background.image_url;
    layer.background = deepMerge(layer.background, background);
    normalizeStoredBackground(layer.background);
  }
  if (isPlainObject(normalized.screenshot)) {
    const shot = { ...normalized.screenshot };
    if (isPlainObject(shot.border) && !isPlainObject(shot.frame)) shot.frame = shot.border;
    delete shot.border;
    const preset = typeof shot.positionPreset === "string" ? shot.positionPreset : undefined;
    delete shot.positionPreset;
    layer.screenshot = deepMerge(layer.screenshot, shot);
    if (preset) applyPositionPreset(layer.screenshot, preset);
  }
  if (isPlainObject(normalized.text)) {
    const textPatch = normalized.text as Record<string, unknown>;
    const stored: Record<string, unknown> = { ...textPatch };
    for (const key of FONT_ALIAS_KEYS) delete stored[key];
    delete stored.headline;
    delete stored.subheadline;
    layer.text = deepMerge(layer.text, stored);
    applyTextShortcuts(layer.text, textPatch, lang);
  }
  if (typeof normalized.positionPreset === "string") {
    applyPositionPreset(layer.screenshot, normalized.positionPreset);
  }
  applyTextShortcuts(layer.text, normalized, lang);
  if (Array.isArray(normalized.elements)) {
    (layer as { elements?: unknown[] }).elements = normalized.elements;
  }
  if (Array.isArray(normalized.popouts)) {
    (layer as { popouts?: unknown[] }).popouts = normalized.popouts;
  }
}

const BACKGROUND_KEYS = new Set([
  "type",
  "gradient",
  "gradientPreset",
  "solid",
  "image",
  "imageSrc",
  "imageFit",
  "imageBlur",
  "imageOffsetX",
  "imageOffsetY",
  "imageScale",
  "overlayColor",
  "overlayOpacity",
  "noise",
  "noiseIntensity",
  "image_base64",
  "image_url",
]);

const SHADOW_KEYS = new Set(["enabled", "color", "blur", "opacity", "x", "y"]);
const FRAME_KEYS = new Set(["enabled", "color", "width", "opacity"]);
const ROTATION_3D_KEYS = new Set(["x", "y", "z"]);
const SCREENSHOT_LAYER_KEYS = new Set([
  "scale",
  "x",
  "y",
  "rotation",
  "perspective",
  "cornerRadius",
  "use3D",
  "device3D",
  "rotation3D",
  "shadow",
  "frame",
  "border",
  "positionPreset",
  "frameColor",
]);
const LAYOUT_KEYS = new Set(["headlineSize", "subheadlineSize", "position", "offsetY", "lineHeight"]);
const PANORAMIC_KEYS = new Set(["enabled", "src", "imageSrc", "overlap", "scale", "offsetY"]);

function textSettingKeys(): Set<string> {
  return new Set<string>([...Object.keys(defaultText()), ...TEXT_SHORTCUTS, ...FONT_ALIAS_KEYS]);
}

function globalSettingKeys(): Set<string> {
  return new Set<string>([
    "language",
    "width",
    "height",
    "apply_to",
    "name",
    "outputDevice",
    "customWidth",
    "customHeight",
    "background",
    "screenshot",
    "text",
    "elements",
    "popouts",
    "positionPreset",
    "panoramicBackground",
    "panoramic",
    "gradientPreset",
    "type",
    "gradient",
    "background_image_base64",
    "background_image_url",
    ...TEXT_SHORTCUTS,
    ...FONT_ALIAS_KEYS,
  ]);
}

function screenshotSettingKeys(): Set<string> {
  return new Set<string>([
    ...globalSettingKeys(),
    "deviceType",
    "src",
    "localizedImages",
    "image",
  ]);
}

function rejectUnknown(paths: string[]): void {
  if (paths.length === 0) return;
  const listed = paths.map((path) => `"${path}"`).join(", ");
  const noun = paths.length === 1 ? "setting" : "settings";
  throw new ProjectError(
    "unknown_setting",
    `Unknown ${noun} ${listed}. Call describe_options for the fields these tools accept. font_family, font_weight, headline, and subheadline apply both under settings.text and at the top level of settings.`,
  );
}

function collectUnknown(unknown: string[], path: string, value: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) unknown.push(`${path}.${key}`);
  }
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ProjectError("invalid_setting", `${path} must be an object.`);
  }
  return value;
}

/** Reject keys the tools do not apply, instead of reporting success and storing them unused. */
export function assertKnownSettings(settings: Record<string, unknown>, scope: "global" | "screenshot"): void {
  const normalized = renameColourKeys(settings) as Record<string, unknown>;
  const unknown: string[] = [];
  collectUnknown(unknown, "settings", normalized, scope === "global" ? globalSettingKeys() : screenshotSettingKeys());

  if (normalized.background !== undefined) {
    const background = assertObject(normalized.background, "settings.background");
    collectUnknown(unknown, "settings.background", background, BACKGROUND_KEYS);
    if (background.gradient !== undefined) {
      const gradient = assertObject(background.gradient, "settings.background.gradient");
      collectUnknown(unknown, "settings.background.gradient", gradient, new Set(["angle", "stops"]));
      if (gradient.stops !== undefined) {
        if (!Array.isArray(gradient.stops)) {
          throw new ProjectError("invalid_setting", "settings.background.gradient.stops must be an array.");
        }
        gradient.stops.forEach((stop, index) => {
          const entry = assertObject(stop, `settings.background.gradient.stops[${index}]`);
          collectUnknown(unknown, `settings.background.gradient.stops[${index}]`, entry, new Set(["color", "position"]));
        });
      }
    }
  }
  if (normalized.screenshot !== undefined) {
    const shot = assertObject(normalized.screenshot, "settings.screenshot");
    collectUnknown(unknown, "settings.screenshot", shot, SCREENSHOT_LAYER_KEYS);
    if (shot.shadow !== undefined) {
      const shadow = assertObject(shot.shadow, "settings.screenshot.shadow");
      collectUnknown(unknown, "settings.screenshot.shadow", shadow, SHADOW_KEYS);
    }
    for (const frameKey of ["frame", "border"] as const) {
      if (shot[frameKey] !== undefined) {
        const frame = assertObject(shot[frameKey], `settings.screenshot.${frameKey}`);
        collectUnknown(unknown, `settings.screenshot.${frameKey}`, frame, FRAME_KEYS);
      }
    }
    if (shot.rotation3D !== undefined) {
      const rotation = assertObject(shot.rotation3D, "settings.screenshot.rotation3D");
      collectUnknown(unknown, "settings.screenshot.rotation3D", rotation, ROTATION_3D_KEYS);
    }
  }
  if (normalized.text !== undefined) {
    const text = assertObject(normalized.text, "settings.text");
    collectUnknown(unknown, "settings.text", text, textSettingKeys());
    if (text.languageSettings !== undefined) {
      const layouts = assertObject(text.languageSettings, "settings.text.languageSettings");
      for (const [lang, layout] of Object.entries(layouts)) {
        const entry = assertObject(layout, `settings.text.languageSettings.${lang}`);
        collectUnknown(unknown, `settings.text.languageSettings.${lang}`, entry, LAYOUT_KEYS);
      }
    }
  }
  for (const panoKey of ["panoramic", "panoramicBackground"] as const) {
    if (normalized[panoKey] !== undefined) {
      const pano = assertObject(normalized[panoKey], `settings.${panoKey}`);
      collectUnknown(unknown, `settings.${panoKey}`, pano, PANORAMIC_KEYS);
    }
  }
  if (normalized.gradient !== undefined) {
    const gradient = assertObject(normalized.gradient, "settings.gradient");
    collectUnknown(unknown, "settings.gradient", gradient, new Set(["angle", "stops"]));
  }
  if (normalized.elements !== undefined && !Array.isArray(normalized.elements)) {
    throw new ProjectError("invalid_setting", "settings.elements must be an array.");
  }
  if (normalized.popouts !== undefined && !Array.isArray(normalized.popouts)) {
    throw new ProjectError("invalid_setting", "settings.popouts must be an array.");
  }
  rejectUnknown(unknown);
  assertWrapSetting(normalized.headlineTextWrap, "settings.headlineTextWrap");
  assertWrapSetting(normalized.subheadlineTextWrap, "settings.subheadlineTextWrap");
  if (isPlainObject(normalized.text)) {
    const text = normalized.text as Record<string, unknown>;
    assertWrapSetting(text.headlineTextWrap, "settings.text.headlineTextWrap");
    assertWrapSetting(text.subheadlineTextWrap, "settings.text.subheadlineTextWrap");
  }
}

function assertWrapSetting(value: unknown, path: string): void {
  if (value === undefined) return;
  if (value !== "wrap" && value !== "balance") {
    throw new ProjectError(
      "unknown_setting",
      `Invalid ${path} "${String(value)}". Use "wrap" or "balance".`,
    );
  }
}

export function updateGlobalSettings(dump: BackupDump, settings: Record<string, unknown>, applyTo: "all" | "defaults" = "all"): void {
  assertKnownSettings(settings, "global");
  const project = primaryProject(dump);
  const lang = typeof settings.language === "string" ? settings.language : project.currentLanguage || "en";
  if (typeof settings.language === "string") {
    project.currentLanguage = settings.language;
    ensureLanguage(project, settings.language);
  }
  const width = typeof settings.width === "number"
    ? settings.width
    : typeof settings.customWidth === "number"
      ? settings.customWidth
      : undefined;
  const height = typeof settings.height === "number"
    ? settings.height
    : typeof settings.customHeight === "number"
      ? settings.customHeight
      : undefined;
  if (typeof settings.outputDevice === "string" || width !== undefined || height !== undefined) {
    setOutputSize(dump, {
      device: typeof settings.outputDevice === "string" ? settings.outputDevice : undefined,
      width,
      height,
    });
  }
  applyLayerSettings(project.defaults, settings, lang);
  const panoInput = isPlainObject(settings.panoramicBackground)
    ? (settings.panoramicBackground as Record<string, unknown>)
    : isPlainObject(settings.panoramic)
      ? (settings.panoramic as Record<string, unknown>)
      : null;
  if (panoInput) {
    setPanoramicBackground(dump, {
      src: typeof panoInput.src === "string" ? panoInput.src : typeof panoInput.imageSrc === "string" ? panoInput.imageSrc : undefined,
      enabled: typeof panoInput.enabled === "boolean" ? panoInput.enabled : undefined,
      overlap: typeof panoInput.overlap === "number" ? panoInput.overlap : undefined,
      scale: typeof panoInput.scale === "number" ? panoInput.scale : undefined,
      offsetY: typeof panoInput.offsetY === "number" ? panoInput.offsetY : undefined,
    });
  }
  if (Array.isArray(settings.elements)) project.defaults.elements = settings.elements as unknown[];
  if (Array.isArray(settings.popouts)) project.defaults.popouts = settings.popouts as unknown[];
  if (applyTo === "all") {
    for (const shot of project.screenshots) {
      applyLayerSettings(shot, settings, lang);
      if (Array.isArray(settings.elements)) shot.elements = clone(settings.elements) as unknown[];
      if (Array.isArray(settings.popouts)) shot.popouts = clone(settings.popouts) as unknown[];
    }
  }
}

export function updateScreenshotSettings(dump: BackupDump, index: number, settings: Record<string, unknown>): void {
  const project = primaryProject(dump);
  const shot = screenshotAt(project, index);
  assertKnownSettings(settings, "screenshot");
  const lang = typeof settings.language === "string" ? settings.language : project.currentLanguage || "en";
  if (typeof settings.language === "string") ensureLanguage(project, settings.language);
  applyLayerSettings(shot, settings, lang);
  if (Array.isArray(settings.elements)) shot.elements = settings.elements as unknown[];
  if (Array.isArray(settings.popouts)) shot.popouts = settings.popouts as unknown[];
  if (typeof settings.name === "string") shot.name = settings.name;
  if (typeof settings.deviceType === "string") shot.deviceType = settings.deviceType;
  project.selectedIndex = index;
}

export function setOutputSize(
  dump: BackupDump,
  input: { device?: string; width?: number; height?: number },
): { device: string; width: number; height: number } {
  const project = primaryProject(dump);
  if (input.device && input.device !== "custom") {
    const spec = OUTPUT_DEVICES[input.device];
    if (!spec) {
      throw new ProjectError(
        "invalid_device",
        `Unknown device "${input.device}". Use one of: ${Object.keys(OUTPUT_DEVICES).join(", ")}, or custom with width and height.`,
      );
    }
    project.outputDevice = input.device;
    project.customWidth = spec.width;
    project.customHeight = spec.height;
    return { device: input.device, width: spec.width, height: spec.height };
  }
  const width = input.width ?? project.customWidth;
  const height = input.height ?? project.customHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new ProjectError("invalid_size", "Custom output size requires numeric width and height.");
  }
  if (width < 100 || height < 100 || width > 4000 || height > 4000) {
    throw new ProjectError("invalid_size", "Custom width and height must be between 100 and 4000 pixels.");
  }
  project.outputDevice = "custom";
  project.customWidth = Math.round(width);
  project.customHeight = Math.round(height);
  return { device: "custom", width: project.customWidth, height: project.customHeight };
}

export function outputSizeOf(project: ProjectRecord): { device: string; width: number; height: number } {
  if (project.outputDevice === "custom" || !OUTPUT_DEVICES[project.outputDevice]) {
    return {
      device: project.outputDevice || "custom",
      width: project.customWidth || 1320,
      height: project.customHeight || 2868,
    };
  }
  const spec = OUTPUT_DEVICES[project.outputDevice];
  return { device: project.outputDevice, width: spec.width, height: spec.height };
}

function numberSetting(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function effectiveLayoutNumber(text: Record<string, unknown>, key: string, lang: string): number | null {
  const settings = text.languageSettings;
  if (settings && typeof settings === "object") {
    const entry = (settings as Record<string, unknown>)[lang];
    if (entry && typeof entry === "object") {
      const sized = numberSetting((entry as Record<string, unknown>)[key]);
      if (sized != null) return sized;
    }
  }
  return numberSetting(text[key]);
}

export function screenshotImageRef(shot: ScreenshotRecord, lang: string): string {
  const localized = shot.localizedImages || {};
  const order = [lang, "en", ...Object.keys(localized)];
  for (const code of order) {
    const src = localized[code]?.src;
    if (src) return src;
  }
  return shot.src || "";
}

export function summarizePanorama(project: ProjectRecord): Record<string, unknown> {
  const raw = project.panoramicBackground;
  const pano = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const src = typeof pano.src === "string" ? pano.src : "";
  return {
    enabled: pano.enabled === true,
    hasImage: Boolean(src),
    overlap: typeof pano.overlap === "number" ? pano.overlap : 0,
    scale: typeof pano.scale === "number" ? pano.scale : 100,
    offsetY: typeof pano.offsetY === "number" ? pano.offsetY : 0,
    src: src.startsWith("data:") ? "data-url" : src,
  };
}

export function summarizeScreenshot(shot: ScreenshotRecord, index: number, lang = "en", panoramaActive = false): Record<string, unknown> {
  const text = shot.text || {};
  const headlines = (text.headlines as Record<string, string>) || {};
  const subheadlines = (text.subheadlines as Record<string, string>) || {};
  const langs = Object.keys(shot.localizedImages || {});
  const background = (shot.background || {}) as Record<string, unknown>;
  const type = typeof background.type === "string" ? background.type : "gradient";
  const imageSrc = typeof background.imageSrc === "string"
    ? background.imageSrc
    : typeof background.image === "string"
      ? background.image
      : "";
  return {
    index,
    name: shot.name,
    deviceType: shot.deviceType || null,
    languages: langs,
    hasImage: langs.some((code) => Boolean(shot.localizedImages[code]?.src)) || Boolean(shot.src),
    background: shot.background,
    backgroundState: {
      type,
      hasImage: Boolean(imageSrc),
      effective: panoramaActive ? "panorama" : type,
    },
    screenshot: shot.screenshot,
    headlines,
    subheadlines,
    headlineEnabled: text.headlineEnabled !== false,
    subheadlineEnabled: text.subheadlineEnabled === true,
    headlineFont: text.headlineFont,
    subheadlineFont: text.subheadlineFont,
    headlineWeight: text.headlineWeight ?? null,
    subheadlineWeight: text.subheadlineWeight ?? null,
    headlineSize: numberSetting(text.headlineSize),
    subheadlineSize: numberSetting(text.subheadlineSize),
    effectiveHeadlineSize: effectiveLayoutNumber(text, "headlineSize", lang),
    effectiveSubheadlineSize: effectiveLayoutNumber(text, "subheadlineSize", lang),
    headlineTextWrap: text.headlineTextWrap || "wrap",
    subheadlineTextWrap: text.subheadlineTextWrap || "wrap",
    headlineColor: text.headlineColor,
    subheadlineColor: text.subheadlineColor,
    position: text.position,
  };
}

export interface RenderFrameSource {
  image: string;
  panorama: boolean;
}

/** Image identity for each screenshot, used to reject identical captures of different photos. */
export function renderSourceKeys(dump: BackupDump): RenderFrameSource[] {
  const project = primaryProject(dump);
  const panorama = summarizePanorama(project);
  const active = panorama.enabled === true && panorama.hasImage === true;
  const lang = project.currentLanguage || "en";
  return project.screenshots.map((shot) => ({
    image: screenshotImageRef(shot, lang),
    panorama: active,
  }));
}

function redactDataUrls(value: unknown): unknown {
  if (typeof value === "string") return value.startsWith("data:image/") ? "data-url" : value;
  if (Array.isArray(value)) return value.map(redactDataUrls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactDataUrls(child);
    return out;
  }
  return value;
}

/** Strip bulky data URLs so get_project stays readable. */
export function backupSummary(dump: BackupDump): Record<string, unknown> {
  const project = primaryProject(dump);
  const panorama = summarizePanorama(project);
  const panoramaActive = panorama.enabled === true && panorama.hasImage === true;
  const lang = project.currentLanguage || "en";
  return redactDataUrls({
    id: project.id,
    name: projectName(dump),
    formatVersion: project.formatVersion,
    output: outputSizeOf(project),
    currentLanguage: project.currentLanguage,
    projectLanguages: project.projectLanguages,
    selectedIndex: project.selectedIndex,
    screenshotCount: project.screenshots.length,
    panoramicBackground: panorama,
    defaults: project.defaults,
    screenshots: project.screenshots.map((shot, index) => summarizeScreenshot(shot, index, lang, panoramaActive)),
  }) as Record<string, unknown>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s/g, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function dataUrlFromBytes(mime: string, bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ProjectError("image_too_large", `Image is ${bytes.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES} (15 MiB).`);
  }
  const safeMime = /^image\/[a-zA-Z0-9.+-]+$/.test(mime) ? mime : "image/png";
  return `data:${safeMime};base64,${bytesToBase64(bytes)}`;
}

export function decodeImageBase64(input: string): { mime: string; bytes: Uint8Array } {
  const trimmed = input.trim();
  const data = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (data) {
    const bytes = base64ToBytes(data[2]);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ProjectError("image_too_large", `Image is ${bytes.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES} (15 MiB).`);
    }
    return { mime: data[1], bytes };
  }
  const bytes = base64ToBytes(trimmed);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ProjectError("image_too_large", `Image is ${bytes.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES} (15 MiB).`);
  }
  return { mime: "image/png", bytes };
}

export function assertPublicImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProjectError("invalid_image_url", "image_url must be an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProjectError("invalid_image_url", "image_url must use http or https.");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === "metadata.google.internal";
  if (blocked) {
    throw new ProjectError("invalid_image_url", "image_url must be a public address.");
  }
  if (url.protocol === "http:" && url.hostname !== "localhost") {
    /* http is allowed only so tests and public CDNs that still use it work; private hosts are blocked above. */
  }
  return url;
}
